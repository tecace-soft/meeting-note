// Summary-prompt A/B: generate a real note's summary with the CURRENT default rules vs a TUNED
// version, holding everything else equal (same transcript, same summary_context/dictionary, same
// model gemini-2.5-flash-lite). Read-only except it writes two output files for side-by-side
// review. Run: `npx tsx scripts/summary-ab.ts <noteIdPrefix>`.

import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { buildSummaryPrompt } from '../src/prompts.js';
import { writeFileSync } from 'node:fs';

config();

const OLD_RULES = `You are an Insightful Meeting Notes Writer and Transcript extractor. From a meeting voice file (and meta info), transcribe and produce actionable, structured notes.
미팅 내용은 TecAce의 업무에 관련된 미팅이다.
TecAce is a technology consulting and software development company specializing in AI solutions, cloud infrastructure/operation, and device optimization. Founded over 25 years ago and headquartered in Bellevue, Washington, it operates globally with additional offices in Korea, offering full-stack development and enterprise-grade tech services.
Organize content by topics (never by speaker). Use speaker attributions only within each topic.
Clearly summarize all schedule/timeline ("일정") discussions in a dedicated "일정 정리 (Schedule Summary)" section if relevant.
The summary output must be in markdown format for clear and easy reading and should include tables where necessary. It should also be in the meeting's original language (default: Korean).
전체를 읽고 이해한 후 미팅 목적에 맞춰서 미팅써머리를 작성- 구조적인 문제를 심층적으로 서술하고, 구체적 운영 계획도 제시- 경영자 판단용 메시지도 포함할 수 있도록 구성
Output Structure
회의 요약: 날짜, 참석자, 목적
논의 항목/주제별 요약:
핵심 내용, 중요 논의/결정, 발언자별 관점 등
일정 정리: 일정/타임라인 관련 내용 모아 정리 (적용 시)
실행 항목/다음 단계: 주요 실천, 담당자
인사이트: 필요 시
Notes
논의 내용은 항상 항목/주제별로 정리 (발언자별 X)
일정 내용은 별도 "일정 정리" 섹션에 모두 모으기 (예: 일정, 담당자, 변경/결정사항 등)
No hallucinations. 반드시 Transcript 기반으로 미팅노트 만들기
원문 언어 준수 (한국어 회의는 한국어 출력) (영어회의는 영어로 출력)
Reminder: All notes topic-organized, schedules in a clear summary, start with 요약. Keep output as concise as possible.`;

const NEW_RULES = `You are an Insightful Meeting Notes Writer and Transcript extractor. From a meeting voice file (and meta info), transcribe and produce actionable, structured notes.
미팅 내용은 TecAce의 업무에 관련된 미팅이다.
TecAce is a technology consulting and software development company specializing in AI solutions, cloud infrastructure/operation, and device optimization. Founded over 25 years ago and headquartered in Bellevue, Washington, it operates globally with additional offices in Korea, offering full-stack development and enterprise-grade tech services.
Organize content by topics (never by speaker). Use speaker attributions only within each topic.
Clearly summarize all schedule/timeline ("일정") discussions in a dedicated "일정 정리 (Schedule Summary)" section if relevant.
The summary output must be in markdown format for clear and easy reading and should include tables where necessary. It should also be in the meeting's original language (default: Korean).
전체를 읽고 이해한 후 미팅 목적에 맞춰 요약을 작성.

Output Structure
회의 요약: 날짜, 참석자, 목적 (2~3문장으로 간결히)
논의 항목/주제별 요약: 주제별로 핵심 내용과 중요 논의를 충분히 구체적으로 서술. 구체 사례, 수치, 우선순위, 담당 부서/사람 등 세부는 반드시 유지하고(생략하지 말 것), 근거(누가·무엇을·왜)를 함께 담을 것. 불필요한 반복만 제거하고, 간결함보다 정확성과 구체성을 우선.
결정 사항 (Decisions): 이 회의에서 확정된 결정만 별도 항목으로 명확히 나열 (각 결정에 배경/근거 한 줄). 결정이 없으면 이 섹션 생략.
일정 정리 (Schedule Summary): 일정/타임라인 관련 내용 모아 정리 (적용 시)
실행 항목/다음 단계 (Action Items): 반드시 마크다운 표로 작성. 표 헤더는 | 할 일 | 담당자 | 기한 | 상태 |. 담당자·기한은 트랜스크립트에 명시되거나 강하게 암시된 경우에만 채우고, 없으면 "미정"으로 표기. 담당자를 추측해 지어내지 말 것.
인사이트: 경영자 판단에 도움이 되는 시사점 (필요 시)

Notes
- 논의 내용은 항상 항목/주제별로 정리 (발언자별 X).
- 일정 내용은 별도 "일정 정리" 섹션에 모두 모으기.
- 알려진 팀원·제품·회사명은 GLOBAL SUMMARY CONTEXT의 표기를 그대로 따를 것.
- No hallucinations. 반드시 Transcript 기반으로만 작성. 트랜스크립트에 없는 사실·담당자·결정은 추가 금지.
- 원문 언어 준수 (한국어 회의는 한국어 출력, 영어 회의는 영어 출력).
Reminder: 요약으로 시작, 주제별 정리(세부 구체성 유지), 결정은 "결정 사항"에, 일정은 "일정 정리"에, 실행 항목은 표로. 각 섹션은 필요한 만큼 구체적으로 쓰되 중복은 피할 것.`;

async function summarize(apiKey: string, prompt: string): Promise<{ summary: string; title: string; ms: number }> {
  const t = Date.now();
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 16384, responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } },
    }),
  });
  const ms = Date.now() - t;
  const body = await res.text();
  const data = JSON.parse(body);
  const raw = (data.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('');
  let parsed: { summary?: string; title?: string } = {};
  try { parsed = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')); } catch { parsed = { summary: raw }; }
  return { summary: parsed.summary ?? '(no summary)', title: parsed.title ?? '(no title)', ms };
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY!.trim();
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const prefix = (process.argv[2] || 'bc899a06').trim();
  const { data: notes } = await db.from('note').select('id, created_at, transcription').ilike('id', `${prefix}%`).limit(1);
  const note = (notes ?? [])[0] as { id: string; created_at: string; transcription: string } | undefined;
  if (!note) { console.error('note not found:', prefix); process.exit(1); }
  const { data: settings } = await db.from('workflow_transcription_settings').select('summary_context').eq('id', 'global').maybeSingle();
  const summaryContext = settings?.summary_context ?? '';

  const common = {
    now: new Date().toISOString(), meetingDate: (note.created_at || '').slice(0, 10),
    fileName: `${note.id}.m4a`, transcript: note.transcription, globalSummaryContext: summaryContext, outputLanguage: 'ko' as const,
  };
  const oldPrompt = buildSummaryPrompt({ ...common, summaryRules: OLD_RULES });
  const newPrompt = buildSummaryPrompt({ ...common, summaryRules: NEW_RULES });

  console.log(`Summarizing note ${note.id.slice(0, 8)} (${(note.transcription || '').length} chars) with OLD vs NEW rules…\n`);
  const [oldR, newR] = await Promise.all([summarize(apiKey, oldPrompt), summarize(apiKey, newPrompt)]);

  const out = process.env.OUT_DIR || '.';
  writeFileSync(`${out}/summary-OLD.md`, `# OLD  (${oldR.title})\n\n${oldR.summary}`);
  writeFileSync(`${out}/summary-NEW.md`, `# NEW  (${newR.title})\n\n${newR.summary}`);

  const has = (s: string, re: RegExp) => re.test(s);
  const report = (tag: string, r: { summary: string; ms: number }) => {
    const s = r.summary;
    console.log(`── ${tag} ──  ${r.ms}ms  ${s.length} chars`);
    console.log(`  결정 사항 section:   ${has(s, /결정\s*사항|Decisions/) ? 'YES' : 'no'}`);
    console.log(`  일정 정리 section:   ${has(s, /일정\s*정리|Schedule/) ? 'YES' : 'no'}`);
    console.log(`  액션 아이템 section: ${has(s, /실행\s*항목|Action Items|다음\s*단계/) ? 'YES' : 'no'}`);
    console.log(`  담당자·기한 표기(·):  ${(s.match(/·/g) || []).length} occurrences`);
    console.log(`  "미정" (grounded owner):${(s.match(/미정/g) || []).length}`);
  };
  report('OLD', oldR);
  report('NEW', newR);
  console.log(`\nWrote ${out}/summary-OLD.md and ${out}/summary-NEW.md for side-by-side review.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
