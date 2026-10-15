// F2: rule-based auto-classification `suggestTriage` (spec section 6.4). Not an LLM.
// PURPOSE_RULES, URGENT_KEYWORDS, matching and the Korean reason sentences are the spec's
// verbatim. AREA_RULES and normalize() are rebuilt for this app's screens.
// The stored reason is always Korean (decision 2026-10-14), whatever the UI language.

import type { AreaId, PriorityId, PurposeId, SeverityId, TriageSuggestion } from './types';

interface PurposeRule {
  purpose: PurposeId;
  priority: PriorityId;
  severity: SeverityId;
  keywords: string[];
  reason: string;
}

// First match from the top wins.
const PURPOSE_RULES: PurposeRule[] = [
  {
    purpose: 'bug', priority: 'P2', severity: 'High',
    keywords: ['안 됨', '안됨', '안 돼', '안돼', '안 되', '안되', '에러', '오류', '크래시', '깨짐', '안 뜸', '안뜸', '실패', '멈춤', 'error', 'fail', 'crash', 'bug'],
    reason: '오류를 뜻하는 표현이 있어 버그로 분류했습니다.',
  },
  {
    purpose: 'feature', priority: 'P3', severity: 'Medium',
    keywords: ['추가', '개선', '요청', '했으면', '주세요', '필요합니다', '지원', '기능', 'feature', 'support'],
    reason: '기능 추가/개선 요청으로 보여 그렇게 분류했습니다.',
  },
  {
    purpose: 'question', priority: 'P4', severity: 'Low',
    keywords: ['?', '인가요', '있나요', '문의', '어떻게', '방법', '궁금'],
    reason: '문의성 표현이 있어 질문으로 분류했습니다.',
  },
];

const FALLBACK_RULE: PurposeRule = {
  purpose: 'other', priority: 'P4', severity: 'Low', keywords: [],
  reason: '긴급 키워드는 없어 일반 피드백으로 분류했습니다. 분류에서 필요하면 조정하세요.',
};

// This app's screens. Order = priority (specific first). Generic words ('저장', '목록',
// single '이슈' / 'issue') are left out on purpose: they would pull ordinary reports in.
const AREA_RULES: { area: AreaId; keywords: string[] }[] = [
  { area: 'speaker', keywords: ['화자', 'speaker', '다이어리제이션', 'diariz'] },
  { area: 'onedrive', keywords: ['onedrive', '원드라이브', '내보내기', 'export'] },
  { area: 'projects', keywords: ['프로젝트', 'project'] },
  { area: 'issues', keywords: ['피드백', '이슈 목록', '이슈 등록', 'feedback'] },
  { area: 'docs', keywords: ['문서', '도움말', 'docs', 'guide'] },
  { area: 'settings', keywords: ['설정', '계정', '로그인', '권한', '프로필', 'settings', 'account', 'login', 'profile'] },
  { area: 'history', keywords: ['히스토리', '기록', '검색', 'history', 'search'] },
  { area: 'meeting-note', keywords: ['회의', '녹음', '노트', '전사', '요약', 'meeting', 'record', 'note', 'transcri', 'summary'] },
];

// Common words such as '전체' are not here: ordinary requests would get escalated.
const URGENT_KEYWORDS = ['긴급', '급함', '급하', '아무도', '못함', '못 함', '전혀', 'urgent', 'asap', 'critical'];

const PRIORITY_LADDER: PriorityId[] = ['P4', 'P3', 'P2', 'P1'];
const SEVERITY_LADDER: SeverityId[] = ['Low', 'Medium', 'High', 'Critical'];
const escalate = <T,>(ladder: T[], cur: T): T => ladder[Math.min(ladder.indexOf(cur) + 1, ladder.length - 1)];

// English keywords match only at a word start ('bug' != 'debug', 'fail' = 'failed').
// Korean keywords match anywhere (particles attach to the word).
const matchesKeyword = (text: string, kw: string): boolean =>
  /^[a-z]/.test(kw) ? new RegExp(`(^|[^a-z])${kw}`).test(text) : text.includes(kw);
const hasKeyword = (text: string, kws: string[]): boolean => kws.some((kw) => matchesKeyword(text, kw));

// Substring collision fixes for this app's table: '노트북' (laptop) must not hit '노트'.
const normalize = (title: string, description: string): string =>
  `${title} ${description}`.toLowerCase().replace(/노트북/g, 'laptop');

export function suggestTriage(title: string, description: string, purposeOverride: PurposeId | null = null): TriageSuggestion {
  const text = normalize(title, description);
  const rule: PurposeRule = purposeOverride
    ? {
        ...(PURPOSE_RULES.find((r) => r.purpose === purposeOverride) ?? FALLBACK_RULE),
        purpose: purposeOverride,
        reason: '직접 고른 종류에 맞춰 긴급도를 정했습니다.',
      }
    : PURPOSE_RULES.find((r) => hasKeyword(text, r.keywords)) ?? FALLBACK_RULE;
  const area = AREA_RULES.find((r) => hasKeyword(text, r.keywords))?.area ?? null;
  const urgent = hasKeyword(text, URGENT_KEYWORDS);
  const reason = [
    rule.reason,
    ...(area ? ['본문에서 관련 영역을 감지했습니다.'] : []),
    ...(urgent ? ['긴급 표현이 있어 우선순위를 한 단계 올렸습니다.'] : []),
  ].join(' ');
  return {
    purpose: rule.purpose,
    area: area ?? 'general',
    priority: urgent ? escalate(PRIORITY_LADDER, rule.priority) : rule.priority,
    severity: urgent ? escalate(SEVERITY_LADDER, rule.severity) : rule.severity,
    reason,
  };
}
