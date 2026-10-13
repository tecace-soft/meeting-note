# 에이전트용 제품 문서 확장 플랜

작성일: 2026-10-13
상태: 제안 v2 (리뷰 2회 반영). 1차 docs 기능은 구현 완료(미커밋).
선행 문서: `AGENT_DOCS_DESIGN.md` (1차 설계 v2, 보안 모델).

## 0. 리뷰 반영 이력 (외부 모델, 2026-10-13)

- [P1] stale 신호를 CI 경고로 끝내지 말고 **웹·MCP 응답 본문까지 전달**(§3.3). 비교 커밋 없으면 `unknown`.
- [P2] 검증 기록을 본문에 묶기: **`verified_body_hash`/`verified_revision`**, 본문 변경 시 재검증 대상 전환, 문서별 담당자(§4).
- [P2] 생성과 CI 검사 역할 분리: 로컬=생성, CI=**`--check`(불일치 시 실패)** + **git 이력 확보(fetch-depth)**(§3.4).
- [P2] `mcp-tools-reference`는 **혼합형**: 이름/입력/설명은 생성(`tools/list`), 출력형태·소유/공유/쓰기 권한은 **검증된 서술**(§2, §6).
- [P1] 현재 1차 `orgVerified`는 정적키·개인토큰만 true → **OAuth proxy·테넌트검증 Azure-JWT 경로가 문서 조회 거부됨**. 지원 연결 방식별 "내부 성공/외부 거부"를 2차-A 진입조건으로(§5).
- [P2] 저장소 기준 명세 vs 운영 검증 구분: migration 변경 탐지는 운영 적용/수동 정책을 모름 → `data-model-and-security`에 둘을 구분 기록, `depends_on`에 디렉터리/glob/삭제/이름변경 규칙(§3.2, §2).

## 1. 목표

1. **커버리지:** 핵심 서브시스템을 문서화(1차는 5개뿐).
2. **신선도(최대 리스크):** 틀린 문서 → 틀린 코드. 드리프트를 **에이전트가 읽는 응답에서** 식별 가능해야 함.
3. **발견성:** 에이전트가 목록만 보고 적합 문서를 고를 수 있어야 함.

"문서 더 쓰기"가 아니라 "믿을 수 있는 문서 세트를 지속 유지하는 체계"를 세운다.

## 2. 추가 문서 후보

| slug(안) | 섹션 | 유형 | 근거 소스 | 우선순위 |
| :--- | :--- | :--- | :--- | :--- |
| `architecture` | Getting started | 서술 | 프론트/workflow-server/edge/Supabase/Render 구조, 배포 | P1 |
| `data-model-and-security` | Getting started | 혼합 | 스키마+RLS(저장소 기준) / 운영 확인 상태 **구분 기록** | P1 |
| `mcp-tools-reference` | Integrations | **혼합** | 이름/입력/설명=생성(`tools/list`), 출력·권한=서술 | P1 |
| `transcription-diarization` | Features | 서술 | record→AssemblyAI→diarization(speaker cap) | P2 |
| `speaker-id` | Features | 서술 | signature(TF-IDF)+anchor, auto-apply, Suggest | P2 |
| `memory` | Features | 서술 | F1 user_memory + memory-in-the-loop | P2 |
| `knowledge-axkh-integration` | Integrations | 서술 | F4 색인 + AXKH 전달(producer) | P2 |
| `f9-ops-agent` | Features | 서술 | 탐지→RCA→F2 티켓 | P3 |
| `eval-harness` | Features | 서술 | F8 eval/gate, speaker-backtest | P3 |
| `mobile-app` | Features | 서술 | Flutter 앱, 수동 APK | P3 |

2차-B = P1 3개. mcp-tools-reference 생성기를 **MCP 입력 참조 1개로 먼저 검증**한 뒤 확장.

## 3. 신선도/드리프트 설계

### 3.1 매니페스트 메타 (확장)

문서별:
- `slug, title, section, order, summary`
- `verified_revision` (= 사람이 마지막으로 검증한 커밋), `verified_at`, `verified_body_hash` (검증 시점 본문 해시), `verified_by`(담당자)
- `depends_on`: 이 문서가 설명/파생하는 **코드 경로 목록(글로브 허용)**. 규칙: 디렉터리는 재귀, 글로브(`src/mcp/tools/*.ts`) 허용, **삭제/이름변경도 변경으로 간주**(경로가 사라지면 stale 사유).
- (생성형 문서) `generated: true`, `generated_from`(추출 소스), `generator`(명령).

`last_updated`/배포 SHA와 **검증 메타는 분리**. 생성형은 "생성됨 ≠ 검증됨".

### 3.2 생성 vs 서술 (유형)

1. **생성형:** 코드에서 결정적으로 추출(release-history=git log, mcp-tools 이름/입력/설명=`tools/list`). 생성기가 본문 재생성.
2. **서술형:** 설계 의도/트레이드오프(사람이 쓰고 검증).
3. **혼합형:** 서술 본문 + 생성 블록(마커로 구분). `mcp-tools-reference`(출력·권한은 서술), `data-model-and-security`(스키마 블록=생성, 운영 상태·정책=서술).

### 3.3 런타임 신선도 (웹·MCP 응답까지 전달 — 리뷰 P1 #1)

웹 목록/본문 + MCP `get_product_docs` 응답에 다음을 포함:
- `checked_against_commit`: 백엔드 현재 배포 SHA(`VERSION_INFO`/`RENDER_GIT_COMMIT`), 모르면 `unknown`.
- `freshness`: `fresh | stale | unknown`.
- `stale_reasons`: 사유 배열.

런타임이 git 없이 신뢰성 있게 계산하는 신호(배포 호스트에 git 미보장):
- **본문 변경:** 현재 본문 해시 ≠ `verified_body_hash` → `stale`, 사유 `"body edited since verification"`. (리뷰 P2 #2)
- **검증 메타 부재** → `unknown`.
- **배포-검증 커밋 괴리(소프트):** `verified_revision`가 `checked_against_commit`보다 과거이고, CI가 미리 계산해 **배포에 동봉한** `freshness.json`에 dep-drift가 기록돼 있으면 그 사유를 그대로 노출. (CI가 git으로 계산 → 런타임은 읽기만)

가이드 규칙: **stale/unknown 문서를 쓸 때는 반드시 코드로 교차 확인**하라고 `guide-for-ai-agents`에 명시.

### 3.4 CI 드리프트 검사 (git 이력 필요 — 리뷰 P2 #3)

- 로컬: `docs:generate` (생성형 재생성 + `verified_body_hash` 재계산 도우미).
- CI: `docs:check` = **`--check` 모드**로 (1) 생성형 재생성 결과가 커밋본과 **불일치하면 실패**, (2) 각 문서 `depends_on`이 `verified_revision` 이후 변경됐는데 재검증 안 됐으면 **stale로 표시 + `freshness.json` 기록**(강제 실패는 정책 선택). 기존 생성기의 실패-허용(soft) 정책은 **가져오지 않음**.
- CI checkout은 기본 1커밋만 받으므로 **`fetch-depth: 0`(또는 verified_revision까지)** 로 이력 확보.

## 4. 검증 절차 (리뷰 P2 #2)

- 문서별 `verified_by`(담당자) + 검증 완료 근거.
- 검증 = 사람이 본문을 코드와 대조 → `verified_revision`/`verified_at`/`verified_body_hash` 갱신.
- 본문이 바뀌면(해시 불일치) 자동으로 재검증 대상(stale).
- `depends_on` 코드가 바뀌면 **해당 문서만** 재검토(전체 아님).

## 5. 보안 (2차-A 진입조건 — 리뷰 P1 #5)

- **`orgVerified` 범위 확대:** 현재 `staticKeyAuthorized || personalToken`만 true. `resolveChatGptUserId`가 해석 경로(트러스트)를 함께 반환하도록 바꿔, **OAuth proxy / MCP_USER_TOKENS / 테넌트검증 Azure-JWT**도 org-verified로 인정. Graph `/me` fallback·익명은 계속 거부.
- **연결 방식별 접근 검증을 완료 조건으로:** 지원하는 각 연결(정적키·개인토큰·OAuth·Azure-JWT·Graph·웹 MSAL)에 대해 **내부 사용자 성공 / 외부 사용자 거부**를 명시 테스트.
- `data-model-and-security`는 **저장소 기준 스키마·RLS**와 **운영에서 확인한 상태**를 구분 기록(리뷰 P2 #6).

## 6. 생성 vs 서술 경계 (리뷰 P2 #4)

- `tools/list`(등록 결과) 추출 = 이름/입력/설명만 생성형으로.
- **출력형태(현재 30개 툴에 `outputSchema` 없음)와 소유/공유/쓰기 권한(핸들러·공통 접근 코드에 있음)은 검증된 서술**로 유지. 이를 생성 명세로 취급하면 잘못된 확신을 준다.

## 7. 단계

- **2차-A (체계, 먼저):** 메타 스키마 확장 + 런타임 신선도(웹·MCP) + CI `--check`/드리프트 + 검증 절차/담당자 + `orgVerified` 확대 + 연결 방식별 접근 검증. 생성기는 **mcp-tools-reference(입력 참조 1개)로 먼저 검증**.
- **2차-B (P1 문서):** architecture / data-model-and-security / mcp-tools-reference.
- **2차-C (P2 문서):** transcription-diarization / speaker-id / memory / knowledge-axkh.
- **3차:** f9 / eval / mobile + AXKH 통합 검토.

### 2차-A 완료 조건 (DoD)

- [ ] 메타 스키마 확장(summary/depends_on(글로브·삭제규칙)/verified_revision/verified_body_hash/verified_by) 적용 + 로더 검증.
- [ ] 웹·MCP 응답에 `freshness`/`checked_against_commit`/`stale_reasons` 포함, 비교불가 시 `unknown`.
- [ ] 본문 변경(해시 불일치) → stale로 응답에 표시.
- [ ] `docs:generate`(로컬) + `docs:check --check`(CI, 불일치 실패, fetch-depth 확보).
- [ ] `orgVerified` 확대 + 연결 방식별 내부성공/외부거부 테스트.
- [ ] 생성기 1개(mcp-tools 입력 참조)로 왕복 검증.

## 8. 범위 밖

- LLM이 본문 서술까지 자동 작성(신뢰성 때문에 제외).
- 권한 역할/보안등급 세분화(org 멤버십 이상).
