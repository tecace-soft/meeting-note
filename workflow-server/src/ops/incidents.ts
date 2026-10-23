import { randomBytes } from 'node:crypto';
import { env } from '../config/env.js';
import { supabase } from '../db/supabaseClient.js';
import { callGeminiWithFallback } from '../ai/geminiFallback.js';
import { STANDARD_FALLBACK_CHAIN } from '../gemini-models.js';
import { parseIssueResolution, ISSUE_RESOLUTION_SCHEMA, buildIssueMail } from '../issues.js';
import { issueDeepLink } from '../issueLinks.js';
import { sendWorkflowAlert, sendEmail, alertRecipients, formatError as formatAlertError, sanitizeContext as sanitizeAlertContext, type WorkflowAlertInput } from '../alerts.js';
import { incidentFingerprint, matchOpsTicket, bumpOccurrence, makeOpsIssueKey, opsSeverityToPriority, buildOpsIncidentDetail, buildOpsTicketDescription, type OpsSuggestionMeta } from '../opsAgent.js';

// ---------------------------------------------------------------------------
// F9 — Autonomous ops agent (v1: detect → RCA draft → F2 ticket, human-gated)
//
// Every workflow alert (job failure, 500, uncaught/unhandled) is also handed to
// this agent, which drafts a root-cause analysis with the SAME structured LLM
// path the human issue-resolution endpoint uses (ISSUE_RESOLUTION_SCHEMA), then
// files an ops-tagged ticket on the existing F2 `feedback_issues` board and
// emails the on-call. It NEVER touches prod code — remediation stays human
// (auto-fix is deferred to F9.2). Repeats of the same failure are de-duped by
// fingerprint so a flapping error updates one ticket instead of flooding the
// board. This function is fully self-contained and MUST NOT reject: it runs off
// the alert path (incl. process.uncaughtException), so a throw here would loop
// back through the same alert handler. All failures are swallowed with a warn.
// ---------------------------------------------------------------------------

const F9_ENABLED = (process.env.F9_OPS_AGENT_ENABLED ?? 'true').toLowerCase() !== 'false';

const OPS_AGENT_AUTHOR_EMAIL = 'ops-agent@tecace.com';

const OPS_AGENT_AUTHOR_NAME = 'Ops Agent (F9)';

const OPS_INCIDENT_THROTTLE_MS = 24 * 60 * 60 * 1000;

// one open ticket per signature per 24h
// Storm cap: max NEW ops tickets (= distinct failure classes) filed per rolling hour.
// De-dup already collapses identical failures; this bounds an incident STORM of many
// DIFFERENT classes (e.g. a bad deploy 500-ing every endpoint) so it cannot flood the
// board, the on-call inbox, OR the Gemini bill (each new ticket = one RCA call). Over
// the cap, new classes are dropped with a warn (existing tickets still de-dup/bump).
const OPS_MAX_NEW_TICKETS_PER_HOUR = Number(process.env.F9_MAX_NEW_TICKETS_PER_HOUR || '10');

const OPS_RCA_SYSTEM_PROMPT = `너는 사내 "Meeting Note"(회의 녹음 → AI 전사·요약·메모리·검색 앱) 백엔드를 운영하는 시니어 SRE다.
스택: Node workflow-server(Render)에서 Gemini 호출, DB Supabase(Postgres + RLS + Storage), 전사 AssemblyAI, 인증 Azure MSAL, 프론트 React/Vite, 모바일 Flutter.
운영 중 발생한 장애 알림(에러 + 컨텍스트)을 읽고 담당 엔지니어가 바로 착수할 수 있는 근본원인 분석(RCA)을 작성한다. 규칙:
- 한국어로, 각 배열 원소는 한 문장씩. 실행 가능한 내용만 쓴다.
- rootCauses 는 스택/메시지/컨텍스트를 근거로, 확인되지 않은 가설임을 전제로 가능성이 높은 순서로 쓴다.
- checks 는 담당자가 로그/DB/대시보드에서 실제로 조회하거나 재현해 볼 절차로 쓴다.
- fixPlan 은 손대야 할 위치와 방향을 순서대로 쓴다. 확실하지 않은 파일명을 지어내지 않는다.
- verification 은 수정 후 무엇이 어떻게 보이면 해결로 볼 수 있는지 쓴다.
- 정보가 부족하면 추측을 늘리지 말고 confidence 를 "low"로 두고 checks 에 무엇을 더 확인해야 하는지 적는다.
- confidence 는 정확히 "low" | "medium" | "high" 중 하나.`;

function opsEnvironment(): string {
  return process.env.RENDER_SERVICE_NAME || process.env.NODE_ENV || 'development';
}

/**
 * Find an open (non-DONE/CLOSED, non-deleted) ops ticket for this fingerprint within the
 * throttle window. Matches the fingerprint SERVER-SIDE (`ai_suggestion->>fingerprint`) so
 * de-dup is exact regardless of how many open ops tickets exist — a JS scan of a capped
 * row window could miss a match beyond the cap during a storm and file a duplicate.
 */
async function findOpenOpsTicket(fingerprint: string): Promise<{ id: string; meta: OpsSuggestionMeta } | null> {
  const cutoff = new Date(Date.now() - OPS_INCIDENT_THROTTLE_MS).toISOString();
  const { data, error } = await supabase
    .from('feedback_issues')
    .select('id, ai_suggestion, status, created_at')
    .eq('area', 'ops')
    .like('issue_key', 'OPS-%')
    .is('deleted_at', null)
    .not('status', 'in', '(DONE,CLOSED)')
    .gte('created_at', cutoff)
    .eq('ai_suggestion->>source', 'f9-ops-agent')
    .eq('ai_suggestion->>fingerprint', fingerprint)
    .order('created_at', { ascending: false })
    .limit(5);
  if (error) throw error;
  // matchOpsTicket re-validates source/fingerprint on the (already-filtered) rows — cheap
  // belt-and-suspenders that also narrows unknown[] to the typed meta.
  return matchOpsTicket((data as Array<{ id: string; ai_suggestion: unknown }>) ?? [], fingerprint);
}

/** Count NEW ops tickets filed in the last rolling hour (area='ops' rows are F9's alone). */
async function countRecentOpsTickets(): Promise<number> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count, error } = await supabase
    .from('feedback_issues')
    .select('id', { count: 'exact', head: true })
    .eq('area', 'ops')
    .like('issue_key', 'OPS-%')
    .is('deleted_at', null)
    .gte('created_at', oneHourAgo);
  if (error) throw error;
  return count ?? 0;
}

async function generateOpsRca(detail: string): Promise<{ resolution: ReturnType<typeof parseIssueResolution>; model: string } | null> {
  if (!env.geminiApiKey) return null;
  const result = await callGeminiWithFallback({
    stage: 'Ops RCA',
    model: env.summaryModel,
    fallbackModels: [...STANDARD_FALLBACK_CHAIN],
    responseMimeType: 'application/json',
    responseSchema: ISSUE_RESOLUTION_SCHEMA,
    maxOutputTokens: 4096,
    parts: [{ text: `${OPS_RCA_SYSTEM_PROMPT}\n\n장애 알림:\n${detail}\n\n위 장애에 대한 RCA를 지정된 JSON 스키마로만 작성하라.` }],
  });
  return { resolution: parseIssueResolution(result.text), model: result.model };
}

export async function fileOpsIncident(input: WorkflowAlertInput): Promise<void> {
  if (!F9_ENABLED) return;
  if (!env.supabaseUrl || !env.serviceRoleKey) return; // no DB → nothing to file
  try {
    const severity: 'error' | 'warning' = input.severity === 'warning' ? 'warning' : 'error';
    const rawErr = formatAlertError(input.error);
    const err = { name: rawErr.name, message: rawErr.message, stack: rawErr.stack };
    const context = sanitizeAlertContext(input.context);
    const fingerprint = incidentFingerprint(input.title, err.name, err.message);
    const nowIso = new Date().toISOString();

    // De-dup: a repeat of the same failure only bumps the existing ticket's counter.
    // Only `ai_suggestion` (display-only agent metadata) is updated — NOT `triage_note`,
    // which is human-authored and must not be clobbered by an automatic recurrence note.
    const existing = await findOpenOpsTicket(fingerprint);
    if (existing) {
      const meta = bumpOccurrence(existing.meta, nowIso);
      const { error: updateError } = await supabase
        .from('feedback_issues')
        .update({ ai_suggestion: meta })
        .eq('id', existing.id);
      if (updateError) throw updateError;
      return;
    }

    // Storm cap: a new failure class, but if too many NEW ops tickets were filed this
    // hour, drop it (warn only) rather than flooding the board/inbox/Gemini bill. Placed
    // AFTER de-dup so recurring known failures still bump their ticket during a storm.
    const recentCount = await countRecentOpsTickets();
    if (recentCount >= OPS_MAX_NEW_TICKETS_PER_HOUR) {
      console.warn(`F9: ops ticket rate cap reached (${recentCount}/${OPS_MAX_NEW_TICKETS_PER_HOUR} this hour) — dropping new incident "${input.title}" (fingerprint ${fingerprint}).`);
      return;
    }

    // New failure class → draft an RCA and open a ticket.
    const contextText = Object.keys(context).length ? JSON.stringify(context, null, 2) : '(없음)';
    const detail = buildOpsIncidentDetail({ title: input.title, severity, environment: opsEnvironment(), err, contextText });

    let resolution: ReturnType<typeof parseIssueResolution> = null;
    let resolutionModel: string | null = null;
    try {
      const rca = await generateOpsRca(detail);
      resolution = rca?.resolution ?? null;
      resolutionModel = rca?.model ?? null;
    } catch (rcaError) {
      console.warn('F9 ops RCA generation failed (filing ticket without RCA):', rcaError);
    }

    const issueKey = makeOpsIssueKey(new Date(), randomBytes(4).toString('hex'));
    const { priority, severity: ticketSeverity } = opsSeverityToPriority(severity);
    const meta: OpsSuggestionMeta = {
      source: 'f9-ops-agent',
      fingerprint,
      occurrences: 1,
      firstSeen: nowIso,
      lastSeen: nowIso,
      environment: opsEnvironment(),
      severity,
    };
    const description = buildOpsTicketDescription({ title: input.title, err, contextText });

    const { error: insertError } = await supabase.from('feedback_issues').insert({
      issue_key: issueKey,
      title: `[운영] ${input.title}`.slice(0, 200),
      description,
      purpose: 'bug',
      area: 'ops',
      status: 'OPEN',
      priority,
      severity: ticketSeverity,
      ai_suggestion: meta,
      resolution: resolution ?? null,
      resolution_generated_at: resolution ? nowIso : null,
      resolution_model: resolutionModel,
      author_email: OPS_AGENT_AUTHOR_EMAIL,
      author_name: OPS_AGENT_AUTHOR_NAME,
    });
    if (insertError) throw insertError;

    // Notify the on-call. Reuses the F2 email renderer so ops tickets read like any issue.
    const { html } = buildIssueMail({
      kind: 'created',
      row: {
        issue_key: issueKey,
        title: `[운영] ${input.title}`,
        description,
        purpose: 'bug',
        area: 'ops',
        status: 'OPEN',
        priority,
        assignee_email: null,
        assignee_name: null,
        triage_note: null,
        resolution,
        attachments: [],
        author_email: OPS_AGENT_AUTHOR_EMAIL,
        author_name: OPS_AGENT_AUTHOR_NAME,
        created_at: nowIso,
      },
      actor: { name: OPS_AGENT_AUTHOR_NAME, email: OPS_AGENT_AUTHOR_EMAIL },
      imageUrls: [],
      deepLink: issueDeepLink(issueKey),
      includeResolution: true,
    });
    await sendEmail({ to: alertRecipients(), subject: `[운영 장애] ${issueKey} ${input.title}`, html });
  } catch (fileError) {
    // Never rethrow — this runs off the alert path (incl. uncaughtException), so a
    // throw would re-enter the alert handler and loop.
    console.warn('F9 fileOpsIncident failed:', fileError);
  }
}

/** Emit an ops alert: the existing email PLUS an F9 RCA ticket. Fire-and-forget, never throws. */
export function raiseIncident(input: WorkflowAlertInput): void {
  void sendWorkflowAlert(input);
  void fileOpsIncident(input);
}
