import { supabase } from '../db/supabaseClient.js';

const DEFAULT_SUMMARY_PROMPT_NAME = 'Default';

// Keep in sync with src/constants/defaultSummaryPrompt.ts (the web copy that seeds a user's
// "Default" summary_prompt row). This backend copy is the FALLBACK when no DB row exists
// (android-default + resolveRegenerateSummaryRules last resort).
export const DEFAULT_SUMMARY_PROMPT = `You are an Insightful Meeting Notes Writer and Transcript extractor. From a meeting voice file (and meta info), transcribe and produce actionable, structured notes.
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

export async function loadSummaryPrompt(promptId: string, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from('summary_prompt')
    .select('prompt')
    .eq('id', promptId)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  const prompt = (data as { prompt?: unknown } | null)?.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new Error('Selected summary prompt was not found for this user.');
  }
  return prompt.trim();
}

export async function resolveSummaryPromptForAndroid(input: { promptId?: string; userId: string }): Promise<{
  promptId: string;
  summaryRulesOverride?: string;
}> {
  if (input.promptId?.trim()) {
    await loadSummaryPrompt(input.promptId.trim(), input.userId);
    return { promptId: input.promptId.trim() };
  }
  return {
    promptId: 'android-default',
    summaryRulesOverride: DEFAULT_SUMMARY_PROMPT,
  };
}

/**
 * Summary rules to use when regenerating a note. Prefers the prompt the user
 * currently has selected (promptId), then the user's "Default" prompt, then the
 * earliest prompt, and finally the built-in default. Regenerate previously used
 * a hardcoded structure and ignored the user's custom prompt entirely.
 */
export async function resolveRegenerateSummaryRules(promptId: string | undefined, userId: string): Promise<string> {
  if (promptId) {
    try {
      return await loadSummaryPrompt(promptId, userId);
    } catch (error) {
      console.warn(`Regenerate: selected prompt ${promptId} not usable for user, falling back to default. ${(error as Error).message}`);
    }
  }

  const { data, error } = await supabase
    .from('summary_prompt')
    .select('name, prompt, created_at')
    .eq('user_id', userId);
  if (error) {
    console.warn(`Regenerate: failed to load user summary prompts, using built-in default. ${error.message}`);
    return DEFAULT_SUMMARY_PROMPT;
  }

  const rows = ((data as Array<{ name?: unknown; prompt?: unknown; created_at?: unknown }>) ?? [])
    .filter((row): row is { name: string; prompt: string; created_at: string | null } =>
      typeof row.prompt === 'string' && row.prompt.trim().length > 0)
    .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));

  const defaultRow = rows.find((row) => (row.name ?? '').trim().toLowerCase() === DEFAULT_SUMMARY_PROMPT_NAME.toLowerCase());
  const chosen = defaultRow ?? rows[0];
  return chosen ? chosen.prompt.trim() : DEFAULT_SUMMARY_PROMPT;
}
