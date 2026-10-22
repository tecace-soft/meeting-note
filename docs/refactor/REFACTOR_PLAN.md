# Meeting Note 리팩터링 계획 (정본, 2026-10-21 개정 3)

이 문서는 #14 리팩터링의 단일 정본이다.
개정 2는 Codex 1차 검토(docs/reviews/2026-10-21-codex-refactor-plan-review.md)와 2026-10-21 사용자 답변을 반영하고, 계획을 세 기둥(안정성, 단순화, 자동화)으로 다시 짰다.
개정 3은 Codex 2차 검토(docs/reviews/2026-10-21-codex-refactor-plan-review-2.md) 19건과 2026-10-21 Andrew의 추가 결정(화자 지정과 공유 분리, Render 설정 권한, Q5, Q10)을 반영했다.
2차 검토 19건은 모두 main(cab4b3e)의 코드와 대조해 확인했고 반대 의견은 없다.
이전 네 문서(2026-10-09 renovation-review, strangler-plan, manual-deploy-steps, 2026-10-20 refactor-handoff)는 이력으로만 남긴다.

읽는 사람: Codex(회사 SSH 서버, 새 clone, 이전 세션 기억 없음), Andrew(제품과 범위의 결정권자), 참고용으로 Hansoo.
Hansoo용 쉬운 말 요약은 docs/refactor/REBUILD_VS_STRANGLER_MEMO.md에 따로 있으며, 2026-10-21 이후에는 결정 요청이 아니라 기록이다(개정 3에서 남은 결정 요청을 지움).
구현은 검토 피드백을 반영한 뒤 Andrew의 Claude Code 세션에서 한다.
Codex는 코드를 수정하지 않고 마지막 절 "Codex 검토 요청"의 형식으로 피드백만 준다.

## 목차

- 0. 개정 이력과 이전 절 번호 대응
- 1. 목적, 세 기둥, 측정 가능한 목표
- 2. 현재 상태 (2026-10-21 검증)
- 3. 범위와 먼저 확인할 질문
- 4. 기둥 1: 안정성
  - 4.1 "자꾸 죽는" 원인 분석
  - 4.2 구조와 무관한 안정성 작업 (S 항목)
  - 4.3 P1.1(작업 실행 모델) 후보와 선택지
  - 4.4 목표 구조
  - 4.5 단계 공통 템플릿 (배포 사전 점검, 롤백)
  - 4.6 Target 1: workflow-server/src/index.ts
  - 4.7 Target 2: 웹 데이터 계층과 큰 페이지
  - 4.8 의존 순서와 권장 첫 배치
- 5. 기둥 2: 단순화 (UX)
- 6. 기둥 3: 자동화
- 7. 다시 만들기 대 단계적 교체
- 8. 열린 후보 항목
- 9. 지켜야 할 규칙
- 10. 위험 등록부
- 11. 완료 정의
- 12. Gotchas
- 13. 검증 명령
- 14. Best-practice check
- 15. Codex 검토 반영표 (15.1 1차, 15.2 2차)
- 16. 참고 문서
- 17. Codex 검토 요청 (3차, 선택)

## 0. 개정 이력과 이전 절 번호 대응

- 개정 1 (d607a07): 네 문서를 합친 첫 정본.
- 개정 2 (70d5c53, cab4b3e에서 결정 기록 보완): Codex 1차 검토 14건 반영, 사용자 답변 반영, 세 기둥 구조, 단순화/자동화 목록, 다시 만들기 비교 추가.
- 개정 3 (이 문서): Codex 2차 검토 19건 반영(15.2), Andrew 추가 결정 기록(3절).
  - 절 번호는 개정 2와 같다.
  - 추가: 4.1 D9, 4.2 S13, 5절 U9-0(화자 지정과 공유 분리)과 2차 검토 하위 수용 기준, 6절 A17~A19, 15.2.
  - 고침: 1.3 M1, M3, M13; 2.2와 7절 수치(cab4b3e 재측정); 3절 Q4, Q5, Q10; 4.2 S1, S2, S5, S9~S12; 4.5 전달 순서와 사전 점검; 4.6 T1-0a 상태, T1-2, T1-9b 선행, 장애 시나리오; 4.8 첫 배치; 5절 U1/U2, U5, U7, U9~U11, U14~U17, U21; 6절 A2, A10, A15; 10절 위험.
  - Hansoo용 요약(REBUILD_VS_STRANGLER_MEMO.md)에서 남아 있던 유료 전환과 방향 결정 요청을 지웠다.

| 개정 1 절 | 개정 2 절 |
| --- | --- |
| 1 목적과 결론 | 1 |
| 2 현재 상태 | 2 |
| 3 범위 질문 | 3 |
| 4 목표 구조 | 4.4 |
| 5.1 단계 공통 템플릿 | 4.5 |
| 5.2 Target 1 | 4.6 |
| 5.3 Target 2 | 4.7 |
| 5.4, 5.5 의존 순서, 첫 배치 | 4.8 |
| 6 열린 후보 | 8 |
| 7 규칙 | 9 |
| 8 위험 등록부 | 10 |
| 9 완료 정의 | 11 |
| 10 Gotchas | 12 |
| 11 검증 명령 | 13 |
| 12 Best-practice check | 14 |
| 13 참고 문서 | 16 |
| 14 Codex 검토 요청 | 17 |

## 1. 목적, 세 기둥, 측정 가능한 목표

### 1.1 Hansoo의 요구 (회의 원문 취지)

2026-10-19 회의(Hansoo, Andrew):
- 자동화할 수 있는 것은 모두 자동화한다.
- 사람들이 실제로 쉽게 쓸 수 있게("잘 쓸 수 있게끔") 리팩터링한다.
- 설정을 없앤다: 사람들이 무언가를 설정해야 하면 쓰지 않는다.
- 안정성이 필요하다: 서비스가 "자꾸 죽는다".
- 그렇게 복잡하지 않으니 같은 기능을 처음부터 다시 만드는 것이 오히려 빠를 수도 있다.
- 2026-10-30 복귀 때 "새 Meeting Note"를 보고 싶다, 6개월 사이 기술이 많이 발전했다.

2026-10-15 회의:
- AX-KH 연동 설계(outbox, 이벤트 스키마, 승인, 추출)가 너무 복잡하다.
- 녹음 후 AX-KH로 바로 올리는 더 단순한 흐름을 원한다.

개정 1은 이 중 안정성과 코드 구조만 다뤘고, 설정 제거, 사용 편의, 자동화, 다시 만들기 검토, "새 Meeting Note"의 의미가 빠져 있었다.

### 1.2 세 기둥

| 기둥 | 목표 | 범위 |
| --- | --- | --- |
| 1. 안정성 | 서비스가 죽지 않고, 죽어도 사용자 작업을 잃지 않는다 | 4절: 원인 분석, S 항목, P1.1 선택지, 기존 구조 계획(T1, T2)과 Codex 수정 |
| 2. 단순화 | 설정과 확인 단계 없이 녹음하면 결과가 나온다 | 5절: 웹과 모바일의 모든 설정, 토글, 모달 단계, 수동 입력 목록과 처리안 |
| 3. 자동화 | 사람이 손으로 하는 운영과 사용자 작업을 줄인다 | 6절: 수동 작업 목록, 자동화 방법, 안전장치 |

### 1.3 측정 가능한 목표

기준선이 "측정 필요"인 항목은 DEC-0015(먼저 측정)에 따라 읽기 전용 조회로 기준선을 먼저 잡는다.

| ID | 기둥 | 지표 | 현재 | 목표 | 측정 방법 |
| --- | --- | --- | --- | --- | --- |
| M1 | 1 | 배포별 작업 중단, 재개, 수렴 | 측정 필요 | 잃은 작업 0건(항상, Q10), 배포로 중단된 작업은 모두 재개 또는 같은 note로 수렴, 4주 연속 확인 | 배포마다 배포 시각 전후 창의 `workflow_job` 읽기 전용 집계: 중단된 job 수, 그중 재개 또는 사용자 재시도로 completed가 된 수, failed로 남은 수, 수렴까지 걸린 시간; sweep 로그의 "Marked N orphaned" N은 보조 자료일 뿐이다(이미 completed로 수렴한 중단, SIGTERM으로 기록된 중단, DB 오류로 sweep하지 못한 경우가 빠진다) |
| M2 | 1 | 월간 서버 정지(무료 시간 상한) | 09-01 이후 미검증 | 11월 청구 주기 0회 | Render Usage 탭, 워크스페이스 전체 사용량(S2, Andrew가 확인) |
| M3 | 1 | 오류 분류별 작업 실패율 | 측정 필요(오류 분류 없음) | 인프라 실패율이 기준선의 절반 이하 | 먼저 오류 분류(무음, 사용자 취소, 입력 오류, 외부 API 실패, 인프라 중단 등)와 집계 단위(job, note, 사용자 시도)를 정하고 실패 기록에서 기계적으로 구분되게 한 뒤, `workflow_job` 읽기 전용 집계(최근 30일)로 기준선을 잡는다 |
| M4 | 1 | 테스트가 .env나 실제 서비스에 닿는 경로 | MCP 경로만 부분 수정(7f66401), index.ts 경로는 남음(4.6 T1-0a) | 0, CI canary 테스트로 강제 | T1-0a canary 테스트 |
| M5 | 1 | 구조 지표 | index.ts 3,996줄, 최상위 함수 104개(cab4b3e) | 400줄 이하, 순환 import 0, 공유 상태 단일 소유 | 줄 수, 순환 검사, 리뷰 체크리스트 |
| M6 | 1 | 백엔드 배포 사전 점검 수행률 | 절차 없음 | 100% | 4.5 체크리스트 기록 |
| M7 | 2 | 녹음 종료 후 요약 시작까지 필수 조작 | 웹 2회(녹음 사용, 요약), 모바일 1회(요약 생성) | 0~1회 | 화면 흐름 E2E |
| M8 | 2 | 요약 전 기본 화면에 보이는 선택 항목 | 웹 3개(지시, 프롬프트, 이미지), 모바일 4개(제목, 지시, 프롬프트, 첨부) | 0개 노출, 나머지는 접힌 "옵션" | 화면 점검 |
| M9 | 2 | 일반 사용자에게 보이는 설정 탭 | 웹 5개, 모바일 설정 행 약 8개 | 웹 3개 이하, 고급은 접힘 | 화면 점검 |
| M10 | 2 | AX-KH 보내기 클릭 수 | 2회(버튼, "연동하고 전송 켜기") | 1회, 자동 전송 0 | E2E |
| M11 | 2 | 화자 이름 제안을 보기까지 조작 | 1회(Suggest 클릭) | 0회(자동 표시), 적용은 사람이 확인 | E2E, `speaker_suggestion_feedback` |
| M12 | 3 | 사람이 손으로 하는 작업 수 | 6절 목록 20건(사용자 4, 운영 16; 개정 3에서 A15를 둘로 나누고 A17~A19 추가) | 자동 또는 반자동으로 절반 이상 | 6절 표 상태 갱신 |
| M13 | 3 | 자율 운영 변경에 의한 무인 prod DB 쓰기 | 0 | 0 유지 | 규칙(9절), 리뷰; 범위는 사람 승인 없이 도는 운영 자동화(수정, 정리, backfill, 마이그레이션)이며 정상 앱 실행의 쓰기(사용자가 시작한 요약과 화자 적용, 기존 memory fold, F9 티켓 등)는 포함하지 않는다 |

### 1.4 기준안과 결정권

- 기준안: 백엔드는 단계적 교체(strangler), 사용자가 보는 화면은 그 위에서 단순화한 "새 기본 흐름"으로 바꾼다(7절).
- 이 기준안은 DEC-0021(docs/decisions/0021-refactor-incremental-strangler.md)로 기록했다.
- 2026-10-21 Andrew가 이 기준안을 승인했다("고치면서 새 모습으로"): DEC-0021 승인.
- Meeting Note의 제품과 범위 결정은 Andrew가 한다.
  Andrew가 요청하지 않는 한 결정을 Hansoo에게 넘기지 않는다.
- 나중에 같은 기능의 전면 재작성으로 바꾸려면 DEC-0021을 대체하는 결정을 기록하고 이 계획의 4.6, 4.7을 다시 짠다.
- AGENTS.md 규칙대로 우리 쪽을 막지 않는 외부 질문은 권장 기본값으로 진행하고, 뒤집히면 대체 결정을 기록한다.

## 2. 현재 상태 (2026-10-21 검증)

### 2.1 기준 SHA 구분

- 문서 기준: main d607a07 (개정 2 작성 시작 시 origin/main).
- 코드 줄 번호 기준: d607a07이다.
  d780d73..d607a07은 문서만 바꿨으므로 개정 1의 d780d73 줄 번호와 같다.
- 라이브 백엔드 /version: 358bcaa, deployedAt 2026-10-20T18:58Z (2026-10-21 22:40Z 관측).
  358bcaa 이후 커밋 6개는 workflow-server를 건드리지 않았다.
- 라이브 프런트 /version.json: d607a07.
- /health: msTenantGate=enforced, msClientGate=log-only.
- 이 개정 작성 중 DEC-0005 lite-only 수정이 별도 커밋 17a0140으로 main에 들어갔다(origin/main과 같음).
  17a0140은 index.ts의 몇 줄을 제자리에서 바꾸고 줄 수는 3966행 뒤에서만 1줄 늘렸다(3,996줄), 그래서 이 문서의 줄 번호는 3966행까지 17a0140에서도 같고 그 뒤는 +1이다.
  각 단계 시작 시 다시 확인한다.
- 작업 트리 주의(작성자 PC, 2026-10-21 시점): C1 iOS 스캐폴드가 미커밋으로 있다(9절 C1 파일 목록).
  새 clone에는 없다.
- 개정 3 재확인(2026-10-21, main cab4b3e):
  - 7f66401과 cab4b3e는 index.ts를 바꾸지 않았으므로 index.ts 줄 번호는 17a0140과 cab4b3e에서 같다.
  - 개정 3에서 새로 적은 줄 번호는 cab4b3e 기준이다.
  - 라이브 백엔드 /version: 70d5c53, deployedAt 2026-10-21T22:58Z(17a0140과 7f66401 포함).
  - 라이브 프런트 /version.json: cab4b3e.
  - 문서만 바꾼 cab4b3e에서 백엔드가 재배포되지 않은 것은 build filter 또는 root directory 설정이 있다는 추가 근거다(S2에서 확인).

### 2.2 수치

기준: main cab4b3e의 추적 파일(git tree, 새 clone과 같음, 작성자 PC의 C1 미커밋 변경 제외).
테스트 제외: `*.test.ts`, `*.test.tsx`, 모바일 `test/` 디렉터리; `workflow-server/src/test-setup.ts`(28줄)는 백엔드 합계에 포함했다.

- `workflow-server/src/index.ts`: 3,996줄, 최상위 함수 104개.
- 크기 추이: 3,593(1e590d5) -> 3,824(20d7025) -> 4,012(e7d3c55) -> 3,995(d607a07) -> 3,996(17a0140, cab4b3e).
- 백엔드 `workflow-server/src` TS: 약 14,862줄(test-setup.ts를 빼면 14,834), 그중 mcp 약 4,721줄, knowledge 약 2,058줄.
- 웹 `src` TS/TSX: 84개 파일, 약 26,892줄.
- 모바일 `meeting-note-mobile/app/lib` Dart: 42개 파일, 약 21,278줄(새 clone 기준).
- migration: 56개, 약 5,096줄; edge function: 7개, 테스트 제외 TS 약 3,405줄.
- 테스트(과거 기록): 백엔드 `npm test` 570개, 프런트 `npx vitest run` 11개 파일 99개 통과는 17a0140 이전의 과거 실행 기록이며 최신 통과 수로 쓰지 않는다.
- 테스트(개정 3 재실행, 2026-10-21, cab4b3e 작업 트리): 백엔드 580개 통과, 프런트 11개 파일 99개 통과.
- CI(.github/workflows/ci.yml): backend build+test, frontend build+vitest, lint(`--max-warnings 0`) 세 job 모두 차단형이다.
- 그 밖의 workflow: decisions-advisory.yml(권고), product-docs-check.yml, tag-mobile-release.yml.
- 계획된 모듈(`workflow-server/src/routes/`, `http/`, `config/`, `jobs/`, `pipeline/`, `src/lib/notes/`, `src/lib/speakers/`)은 아직 없다(앞으로 만들 경로).

### 2.3 완료 항목

| 항목 | 내용 | 커밋 | 상태 |
| --- | --- | --- | --- |
| 1 | meeting-recordings 버킷 RLS를 owner_id로 범위 지정 | 520f81a, 9c2a112 | 완료, prod 적용 |
| A | 녹음 잘림/무음 누락 수정 | bf57199 | 완료 |
| A | 멱등 note 쓰기, orphan 수렴, transcript checkpoint | 20d7025 | 완료, migration 적용 |
| A | 웹 재시도 시 noteId 재사용 | 4b65e62 | 완료 |
| B | Codex-only #2/#3/#4 (프로젝트 채팅, 메모리 fold, insight 소유) | 52c97b9 | 완료, 2-user E2E는 보류(두 번째 계정 없음) |
| B | #10 edge Graph fallback 조직 allowlist | 8d9789c | 완료, 배포 |
| 형제 취약점 | admin-*, mcp-token, note-audio-url Graph 경로 | 86175a9 | 완료, 배포 |
| C | 모바일 중단 m4a 삭제 방지 | a6095a5 | 완료, 실기기 E2E 통과(2026-10-12) |
| C | Vitest + 차단형 CI | a666950 | 완료 (= T2-0) |
| C | lint 0 problems + 차단형 lint gate | 5991d03 | 완료 |
| C | Gemini 공통 helper | e582bfa | 완료 |
| C | mcp_tracking migration 정리 | 40a959c | 완료, 적용 |
| R01 | note-audio-url 소유권 게이트 | 52c292c, cbd9e22 | 완료, 레거시 미재생 319 -> 0 |
| 후속 | 노트가 참조하는 최근 녹음 삭제 차단 | 4436643 | 완료, prod E2E 통과 |
| 후속 | 인증 provider clear 시 anon 요청 방지 | 3f9b5bd | 완료 (R09 일부) |
| 후속 | 로그인 신뢰를 tid+oid로 한정 | af6635d | 완료 (DEC-0001) |
| UX | 참석 인원 수동 입력 제거 | 260e729 | 완료(8cf6519를 되돌림) |
| UX | AX-KH 모달의 참석자 확인을 선택 사항으로 접음 | 43152df | 완료 |
| UX | Teams 전달, OneDrive 내보내기 제거 | (2026-08-21 팀 결정) | 완료, 남은 문자열은 5절 U24 |
| T2-1 / A17 첫 부분 | note RLS PGlite 도구와 Project 소유자 쓰기 검사 | 이 PR | 0행 성공 처리 재현 후 수정, 로컬 검증 완료, Andrew 소유 노트 수동 확인과 2계정 E2E 대기 |

### 2.4 10/09 이후 새로 생긴 코드

- `workflow-server/src/microsoftIdentity.ts` (af6635d): 신원 확인의 단일 구현.
- `workflow-server/src/issues.ts` (e7d3c55): 이슈 순수 로직, 라우트는 아직 index.ts.
- `workflow-server/src/knowledge/enable-all.ts` (e597609): knowledge/http.ts 소유.
- `workflow-server/src/productDocs.ts` (25a7272): 라우트 2개는 index.ts:706-744.
- `docs/decisions/`: DEC-0001..0021.
- `NoSpeechDetectedError` (1a3696b): index.ts:144.

## 3. 범위와 먼저 확인할 질문

구현 세션의 첫 단계는 아래 질문으로 범위를 확정하는 것이다(requirements-clarification 규칙).
답이 나온 질문은 표에 답을 적어 두고, 남은 질문은 표 아래에 모았다.

이미 답이 나온 것 (2026-10-21 사용자):
- 두 번째 테스트 계정은 없다.
  T2-1 재현은 fake supabase 단위 테스트와 기존 PGlite SQL harness(RLS), Andrew 본인 수동 확인으로 한다.
  Group B 2-user E2E는 계속 보류한다.
- .env 내용과 상관없이 테스트는 .env를 읽거나 실제 서비스에 닿지 않는다(T1-0a의 필수 선행 조건).
- Render 배포 게이트 질문에 (c) PR + CI 후 main merge 선택지를 추가한다(질문 Q5).

Andrew 결정 (2026-10-21, 결정권자는 Andrew):
- Q2 방향: 단계적 교체(strangler) + 화면 재설계, "고치면서 새 모습으로"(백엔드는 단계적으로 바꾸고 화면과 흐름은 새로 설계). DEC-0021 승인.
- Q1 기둥 우선순위: 둘 다 같이. 안정성 첫 배치(테스트 격리, parity, 배포 사전 점검)를 끝내고 단순화를 병행한다.
- Q12 / Q3 (d): Render 백엔드는 무료 플랜을 유지한다(유료 전환 없음). 유료 전환에 기대던 항목은 4절에서 코드 대응으로 바꿨다.
- Q8: 한 번 클릭 전송(DEC-0018 유지, 자동 전송 없음).
- UX: U1/U2, U9(화자 편집 가능 조건 포함), U15, 설정 화면 통합은 승인, U10은 검증 조건부(5절 표).

Andrew 추가 결정 (2026-10-21, 2차 검토 후, 결정권자는 Andrew):
- 화자 지정과 노트 공유는 분리한다.
  - 화자 이름 지정(수동 지정이든 제안 수락이든)만으로는 노트를 공유하지 않는다.
  - 지정 직후 한 번 클릭으로 확인하는 "이 사람과 노트 공유" 버튼을 보여 준다.
  - 수동 지정과 제안 수락, 웹과 모바일에서 같은 동작이다.
  - 현재 동작(웹 수동 지정과 Microsoft 연락처 지정, 모바일 화자 변경이 공유까지 수행; 웹 제안 수락은 공유하지 않음)을 바꾸는 동작 변경이므로 U9 앞의 별도 단계 U9-0으로 테스트와 함께 한다(5절).
  - 이 공유 부수 효과를 다루는 기존 DEC는 없다(2026-10-21 docs/decisions 확인); 구현할 때 새 DEC를 기록하고, U9의 DEC-0010 대체 결정과 함께 다룰 경우 서로를 참조한다.
- Render: Andrew는 Render 설정을 바꿀 수 있지만 플랜은 바꿀 수 없다(플랜은 무료 유지).
  - 그래서 S2(플랜과 시간 사용량 확인)와 build filter, 자동 배포 설정 변경은 Andrew가 할 수 있다.
  - 유료 전환은 불가능하며 다시 제안하지 않는다.
- Q5 배포 게이트: 작업 브랜치 + PR + CI 통과 후 main merge(선택지 (c)).
  - 앞으로 코드 변경은 main에 직접 push하지 않는다.
  - 문서만 바꾸는 변경은 Andrew가 요청하면 계속 직접 push할 수 있다.
  - GitHub branch protection을 켜면 이 규칙이 강제된다; 켤지는 Andrew가 나중에 정한다.
- Q10 허용 중단 시간: 엄격하지 않다(내부 도구라 수 시간 중단도 허용).
  - 단 진행 중인 녹음과 작업은 절대 잃지 않는다(M1, S10~S12의 기준).
  - 롤백 담당은 Andrew다.

| 질문 | 선택지 | 권장 | 결정자 | 결정 시점 |
| --- | --- | --- | --- | --- |
| Q1 기둥 우선순위 | (a) 안정성 -> 단순화 -> 자동화 순차 (b) 안정성 첫 배치(T1-0a, T2-1, S1) 직후 단순화를 병행 (c) 단순화 먼저 | (b): 10/30에 보여 줄 변화는 단순화에서 나오고, 단순화는 대부분 프런트라 T1 추출과 겹치지 않는다 | Andrew | 답 (2026-10-21): 둘 다 같이, 첫 안정성 배치를 끝낸 뒤 단순화 병행 |
| Q2 다시 만들기 대 단계적 교체 | (a) 단계적 교체 + 화면 재설계(기준안) (b) 같은 기능 전면 재작성 (c) 웹만 새로 만들고 백엔드는 단계적 교체 | (a), 근거 7절 | Andrew | 답 (2026-10-21): (a) "고치면서 새 모습으로", DEC-0021 승인 |
| Q3 작업 실행 모델(P1.1) | (a) 현행 + S 항목 (b) 재시작에도 이어지는 작업(전사 id 저장, 부팅 시 재개, webhook 선택) (c) 원래 P1.1(Edge Function 이전) (d) 백엔드 유료 플랜만 | 무료 유지로 (d)는 제외: (a)에 S4, S9~S12(무료 플랜 대응)를 넣고, (b)는 T1-9b 후 별도 결정(무료 플랜에서는 가치가 커졌으므로 앞당겨 검토), (c)는 제외, 근거 4.3 | Andrew | (a)+S9~S13은 지금(S10, S12의 설계와 테스트 작성은 첫 배치부터), (b)는 T1-9b 후 |
| Q4 재시작 후 자동 재개가 필수인가 | (a) 실패 표시 + 사용자 재시도 허용(현행; 저장된 transcript checkpoint 또는 전사 id를 재사용하는 구간에서만 재과금 없음) (b) 자동 재개 필수 | 무료 플랜은 재시작과 정지가 더 잦을 수 있으므로 S10(안전한 재시도 또는 자동 재개)을 기둥 1에 넣는다; 완전한 자동 재개는 Q3 (b)와 함께; Q10 결정(작업을 잃지 않음)으로 S10은 필수이고 남은 질문은 자동 재개 범위와 시점이다 | Andrew | Q3과 함께, S10 설계 검토는 첫 배치부터 |
| Q5 백엔드 배포 게이트 | (a) Render "CI 통과 후 배포" 설정 (b) 그대로 두고 push 전 로컬 전체 검증 (c) 작업 브랜치 -> PR -> CI 통과 -> 사람이 main merge(브랜치 보호) | (c) + 가능하면 (a), (b)는 CI 게이트와 동등하게 취급하지 않는다 | Andrew((a)의 Render 설정도 Andrew가 바꿀 수 있음, 2026-10-21) | 답 (2026-10-21): (c), 코드 변경은 main 직접 push 금지, 문서 전용은 Andrew 요청 시 직접 가능; branch protection 적용 여부와 (a) 보조 설정은 Andrew가 나중에 결정 |
| Q6 모바일 범위 | (a) 구조 리팩터링(T5) 제외, 단순화(5절 모바일 항목)는 포함 (b) 모바일 전부 제외 (c) T5까지 포함 | (a), C1 파일은 건드리지 않는다 | Andrew | 단순화 착수 전 |
| Q7 모바일 UI 변경 권한 | (a) 2026-07-28의 "UI 생성/삭제/재배치는 디자이너 소유" 제약이 아직 유효 (b) 해제됨 | 확인 필요 | Andrew(필요하면 Hansoo) | 모바일 단순화 전 |
| Q8 AX-KH 단순화 범위 | (a) 한 번 클릭 전송(동의는 그 클릭), 자동 전송 없음(DEC-0018 유지) (b) 사용자 설정으로 "항상 보내기"(DEC-0018 대체 필요) | (a) | Andrew | 답 (2026-10-21): (a) 한 번 클릭 전송, 자동 전송 없음 |
| Q9 열린 후보(R08, R09, R10, R12) | (a) 관련 코드를 옮긴 직후 별도 동작 변경 커밋, 항목별 수용 기준 (b) 리팩터링 후 따로 | (a) | Andrew | 해당 단계 전 |
| Q10 운영 검증과 롤백 담당, 허용 중단 시간 | 담당자 이름, 관찰 시간, 허용 중단 시간 | Andrew 담당, 관찰 30분 + 실제 작업 1건 | Andrew | 답 (2026-10-21): 롤백 담당 Andrew, 허용 중단은 엄격하지 않음(수 시간 허용), 진행 중 녹음과 작업은 절대 잃지 않음; 관찰 시간은 권장값(30분 + 실제 작업 1건)으로 진행 |
| Q11 새 도구 의존성 | 순환 import 검사(madge 등), 커버리지 도구 | 순환 검사는 승인 후 추가, 커버리지는 선택 | Andrew | T1-0a 전 |
| Q12 백엔드 유료 전환(월 약 7달러) | (a) 전환 (b) 무료 유지 | (원래 권장 (a), Andrew가 (b) 선택) | Andrew | 답 (2026-10-21): (b) 무료 유지, 유료 업그레이드 없음; Andrew는 플랜을 바꿀 수 없으므로 다시 묻지 않음 |

남은 열린 질문 (개정 3 기준, 모두 첫 배치를 막지 않음):
- Q3 (b) 완전한 자동 재개의 범위와 시점: T1-9b 후 결정(S10 설계 검토는 첫 배치부터).
- Q6, Q7: 모바일 단순화 전.
- Q9: 해당 후보 수정 전.
- Q11: 순환 검사와 PGlite 고정 버전 설치(A17) 같은 새 도구 의존성, T1-0a 전.
- GitHub branch protection 적용 여부와 Render "CI 통과 후 배포" 보조 설정: Andrew가 나중에 결정(Q5).
- U1/U2 진입 경로 표에서 자동 요약을 시작하지 않는 두 경로(중단 녹음 복구본, 녹음 중 페이지 이동): 개정 3의 권장안, U1 구현 전 Andrew 확인.
- S9의 허용 지연 값(서버가 잠든 동안 knowledge 처리가 멈추는 시간): S2 사용량 확인 뒤 정한다.

## 4. 기둥 1: 안정성

### 4.1 "자꾸 죽는" 원인 분석

근거: RUNBOOK.md 1절, 6절, 7절, OPS_BACKLOG.md P0, P1.1, P1.3, docs/reviews/2026-09-29-ops-stability-review.md, DEC-0003, index.ts, 라이브 /version.

| # | 원인 | 근거 | 현재 상태 | 영향 |
| --- | --- | --- | --- | --- |
| D1 | 배포가 백엔드를 재시작해 진행 중 작업을 끊는다 | DEC-0003, index.ts에 SIGTERM 처리 없음(`SIGTERM` grep 0건), orphan 기준 5분(index.ts:1870), 10월 커밋 70개 중 26개가 workflow-server를 건드림 | sweep이 실패 처리하거나 note가 있으면 완료로 수렴(20d7025); 사용자는 재시도해야 한다 | 높음 |
| D2 | 무료 플랜 시간 상한(워크스페이스 공유 월 750시간)으로 월말 정지 | RUNBOOK.md:104-107, :127, OPS_BACKLOG.md:40 | 09-01 MCP 통합으로 상시 서비스 1개, 31일 달 744시간으로 여유 약 6시간; 한 달 넘게 유지되는지 미검증; 같은 워크스페이스의 다른 무료 서비스 사용량 미확인 | 높음(발생 시 전체 처리 중단) |
| D3 | 무료 플랜 유휴 정지와 cold start | 2026-08-06 모바일 "Could not reach" (첫 /health 12.2초), 모바일 재시도 패치 | 2026-10-21 관측 시 프로세스가 27시간 넘게 재시작 없이 떠 있음(deployedAt 2026-10-20T18:58Z); 유휴 정지가 지금 일어나지 않는 이유(유입 트래픽 또는 플랜 변경)는 미확인 | 중 |
| D4 | 작업이 프로세스 안에서 길게 돈다 | AssemblyAI 폴링 최대 30분(transcribeWithAssembly, index.ts:1330), 완료 후 memory/speaker 후처리도 heartbeat 유지(processSummarizeJob, index.ts:2476) | 재시작이나 정지에 노출되는 시간이 회의 길이에 비례한다 | 높음 |
| D5 | 외부 API 변화 | gemini-2.0 퇴역으로 edge function 404(2026-08-18), 중첩 responseSchema MAX_TOKENS(DEC-0006) | 모델 registry와 drift 테스트(1e590d5); DEC-0005 lite-only 불일치는 수정 중(8절) | 중 |
| D6 | 관측 공백 | /health는 프로세스 생존만 보고 DB, AssemblyAI, Gemini 성공을 보증하지 않음; terminal write, sweep, memory enrichment 실패는 warn 경로(2026-09-29 리뷰 "장애 관측 공백") | Render 메일은 소유자(Hansoo)에게만, 외부 uptime 감시 없음(P0.1, P0.2 보류) | 중 |
| D7 | 무료 인스턴스 자원 | Android multipart가 서버 임시 디스크를 거침(index.ts:429), 첨부 base64가 job body에 들어감, `completedJobResults`(index.ts:2540)는 완료 GET에서만 지워짐 | OOM은 재현하지 않음(가설) | 낮음~중 |
| D8 | 인증 1시간 절벽, 조용한 anon 진행 | 2026-07 감사 C5~C7 | Phase 1에서 대부분 해결, R09 잔여(8절) | 낮음 |
| D9 | 동시 실행과 입력 크기 상한 부재 | 제출마다 `processSummarizeJob`를 바로 실행하고 서로 다른 job의 전역 동시 실행 한도가 없다(index.ts:2372, :2462의 `void processSummarizeJob`); `readBody`(index.ts:354)는 chunk마다 `Buffer.concat(chunks)`(:359)로 누적 크기를 다시 계산해 본문 크기에 대해 제곱 비용이 든다; 첨부 base64와 결과 캐시가 겹친다 | OOM 발생은 확인하지 못했다(가설, Codex 2차 7) | 낮음~중, U1/U9로 자동 실행이 늘면 커짐 |

가설과 확인 방법:
- D3의 유휴 정지가 진행 중 작업을 죽일 수 있는지는 확인하지 않았다(Render 무료 플랜은 들어오는 요청이 없을 때 정지하며, 작업의 바깥 방향 호출은 요청으로 세지 않는 것으로 이해한다).
  Render 로그에서 "Marked N orphaned" 직전에 정지/기동 기록이 있는지 읽기 전용으로 확인한다.
- 라이브 백엔드가 358bcaa에 머문 것(2.1)은 백엔드 서비스에 root directory나 build filter가 이미 설정돼 workflow-server 변경 때만 재배포된다는 뜻으로 보인다.
  대시보드에서 확인한다(S2).
  확인되면 D1의 실제 재시작 빈도는 "workflow-server를 건드린 push 수"다.

### 4.2 구조와 무관한 안정성 작업 (S 항목)

리팩터링 단계(T1, T2)와 별도로, 대부분 작고 바로 효과가 있다.
동작을 바꾸는 항목은 각각 별도 커밋, E2E 재현 후 수정이다.

| ID | 내용 | 원인 | 크기 | 선행 | 비고 |
| --- | --- | --- | --- | --- | --- |
| S1 | 모든 백엔드 배포 전 사전 점검(4.5): 상태가 `queued` 또는 `processing`인 모든 `workflow_job` 행과 최근 2분 안에 `updated_at`이 바뀐 행(완료 후처리 포함)이 모두 0건일 때만 merge(배포 허용) | D1 | S | 없음 | 문서와 읽기 전용 SQL, 자동화는 6절 A9; 조회 실패는 0건이 아니다(통과 아님); 오래된 활성 행(updated_at이 5분 넘게 지남)은 sweep 한 주기(2분, index.ts:1874)를 기다린 뒤 다시 확인하고, 그래도 남으면 원인을 확인하기 전까지 통과시키지 않는다 |
| S2 | Render 대시보드 확인과 설정: 플랜(무료 유지 확인), root directory/build filter, 자동 배포와 "CI 통과 후 배포" 옵션, 종료 대기 시간, 배포 중 인스턴스 중첩 여부, 워크스페이스 전체 무료 시간 사용량 | D1~D3 | S | 없음 | Andrew가 확인하고 설정을 바꿀 수 있다(플랜 변경은 불가, 2026-10-21); workspace 소유자는 Hansoo; 결과를 RUNBOOK에 기록 |
| S3 | (결정 완료 2026-10-21) 백엔드는 무료 플랜 유지, 유료 전환 없음 | D2, D3 | - | 없음 | Q12 (b); 이 항목에 기대던 대응은 S9~S12로 코드에서 처리; 프런트 서비스는 이미 유료라는 기록(2026-08-06)이 있으나 RUNBOOK은 "static site"로 적고 있어 S2에서 함께 확인 |
| S4 | (S12와 같은 작업) SIGTERM 처리; 내용과 순서는 S12 | D1 | S~M | S12와 같음 | 동작 변경, Render 종료 대기 시간(S2) 안에서만 의미가 있다 |
| S5 | 관측 보강: sweep N>0, terminal write 실패, memory enrichment 실패를 alerts/F9로; 경보 발송 전 공통 중복 억제(같은 서명은 시간창 안에서 1회), 집계 시간창, 메일 수와 RCA 비용 상한, 경보 실패가 다시 경보를 부르지 않는 재귀 방지 | D6 | S | T1-3, T1-9b | 기존 F9 throttle(OPS_INCIDENT_THROTTLE_MS, index.ts:3393)은 F9 티켓만 막는다; `raiseIncident`(index.ts:3583)는 `sendWorkflowAlert`와 `fileOpsIncident`를 각각 부르고 `sendWorkflowAlert`(alerts.ts:130)에는 throttle이 없으므로 새 공통 억제가 필요하다 |
| S6 | `/health`와 별도로 의존 서비스 확인용 읽기 전용 점검(관리자 전용) | D6 | S | T1-11 | 무료 플랜에서는 주기 호출 금지(시간 소모) |
| S7 | `completedJobResults` 상한 또는 TTL | D7 | S | T1-9b | 동작 변경 |
| S8 | 동기 `/summarize-audio` 제거 후보 | D4 | S | T1-9b | 저장소 안 호출자 0곳(웹, 모바일 grep), 외부 호출자(별도 Android 앱 등) 확인 후 |
| S9 | 무료 플랜 예산: 월 무료 시간 안에 머물기. 유휴 keep-alive(주기 ping, 서버를 깨워 두려는 호출)는 금지한다; 실제 작업을 위한 폴링(진행 중 job의 AssemblyAI 폴링, 클라이언트의 진행 중 job 상태 폴링, knowledge worker의 SQL 큐 확인)은 keep-alive가 아니므로 허용한다. 워크스페이스 전체 사용량과 남은 기간 예측, outbound bandwidth와 build minutes 예산, 서비스가 시작하는 외부 트래픽 점검, 임계 근접 알림과 담당(Andrew) | D2, D3 | S | S2 | knowledge delivery와 extraction worker는 프로세스 안에서 5초마다 큐를 확인한다(knowledge/delivery.ts:225, knowledge/extraction-worker.ts:124); 서버가 잠들면 큐는 보존되지만 처리는 멈추므로 "새 사용자 요청 또는 승인된 실제 작업 이벤트로 깨어난 뒤 재개"를 조건으로 두고 허용 지연을 정한다; 내부 타이머나 외부 API 호출이 서버를 깨우는 입력 요청을 대신한다고 가정하지 않는다; 상한 정지 동안에는 제출을 보존하고 복귀 안내를 보이며 자동 복구는 한도 해제 이후로 한정한다; 한 서비스의 744시간 계산은 실제 사용량의 증거가 아니므로 S2에서 워크스페이스 전체로 확인한다; 근거 Render 무료 서비스 제한 문서(https://render.com/docs/free#free-web-services) |
| S10 | 재시작과 정지 뒤 작업 안전 재시도 또는 자동 재개: 부팅 시 미완료 job을 안전하게 이어가거나 사용자 재시도로 수렴. 설계 항목: (1) 원자적 작업 인수: 조건부 갱신(예: status와 lease 만료 또는 실행 세대를 조건으로 한 update ... returning)으로 한 인스턴스만 실행권을 얻는다 (2) 만료되는 소유권(lease)과 실행 세대(generation): 실행권을 잃은 인스턴스는 job 상태, note, 후처리를 더 쓰지 못한다(모든 쓰기에 세대 조건) (3) AssemblyAI 제출 성공 직후 전사 id를 job 행에 저장해 재개 시 재제출 대신 조회한다 (4) 제출 성공과 전사 id 저장 사이에 죽는 구간은 별도 탐지와 정책(재제출 허용 여부, 비용 기록)을 둔다 | D1, D3, D4 | M | 설계와 테스트 작성: 없음(첫 배치부터), 구현: T1-9b | 부분 unique index(`workflow_job_active_note_uniq`)는 같은 note의 활성 행 두 개를 막을 뿐, 겹쳐 실행되는 구 인스턴스와 새 인스턴스가 같은 job 행을 실행하는 것은 막지 못한다(현재 상태 갱신은 job id 조건뿐, index.ts:1886); 부팅 시 모든 미완료 job을 재개하면 heartbeat와 orphan sweep의 의미가 바뀌므로 함께 설계한다; 재과금 없음은 저장된 checkpoint 또는 전사 id를 재사용하는 구간에서만 성립한다(checkpoint는 전사 완료 뒤에만 남음); 두 인스턴스 중첩과 DB 지연 시나리오를 테스트한다; DB 스키마 추가는 사람이 적용 |
| S11 | 클라이언트 제출과 재시도 계약(웹, 모바일 공통): (1) 최초 POST 전에 사용자와 원본에 묶인 noteId/fileId와 제출 상태를 영속 저장한다(웹은 지금 메모리 슬롯, 모바일은 jobId 응답 뒤에 기록) (2) 재실행이나 재시도 시 기존 job 또는 note를 먼저 조회한다 (3) 통신 실패(응답 없음, 타임아웃)와 서버의 확정 실패를 구분하고, 확정 종료 전에는 복구 정보를 버리지 않는다 (4) 재시도 횟수, 전체 deadline, jitter, 취소, 인증 실패와 4xx는 재시도하지 않음, 429는 대기 후 재시도, background 복귀, 같은 job의 동시 poll 금지 (5) 오래된 서명 URL은 원본 소유권을 다시 확인해 갱신하고 로컬 녹음과 첨부를 보존한다 (6) 월 상한 정지는 짧은 cold start와 구분해 무한 재시도하지 않는다; 깨우는 중 표시 | D3 | M | 없음 | 웹 제출 슬롯 TranscriptionSummary.tsx:364, :418, jobId 저장 :1257 이후; 모바일 notes_repository.dart:294, :323, :388, processing_screen.dart:241; 웹은 통신 오류로 폴링을 포기하면 활성 기록을 지우고 모바일은 오래된 활성 기록을 24시간 뒤 정리한다; 모바일은 Q6, Q7와 C1 파일 불가침을 지킨다; U1/U2의 선행 조건 |
| S12 | 종료 신호(SIGTERM) 정상 처리, 순서: (1) 새 작업 접수 차단과 readiness 전환 (2) orphan sweep 타이머와 knowledge delivery, extraction worker 스케줄 중지(lease 만료 포함) (3) heartbeat와 외부 호출 중지 또는 제한된 대기 (4) 실행권(S10)을 확인한 뒤에만 비종료 상태(재개 대기)로 갱신 (5) 종료 대기 시간 안에 종료 | D1, D3 | S~M | 설계와 테스트 작성: 없음(첫 배치부터), 구현: T1-9b, S10 | 이미 `completed`인 job은 완료 상태를 유지한다: 완료 뒤에도 finalizeNoteMemory 등 후처리와 heartbeat가 돌기 때문에(index.ts:2480, :2535) 메모리에 남은 실행을 일괄로 실패 처리하면 성공한 job을 실패로 돌린다; 후처리 미완료는 별도로 기록한다; 진행 중 실행을 멈추기 전에 failed로 바꾸면 사용자 재시도와 기존 실행이 겹칠 수 있으므로 실패로 바꾸지 않는다; SIGTERM과 SIGKILL을 각각 시험하고 최종 안전망은 S10의 영속 상태와 인수 규칙이다; 배포 중 인스턴스 중첩과 종료 신호 순서는 Render 배포 문서(https://render.com/docs/deploys#graceful-shutdown)를 기준으로 S2에서 실제 설정을 확인한다; S4와 같은 작업 |
| S13 | 과부하 방지: 요약과 자동 화자 제안의 전역 및 사용자별 동시 실행 상한, 대기열 길이 상한, 최대 입력 크기, 취소된 실행 정리, 과부하 응답(거부 또는 지연 시 원본 보존); `readBody`는 chunk 크기를 누적하는 바이트 카운터로 바꿔 매 chunk의 `Buffer.concat`(index.ts:359)을 없앤다 | D7, D9 | S~M | readBody: T1-0c 이동 뒤 별도 커밋; 동시 실행 상한: T1-9b; U1, U9 확대 전 | 상한 값은 격리 부하 측정으로 정한다; readBody의 오류 문구("Request body is too large.", "Request body must be valid JSON.")는 getHttpStatus 판정에 쓰이므로 바꾸지 않는다; 동작 변경이므로 별도 커밋 |

### 4.3 P1.1(작업 실행 모델) 후보와 선택지

OPS_BACKLOG P1.1(AssemblyAI webhook -> Supabase Edge Function)은 2026-08-14부터 보류다.
P1.1의 핵심 장점이던 "상시 백엔드 제거"는 2026-09-01 MCP 통합(DEC-0016) 이후 성립하지 않는다.
MCP 연결(Claude, ChatGPT), knowledge 전송/추출 worker, 이슈, 제품 문서, 프로젝트 채팅이 모두 같은 서버에 있기 때문이다.
그래서 P1.1을 "작업이 재시작을 견디게 하는 방법"으로 다시 정의하고 선택지를 비교한다.

| 선택지 | 바뀌는 것 | 없애는 원인 | 남는 원인 | 크기 | 위험 |
| --- | --- | --- | --- | --- | --- |
| (a) 현행 + S1~S8 | 배포 절차, 경보, 작은 수정 | D6 일부, D1 노출 감소 | D1(전사 중 재시작), D2, D3 | S | 낮음 |
| (b) 재시작에도 이어지는 작업 | AssemblyAI 전사 id와 단계를 job 행에 저장, 부팅 시 미완료 작업을 실패 대신 재개(전사 완료면 요약부터), 완료 알림은 webhook(선택) 또는 재개 시 한 번 조회 | D1, D4 | D2, D3 | M~L | 중: DB 스키마 추가(사람이 적용), 중복 실행 방지(부분 unique index만으로는 같은 job 행의 중첩 실행을 막지 못하므로 S10의 원자적 인수, lease, 실행 세대가 필요), webhook이면 공개 endpoint 인증 |
| (c) 원래 P1.1 | 요약 파이프라인을 Edge Function(Deno)으로 이전 | D4 일부 | 상시 서버는 MCP 등 때문에 그대로, 파이프라인 코드 이중화 | L | 높음: 실행 시간 상한, 첨부와 후처리 연쇄 호출, 두 런타임 유지 |
| (d) 백엔드 유료 플랜 | 비용 월 약 7달러 | D2, D3 | D1, D4 | S(설정) | 낮음; 2026-10-21 Andrew가 무료 유지를 결정해 제외 |

결정(2026-10-21): 백엔드는 무료 플랜을 유지하므로 (d)는 제외한다.
권장: 지금 (a)와 S9~S13(무료 플랜 영향과 과부하를 코드에서 처리), T1-9b 이후 (b)를 별도 결정(DEC)으로, (c)는 범위에서 뺀다.
S10, S12의 상태 전이와 실패 구간 설계, 테스트 작성은 첫 배치부터 시작하고 실제 추출 순서(T1-9b)와 분리한다(Codex 2차 18).
무료 플랜에서는 D2(월 시간 상한)와 D3(유휴 정지, 재시작)이 계속 남으므로 (b)의 가치가 커졌고, 4.8 첫 배치 뒤 우선순위를 올려 검토한다.
확인할 것: AssemblyAI webhook 재시도와 인증 방식, Render 종료 대기 시간과 배포 중 인스턴스 중첩, (b)의 스키마 변경 범위(전사 id, lease, 실행 세대).

### 4.4 목표 구조

기존 패턴을 따른다: 백엔드는 `handle<Group>Request(req, res, url) => Promise<boolean>` 한 줄 dispatch(knowledge, mcp가 사용 중), 웹은 `src/lib/<domain>/`(src/lib/issues/가 선례).
아래에서 "(신규)"는 앞으로 만들 경로, "(기존)"은 지금 있는 경로다.

```
workflow-server/src/
  index.ts                    (기존) 진입점: loadEnv 후 startServer()만 (start = node build/index.js)
  server.ts                   (신규) createServer, startServer(): dispatcher, process 핸들러, listen, 타이머, worker 등록
  config/loadEnv.ts           (신규) dotenv 로드, 테스트에서는 꺼짐
  config/env.ts               (신규) env 객체와 상수(transcription 라벨, TRANSLATION_ENABLED)
  db/supabaseClient.ts        (신규) service-role client 1개
  http/shared.ts              (신규) HttpError, sendJson, sendNoContent, readBody, corsHeaders, getHttpStatus, errorMessage, getBearerToken, requiredString
  http/identity.ts            (신규) getMicrosoftUserId, getMicrosoftProfile (microsoftIdentity.ts 위임)
  http/router.ts              (신규) dispatch 순서와 404, VERSION_INFO
  ai/geminiFallback.ts        (신규) callGeminiWithFallback, delay, GeminiWorkflowCallResult
  pipeline/usage.ts           (신규) recordGeminiUsage, recordAssemblyUsage
  pipeline/memoryContext.ts   (신규) getPersonalMemoryContext
  pipeline/speakerContext.ts  (신규) buildSpeakerContextFromSegments
  pipeline/types.ts           (신규) SummarizeAudioInput, SummarizeAudioResult, 요청 타입
  pipeline/errors.ts          (신규) NoSpeechDetectedError, noSpeechMessage
  pipeline/inputs.ts          (신규) parseSummarizeInput, parseSummaryAttachments, 첨부 MIME 목록
  pipeline/promptLoaders.ts   (신규) DEFAULT_SUMMARY_PROMPT, loadSummaryPrompt, resolveSummaryPromptForAndroid, resolveRegenerateSummaryRules
  pipeline/androidUpload.ts, pipeline/transcription.ts, pipeline/summarize.ts  (신규)
  jobs/store.ts               (신규) WorkflowJobRow, updateWorkflowJob, heartbeat 상수, transcript checkpoint
  jobs/runner.ts              (신규) processSummarizeJob, completedJobResults
  jobs/orphanSweep.ts         (신규) failOrphanedJobs, reconstructResultFromNote
  ops/incidents.ts            (신규) fileOpsIncident, raiseIncident (순수 helper는 기존 opsAgent.ts)
  issueLinks.ts               (신규) issueDeepLink, warnedRelativeDeepLink (routes/issues.ts와 ops/incidents.ts가 함께 import, ops가 routes를 import하지 않게 함)
  routes/transcriptionTest.ts, issues.ts, productDocs.ts, briefing.ts, insight.ts, projectChat.ts, regenerateSummary.ts, jobs.ts  (신규)
  (기존 유지) knowledge/, mcp/, issues.ts, microsoftIdentity.ts, memory.ts, parsers.ts, prompts.ts, gemini.ts, gemini-models.ts, alerts.ts, opsAgent.ts
src/lib/notes/repository.ts     (신규)
src/lib/speakers/repository.ts  (신규)
```

- 의존 방향: routes -> jobs/runner -> pipeline -> jobs/store, ai, db, http, config.
  `jobs/store.ts`는 pipeline을 import하지 않는다(Codex 1).
- 추출한 모듈은 index.ts를 역으로 import하지 않는다.
  중간 단계에서 아직 index.ts에 남은 함수가 필요하면 그 함수를 인자로 주입한다.
- 모듈 수준 상태(`completedJobResults`, `createdIssueMailSent`, `productDocsIdentityCache`, `warnedRelativeDeepLink`)는 정확히 한 모듈에만 둔다(`warnedRelativeDeepLink`는 issueLinks.ts).
- routes/ 모듈은 서로를 import하지 않고, ops/와 jobs/는 routes/를 import하지 않는다.
- import 시 부작용(dotenv, undici global dispatcher, process 핸들러, listen, setInterval, knowledge worker)은 `startServer()`만 소유한다(Codex 9).
- `src/data/`(10/09 계획)는 쓰지 않는다.

### 4.5 단계 공통 템플릿

공통 규칙: 단계 1개 = 커밋 1개(또는 짧은 PR 1개), 동작 보존, 장기 브랜치 금지, 단계마다 main에 배포 가능.
전달 경로(Q5 결정, 2026-10-21): 작업 브랜치 -> PR -> CI 3 job 통과 -> 배포 사전 점검 -> 사람(Andrew)이 merge(= 배포 허용, Render 자동 배포 시작) -> 배포 후 점검.
- 사전 점검은 merge 전에 한다: main merge가 Render 자동 배포를 시작하므로 merge 뒤의 점검은 늦다(9절 규칙과 같은 순서).
- 코드 변경은 main에 직접 push하지 않는다; 문서만 바꾸는 변경은 Andrew가 요청할 때 직접 push할 수 있다.
- GitHub branch protection으로 이 순서를 강제할 수 있다; 적용 여부는 Andrew가 나중에 정한다.
각 단계에 목표, 대상, 특성화 테스트(옮기기 전에 먼저), 검증, 롤백, 완료 기준을 채운다.

검증 기본값:
- `npm test`, `npx tsc --noEmit`, `npm run build`, 라우트 parity와 계약 테스트, 순환 import 검사.
- 로컬 실행은 loopback에만 바인딩한다(T1-0b), 프런트 dev 서버도 `--host 127.0.0.1`(별도 작은 커밋).

배포 사전 점검 (모든 백엔드 배포, 롤백 포함, merge 전):
1. PR의 CI 3 job 통과를 확인한다.
2. 테스터에게 새 녹음 제출을 잠시 멈춰 달라고 알린다(필요할 때).
3. 읽기 전용 조회 두 개를 함께 본다(SQL Editor, 읽기 전용):
   - 활성 행: `select status, count(*), min(updated_at) from workflow_job where status in ('queued', 'processing') group by status;`
     updated_at과 무관하게 모든 활성 행을 센다: heartbeat 쓰기가 실패하거나 늦은 job도 잡기 위해서다.
   - 최근 갱신 행: `select count(*) from workflow_job where updated_at > now() - interval '2 minutes';`
     완료(`completed`) 뒤에도 memory/speaker 후처리 동안 heartbeat(60초, index.ts:1866)가 `updated_at`을 갱신하므로 후처리 중인 완료 job을 잡는다; 이 확인은 활성 행 확인을 대체하지 않는다.
4. 판정:
   - 두 조회 모두 0건이면 통과다.
   - 조회가 실패하거나 결과를 확인하지 못하면 0건으로 취급하지 않는다(통과 아님).
   - 활성 행이 있고 최근에 갱신됐으면 기다렸다가 다시 확인한다.
   - 오래된 활성 행(updated_at이 5분 넘게 지남, index.ts:1870)은 sweep 한 주기(2분, index.ts:1874)를 기다린 뒤 다시 확인한다; 그래도 남으면 원인을 확인하거나 안전하게 수렴할 때까지 통과시키지 않는다.
5. 한계: job 행이 없는 짧은 동기 요청(요약 재생성, 프로젝트 채팅, 브리핑, 이슈 해결책)은 이 조회로 보이지 않는다; 수십 초 안에 끝나므로 허용한다.
6. 통과하면 Andrew가 merge한다(= 배포 허용).

배포 후 확인:
- 백엔드가 재배포되는 merge이면 /version sha가 기대한 backend SHA(그 merge 커밋)인지 제한 시간 안에서 확인한다; build filter 때문에 백엔드가 재배포되지 않는 merge(프런트나 문서 전용)는 backend SHA 대기를 생략한다(A10).
- /health ok, Render 로그 오류 증가 없음, 새 F9 인시던트 메일 없음, sweep 로그 N=0, M1 집계(배포 전후 중단, 재개, 수렴).
- 해당 경로 E2E 1건.

롤백 (기본은 git revert):
- 단계마다 직전 정상 배포 SHA를 이 문서 단계 표에 적는다.
- 판단 기준: /health 실패, 오류율 증가, 새 F9 인시던트, 해당 경로 E2E 실패.
- 담당: Andrew, 관찰 시간: 배포 후 30분과 실제 작업 1건 완료까지(Q10, 2026-10-21 결정).
- 허용 중단 시간은 엄격하지 않다(수 시간 허용): 서둘러 롤백하기보다 진행 중 녹음과 작업을 잃지 않는 쪽을 우선한다.
- 방법: `git revert <sha>` -> PR -> CI -> 사전 점검 -> merge(자동 재배포), 롤백 배포도 위 사전 점검을 거친다.
- Render 대시보드 롤백은 비상용이다: 자동 배포를 끄므로 사용 후 자동 배포를 다시 켜고 그 사실을 기록한다.
- 데이터와 작업 복구: 관찰 시간 동안 실패한 jobId와 noteId를 읽기 전용으로 찾고, 사용자 재시도(웹은 noteId 재사용)로 수렴했는지 확인한다.
  재과금 없음은 저장된 transcript checkpoint 또는 전사 id를 재사용하는 구간에서만 성립한다; AssemblyAI 제출 뒤 전사 완료 전에 끊긴 작업은 다시 전사될 수 있으므로 별도로 기록한다(S10).
  클라이언트 쪽 복구 정보는 S11의 제출 기록 계약을 따른다.
- 마이그레이션이 없는 단계는 스키마 역호환 부담이 없지만, 잘못 쓴 데이터와 중단된 작업은 코드 롤백으로 복구되지 않으므로 위 확인이 필요하다.
- 리팩터링 단계는 마이그레이션을 만들지 않는다.

feature flag는 쓰지 않는다; 동작을 바꾸는 단계(T2-1, S 항목, 단순화 항목, 후보 수정)만 별도 커밋으로 분리하고 필요할 때만 flag를 검토한다.

### 4.6 Target 1: workflow-server/src/index.ts

줄 번호는 d607a07 기준이며 각 단계 시작 시 다시 확인한다.
T1-9와 T1-10은 순환을 피하려고 T1-9a -> T1-10a/b/c -> T1-9b 순서로 바꿨다(Codex 1).

| 단계 | 내용 | 대상 (d607a07 줄) | 선행 | 크기 |
| --- | --- | --- | --- | --- |
| T1-0a | import 가능화, 테스트 격리(필수 선행 조건), 라우트 parity + 계약 테스트 | 63-64, 315-318, 3680-3798(server export), 3800-3816, 3939-3995, mcp/lib/env.ts:62 | 없음 | M |
| T1-0b | config/loadEnv.ts, config/env.ts, 상수 이동, 로컬 loopback 바인딩(별도 커밋) | 63-64, 275-301, 313 | T1-0a | S |
| T1-0c | HTTP primitive, requiredString, identity 위임, supabase client | 129-143, 320-403, 533-552, 681-704 | T1-0b | M |
| T1-0d | 공유 AI/usage helper, 공유 helper 소유 확정(memory context, speaker context), 순수 parser를 parsers.ts로 | 759-764, 807-872, 1191-1257, 1607-1694, getPersonalMemoryContext(2225), buildSpeakerContextFromSegments(2895-2905) | T1-0c | M |
| T1-1 | transcription-test 라우트 + 테스트 전용 엔진 3개 + uploadAssemblyAudio | 83-89, 104-109, 302-312, 577-607, 1506-1606, 1733-1865, 3641-3661 | T1-0d | M |
| T1-2 | issues 라우트; parseIssueResolution(순수 파서)은 기존 issues.ts로, issueDeepLink와 warnedRelativeDeepLink는 공통 단일 모듈 issueLinks.ts(신규)로 | 3153-3389 | T1-0d | M |
| T1-3 | ops 인시던트(fileOpsIncident, raiseIncident) | 3390-3593 | T1-2 (parseIssueResolution 3467, 3508, issueDeepLink 3571 사용; 둘 다 issues.ts, issueLinks.ts에서 import하고 routes는 import하지 않음) | M |
| T1-4 | product-docs 라우트 2개 (DEC-0017) | 706-744 | T1-0c | S |
| T1-5 | meeting-briefing | 2981-3089 | T1-0d | S |
| T1-6 | refresh-note-insight, admin/backfill-insight | 3090-3152, 3594-3640 | T1-0d (buildSpeakerContextFromSegments 3140 사용) | S |
| T1-7 | project-chat + SSE (Group B #2 수정 2661 보존) | 99-103, 2569-2788 | T1-0d | M |
| T1-8 | regenerate-summary + prompt loader + 기본 프롬프트 | 90-98, 162, 201-226, 608-642, 873-935, 2789-2894 | T1-0d (getPersonalMemoryContext 2821 사용) | M |
| T1-9a | 공통 타입, 오류, 입력 파싱, job 상태 저장, checkpoint (pipeline을 import하지 않음) | 66-82, 110-115, 144-159, 229-262, 553-576, 643-670, 766-806, 1866-1969 | T1-3 | M |
| T1-10a | androidUpload helper (라우트는 T1-9b) | 116-128, 160-161, 163-200, 404-532, 936-992 | T1-9a, T1-8 (resolveSummaryPromptForAndroid) | M |
| T1-10b | transcription | 263-274, 745-758, 993-1057, 1330-1505, 1695-1732 | T1-9a | L |
| T1-10c | summarize + finalize + ingest 화자 처리 | 671-680, 1058-1190, 1258-1329, 1970-2282(getPersonalMemoryContext 제외), 2907-2980 | T1-10b, T1-8 (loadSummaryPrompt 1976) | L |
| T1-9b | job 라우트, runner, orphan sweep | 2283-2568, 3818-3938 | T1-10a (Android job 라우트가 multipart와 저장 helper 사용), T1-10c, T1-3 (raiseIncident 2516) | L |
| T1-11 | router와 VERSION_INFO를 http/router.ts로, index.ts는 진입점만 | 3662-3798 | 나머지 전부 | S |

개정 1에서 소유가 없던 구간의 소유 (Codex 2의 "공유 helper 최종 소유 모듈과 추출 시점"):

| 구간 | 내용 | 소유 모듈 | 단계 |
| --- | --- | --- | --- |
| 144-159 | NoSpeechDetectedError, noSpeechMessage (2007, 2512에서 사용) | pipeline/errors.ts | T1-9a |
| 160-161, 163-200 | AUDIO_BUCKET, ANDROID_AUDIO_MAX_BYTES, AssemblyAI 확장자 목록과 정규식 | pipeline/androidUpload.ts | T1-10a |
| 162, 201-226 | DEFAULT_SUMMARY_PROMPT_NAME, DEFAULT_SUMMARY_PROMPT(웹 사본 src/constants/defaultSummaryPrompt.ts와 동기화 주석 포함) | pipeline/promptLoaders.ts | T1-8 |
| 229-262 | SUPPORTED_GEMINI_ATTACHMENT_MIME_TYPES (565에서 사용) | pipeline/inputs.ts | T1-9a |
| 263-274 | CustomSpellingRule, TranscriptionSettings | pipeline/transcription.ts | T1-10b |
| 533-552 | requiredString (오류 문구 "is required"가 getHttpStatus의 400 판정에 쓰임) | http/shared.ts | T1-0c |
| 553-576 | parseSummaryAttachments | pipeline/inputs.ts | T1-9a |
| 608-642 | parseRegenerateSummaryInput | routes/regenerateSummary.ts | T1-8 |
| 643-670 | parseSummarizeInput (2284, 2295에서 사용) | pipeline/inputs.ts | T1-9a |
| 671-680 | inferMeetingStartAt (2044에서 사용) | pipeline/summarize.ts | T1-10c |
| 745-758 | normalizeDetectedTranscriptLanguage(1503), getOppositeTranscriptLanguage(2019) | pipeline/transcription.ts (summarize가 import) | T1-10b |
| 759-764 | GeminiWorkflowCallResult | ai/geminiFallback.ts | T1-0d |
| 766-806 | SummarizeAudioInput, SummarizeAudioResult, WorkflowJobRow | pipeline/types.ts, jobs/store.ts | T1-9a |

T1-0a 상세 (모든 단계의 안전망):
- 필수 선행 조건(사용자 결정 2026-10-21): .env 내용과 상관없이 테스트는 .env를 읽지 않고 실제 서비스(Supabase, Gemini, AssemblyAI, OpenAI, Graph, Resend, AX-KH)에 닿지 않는다.
- 상태: MCP 경로만 부분 수정됨(커밋 7f66401, 기존 MCP 경로의 부분 선행 수정이며 T1-0a 완료가 아니다).
  - 7f66401이 한 것: `npm test`가 `src/test-setup.ts`를 preload해 MEETING_NOTE_SKIP_DOTENV=1, 알림 비활성, 최초 URL host 기준의 외부 fetch 차단을 적용한다; `mcp/lib/env.ts`의 dotenv는 이 스위치로 건너뛴다; `src/test-isolation.test.ts`가 MCP import 전후 한 변수 값이 같은지 검사한다.
  - 남은 것: index.ts는 여전히 import 시 dotenv를 직접 호출하고(index.ts:64, 스위치 없음) process 핸들러, 전역 dispatcher(:315), listen 부작용이 남아 있다; 지금은 어떤 테스트도 index.ts를 import하지 않아서 드러나지 않을 뿐이다.
  - 현재 canary는 index import가 .env를 읽지 않는다는 것을 검사하지 않는다; fetch 차단은 최초 URL의 host만 보므로 loopback 응답이 외부 URL로 redirect하는 경우를 막는다는 증거가 아니다; 상속된 서버 자격정보 env도 대부분 지우지 않는다.
- 수정 전 근거(7f66401 이전, 당시 위반): `workflow-server/src/mcp/lib/env.ts:62`가 import 시 `workflow-server/.env`를 읽었다.
  `src/mcp/chatgptCompat.test.ts`가 `./transports/http.js`를 import하고 그 파일이 `../lib/env.js`를 import하므로, 당시 `npm test`가 로컬 .env를 읽었다(import 경로로 확인, 실제 네트워크 호출 여부는 확인하지 않음).
  작성자 PC의 로컬 .env는 운영 Supabase를 가리킨다는 기록이 있다(2026-07-23 로컬 환경 결정).
- 미래 라우트 테스트가 index.ts(또는 server.ts)를 import하기 전에 아래 canary가 먼저 통과해야 한다.
- 방법 1: index.ts:63-64의 dotenv 호출도 mcp/lib/env.ts와 같은 하나의 실제 스위치(현재 `MEETING_NOTE_SKIP_DOTENV=1`)로 감싼다; 스위치를 둘로 늘리지 않는다.
  테스트 파일은 import 전에 이 스위치를 켜고 대상 모듈을 dynamic import한다.
- 방법 2: 테스트는 `WORKFLOW_ALERTS_ENABLED=false`(alerts.ts:20), `F9_OPS_AGENT_ENABLED=false`(index.ts:3390)를 설정하고 `MEETING_KNOWLEDGE_*`를 비운다.
- 방법 3: undici `MockAgent`에 `disableNetConnect()`를 걸어 global dispatcher로 둔다.
  index.ts:315-318이 import 시 global dispatcher를 덮어쓰므로, 이 블록을 `startServer()`로 옮긴 뒤 테스트가 import 전에 MockAgent를 설정한다.
  Node 내장 fetch가 이 dispatcher를 따르는지 테스트로 확인한다(외부 host fetch가 실패해야 함).
- 방법 4: 테스트 서버는 `server.listen(0, '127.0.0.1')`(선례 knowledge/http.test.ts:52, mcp/oauth/proxy.test.ts:30).
- 방법 5: canary 테스트(CI 차단형), 개정 3에서 범위를 넓혔다:
  - index import 포함: index.ts(또는 server.ts)를 import해도 dotenv를 읽지 않는다; 임시 .env에 sentinel 값을 넣고 import 뒤 그 값이 process.env에 없음을 단언한다.
  - 합성 자격정보만: `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY` 등 서버 자격정보 env가 테스트가 넣은 합성 값 외에는 비어 있다(상속된 값은 preload에서 지운다).
  - redirect 차단: loopback 응답이 외부 URL로 redirect해도 외부 통신이 일어나지 않는다.
  - dispatcher 복원: 테스트가 바꾼 undici global dispatcher가 테스트 뒤 원래대로 돌아오고, import가 dispatcher를 덮어쓰지 않는다.
  - 타이머와 리스너 정리: import만으로 setInterval, process 리스너, listen이 생기지 않고, startServer()로 만든 것은 정리 함수로 모두 해제된다.
- import 가능화: `server`와 `startServer()`를 export하고, `startServer()`가 dispatcher(315-318), process 핸들러(3800-3816), listen과 sweep 타이머, knowledge worker(3939-3995)를 소유한다.
  index.ts는 진입점일 때만 `startServer()`를 부른다; 진입점 판정은 저장소 루트와 workflow-server 디렉터리 실행, tsx 실행과 build 결과 실행 네 경우를 모두 확인한다(Codex 9).
- 무인증 parity 테스트(유지): if-chain의 18개 경로 각각의 무인증 status, OPTIONS 204, 미등록 경로 404, GET /health 키 목록, /version 형태, `req.url ===` 비교 경로에 query string이 붙으면 404, dispatch 순서(knowledge -> OPTIONS -> MCP), `/admin/backfill-insight`가 if-chain으로 떨어짐.
- 계약 테스트(추가, Codex 3): Graph, Supabase, AI 경계를 가짜 구현으로 바꿔 인증 후 성공, 권한 거부, 의존 서비스 실패를 라우트별로 기록한다.
- 명시적 테스트 표(추가): SSE 헤더(index.ts:2714 `text/event-stream`), 이벤트, 종료; 잘못된 메서드(`/issue-resolution` 비POST 405, index.ts:3226); query string; CORS; MCP와 knowledge 경로 소유권.
- 검증: 배포 후 Render에서 `node build/index.js`로 listen하는지 /version으로 확인.
- 롤백: revert 1개.
- 완료 기준: 필수 선행 조건 5개가 테스트로 강제되고, parity와 계약 테스트 표가 CI에서 통과.

T1-0b 상세:
- 문제: ESM import가 모두 평가된 뒤 index.ts:64가 실행되므로 env를 별도 모듈로 옮기면 그 모듈은 dotenv 전에 평가된다(alerts.ts는 이미 이 이유로 로컬 .env 값을 못 읽음).
- 해결: `config/loadEnv.ts`를 index.ts의 첫 import로 둔다.
- `.env` 경로 계산은 모듈 위치 기준이므로 `config/` 아래로 옮길 때 기준 디렉터리를 보정하고, 4가지 실행 방식(T1-0a)에서 같은 파일을 읽는지 확인한다.
- 로컬 loopback: listen host를 env로 받고 Render 외에는 127.0.0.1을 기본으로 한다; 동작 변경이므로 별도 커밋.
- 테스트: env 기본값 규칙(`||` vs `??`, 빈 문자열) 특성화.

T1-0c 상세:
- `getHttpStatus`(377)는 오류 메시지 부분 문자열로 status를 정하므로 옮길 때 오류 문구를 한 글자도 바꾸지 않는다.
- getHttpStatus, errorMessage, corsHeaders, readBody 상한, requiredString 문구를 먼저 특성화 테스트로 고정한다.

T1-0d 상세:
- 공유 helper의 최종 소유를 여기서 확정해 T1-6, T1-8이 T1-10에 묶이지 않게 한다(Codex 2).
- `getPersonalMemoryContext`(2225; 2054, 2821에서 사용) -> pipeline/memoryContext.ts.
- `buildSpeakerContextFromSegments`(2895; 2970, 3140에서 사용) -> pipeline/speakerContext.ts.
- `callGeminiWithFallback`(816; 11곳 사용)과 usage 기록 -> ai/, pipeline/usage.ts.

T1-1..T1-8 공통:
- 옮길 함수를 먼저 export하고 colocated `*.test.ts`로 순수 부분을 고정한 뒤 이동한다.
- 모듈은 `handle<Group>Request`를 export하고 router에 한 줄로 연결한다.
- T1-7은 52c97b9의 `noteAccessFilterFor` 적용(2661)을, T1-8은 "regenerate의 fold/insight는 note.user_id로" 동작을 테스트로 고정한다.
- 각 이동 PR은 관련 결정의 `paths`(예: DEC-0003은 jobs/ 파일 추가)와 제품 문서 `depends_on`을 함께 고친다(Codex 11).

T1-9a, T1-10a/b/c, T1-9b 상세 (가장 위험):
- T1-9a의 `jobs/store.ts`는 pipeline을 import하지 않는다; T1-10은 store만 import하고, T1-9b의 runner가 pipeline을 import한다.
- 필수 장애 시나리오(Codex 4), fake supabase로 특성화:
  - 동일 noteId 동시 제출은 job 1개로 수렴한다(createSummarizeJob dedup).
  - checkpoint 저장 후 재시작, 재시도는 transcript를 재사용한다(AssemblyAI 재과금 없음).
  - note 저장 후 완료 상태 쓰기 실패 시 sweep이 note에서 결과를 재구성해 completed로 수렴한다(reconstructResultFromNote).
  - heartbeat가 살아 있는 작업은 sweep이 건드리지 않는다.
  - 무음 결과는 인시던트를 만들지 않는다(index.ts:2512).
  - 인스턴스 중첩(개정 3 추가): 구 인스턴스와 새 인스턴스가 같은 job 행을 동시에 실행하려 하면 한쪽만 실행권을 얻고, 실행권을 잃은 쪽은 job 상태, note, 후처리를 쓰지 못한다(S10; DB 지연 포함).
  - 완료 후 실패(개정 3 추가): job이 completed가 된 뒤 finalizeNoteMemory 같은 후처리가 실패하거나 종료 신호를 받아도 job은 completed로 남고 후처리 미완료만 따로 기록된다(S12).
- DB 보장(부분 unique index `workflow_job_active_note_uniq`, supabase/migrations/20261009120100_reliability_transcript_checkpoint_and_active_job_uniq.sql:53)과 S10의 조건부 인수 갱신은 fake로 확인할 수 없으므로 PGlite SQL harness로 격리 검증한다(A17; 기존 workflow-server/scripts/verify-feedback-issues-sql.mjs는 feedback fixture만 검사하므로 note RLS와 workflow_job 경합 검사는 새로 만든다).
- 배포는 4.5 사전 점검 후, 배포 직후 sweep 로그와 실제 요약 1건 E2E(웹 업로드 -> 요약 완료)를 확인한다.
- T1-10a/b/c는 각각 웹 업로드 1건과 Android 업로드 1건 E2E를 한다.

Target 1 완료 기준:
- index.ts 400줄 이하(진입점).
- 순환 import 0(자동 검사), 모듈 수준 상태 단일 소유.
- 옮긴 모듈마다 중요한 성공, 권한, 실패 분기 체크리스트가 테스트로 덮인다(Codex 13).
- 테스트 수(개정 3 재실행 기준 580, 과거 기록 570)와 줄 수는 보조 지표다: 줄지 않아야 하지만 그것만으로 완료를 판단하지 않는다.
- parity와 계약 테스트 전 단계 통과, CI 3 job 통과.

### 4.7 Target 2: 웹 데이터 계층과 큰 페이지

- 현재: `supabase.from('note')` 21곳(8개 파일), `supabase.from('speaker')` 24곳.
- 페이지 크기: SummaryHistory.tsx 4,090, TranscriptionSummary.tsx 3,283, Project.tsx 1,984, AccountSettings.tsx 1,917.
- 확인된 버그: `src/pages/Project.tsx:724-731`(summary_edit 저장)과 `:755-760`(이름 변경)은 user_id 범위, `.select()`, row 수 확인 없이 성공 처리한다.
- note UPDATE RLS는 소유자만 허용한다(`note_owner_update`, supabase/migrations/20260602124000_enable_user_data_rls.sql:63-68); 그래서 비소유자 편집은 0행 갱신이 되고 화면은 성공으로 보인다.
- 올바른 선례: `src/pages/SummaryHistory.tsx:1800-1810`.

| 단계 | 내용 | 크기 | 비고 |
| --- | --- | --- | --- |
| T2-0 | Vitest + testing-library + jsdom | S | 완료(a666950) |
| T2-1 | `src/lib/notes/repository.ts` 소유자 쓰기 메서드 + Project.tsx 두 곳 이전 | S | 동작 변경(버그 수정) |
| T2-2 | 나머지 note 호출부를 repository로, 파일 1개당 커밋 1개 | M | 동작 보존 |
| T2-3 | `src/lib/speakers/repository.ts` + 24곳 이전 | M | DEC-0008, DEC-0010 확인 |
| T2-4 | SummaryHistory.tsx부터 hook/하위 컴포넌트로 분해 | L | 추출 단위와 회귀 시나리오는 아래 |

repository 권한 계약 (Codex 8):

| 메서드 | 허용 대상 | 범위 조건 | 0행일 때 | 오류 처리 | 보존할 의미 |
| --- | --- | --- | --- | --- | --- |
| listNotes | 소유자 + 직접 공유 + 프로젝트 공유 | RLS와 기존 RPC 그대로, user_id 필터를 새로 넣지 않음 | 빈 목록(정상) | 오류는 notesError로 표시 | 정렬, 페이지네이션, `count: 'exact'`(SummaryHistory.tsx:712) |
| getNote | 위와 같음 | RLS | null(정상) | 오류 표시 | 선택 열 |
| updateOwnedNote(summary_edit, name, diarization 등) | 소유자만 | `.eq('user_id', userId)` + `.select('id').maybeSingle()` | 오류("권한이 없을 수 있음") | throw, 화면에 표시 | 낙관적 갱신은 성공 후에만 |
| deleteOwnedNote | 소유자만 | user_id + select | 오류 | throw | 녹음 참조 삭제 차단(4436643)과 별개 |
| updateSharedUsers | 소유자만 | user_id + select | 오류 | throw | 현재 TranscriptDiarizedEditor.tsx:696은 user_id 없이 갱신하므로 T2-2에서 확인 |
| leaveSharedNote | 공유받은 사람 | 기존 RPC(공유 해제) | RPC 결과 그대로 | throw | RPC 의미 변경 금지 |

- T2-1 재현(두 번째 계정 없음, 2026-10-21 결정):
  1. fake supabase 단위 테스트: update가 오류 없이 0행을 돌려줄 때 현재 Project.tsx 처리는 성공으로 보이고, repository는 오류를 낸다.
  2. PGlite SQL harness: 비소유자 JWT로 note UPDATE가 0행이 되는 것을 실제 정책 SQL로 확인한다(note RLS fixture는 새로 만든다, A17).
  3. Andrew 본인 수동 확인: 소유 노트 편집과 이름 변경이 계속 성공하는지(회귀 없음).
  - 실제 2계정 prod E2E는 남은 과제로 기록한다(Group B와 함께 보류).
- T2-4 추출 단위: 조회(목록, 캘린더), 편집(제목, 요약, 전사), 화자, 재생(서명 URL), 모달(공유, AX-KH, 프로필).
  단위마다 loading, error, unmount 중 응답 도착 회귀 시나리오를 renderHook 테스트로 먼저 둔다.
- T2 완료 기준: 페이지에서 `supabase.from('note'|'speaker')` 직접 호출 0곳, 위 표의 메서드별 테스트, 프런트 테스트 99개 이상.

### 4.8 의존 순서와 권장 첫 배치

실제 의존(Codex 2):
- T1-0a -> T1-0b -> T1-0c -> T1-0d.
- T1-0d 이후: T1-1, T1-4, T1-5, T1-6, T1-7, T1-8은 서로 독립이다.
- T1-2 -> T1-3.
- T1-3 -> T1-9a -> T1-10a/b/c -> T1-9b -> T1-11 (T1-9b는 T1-10a와 T1-10c 모두 뒤).
- T1-8 -> T1-10a, T1-10c.
- T2-1은 T1과 독립이며 T2-2 -> T2-3 -> T2-4.
- S1, S2, S9, S11은 언제든; S10, S12의 설계와 테스트 작성은 첫 배치부터; S4(=S12), S5, S7, S8, S10의 구현은 T1-9b 이후; S13은 readBody가 T1-0c 뒤, 동시 실행 상한이 T1-9b 뒤(U1, U9 확대 전).
- U9-0(화자 지정과 공유 분리) -> U9.
- S11(제출 기록과 재시도 계약)과 U1/U2 입력 snapshot -> U1, U2.

첫 배치 (개정 3에서 확정, Codex 2차 18):
1. S1(개정 3의 판정 규칙), S2, S9: 배포 사전 점검 문서화, Render 설정과 플랜(무료) 및 워크스페이스 전체 사용량 확인, 무료 플랜 예산 규칙; Q5와 Q10 운영 조건(2026-10-21 결정)을 RUNBOOK에 적는다; 코드 거의 없음.
2. T1-0a (테스트 격리 완료 + import 가능화 + parity/계약 테스트, 4.6의 넓힌 canary 포함); 로컬 서버를 처음 실행하는 단계 전에 loopback 조건을 충족한다.
3. note RLS PGlite harness 준비(A17의 첫 부분) + T2-1 (note repository, 확인된 무음 성공 버그).
4. S10, S12 설계와 테스트 작성 시작: 상태 전이, 실패 구간(제출 후 전사 id 저장 전, 완료 후 후처리, 인스턴스 중첩), SIGTERM과 SIGKILL 시험 계획; 구현은 T1-9b 뒤이며 실제 추출 순서와 분리한다.

첫 배치 뒤 순서:
5. T1-0b.
6. T1-0c (뒤이어 S13의 readBody 바이트 카운터를 별도 커밋으로).
7. T1-0d.
8. T1-1 (단일 사용자 게이트라 가장 안전한 첫 추출).
- S11(클라이언트 제출 기록과 재시도 계약)은 단순화 병행 작업과 함께 프런트 단독 커밋으로 넣는다(백엔드 구조와 독립); U1/U2의 선행 조건이다.
- 결정됨(Q1, 2026-10-21): 첫 배치 직후 5절 단순화의 승인된 빠른 항목(U1, U5, U9, U15, 설정 통합)을 병행한다.
  - U9의 선행 조건: U9-0(화자 지정과 공유 분리, Andrew 결정 2026-10-21).
  - U1/U2의 선행 조건: S11 제출 기록과 제출 시점 입력 snapshot.
  - U10은 5절의 선행 검증 후.
  - 모바일 항목의 Q6/Q7은 모바일 변경만의 조건이며 웹 단순화 전체를 기다리게 하지 않는다.
- 5~8(T1-0b..T1-1)과 단순화는 서로 독립이라 병행하고, S4(=S12), S10의 구현은 T1-9b 이후 이어서 한다.

## 5. 기둥 2: 단순화 (UX)

원칙:
- 첫 요약까지 사용자가 설정하거나 고를 것이 없어야 한다.
- 선택 사항은 지우거나 접힌 "옵션"으로 옮기고, 기본값은 자동으로 정한다.
- 개인정보 기본값은 느슨하게 하지 않는다: 자동 전송, 자동 공유, 자동 권한 부여는 하지 않는다(DEC-0018).
- 화자 이름 지정은 공유나 권한 변경을 하지 않는다(Andrew 결정 2026-10-21, U9-0); 공유는 사용자가 누르는 별도 동작이다.
- 파괴적 동작(삭제, 폐기)의 확인은 유지한다.
- OS 권한(마이크, 카메라) 요청과 녹음 중 이동 확인은 필요한 시점에 유지한다(RecorderContext.tsx:653, RecordingNavigationGuard.tsx:45, 모바일 record_screen.dart:169, :195); 자동 허용으로 대체하지 않는다.

처리 구분: 유지, 제거, 자동 기본값(기본으로 자동 처리하고 바꿀 수는 있음), 통합(다른 단계와 합침).
위치는 HEAD d607a07 기준이며, 개정 3에서 추가한 위치는 cab4b3e 기준이다(모바일 경로는 meeting-note-mobile/app/lib/ 아래).

| # | 항목 | 위치 | 현재 | 처리 | 근거 | 위험, DEC |
| --- | --- | --- | --- | --- | --- | --- |
| U1 | 녹음 후 "녹음 사용" + "요약" 두 번 클릭(웹) | src/pages/TranscriptionSummary.tsx:446 useRecording, :2391 요약 버튼 | 녹음 중지 -> 완료 패널 -> 녹음 사용(업로드) -> 요약 | 통합 + 자동 기본값: 중지하면 업로드와 요약이 바로 시작. 취소는 서버 접수 전의 유예 시간 안에서만 보장한다(유예 중 취소 = 제출하지 않음); 서버가 접수한 뒤에는 서버 취소 API가 없으므로 "없던 일"로 되돌린다고 표시하지 않는다. 선행 조건: S11 제출 기록과 제출 시점 입력 snapshot. 진입 경로별 동작은 아래 U1/U2 표. 승인됨(Andrew, 2026-10-21) | 가장 자주 하는 흐름의 필수 클릭 2회 | 실수 녹음 비용: 아주 짧은 녹음은 자동 시작하지 않음, 유예 중 취소 버튼; 접수 뒤 취소가 필요하면 서버 취소 계약과 비용 한계를 별도로 설계; DEC-0003(작업 증가); 중복 제출 방지(S11) |
| U2 | 모바일 녹음 후 새 노트 화면 + "요약 생성" | meeting-note-mobile/app/lib/features/record/ui/record_screen.dart:245, :315, features/notes/ui/new_note_screen.dart | 중지 -> 새 노트 화면 -> 요약 생성 | 통합 + 자동 기본값: 중지하면 바로 처리 화면. 취소 경계, 선행 조건, 진입 경로별 동작은 U1과 같다. 녹음 중 찍은 사진(record_screen.dart:195)은 U2의 제출 입력으로 전달한다. 승인됨(Andrew, 2026-10-21) | U1과 같음 | Q7(모바일 UI 권한), 오프라인이면 업로드 대기, 로컬 녹음 보존(S11) |
| U3 | 요약 프롬프트 선택 | TranscriptionSummary.tsx:2354, new_note_screen.dart:240 | 매번 보이는 드롭다운(기본 프롬프트가 미리 선택됨) | 자동 기본값: 마지막 사용 또는 기본 프롬프트, 선택은 "옵션"에 | 대부분 기본값 사용 | 없음 |
| U4 | 추가 지시 입력 | TranscriptionSummary.tsx:2334, new_note_screen.dart | 항상 보이는 입력칸 | 유지(접힘) | 가끔 유용 | 없음 |
| U5 | 이미지/파일 첨부 | TranscriptionSummary.tsx(NoteImageAttachments), new_note_screen.dart(첨부, 카메라) | 요약 폼에 노출 | 유지(접힘), 녹음 전과 녹음 중에도 접힌 옵션에서 추가할 수 있고 제출 시점에 snapshot으로 고정; 요약 후 노트에서 추가하는 첨부는 노트에 저장될 뿐 이미 만든 요약의 AI 입력에는 들어가지 않는다(현재 regenerate도 첨부를 다시 받지 않음); 요약 후 첨부를 AI에 반영하려면 별도 동작 변경으로 다룬다 | 선택 사항 | 웹 pending 첨부는 새로고침에 사라짐(2026-09-29 리뷰), NoteImageAttachments.tsx:171; 화면 문구가 "요약에 반영"으로 오해되지 않게 한다 |
| U6 | 모바일 노트 제목 입력 | new_note_screen.dart 제목 필드 | 입력칸 | 제거(서버가 제목 생성, buildNoteName), 요약 후 편집 | 서버 자동 제목이 이미 있음 | 없음 |
| U7 | 모바일 "로컬 경로 직접 입력" | new_note_screen.dart:327, :400 (`/sdcard/...` 힌트); 모바일 홈의 같은 진입점 record_screen.dart:229(경로 직접 입력 항목), :283(`/sdcard/...` 힌트 입력창) | 새 노트 화면과 홈의 파일 선택 시트 두 곳에 노출 | 제거(개발용), 두 진입점 모두 | 일반 사용자에게 의미 없음 | 개발 시 필요하면 debug 빌드에만 |
| U8 | 참석 인원 힌트 | (260e729로 제거) | 없음 | 유지(제거 상태) | 2026-08-25 Hansoo 부정적 | 없음 |
| U9-0 | 화자 지정이 노트 공유까지 수행 | 웹 src/components/TranscriptDiarizedEditor.tsx:671(shareCurrentNoteWithMicrosoftUser), :755(저장된 화자 지정), :852(Microsoft 연락처 지정); 모바일 features/notes/ui/summary_screen.dart:2224, features/notes/data/notes_repository.dart:1309 | 수동 지정은 지정한 사람의 Microsoft id로 `note.shared_users`를 갱신; 제안 수락(웹 :489, 모바일 제안 시트)은 공유하지 않음; 두 경로의 효과가 다름 | 분리(동작 변경, Andrew 결정 2026-10-21): 화자 지정(수동, 제안 수락)은 공유하지 않는다; 지정 직후 그 사람이 Microsoft id로 확인되면 "이 사람과 노트 공유" 확인 버튼을 한 번 클릭으로 보여 주고, 누르면 U17의 공유 경로로 공유한다; 웹과 모바일, 수동과 제안 수락 모두 같은 동작 | 이름 고치기와 열람 권한 부여를 분리(개인정보 원칙), 두 경로의 차이 제거 | U9 앞의 별도 단계, 별도 커밋과 테스트: 화자 적용과 재편집만으로 `shared_users`, 프로젝트 공유, AX-KH 참석 권한이 바뀌지 않음을 웹과 모바일에서 테스트, 버튼을 눌렀을 때만 공유되고 소유자가 아니면 실패를 표시(T2 repository의 updateSharedUsers, 현재 :696은 user_id 조건 없음); 구현 시 새 DEC 기록(기존 해당 DEC 없음) |
| U9 | 화자 이름 제안 실행 | src/components/TranscriptDiarizedEditor.tsx:469, :973; 모바일 summary_screen.dart:537 | 사용자가 Suggest를 눌러야 제안이 보임 | 자동 기본값: 요약 완료 후 제안을 자동으로 계산해 미리 채워 보여 줌, 적용은 한 번 탭 확인. 승인됨(Andrew, 2026-10-21) 단 필수 조건: 제안은 아직 정확하지 않으므로 사용자가 적용 전에도, 이름을 적용하거나 확정한 뒤에도 언제든 화자를 바꿀 수 있어야 하고 이름을 잠그지 않는다(5절 화자 편집 요구). 선행 조건: U9-0, S13(동시 실행 상한). 완료 기준은 아래 "U9 완료 기준" | 클릭 1회와 "기능을 모름" 문제 제거 | 다중 화자 자동 적용은 하지 않음(2026-08-25 측정 정밀도 약 60%); DEC-0010 본문(임계값 자동 적용)과 현재 코드(단일 화자만 자동)가 어긋남, 대체 결정 필요; DEC-0005(lite 모델, 노트마다 호출 비용 증가) |
| U10 | 프로필 동기화(Sync Profile) 모달 | TranscriptionSummary.tsx:1601, :2810; SummaryHistory.tsx:559; 모바일 summary_screen.dart:1299, :1311 | 화자 찾기 -> 생성 -> 개별 저장 또는 모두 저장 확인 | 통합: 이름 적용 시 프로필 자동 누적(TranscriptDiarizedEditor.tsx:449 accumulateSpeakerProfile가 이미 함)으로 대체, 모달 제거. 보류(Andrew, 2026-10-21): 선행 검증 통과 후에만 제거(아래 U10 선행 검증, 재편집 일관성 포함) | 같은 일을 두 번 시킴 | 프로필 품질 회귀 여부를 eval로 확인(DEC-0012), generate-profile 호출 감소; 자동 누적의 화면 내 중복 억제 키가 `noteId:이름`(TranscriptDiarizedEditor.tsx:441)이라 A에서 B로 고쳐도 A에 이미 누적한 정보가 되돌려지지 않고, 다시 A로 고치면 갱신이 생략될 수 있다 |
| U11 | 화자 프로필 JSON 직접 편집 | src/pages/AccountSettings.tsx 계정 탭(자기 프로필 편집, 복사), 화자 프로필 탭; 같은 기능의 다른 진입점: src/components/TranscriptDiarizedEditor.tsx:1632, src/pages/SummaryHistory.tsx:3868, 모바일 features/settings/ui/settings_screen.dart:439 | 원시 JSON 편집기 | 일반 사용자에게서 원시 JSON 편집은 제거하고 관리자 진단으로 이동; 설정 탭만이 아니라 세 진입점 각각에 대해 읽기, 구조화 편집, 제거를 정한다; 본인이 관리하는 잘못된 프로필을 교정하거나 삭제하는 경로는 남긴다 | 일반 사용자가 JSON을 편집할 이유 없음, 그러나 틀린 프로필은 고칠 수 있어야 함(U9 오지정) | 잘못된 JSON 저장 위험도 사라짐 |
| U12 | 요약 프롬프트 관리 탭 | AccountSettings.tsx 탭(620-700), 생성 :1744, 삭제 :1861 | 독립 탭 | 유지(고급으로 접음) | 소수 파워 유저 기능 | 없음 |
| U13 | 메모리 탭(보기, 삭제) | AccountSettings.tsx 메모리 탭, 모바일 설정 | 독립 탭 | 유지 | DEC-0014(자동 관리, 삭제만) | 없음 |
| U14 | MCP 설정 탭(개인 토큰 생성, 복사) | AccountSettings.tsx MCP 탭, 모바일 설정 | 토큰 생성 후 수동 복사 | 유지 + 단순화: 연결 화면을 "연결" 한 곳에 모으고, 사용자가 누르는 복사 버튼 한 번으로; 키 폐기(AccountSettings.tsx:1465, 모바일 settings_screen.dart:799)와 연결 방식별(OAuth, 개인 키) 설치 안내(AccountSettings.tsx:1591)는 유지; 키 자동 생성과 자동 클립보드 복사는 하지 않는다 | Claude/ChatGPT 연결은 핵심 사용처 | 토큰은 비밀값, 명시적 생성 유지 |
| U15 | AX-KH 보내기 | src/components/AxkhIntegrationButton.tsx, src/components/MeetingKnowledgeModal.tsx:163 | 버튼 -> 모달 -> "연동하고 전송 켜기"(2클릭) | 통합: 버튼 한 번이 동의이자 전송(버튼 문구에 "보내면 참석자와 공유받은 사람이 AX-KH에서 볼 수 있음" 명시). 버튼은 기존 enable_all(workflow-server/src/knowledge/enable-all.ts:53)과 상태 조회를 재사용하고, 부분 실패나 응답 유실이면 상태를 다시 읽어 실제 상태(전송 대기, worker 비활성, 처리 승인 대기, 완료)를 보여 준다; 누른 즉시 "전송 완료"로 표시하지 않는다. "실행 취소"는 서버 disable과 source.disabled 전파 상태를 보여 줄 뿐 이미 전달된 자료의 회수를 보증하지 않으며 문구도 그렇게 쓴다. 참석자 확정, 공유, 접근 복원, 모델 처리 승인은 한 번 클릭의 부수 효과로 실행하지 않는다; 새 노트는 클릭 전까지 opt-in 해제 상태. 승인됨(Andrew, 2026-10-21), 자동 전송은 여전히 없음 | Hansoo 요구(단순한 녹음 후 연동) | 자동 전송 없음(DEC-0018 유지, Q8); 계약 파일 변경 없음; 수용 테스트: 소유자가 아닌 사용자, 원문 크기 초과, revision 충돌, 전송 대기, 처리 승인 거부 |
| U16 | AX-KH 참석자 추가, 전송 끄기/켜기, 다시 동기화, 접근 철회 | MeetingKnowledgeModal.tsx:167, :187, :190-206, :219 | 모달 안 여러 단계 | 유지(고급으로 접음). 참석자 후보 제시는 별도 작업 두 개다: (1) 선택한 회의 일정의 초대 목록 조회(현재 일정 DTO와 Graph select, src/services/graphService.ts:54에 attendees 없음) (2) 회사 디렉터리에서 검증된 Microsoft object id 후보로 매핑. 외부 참석자, 미확인 매핑, 중복 이름은 자동 확정하지 않고, 후보 조회 실패는 권한 추가 없이 끝낸다; 사용자가 실제 참석을 확인한 뒤에만 기존 confirm_participant를 부른다; 일정 선택만으로 공유를 바꾸지 않는다 | 대부분 불필요, 그러나 권한 관리에 필요 | 참석 확인은 AX-KH 접근 권한을 주므로 자동 확인 금지; 초대 목록은 실제 참석 확인이 아니며 이메일과 표시 이름은 object id를 대신할 수 없다(DEC-0001) |
| U17 | 노트 공유 | src/components/ShareNoteModal.tsx:94 | 사용자 선택 모달 | 유지; U9-0의 "이 사람과 노트 공유" 버튼도 이 공유 경로를 쓴다. 프로젝트 공유(대상 선택과 권한 변경, src/components/ShareProjectModal.tsx:86, src/components/AppSidebar.tsx:1153)는 노트 공유와 별도의 승인 동작으로 유지하고, 프로젝트에 넣은 노트가 프로젝트 구성원에게 보인다는 영향을 화면에서 설명한다 | 명시적 권한 부여 | 참석자 자동 공유 금지, 화자 지정 자동 공유 금지(U9-0) |
| U18 | 프로젝트 지정 | SummaryHistory.tsx:539(프로젝트에 추가), src/pages/Project.tsx:303(노트 추가 모달), src/components/AppSidebar.tsx:176(프로젝트 생성 모달) | 세 곳에서 수동 | 유지 + 자동 제안: 제목, 참석자, 과거 배정으로 프로젝트를 제안하고 한 번 탭으로 확정 | 수동 정리 부담 | 자동 배정 금지: 프로젝트 공유가 구성원에게 노트를 보여 주므로 권한이 넓어짐 |
| U19 | 앱 언어와 요약 언어 결합 | AccountSettings.tsx:810, TranscriptionSummary.tsx:1344(`language: appLanguage`), 모바일 settings_screen.dart:53 | 앱 언어가 요약 언어를 정함 | 자동 기본값: 앱 언어는 브라우저/기기 언어로 시작, 요약 언어는 앱 언어 유지(현행)하되 변경은 옵션에 | 처음 쓰는 사람이 설정할 필요 없음 | 회의 언어와 요약 언어 분리는 별도 결정(기본 프롬프트는 "원문 언어 준수"라 충돌 여부 확인) |
| U20 | 모바일 테마 | settings_screen.dart:58, :168 (라이트/다크만) | 수동 선택 | 자동 기본값: 시스템 설정 따름 옵션 추가 | 설정 불필요 | 없음 |
| U21 | 전사 언어 토글(원문/번역) | SummaryHistory.tsx:1434-1436 | 노트에 번역 데이터가 있으면 표시 | 유지: 새 노트와 옛 노트 모두 실제 번역 데이터 유무로 토글을 결정 | `TRANSLATION_ENABLED=false`(index.ts:313)는 반대 언어 요약 분기(:2124)만 끄고, 전사 번역(`translationPromise`, :2027)은 감지 언어가 있으면 이 값과 상관없이 실행되므로 새 노트에도 번역 데이터가 생길 수 있다(개정 2의 "옛 노트에만"은 틀림) | 번역 실행 정책 자체를 바꾸려면 별도 동작 변경 |
| U22 | 관리자 음성 모델 선택 | src/pages/AdminControls.tsx:212-219 | 선택해도 서버는 universal-2 고정(index.ts:300, :1341) | 제거 | 효과 없는 설정은 오판을 부름(R12) | 없음 |
| U23 | 관리자 용어(keyterms), 맞춤 철자, 요약 맥락 | AdminControls.tsx:225-310 | 관리자 입력 | 유지(관리자 전용) | 용어 사전 효과(2026-08-25 회의 아이디어) | 없음 |
| U24 | Teams 전달, OneDrive 내보내기 잔여 문자열 | src/config/msalConfig.ts:51-53(제거 기록), src/context/LanguageContext.tsx:50, :198 | 기능 제거, 문자열 남음 | 제거(정리) | 죽은 문자열 | 없음 |
| U25 | 히스토리 보기 모드, 캘린더 모드, 소유 필터, 정렬 | SummaryHistory.tsx:494-506 | 매번 기본값 | 유지 + 마지막 선택 기억 | 보기 도구라 설정이 아님 | 없음 |
| U26 | 요약, 제목, 전사 편집과 요약 재생성 | TranscriptionSummary.tsx, SummaryHistory.tsx | 수동 | 유지 | 사용자 교정 | 비소유자 편집 무음 성공은 T2-1 |
| U27 | 폐기, 삭제 확인 모달 | TranscriptionSummary.tsx:369, SummaryHistory.tsx:535, Project.tsx:284 | 확인 모달 | 유지 | 파괴적 동작 | 없음 |
| U28 | 2시간 자동 중지 경고 | src/context/RecorderContext.tsx:839, 모바일 recording_service.dart | 자동 | 유지 | 이미 자동 | C1 파일(recording_service.dart)은 건드리지 않음 |

요약:
- 29개 항목: 그대로 유지 8(U13, U17, U21, U23, U25, U26, U27, U28), 유지하되 접기 또는 단순화 5(U4, U5, U12, U14, U16), 제거 5(U6, U7, U11, U22, U24), 자동 기본값 또는 자동 제안 5(U3, U9, U18, U19, U20), 통합 4(U1, U2, U10, U15), 분리 1(U9-0, 개정 3 추가), 이미 제거 1(U8).
- 이 표가 모든 수동 동작을 포괄한다고 보지 않는다; 2차 검토에서 찾은 다른 진입점은 아래 "하위 수용 기준"에 붙였다.
  단순화 후보를 적는 것과 이번 배치에 모두 구현하는 것은 다르다.
- 10/30 전에 할 수 있는 빠른 항목: U1, U3, U9-0, U9, U15, U22, U24, 설정 통합(웹, 동작 변경이라 각각 별도 커밋과 E2E); U9는 U9-0 뒤, U1은 S11 뒤; U10은 선행 검증 통과 후.
- 모바일 항목(U2, U6, U7, U20)은 Q6, Q7 답과 APK 배포(6절 A7)에 묶인다.
- 결과 화면 목표(M8, M9): 요약 폼은 "녹음/업로드" 하나와 접힌 "옵션", 설정은 "계정", "내 메모리", "연결" 세 탭과 접힌 "고급".
- 설정 화면 통합(계정, 내 메모리, 연결 + 접힌 고급; U11~U14, U19 관련): 승인됨(Andrew, 2026-10-21).

Andrew 결정 기록 (2026-10-21):
- U1/U2 녹음 중지 후 요약 바로 시작: 승인.
- U9 화자 이름 제안 자동 표시: 승인, 단 아래 화자 편집 요구를 지킨다.
- U15 AX-KH 한 번 클릭 전송: 승인(자동 전송 없음, DEC-0018).
- 설정 화면 통합: 승인.
- U10 Sync Profile 모달 제거: 보류, 아래 선행 검증 후.
- U9-0 화자 지정과 노트 공유 분리(2차 검토 후 추가 결정): 지정만으로 공유하지 않고, 지정 직후 한 번 클릭 "이 사람과 노트 공유" 확인 버튼; 수동과 제안 수락, 웹과 모바일 동일.

U1/U2 진입 경로별 자동 요약 (E2E 표, 개정 3 추가):
이 표는 자동 요약 승인 자체를 다시 묻는 것이 아니라 경로별 동작과 중복 제출 방지를 정한다.

| 진입 경로 | 위치 | 자동 요약 시작 | 중복 제출 방지와 보존 |
| --- | --- | --- | --- |
| 일반 녹음 중지 | TranscriptionSummary.tsx:446, 모바일 record_screen.dart:242 부근 | 예(짧은 녹음 제외, 유예 후 제출) | S11 제출 기록, 같은 원본은 같은 noteId |
| 중단된 녹음 복구본 | TranscriptionSummary.tsx:1931, 모바일 record_screen.dart:122 | 아니오: 복구 제안은 자동으로 보이되 요약은 사용자가 복구본을 고른 뒤 시작; 복구본 폐기와 외부 전송을 묶지 않음 | 복구본은 제출 확정 전까지 보존 |
| 기존 파일 선택, 최근 녹음 선택 | TranscriptionSummary.tsx:2229, 모바일 record_screen.dart:242, :302 | 예: 선택이 곧 사용자 의사이므로 선택 직후 유예 후 제출 | 이미 같은 원본으로 진행 중이거나 완료된 job이 있으면 새로 제출하지 않고 그 job 또는 note로 이동; 원본 삭제 확인과 참조 노트 삭제 가드(4436643) 유지 |
| 2시간 자동 중지 | RecorderContext.tsx:839, 모바일 recording_service.dart(C1, 수정하지 않음) | 예: 일반 중지와 같게 처리 | 자리를 비운 경우를 고려해 결과 알림 유지; 같은 녹음의 중복 제출 없음 |
| 녹음 중 페이지 이동으로 인한 종료 | RecordingNavigationGuard.tsx:45, :60 | 아니오: 이동 확인에서 "Stop and continue"(중지하고 이동)를 고르면 녹음은 중지하고 저장하되 요약은 돌아왔을 때 사용자가 시작(완료 패널에 남은 녹음 또는 복구본) | 녹음 원본 보존(돌아왔을 때 남아 있는지 E2E로 확인), 자동 제출하지 않음 |

- 기본 원칙: 제출 시점의 입력(프롬프트, 추가 지시, 녹음 중 사진과 첨부)을 snapshot으로 고정하고, 옵션은 녹음 전과 녹음 중에도 접힌 형태로 바꿀 수 있게 한다.
- 이 표의 "아니오" 두 경로는 개정 3의 권장안이며 구현 전에 Andrew 확인이 필요하다(3절 "남은 열린 질문").

U9 완료 기준 (개정 3 추가):
- 제안은 `speakerKey`와 전사 revision을 기준으로 무효화한다: 전사나 화자 라벨이 바뀌면 이전 제안을 버린다.
- A -> B -> A 재편집, 전체 이름 초기화(handleResetSpeakers, TranscriptDiarizedEditor.tsx:879), 편집 중 늦게 도착한 제안이나 프로필 갱신 응답이 새 편집을 덮지 않는다.
- 공유받은 사용자(소유자가 아님)의 화자 편집은 거부되고 화면에 표시된다(무음 성공 금지, T2-1과 같은 기준).
- 같은 note와 전사 revision의 제안은 한 번만 계산한다: 화면 재방문마다 AI를 다시 부르지 않는다(S13, DEC-0005 비용).
- 화자 치환 범위(TranscriptDiarizedEditor.tsx:1394, :1441, 모바일 summary_screen.dart:2302, :2381)를 유지하고 한 구간 수정이 전체 발언 변경으로 커지지 않게 한다(U26과 같음).
- 화자 지정은 공유를 바꾸지 않는다(U9-0의 테스트를 U9 E2E에서도 다시 확인).

2차 검토로 추가한 하위 수용 기준 (Codex 2차 11, 구현 배치와는 별개):
- 이슈 작성의 목적과 영역 선택, 모바일 우선순위와 심각도(src/components/issues/CreateForm.tsx:182, :204, 모바일 features/issues/ui/issues_screen.dart:404, :477): 현재 자동 분류 기본값을 쓰고 고급 선택은 접되 수정은 허용하며, 제출과 수신자 변경은 사람에게 남긴다.
- 최근 녹음 선택과 서버 또는 로컬 원본 삭제: 업로드 진입점으로 합치되 원본 삭제 확인과 참조 노트 삭제 가드를 유지한다(위 U1/U2 표).
- OS 권한과 녹음 중 이동 확인: 5절 원칙대로 유지한다.

화자 편집 요구 (U9의 필수 조건):
- 화자 이름 제안은 아직 정확하지 않다(측정 정밀도 약 60%, 다중 화자).
- 사용자는 제안을 적용하기 전에도, 이름이 적용되거나 확정된 뒤에도 언제든 누가 말했는지 바꿀 수 있어야 한다.
- 이름을 잠그지 않는다: "확정" 상태가 있어도 다시 바꾸는 길을 막지 않는다.
- 자동 표시된 제안은 미리 채움일 뿐이며 사용자 확인 없이 적용하지 않는다(다중 화자 자동 적용 금지 유지).
- 바꾼 결과가 프로필 누적과 노트 화자 목록에 일관되게 반영되는지 U9 E2E에서 확인한다(편집 뒤 재편집 포함).
- 프로필 누적의 출처와 정정 방법을 정한다: 지금 누적은 기존 프로필을 읽어 합치며(accumulateSpeakerProfile.ts:72, :104) A에서 B로 고쳐도 A에 이미 합친 정보를 빼는 경로가 없다.
  정정이 끝나기 전에는 단순 재편집을 "프로필까지 복구됨"으로 표시하지 않는다; 사용자가 틀린 프로필을 고치거나 지우는 경로는 U11에서 남긴다.

U10 선행 검증 (모달 제거의 전제 조건):
- 이름 적용 시 자동 프로필 누적(TranscriptDiarizedEditor.tsx 약 449행 accumulateSpeakerProfile)이 Sync Profile 모달이 하던 일을 모두 대신하는지 먼저 확인한다.
- 비교 항목: 새 프로필 생성, 기존 프로필 갱신, 개별 저장과 모두 저장 경로, generate-profile 호출 시점, 모바일(summary_screen.dart) 경로 차이.
- 재편집 일관성(개정 3 추가): 화면 내 중복 억제 키가 `noteId:이름`(TranscriptDiarizedEditor.tsx:441)이므로 A로 지정했다가 B로 고치면 A에 누적한 정보는 되돌려지지 않고, 다시 A로 고치면 같은 키라서 갱신이 생략될 수 있다; A -> B -> A, 전체 초기화, 늦은 응답에서 프로필이 어떻게 남는지 확인하고, 모달 제거 전에 정정 경로를 정한다.
- 모달에만 있고 자동 누적에 없는 기능이 있으면 먼저 자동 누적에 옮기거나 모달 제거를 취소한다.
- 프로필 품질 회귀는 eval로 확인한다(DEC-0012).
- 이 검증이 통과하기 전에는 U10 모달을 제거하지 않는다.

DEC 충돌과 정리할 기록:
- DEC-0010: 본문은 임계값 이상 자동 적용이지만 코드는 2026-08-25 측정 후 단일 화자만 자동 적용한다; U9 착수 전에 대체 결정을 기록하며 "화자는 항상 바꿀 수 있고 이름을 잠그지 않는다"를 함께 적는다.
- U9-0(화자 지정과 공유 분리): 이 부수 효과를 다루는 기존 DEC가 없으므로(2026-10-21 확인) 구현 PR에서 새 DEC를 기록한다; DEC-0010 대체 결정과 같은 시기에 쓰면 서로 참조한다.
- DEC-0018: U15는 클릭 한 번을 동의로 유지하므로 충돌하지 않는다; "항상 보내기"를 고르면(Q8 (b)) 대체 결정이 먼저다.
- DEC-0014: 메모리 승인 단계를 추가하지 않는다(U13 유지).
- DEC-0005: U9처럼 노트마다 AI 호출이 늘면 lite 모델만 쓰고 비용을 측정한다.
- DEC-0017: 화면 흐름이 바뀌면 제품 문서(product-docs) 본문과 revision을 고치고 docs:check, Andrew 승인 후 docs:verify.
- DEC-0021: 화면 재설계는 백엔드 전면 재작성이 아니므로 충돌하지 않는다.

## 6. 기둥 3: 자동화

안전장치(모든 항목 공통):
- 자율 운영 변경의 무인 prod DB 쓰기 금지: F9.2 자동 수정은 영구 폐기했고, 마이그레이션은 사람이 SQL Editor에서 적용한다(PRE/POST check, ROLLBACK 블록).
  이 금지는 사람 승인 없이 도는 운영 자동화(수정, 정리, backfill, 마이그레이션)에 대한 것이다; 사용자가 시작하거나 승인한 정상 앱 실행의 쓰기(요약 저장, 화자 적용, 기존 memory fold, F9 티켓 등)는 범위 밖이며 A1, A4와 현재 동작은 이 규칙과 모순되지 않는다(M13).
- 자동화는 읽기, 검사, 알림, 사람이 승인하는 버튼까지만 한다.
- 외부 모델을 부르는 작업은 읽기 전용이 아니다: 비용과 데이터 처리가 생기므로 사람 승인 전에는 스케줄하지 않는다(A15b).
- 비밀값은 CI 로그에 남기지 않고, 새 비밀값을 CI에 넣는 항목은 Andrew 승인과 결정 기록이 먼저다.
- 결정 기록 검사는 권고로 유지한다(DEC-0019).

| # | 수동 작업 | 현재 | 제안 | 방법 | 안전장치 |
| --- | --- | --- | --- | --- | --- |
| A1 | 화자 이름 지정(사용자) | Suggest 클릭 후 선택 | 제안 자동 계산과 미리 채움(U9) | 요약 후 identify-speakers 호출(note와 전사 revision당 1회, S13 상한 안에서) | 다중 화자 자동 적용 금지, 화자 지정은 공유하지 않음(U9-0), 정밀도 측정 후 재검토(eval:self-precision) |
| A2 | AX-KH 참석자 확인(사용자) | 연락처에서 한 명씩 선택 | 일정 참석자를 후보로 제시(U16) | 별도 작업 두 개: 선택한 일정의 초대 목록 조회(현재 Graph select, graphService.ts:54에 attendees 없음; Calendars.Read 권한이 있어도 데이터는 아직 안 가져옴)와 회사 디렉터리의 검증된 object id 매핑 | 확인은 사람이 한다(접근 권한 부여); 자동 확정 없음; 외부 참석자, 미확인 매핑, 중복 이름은 후보로만; 조회 실패는 권한 추가 없이 끝냄; 이메일이나 표시 이름으로 권한을 정하지 않음(DEC-0001) |
| A3 | 프로젝트 정리(사용자) | 수동 배정 | 제안 후 한 번 탭(U18) | 제목, 참석자, 과거 배정 규칙 또는 lite 모델 | 자동 배정 금지 |
| A4 | 녹음 후 요약 시작(사용자) | 클릭 1~2회 | 자동 시작(U1, U2) | 프런트 흐름 변경, S11 제출 기록 선행 | 짧은 녹음 제외, 서버 접수 전 유예 중 취소, 진입 경로별 규칙(5절 U1/U2 표) |
| A5 | AX-KH 노드 "Meeting Note 현황" 갱신 | 커밋마다 stale, 에이전트 세션에서 개인 키로 수동 게시 | 반자동: CI가 `axkh:node:check`와 미리보기 산출물을 만들고, 주 1회 알림 | GitHub Action(키 없이 조립과 스캔만) | 게시(add_knowledge 2단계 확인)는 사람, 개인 키는 CI에 넣지 않음 |
| A6 | 제품 문서 서명 docs:verify | Andrew 승인 후 수동 | 반자동: PR에 stale 문서 목록 코멘트 | product-docs-check.yml 확장 | 서명은 사람 |
| A7 | 모바일 APK 빌드와 배포 | Andrew PC에서 build_apk.sh, 직접 전달 | CI에서 `flutter analyze`와 `flutter test`(현재 CI에 없음), 서명 빌드는 Andrew PC 유지 | GitHub Action(서명 없음) | DEC-0020: 키는 Andrew PC에만; CI 서명은 키를 비밀값으로 올려야 하므로 별도 결정 |
| A8 | Edge function 배포 7개 | `npx supabase functions deploy <name>` 수동 | 반자동: main의 `supabase/functions/**` 변경 시 승인 버튼 후 배포 | GitHub Action + environment 승인자 | 배포 순서 제약(예: generate-profile 게이트는 클라이언트 후)은 승인자가 판단; Supabase 토큰을 CI 비밀값으로 둘지 결정 필요 |
| A9 | 백엔드 배포 사전 점검(S1) | 없음 | 반자동: 활성 작업 수와 최근 갱신 수(개수만)를 돌려주는 관리자 전용 읽기 endpoint + 점검 스크립트, 판정은 4.5 규칙(모든 queued/processing, 최근 updated_at, 조회 실패는 통과 아님, 오래된 활성 행은 sweep 한 주기 뒤 재확인) | routes/에 새 라우트(index.ts 아님) | 읽기 전용, 개수 외 데이터 노출 없음; merge 전에 실행 |
| A10 | 배포 후 확인 | 사람이 /version, /health 확인 | 자동: merge 후 기대한 backend SHA(그 merge 커밋)와 /version을 비교해 제한 시간 안에서 확인, /health, 결과 기록; build filter 때문에 백엔드가 재배포되지 않는 merge(프런트나 문서 전용)는 backend SHA 대기를 생략하고 프런트 /version.json만 확인 | GitHub Action(읽기 전용) | 무료 플랜이면 주기 호출 금지(배포 직후 제한 시간 안의 확인만, keep-alive 아님) |
| A11 | 마이그레이션 적용 | 사람이 SQL Editor | 유지(사람) + 검사 자동화: PR에서 PRE/POST check, ROLLBACK 블록 존재 검사 | 스크립트 + CI | prod 적용은 계속 사람 |
| A12 | 마이그레이션 drift 확인 | 배포 전 사람이 컬럼 확인 | 반자동: 읽기 전용 점검 SQL을 RUNBOOK에 두고 배포 체크리스트에 포함 | 문서 | 읽기만 |
| A13 | known-client gate(#20) | 2026-10-26 이후 약 7일 로그를 사람이 읽고 env 변경 | 반자동: `ms_token_client_check` 로그 요약 스크립트(알 수 없는 client 수) | 로컬 스크립트 | env 변경은 사람 |
| A14 | 모니터링, 경보 | Render 메일(소유자만), sendWorkflowAlert, F9 | 확장: S5(sweep, terminal write, enrichment), 회사 주소로 받는 외부 감시는 무료 플랜 시간 예산(S9)을 해치지 않는 방식일 때만(주기 ping 금지) | alerts.ts, F9 | 무료 백엔드에 주기 ping 금지 |
| A15a | speaker:feedback 보고(집계) | 사람이 실행 | 주기 보고: 집계 조회만 | 로컬 또는 CI 스케줄(읽기 비밀값을 CI에 넣으려면 Andrew 승인) | 읽기 전용, 외부 모델 호출 없음, 사용자 식별 조각은 보고에 넣지 않음 |
| A15b | memory:gc 미리보기(모델 호출) | 사람이 실행 | 승인 전에는 모델을 부르지 않는 개수와 크기 집계만 자동; 모델 실행 미리보기 스케줄은 승인 후 | dry-run도 사용자마다 `consolidateMemory`로 Gemini를 부른다(workflow-server/scripts/consolidate-memory-gc.ts:65, memory.ts:1107); DB 최종 쓰기만 생략한다 | 처리 대상, 호출 상한, 비밀값의 CI 이동, 보고 보관과 마스킹을 Andrew가 승인한 뒤에만 스케줄; `--write`는 계속 사람만 |
| A16 | decisions:check | 사람이 실행, CI 권고 | 유지(이미 CI 권고) | 없음 | 권고 |
| A17 | 격리 SQL 검증(사람이 PGlite를 scratch에 설치하고 실행) | 수동, feedback harness만 있음(verify-feedback-issues-sql.mjs:17, :22) | 자동: 고정 버전 PGlite 설치, note RLS fixture(T2-1), workflow_job 부분 unique index와 S10 조건부 인수의 경합 검사, CI 명령 | 스크립트 + CI job | 새 의존성과 CI 변경은 Andrew 승인(Q11); prod 접속 없음, fixture만 |
| A18 | latency, 실패, 복구 집계(latency-report, memory-coverage 등) | 사람이 스크립트 실행 | 반자동: 익명 집계 보고(M1, M3 기준 포함) | 기존 workflow-server/scripts/latency-report.ts, memory-coverage.ts | 읽기 전용, 사용자 식별 정보 없이 개수와 분포만 |
| A19 | knowledge 모델 처리 승인, 실패 또는 과거 데이터 backfill(backfill-events.ts:106 등)과 복구 보고 | 사람 | 사람 유지(U15 한 번 클릭으로 없앨 수 있는 단계가 아님) | 없음 | 승인과 backfill 쓰기는 사람; 보고 조립만 자동화 가능 |

참고로 이미 자동인 것: docs/ai-native/history.md 재생성(pre-commit), 모바일 릴리스 태그(tag-mobile-release.yml), 차단형 CI 3 job, 작업 실패 메일(P0.3), F9 RCA 티켓.

요약: 20개 중 사용자 작업 4(A1~A4), 운영 작업 16(A5~A19, A15는 a와 b로 나눔).
자동으로 바꿀 것 6(A1, A4, A10, A14 일부, A15a, A17), 반자동(사람 승인 유지) 10(A2, A3, A5, A6, A8, A9, A12, A13, A15b, A18), 사람 유지 + 검사 자동화 2(A7 서명, A11), 사람 유지 1(A19), 그대로 1(A16).

## 7. 다시 만들기 대 단계적 교체

규모 근거(2026-10-21 재측정, main cab4b3e의 추적 파일 = 새 clone, 테스트 제외 줄 수, 집계 규칙은 2.2):

| 영역 | 규모 |
| --- | --- |
| 웹(src) | TS/TSX 84개 파일, 약 26,892줄, 페이지 4개가 1,917~4,090줄 |
| 백엔드(workflow-server/src) | 약 14,862줄(test-setup.ts 포함; index.ts 3,996, mcp 약 4,721, knowledge 약 2,058) |
| Edge function | 7개, 테스트 제외 TS 약 3,405줄 |
| DB | migration 56개, 약 5,096줄 |
| 모바일(Flutter) | lib Dart 42개 파일, 약 21,278줄 |
| 테스트 | 백엔드 27개 파일 약 4,060줄(재실행 580개 통과), 웹 11개 파일 약 1,006줄(99개 통과), 모바일 4개 파일 약 276줄 |

개정 2의 knowledge 약 3,800줄, edge function 약 3,900줄, 모바일 약 21,600줄은 집계 대상(테스트 포함 여부, 작업 트리)이 달랐다; 차이는 작고 결정(Q2)에 영향을 주지 않는다.

기능 수준에서는 Hansoo 말대로 복잡하지 않다(녹음 -> 전사 -> 요약 -> 검색, 공유).
복잡한 부분은 눈에 보이지 않는 곳에 있다.
- 보안 경계: 오디오 서명 소유권(R01), 조직 계정 제한(R02, DEC-0001), 공유 노트의 메모리/채팅 누출 수정(Group B), 버킷 RLS.
- 복구: heartbeat, orphan sweep 수렴, 멱등 note 쓰기, transcript checkpoint, 재시도.
- 외부 계약: MCP(Claude, ChatGPT 연결 URL과 OAuth), AX-KH 계약 파일(AX-KH 저장소와 byte-identical, DEC-0018), Azure 앱 등록과 모바일 서명(DEC-0020).
- 측정으로 얻은 결정: 화자 식별(DEC-0008~0012), 메모리(DEC-0013, 0014), lite 모델(DEC-0005).
- 운영 데이터: 수백 건의 회의(2026-08 기준 약 679건)와 사용자별 메모리, 화자 프로필.

| 기준 | 같은 기능 전면 재작성 | 단계적 교체 + 화면 재설계(기준안) |
| --- | --- | --- |
| 10/30까지 보여 줄 것 | 웹 핵심 흐름 시제품 정도(추정) | 단순해진 기본 흐름(U1, U3, U9, U15 등, U10은 선행 검증 통과 시)이 실제 서비스에서 동작 |
| 같은 기능 수준 도달 | 웹+백엔드 수 주(추정 4~8주, 코딩 에이전트 사용 가정), 모바일과 MCP, AX-KH 별도 | 단계마다 즉시 배포, 전체 구조 정리는 수 주에 걸쳐 진행 |
| 위험 | 고친 보안, 복구 문제 재발; 데이터 이전; 연결 URL, 모바일 앱, AX-KH 계약 재검증; 전환일 일괄 위험 | 단계마다 작고 되돌릴 수 있음; 대신 오래된 구조가 한동안 공존 |
| 사용자 영향 | 전환일에 한 번에 바뀜, 두 시스템 병행 기간 | 매주 조금씩 쉬워짐 |
| 비용 | 개발 시간 대부분이 재작성과 재검증에 듬 | 개발 시간 대부분이 사용자 체감 개선(단순화, 자동화)에 듬 |
| "새 Meeting Note"의 의미 | 새 코드베이스 | 새 사용 경험: 설정 없이 녹음하면 결과, 화자 제안 자동, AX-KH 한 번 클릭 |

추정의 한계: 4~8주는 코드 규모와 10월 작업 속도(커밋 70개)에 근거한 대략값이며 측정한 것이 아니다.

결론:
- 같은 기능의 전면 재작성은 사용자에게 보이는 변화 대비 위험과 재검증 비용이 크다.
- Hansoo가 원하는 "새 Meeting Note"는 화면과 흐름 수준의 재설계로 더 빨리, 더 안전하게 보여 줄 수 있다.
- 기술 발전(새 모델, webhook, 코딩 에이전트)은 단계적 교체 안에서도 하나씩 들일 수 있다(예: 4.3 (b), U9).
- 중간안: 웹 화면만 새 셸로 만들고(src/lib repository 재사용) 페이지를 하나씩 옮기는 방법(Q2 (c))은 T2 이후에 의미가 있다.
- 기준안은 DEC-0021 그대로이며 2026-10-21 Andrew가 승인했다(Q2 (a)).
- Hansoo용 한 장 요약: docs/refactor/REBUILD_VS_STRANGLER_MEMO.md.

## 8. 열린 후보 항목 (리팩터링 범위 밖, 상태 검증됨)

| 항목 | 상태 (d607a07) | 근거 |
| --- | --- | --- |
| DEC-0005 lite-only 불일치 | 수정 배포됨(17a0140이 라이브 백엔드 70d5c53에 포함, 2026-10-21 /version 확인); 운영 경로의 실제 모델 사용 확인은 남음 | d607a07에서는 공통 fallback(gemini-models.ts:63 STANDARD_FALLBACK_CHAIN 등)과 프로젝트 채팅 스트림(index.ts:2732)에 non-lite 모델이 있었고 drift 테스트는 등록 여부만 확인했다(Codex 10); 17a0140이 non-lite id를 drift 테스트로 막는다; 리팩터링 이동 커밋에서는 모델 체인을 바꾸지 않는다 |
| R08 프로젝트 공유 권한 불일치 | 열림 | note-audio-url에 project 분기 없음, `search_notes` 최신 RPC(20260810190000) 64행은 owner/shared_users만 본다 |
| R09 인증 대기 timeout 후 anon 진행 | 일부 해결 | 3f9b5bd로 provider clear 경로 해결; `src/config/supabaseConfig.ts:74-78` 15초 후 토큰 없이 진행, `src/context/AuthContext.tsx:159` 교환 fetch deadline 부재 |
| R10 오디오 서명 URL 만료 무시 | 열림 | `src/pages/SummaryHistory.tsx:508` 캐시, 1642/1670/1761에서 만료 확인 없이 재사용 |
| R12 관리 UI/문서 불일치 | 열림 | AdminControls.tsx:218-219 vs index.ts:300/1341(U22); RUNBOOK.md:36에 삭제된 update-user-memory; RUNBOOK.md:112 "Jobs are safe"; RUNBOOK.md:13 프런트 "static site" 표기는 확인 필요(S2) |
| P1.1 작업 실행 모델 | 재정의(4.3) | webhook_url 없음, transcribeWithAssembly(1330) 폴링 |
| Group B 2-user prod E2E | 보류(두 번째 계정 없음) | #4 regenerate 후 note_insight 소유 유지, #2 제3자 노트 비노출 |
| #20 known-client gate | 대기 | 2026-10-26 이후 약 7일 로그 검토 후 설정(A13) |
| 범위 밖 보안 후속 | 열림 | 정적 MCP key + 사용자 id 헤더로 사용자 선택 가능, edge verifyAppJwt가 exp/role/iss 미확인 |
| DEC-0016 순서 표현 | 열림(문서) | "가장 먼저 dispatch"는 실제 knowledge(3684) -> OPTIONS -> MCP(3693)와 다름; T1-11 때 정리 |

- 후보를 고칠 때는 해당 코드를 옮긴 단계와 별도 커밋으로, E2E 재현 후 수정한다.
- #20은 SUPABASE_TOKEN_REQUIRE_ID_TOKEN을 끈 채로 둔다.

## 9. 지켜야 할 규칙

- 커밋과 푸시는 Andrew가 요청할 때만 한다.
- 코드 변경은 작업 브랜치 -> PR -> CI 통과 -> 사전 점검 -> merge로만 main에 들어간다(Q5, 2026-10-21); main 직접 push는 Andrew가 요청한 문서 전용 변경만.
- main merge는 web과 backend를 자동 배포한다(백엔드 재시작, DEC-0003, build filter가 있으면 해당 경로 변경 때만): 4.5 사전 점검을 merge 전에 하고, 백엔드를 그에 의존하는 프런트보다 먼저 배포한다.
- 진행 중인 녹음과 작업은 잃지 않는다(Q10); 허용 중단 시간은 엄격하지 않으므로 속도보다 이 조건을 우선한다.
- 화자 이름 지정은 노트 공유나 권한 변경을 하지 않는다(U9-0); 공유는 사용자가 누르는 별도 동작이다.
- Render 플랜은 무료로 유지한다; 유료 전환을 제안하지 않는다(Andrew는 설정만 바꿀 수 있고 플랜은 바꿀 수 없음).
- 명시적 경로만 stage한다(git add -A, git add ., commit -a 금지), --no-verify 금지.
- 공유 트리에서 stash, checkout, reset, clean, rebase 금지.
- 커밋 작성자는 andrewyoo_tecace이고 에이전트 이름, Co-Authored-By, 세션 트레일러를 넣지 않는다.
- 커밋 전에 비밀값 검사를 한다; 비밀값은 채팅과 파일에 쓰지 않고 env는 이름만 다룬다.
- 문서와 결정 기록에 tenant id, client id, oid, 이메일을 쓰지 않는다.
- prod DB에는 쓰지 않는다: 마이그레이션은 파일만 만들고 Andrew가 SQL Editor에서 적용하며 PRE/POST check와 ROLLBACK 블록을 포함한다.
- 자율 운영 변경의 무인 prod DB 쓰기 자동화 금지(F9.2 영구 폐기; 범위는 6절 안전장치와 M13).
- 테스트는 .env를 읽지 않고 실제 서비스에 닿지 않는다(T1-0a, canary 테스트로 강제).
- 로컬 서버와 테스트 서버는 127.0.0.1에만 바인딩한다.
- 버그는 E2E로 재현한 뒤 수정하고 같은 방식으로 검증한다(두 번째 계정이 필요한 경우는 4.7의 대체 절차).
- 파일 변경 전 `npm run decisions:check`를 돌리고, active 결정과 모순되면 먼저 대체 결정을 기록한다.
- 제품 문서 본문을 바꾸면 revision을 올리고 `npm run docs:check`를 돌리며, docs:check의 신선도 검사는 권고(workflow-server/scripts/product-docs/check.ts:6)이므로 종료 코드 0만으로 최신성을 판정하지 않는다; 서명(docs:verify)은 Andrew 승인 후.
- Gemini는 lite 모델만(DEC-0005), 중첩 responseSchema 금지(DEC-0006).
- Hansoo에게 보내는 메시지는 쉬운 말로 쓴다(코드 이름, SHA, 전문 용어 없이).
- C1 파일 5개는 건드리지 않는다: C1_M4A_RECOVERY_DESIGN.md, meeting-note-mobile/app/ios/Runner/AppDelegate.swift, meeting-note-mobile/app/ios/Runner/AudioMergePlugin.swift, meeting-note-mobile/app/lib/features/record/data/recording_service.dart, meeting-note-mobile/app/lib/features/record/data/audio_merge.dart (작성자 PC 미커밋 상태 기준).
- 문서는 한 문장 한 줄로 쓰고 em-dash를 쓰지 않는다.
- T1-0a 이후 index.ts에 새 라우트나 새 최상위 함수를 추가하지 않는다.
- 리팩터링 커밋과 동작 변경 커밋을 섞지 않는다; 이동 커밋은 오류 문구, 라우트 순서, 응답 형태를 바꾸지 않는다.
- 이동 PR은 관련 결정의 `paths`와 제품 문서 `depends_on`을 함께 갱신한다.
- 개인정보 기본값을 느슨하게 하지 않는다: 자동 전송, 자동 공유, 자동 권한 부여 금지(DEC-0018).

## 10. 위험 등록부

| 위험 | 가능성 | 영향 | 완화 |
| --- | --- | --- | --- |
| 배포 재시작으로 진행 중 작업 중단 | 높음 | 높음(Q10: 작업을 잃으면 안 됨) | 4.5 사전 점검(merge 전, 모든 백엔드 배포), 시간대, M1 집계, S12, S10, Q3 (b) |
| 배포 중 구 인스턴스와 새 인스턴스 중첩으로 같은 job 이중 실행, 실행권 없는 쓰기 | 중 | 높음 | S10 원자적 인수, lease와 실행 세대, 모든 쓰기에 세대 조건; S12 종료 순서; 4.6 인스턴스 중첩 시나리오와 A17 경합 검사 |
| 종료 처리가 완료된 job을 실패로 되돌림 | 중 | 중 | S12: completed 유지, 후처리 미완료 별도 기록; 4.6 완료 후 실패 시나리오 |
| 응답 유실이나 앱 재실행으로 제출 기록 손실, 중복 제출 | 중 | 높음 | S11 POST 전 영속 제출 기록, 기존 job 또는 note 먼저 조회 |
| 화자 지정이 노트 공유까지 수행(현재 수동 지정 경로) | 높음(현재 동작) | 높음 | U9-0: 지정과 공유 분리, 한 번 클릭 공유 확인 버튼, 웹과 모바일 테스트, 새 DEC |
| 동시 실행이나 큰 입력으로 메모리 과부하(무료 인스턴스) | 낮음~중(U1, U9로 증가) | 높음 | S13 전역 및 사용자별 상한, 입력 크기 상한, readBody 바이트 카운터; 거부나 지연 시 원본 보존 |
| 장애 중 경보 메일과 RCA 비용 폭주 | 중 | 낮음~중 | S5 공통 중복 억제, 시간창, 비용 상한, 재귀 방지 |
| 월말 무료 시간 상한 정지 | 중 | 높음 | S2, S9(무료 플랜 유지 결정, 워크스페이스 전체 사용량과 bandwidth, build 예산 확인), S10, S11(정지 중 제출 보존과 안내) |
| 서버가 잠든 동안 knowledge worker 처리가 멈춤 | 중 | 낮음~중 | S9: 깨어난 뒤 재개 조건과 허용 지연, keep-alive 금지 |
| 유휴 정지 뒤 첫 요청 지연과 재시작으로 작업 중단(무료 플랜 유지) | 중 | 중 | S11(클라이언트 재시도, backoff), S12(SIGTERM), S10(재개) |
| 자동 제안이 틀렸는데 화자 이름이 고정됨 | 중 | 중 | 5절 화자 편집 요구, U9 E2E |
| U10 모달 제거 뒤 프로필 누적이 모자람 | 중 | 중 | U10 선행 검증 통과 전 제거 금지 |
| 테스트가 로컬 .env로 운영 서비스에 닿음 | 중(MCP 경로는 7f66401로 막힘, index.ts를 import하는 테스트가 생기면 다시 높음) | 높음 | T1-0a 필수 선행 조건, 넓힌 canary 테스트(index import, sentinel, redirect, dispatcher, 타이머) |
| 로컬/테스트 서버가 모든 인터페이스에 바인딩 | 중 | 중 | 127.0.0.1 바인딩(T1-0a, T1-0b), 프런트 `--host 127.0.0.1` |
| 오류 문구 변경으로 HTTP status가 바뀜 | 중 | 중 | 문구 고정, getHttpStatus 특성화 |
| 라우트 순서/매칭 차이 | 중 | 높음 | parity + 계약 테스트 |
| 인증 뒤 처리 회귀를 무인증 테스트가 못 잡음 | 높음(대비 없으면) | 높음 | 계약 테스트(가짜 경계), SSE 표 |
| env 분리 시 dotenv 순서 붕괴, .env 경로 기준 변경 | 높음(대비 없으면) | 로컬 중 | loadEnv 첫 import, 4가지 실행 방식 확인 |
| 순환 import(jobs와 pipeline, raiseIncident) | 중 | 중 | T1-9a/T1-9b 분리, 의존 주입, 자동 순환 검사 |
| 모듈 수준 상태 중복 | 중 | 중 | 단일 소유 모듈 |
| 동시 제출, sweep 경합 등 장애 순서 회귀 | 중 | 높음 | T1-9 장애 시나리오, PGlite로 부분 unique index |
| repository가 공유 노트 읽기를 좁힘 | 중 | 중 | 4.7 권한 계약 표 |
| 롤백이 데이터와 작업을 복구하지 못함, 대시보드 롤백이 자동 배포를 끔 | 중 | 중 | 4.5 롤백 절차 |
| Render가 CI 전에 배포 | 낮음(Q5 (c) 결정 후) | 중 | Q5 (c) 운영 규칙, branch protection(Andrew가 나중에 결정), (a) 보조 설정 |
| 결정과 제품 문서 추적 경로가 이동 후 낡음 | 높음 | 낮음 | 이동 PR에 paths/depends_on 갱신 |
| 단순화가 개인정보 기본값을 느슨하게 함 | 낮음 | 높음 | 5절 원칙, DEC-0018, U15~U18 금지 사항 |
| 자동 요약 시작으로 실수 녹음 비용 증가 | 중 | 낮음 | 짧은 녹음 제외, 서버 접수 전 유예 중 취소(접수 뒤 취소는 보장하지 않음) |
| 자동 화자 제안으로 AI 비용 증가 | 중 | 낮음 | lite 모델, 비용 측정, note와 전사 revision당 1회 계산 |
| 자동 프로필 누적이 틀린 지정을 되돌리지 못함 | 중 | 중 | U9 완료 기준, U10 선행 검증의 재편집 일관성, U11 교정과 삭제 경로 |
| 모델을 부르는 dry-run을 읽기 전용으로 오인해 스케줄 | 중 | 중 | A15a와 A15b 분리, 승인 전 모델 호출 금지 |
| 모바일 UI 권한 불명확(디자이너 제약) | 중 | 중 | Q7 |
| 나중에 전면 재작성으로 방향이 바뀜(현재는 단계적 교체로 결정됨) | 낮음 | 높음 | 단계마다 독립 가치, 7절 비교, 대체 결정 기록 |
| 병행 기능 작업(DEC-0005 수정 등)과 index.ts 충돌 | 중 | 중 | 새 코드 index.ts 금지, 줄 번호 재확인, 작은 단계 |
| 모바일 C1 스캐폴드 충돌 | 낮음 | 중 | C1 파일 불가침 |

## 11. 완료 정의

- 단계 완료: 특성화 테스트 선행, parity와 계약 테스트 통과, CI 3 job 통과, 순환 import 0, decisions:check 확인, 4.5 사전 점검 기록, 배포 후 /version과 /health 확인, 해당 경로 E2E 1건, 직전 정상 SHA와 롤백 방법 기록, 이 문서의 상태 표 갱신.
- 기둥 1 완료: 4.6과 4.7 완료 기준, S10~S13 구현과 테스트(인스턴스 중첩, SIGTERM과 SIGKILL 포함), M1~M6 목표, 결정 paths와 product docs depends_on 갱신, DEC-0016 순서 표현 정리.
- 기둥 2 완료: 5절 처리안이 반영되고 M7~M11 목표, 바뀐 결정(DEC-0010 대체 등) 기록, 제품 문서 갱신과 서명.
- 기둥 3 완료: 6절 표의 상태가 갱신되고 M12, M13 목표.
- 전체 완료: 세 기둥 완료, DEC-0021 status 재확인(Andrew 승인 2026-10-21 반영).
- 진행 상태는 이 문서의 표에만 기록한다.

## 12. Gotchas

- Windows CRLF와 LF 차이: 제품 문서 해시는 정규화되지만(358bcaa) 생성 파일은 조심한다; 작성자 PC에서 build.gradle.kts의 M 표시는 CRLF 차이뿐이다(2026-10-21 시점).
- `.githooks/pre-commit`이 docs/ai-native/history.md를 재생성한다(정상).
- AX-KH node 갱신은 수동이고 커밋 후 `npm run axkh:node:check`는 항상 stale이 된다; 개인 AX-KH key가 필요하다(A5).
- 인프라 소유(2026-10-20 검증): 로그인 테넌트는 TecAce 회사 테넌트, 앱 등록 소유자는 Hansoo와 Andrew, Render workspace 소유자는 Hansoo.
  Andrew는 Render 설정(build filter, 자동 배포 등)을 바꿀 수 있지만 플랜은 바꿀 수 없다(2026-10-21).
- 모바일 APK는 기존 debug key로 서명해야 한다(DEC-0020).
- repo 마이그레이션은 자동 적용되지 않고 prod에 drift 이력이 있다; 코드 배포 전 컬럼을 확인한다.
- edge function은 `npx supabase functions deploy <name>`로 수동 배포한다(A8).
- MCP는 특정 경로만 소유하며 `/admin/backfill-insight`는 index.ts if-chain이 처리한다.
- dispatch 순서는 knowledge(3684) -> OPTIONS -> MCP(3693)이다; router 이동 시 유지한다.
- index.ts는 import 시 .env를 읽고(스위치 없음) process 핸들러와 undici global dispatcher를 등록한다(T1-0a가 없앤다); mcp/lib/env.ts는 `MEETING_NOTE_SKIP_DOTENV=1`이면 .env를 건너뛴다(7f66401).
- `readBody`(index.ts:354)의 오류 문구는 getHttpStatus 판정에 쓰이므로 S13에서 구현을 바꿔도 문구는 그대로 둔다.
- 화자 수동 지정은 지금 노트 공유까지 한다(U9-0에서 분리하기 전까지 기존 동작).
- `TRANSCRIPTION_MODEL_TEST_USER_ID`, `INSIGHT_BACKFILL_ADMIN_IDS` 같은 하드코딩 id는 옮기되 값을 문서나 로그에 복사하지 않는다.
- 커버리지와 순환 검사 도구는 설치돼 있지 않다; 새 의존성은 Andrew 승인 후에만(Q11).
- PGlite는 저장소 의존성이 아니다; 기존 SQL harness는 scratch 폴더에 설치한 PGlite 경로를 인자로 받는다.
- 무료 백엔드에 주기 ping을 걸지 않는다(무료 시간 소모).

## 13. 검증 명령

- Root: `npx vitest run`, `npm run lint`, `npm run build`, `npm run decisions:test`, `npm run decisions:check`, `npm run axkh:node:test`.
- workflow-server: `npm test`, `npx tsc --noEmit`, `npm run build`, `npm run docs:check`.
- SQL harness: `node workflow-server/scripts/verify-feedback-issues-sql.mjs <PGlite dist/index.js 절대 경로>` 방식.
- Mobile(범위일 때만): `flutter test`, `flutter analyze`(기존 info 34건).
- Live: GET https://meeting-note-backend-njfb.onrender.com/health, /version, https://meetingnote.tecace.com/version.json.
- 기준선(2026-10-21 개정 3 재실행, cab4b3e): 백엔드 580 통과, 프런트 99 통과(11 파일), index.ts 3,996줄; lint 0은 이전 기록(이번에 재실행하지 않음).
- 과거 기록: 백엔드 570, index.ts 3,995줄(d607a07, 17a0140 이전).
- 줄 수 재현: 2.2의 집계 규칙(git tree 기준, 테스트 제외 규칙, 기준 SHA)을 따른다.

## 14. Best-practice check

| 관행 | 판정 | 내용 |
| --- | --- | --- |
| 이동 전 특성화 테스트 | Fixed | T1-0a에 무인증 parity와 인증 후 계약 테스트 |
| 테스트 격리(실서비스 차단) | Fixed | T1-0a 필수 선행 조건 5개와 canary |
| 작고 독립 배포 가능한 단계 | Fixed | 단계마다 검증, 롤백, 완료 기준 |
| big-bang 브랜치 금지 | Pass | 단계 1개 = 커밋 1개 |
| 동작 변경에만 feature flag | Pass | 동작 변경은 별도 커밋 |
| 배포 재시작 대비 | Fixed | 모든 백엔드 배포에 merge 전 사전 점검, S10 원자적 인수, S12 종료 순서 |
| 롤백의 데이터, 작업 복구 | Fixed | 4.5 롤백 절차 |
| 측정 가능한 목표 | Fixed | 1.3 M1~M13, 테스트 수와 줄 수는 보조 지표 |
| 의존 순서 | Fixed | 4.8 실제 의존, T1-9a/T1-9b |
| 위험 등록부, 완료 정의 | Fixed | 10절, 11절 |
| 결정 기록과 추적 경로 | Fixed | 이동 PR에 paths/depends_on 갱신 |
| CI 통과 후 배포 | Fixed(규칙), 강제는 Gap | Q5 (c) 결정(2026-10-21): 브랜치 + PR + CI 후 merge; branch protection으로 강제할지는 Andrew가 나중에 결정 |
| 클라이언트 재시도와 멱등 제출 | Fixed(계획) | S11 POST 전 영속 제출 기록과 재시도 계약 |
| 과부하 보호 | Fixed(계획) | S13 동시 실행과 입력 크기 상한 |
| 커버리지 측정 | Gap | 분기 체크리스트로 대신, 도구는 Q11 |
| 사용자 가치 중심 범위 | Fixed | 세 기둥, 5절, 6절 |
| 기존 패턴 우선 | Pass | `src/lib/<domain>/`, `handle<Group>Request` |

## 15. Codex 검토 반영표

이 표의 "반영"은 계획 문서의 수정을 뜻하며 구현 완료나 운영 검증 완료를 뜻하지 않는다(Codex 2차 19).

### 15.1 1차 검토 반영표

2차 검토 판정: 반영 10건, 부분 반영 4건(2, 6, 7, 9); 부분 4건은 개정 3에서 15.2의 18, 5, 2~4, 17로 보완했다.

| Finding | 심각도 | 반영 위치 |
| --- | --- | --- |
| 1 작업 큐와 파이프라인 순환 | High | 4.4 의존 방향, 4.6 T1-9a -> T1-10a/b/c -> T1-9b |
| 2 T1-1~T1-8 독립성, 첫 배치 | Med | 4.6 소유 표와 선행 열, 4.8 실제 의존, 첫 배치에 T1-0d |
| 3 무인증 parity 한계 | High | 4.6 T1-0a 계약 테스트와 명시적 테스트 표 |
| 4 T1-9/T1-10 장애 시나리오 | High | 4.6 필수 장애 시나리오, PGlite 검증 |
| 5 서버 바인딩 | High | T1-0a `listen(0, '127.0.0.1')`, T1-0b loopback, 9절 규칙 |
| 6 모든 백엔드 배포의 사전 점검 | Med | 4.5(updated_at 2분 조건), Q5 |
| 7 롤백의 데이터와 작업 복구 | Med | 4.5 롤백 |
| 8 T2 권한 계약, T2-4 기준 | Med | 4.7 권한 계약 표, T2-4 추출 단위, mock 대체 기록 |
| 9 import 가능화와 dotenv 검증 범위 | Med | 4.4 startServer 소유, T1-0a, T1-0b |
| 10 DEC-0005 불일치 | Med | 8절(진행 중, 별도 커밋) |
| 11 결정과 제품 문서 추적 경로 | Med | 4.6 공통, 8절 DEC-0016, 9절 규칙 |
| 12 기준 SHA와 작업 트리 설명 | Low | 2.1, 4.4 신규/기존 표시, 9절과 12절의 시점 표시 |
| 13 테스트 수와 줄 수는 보조 지표 | Low | 4.6 완료 기준, 1.3 M5 |
| 14 범위 질문의 영향도와 시점 | Med | 3절 표(결정자, 결정 시점), Q4, Q10 추가 |

### 15.2 2차 검토 반영표 (개정 3)

출처: docs/reviews/2026-10-21-codex-refactor-plan-review-2.md (기준 cab4b3e).
19건 모두 main 코드와 대조해 확인했고 반대 의견은 없다.

| Finding | 심각도 | 반영 위치 |
| --- | --- | --- |
| 1 화자 지정이 노트 공유까지 수행 | 높음 | 3절 Andrew 결정(분리, 한 번 클릭 공유 버튼), 5절 U9-0과 원칙, U17, U9 완료 기준, 9절 규칙, 10절 위험, 12절 |
| 2 부분 unique index만으로 중복 실행을 막지 못함, 재과금 없음의 범위 | 높음 | 4.2 S10(원자적 인수, lease, 실행 세대, 전사 id 즉시 저장, 제출 후 저장 전 구간), 3절 Q4, 4.3 (b), 4.5 롤백, 4.6 인스턴스 중첩 시나리오 |
| 3 S12 종료 처리와 완료 후처리 구분 | 높음 | 4.2 S12(종료 순서, completed 유지, worker 중지, SIGTERM과 SIGKILL 시험), S4, 4.6 완료 후 실패 시나리오, 10절 |
| 4 S11 영속 제출 기록 | 높음 | 4.2 S11(POST 전 기록, 재시도 계약), 4.5 롤백, U1/U2 선행 조건 |
| 5 사전 점검 순서와 SQL 조건 | 높음 | 4.5 전달 순서(merge 전 점검)와 판정 규칙, S1, A9, A10, 9절 |
| 6 무료 플랜의 다른 제한과 잠든 worker | 중간 | 4.2 S9(keep-alive와 실제 작업 폴링 구분, bandwidth와 build 예산, worker 재개 조건), S2, 10절 |
| 7 동시 실행과 입력 메모리 상한 | 중간 | 4.1 D9, 4.2 S13, U9 완료 기준(revision당 1회 계산), 10절 |
| 8 U1/U2 취소 경계, 옵션, 첨부 의미 | 중간 | 5절 U1, U2, U5, U1/U2 진입 경로 표, 입력 snapshot |
| 9 U15 한 번 클릭과 실행 취소의 실제 상태 | 중간 | 5절 U15(enable_all 재사용, 상태 재조회, 취소 문구, 수용 테스트) |
| 10 U9 재편집과 프로필 누적, 늦은 응답 | 중간 | 5절 U9 완료 기준, 화자 편집 요구, U10 선행 검증의 재편집 일관성, U11 |
| 11 다른 진입점과 별도 흐름 | 중간 | 5절 U7, U11, U14, U17, U1/U2 표, 원칙(OS 권한), 하위 수용 기준(이슈 작성) |
| 12 U21 번역 근거 | 중간 | 5절 U21(실제 데이터 유무로 표시) |
| 13 A2 참석자 후보와 object id | 중간 | 5절 U16, 6절 A2 |
| 14 memory:gc dry-run의 모델 호출 | 중간 | 6절 A15a, A15b, 안전장치, 10절 |
| 15 SQL 검증 재현성과 사람 승인 작업 | 중간 | 6절 A17, A18, A19, 안전장치의 범위, 1.3 M13, 4.6, 4.7 T2-1 |
| 16 일반 경보 메일 throttle, M1/M3 관측 | 중간 | 4.2 S5, 1.3 M1, M3, 10절 |
| 17 T1-0a 부분 선행 수정과 남은 검증 | 중간 | 4.6 T1-0a 상태와 canary, 1.3 M4, 10절, 12절 |
| 18 선행 관계와 첫 배치 | 중간 | 4.6 T1-2, T1-3, T1-9b, 4.4 issueLinks.ts, 4.8 첫 배치와 선행 조건, 3절 Q3 |
| 19 규모 수치와 결정 기록용 요약 | 낮음 | 2.1, 2.2, 7절, 13절(570/99는 과거 기록), 15절 머리말, REBUILD_VS_STRANGLER_MEMO.md(유료 전환과 방향 결정 요청 삭제, U10과 재과금 문구) |

## 16. 참고 문서

- AGENTS.md, RUNBOOK.md, OPS_BACKLOG.md(P0, P1.1, P1.3), LOCAL_DEV.md.
- docs/reviews/2026-10-21-codex-refactor-plan-review.md (Codex 1차 검토).
- docs/reviews/2026-10-21-codex-refactor-plan-review-2.md (Codex 2차 검토).
- Render 문서: https://render.com/docs/free#free-web-services, https://render.com/docs/deploys#graceful-shutdown (S2, S9, S12).
- docs/refactor/REBUILD_VS_STRANGLER_MEMO.md (Hansoo용 요약).
- docs/decisions/README.md, DEC-0001, DEC-0003, DEC-0005, DEC-0006, DEC-0008, DEC-0010, DEC-0014, DEC-0015, DEC-0016, DEC-0017, DEC-0018, DEC-0019, DEC-0020, DEC-0021.
- workflow-server/content/product-docs/ (architecture.md, f2-feedback.md, speaker-id.md, transcription-diarization.md가 index.ts에 depends_on).
- docs/reviews/2026-09-29-ops-stability-review.md (R01~R12, 장애 관측 공백).
- docs/ai-native/history.md, AXKH_NODE_AND_DECISIONS_PLAN.md, docs/axkh-node/README.md.
- 이력(대체됨): docs/reviews/2026-10-09-renovation-review.md, docs/reviews/2026-10-09-strangler-plan.md, docs/reviews/2026-10-09-manual-deploy-steps.md, docs/handoffs/2026-10-20-refactor-handoff.md.

## 17. Codex 검토 요청 (3차, 선택)

2차 검토 요청(개정 2)은 docs/reviews/2026-10-21-codex-refactor-plan-review-2.md로 끝났다.
3차 검토는 Andrew가 요청할 때만 하며, 하게 되면 개정 3에서 바뀐 부분만 본다.
Codex는 코드를 수정하지 않고, 이 문서와 repo를 읽어 아래를 검토한다.
기준 커밋은 이 개정이 들어간 커밋이며, 개정 3에서 새로 적은 줄 번호는 cab4b3e 기준이다(그 밖의 index.ts 줄 번호는 d607a07 기준, 3966행 뒤만 +1).
이미 정해진 선택(3절의 Andrew 결정, 무료 유지, Q5, Q10, 화자 지정과 공유 분리)은 다시 묻지 않는다.

1. 15.2 반영표의 각 위치가 2차 지적을 충분히 반영했는가.
2. S10(원자적 인수, lease, 실행 세대, 전사 id 저장), S11(제출 기록과 재시도 계약), S12(종료 순서), S13(과부하 방지)의 설계 항목에 빠진 실패 구간이 있는가.
3. 4.5의 merge 전 사전 점검 판정 규칙과 A9, A10이 서로 맞는가.
4. U9-0(화자 지정과 공유 분리)의 테스트 범위와 U1/U2 진입 경로 표의 "아니오" 두 경로가 타당한가.
5. 4.8 첫 배치와 선행 조건에 남은 순서 문제가 있는가.

피드백 형식:
- 번호가 붙은 finding 목록.
- 각 finding에 심각도(High, Med, Low), 이 문서의 절 번호와 repo 파일:줄 참조, 구체적인 수정 제안(바꿀 문장이나 추가할 행)을 적는다.
- 동의하는 부분은 짧게 "동의"로만 적고, 확인하지 못한 것은 확인하지 못했다고 적는다.
