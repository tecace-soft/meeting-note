---
title: "개인 메모리 (F1')"
slug: memory
section: "Features"
order: 4
summary: "회의마다 사용자별 서사형 개인 메모리를 접고(fold), 그 메모리를 다음 요약 생성에 배경 컨텍스트로 주입한다."
depends_on:
  - "workflow-server/src/memory.ts"
  - "supabase/migrations/20260805130000_create_user_memory.sql"
  - "supabase/migrations/20260807140000_create_note_insight_and_search_indexes.sql"
  - "src/components/UserMemoryView.tsx"
source_of_truth: "repo code; manual verification 2026-10-13"
---

# 개인 메모리 (F1')

사용자별로 회의들을 가로질러 누적되는 서사형(narrative) 장기 메모리다.
ChatGPT / MEMORY.md 스타일로, 할 일 목록이나 이름·토픽의 CRM 덤프가 아니라 사용자 자신의 일에 대한 "이해"를 담는다.
모든 메모리 쓰기는 백엔드(workflow-server)에서 요약 파이프라인 직후에 서버 사이드로 접힌다.
덕분에 웹이든 모바일이든 클라이언트와 무관하게 모든 노트가 커버된다.

## 두 산출물: user_memory vs note_insight

`memory.ts`는 노트 하나당 두 개의 집중된 Gemini 호출을 돌린다. 둘은 서로를 잘라먹지 않도록 분리돼 있다.

- MEMORY (user_memory): 내구성 있는, 회의를 가로지르는 "이해"를 서사 아이템으로 유지한다. add / update / supersede / archive 연산으로 병합된다.
- INSIGHT (note_insight, F4): THIS 회의 하나에 대한 구조화 인덱스(actions / decisions / events / topics / people / companies)를 써서 키워드·구조 검색에 쓴다.

두 산출물의 범위가 다르다는 점이 핵심이다.
user_memory는 회의를 가로지르는 누적 이해이고, note_insight는 그 회의 한 건만의 구조화 레코드다.
note_insight는 `public.note_insight`에 노트당 한 행으로 저장되고, F4 검색 인덱스를 채운다(이 문서 범위 밖).

## 무엇이 접히는가

메모리 모델은 요약이 아니라 "맥락과 관계"를 우선한다.

- 결정과 그 "이유": 무엇을 왜 정했고, 무엇을 버렸으며, 어떤 제약·트레이드오프가 그걸 끌었는지.
- 사물들이 "어떻게 연결"되는지: 프로젝트·사람·문제·토픽이 서로 어떻게 엮이는지, 의존 관계, 무엇이 무엇을 풀거나 막는지.
- 사물들이 "어떻게 변했는지": 이전 대비 무엇이 왜 바뀌었는지(supersede로 기록).
- 일하는 "관계"의 성격: 단순히 "X는 협업자"가 아니라, 사용자와 X가 무엇을 함께 하고 누가 무엇을 맡는지.
- 사용자의 우선순위·방향·안정적 선호.

열린 커밋먼트(open commitment)도 기록하되, 맨 할 일 한 줄이 아니라 맥락·이유와 함께 담는다.
구 F1c의 버킷 모양(open_action_items / collaborators / active_projects / recurring_topics)은 마이그레이션 시 서사 아이템으로 한 번 접어서 시드한다.

## 결정적 접기 규칙

LLM은 연산 리스트만 "제안"하고, 적용은 서버가 결정적으로 한다(`applyOps`).
이 분리로 메모리의 무한 증식과 중복 축적을 막는다.

- 접기 1건당 `add`는 최대 3개(`MAX_ADDS_PER_FOLD`)로 캡한다. 한 회의는 거의 항상 기존 스레드를 "이어가므로" update/supersede가 대부분이어야 한다.
- 전체 연산은 최대 20개, 모델에 노출하는 활성 아이템은 캡이 걸린다.
- 활성 아이템 캡(`ACTIVE_CAP` 50)과 총 아이템 캡(`TOTAL_CAP` 80)을 넘으면 오래된 것부터 archive/삭제한다.
- 아이템 길이·엔티티 개수 등 모든 필드가 경계 검증을 거친다.

접기 후에는 선택적 F1'' 통합(consolidation) 패스가 한 번 더 돈다(prod 기본 ON, `MEMORY_CONSOLIDATION_ENABLED`로 끌 수 있음).
이 패스는 트랜스크립트 없이 활성 아이템 리스트만 모델에 주고 근접 중복을 그룹핑하게 한 뒤, 서버가 결정적으로 병합(merge, 생존자 하나로 합치고 나머지 archive)한다.
어떤 실패나 아이템 수 부족 시 접기 결과를 그대로 둬서, 통합은 메모리를 더 깨끗하게만 할 뿐 절대 망가뜨리지 않는다.

## 접기 트리거 (요약 경로)

`foldNoteIntoMemory`가 요약 파이프라인에서 응답을 보낸 "뒤에" best-effort로 호출된다(사용자를 블로킹하지 않음).

- 신규 요약 경로: 노트가 처음 요약될 때.
- 재생성(regenerate) 경로: 주로 서버 사이드 접기 이전에 만들어진 노트(예: 과거 모바일 노트)를 재생성할 때 백필한다.

멱등(idempotent)이다.
이미 처리한 노트 id는 `processed_note_ids`에 있어 건너뛰므로, 재시도나 재생성이 이중 집계를 만들지 않는다.
service-role 클라이언트로 쓰므로 어떤 클라이언트가 만든 노트든 접을 수 있다.
사용자별 접기는 인프로세스 락(`withUserFoldLock`)으로 직렬화해, 두 접기가 동시에 같은 `user_memory` 행을 읽고 덮어쓰는 lost-update를 막는다(백엔드는 단일 인스턴스 기준).
`user_memory` 읽기가 "없는 행"이 아니라 진짜 실패면 접기를 중단한다. 그래야 누적된 실제 메모리를 빈 값으로 덮어쓰지 않는다.

## 메모리-인-더-루프 (요약 생성에 주입)

누적 개인 메모리는 다음 요약 "생성"에 배경 컨텍스트로 다시 들어간다.

- `getPersonalMemoryContext(userId)`가 `user_memory`를 읽고 `renderMemoryForContext`로 활성 v2 아이템만 간결한(최대 4000자) 텍스트 블록으로 렌더한다.
- 이 블록이 신규 요약(`buildSummaryPrompt`)과 재생성(`buildRegenerateSummaryPrompt`) 프롬프트에 PERSONAL MEMORY CONTEXT로 주입된다.
- 메모리가 실제로 주입될 때만 드리프트 가드 규칙이 붙는다. 메모리가 없거나 읽기 실패면 프롬프트는 F1' 이전과 바이트 단위로 동일하다.
- 주입된 메모리는 용어·선호 스타일·회사 배경·반복 프로젝트/제품명을 "안내"만 할 뿐, File Transcript에 없는 사실을 요약에 추가하지 못한다.

## 읽기 전용 "내 메모리 / My Memory" 화면

`src/components/UserMemoryView.tsx`가 사용자별 메모리를 최신 업데이트순 자연어 아이템 리스트로 보여준다.
회의 요약이 생성될 때마다 백그라운드에서 자동으로 채워지는 개인 컨텍스트임을 안내한다.
읽기 전용이며, 사용자가 전체 메모리를 언제든 삭제할 수 있다(`clearUserMemory`, RLS로 본인 행만).
세련된 대시보드는 이후 디자인 작업이다.

## 데이터 모델과 격리

`public.user_memory`는 사용자당 한 행이다.
구조화 베이스는 고정 카테고리 컬럼이 아니라 단일 `memory` jsonb 컬럼에 담겨, 마이그레이션 없이 카테고리를 늘릴 수 있고 미래 소비자가 같은 베이스를 읽는다.
`processed_note_ids`가 노트별 내구성 dedup을 준다.
RLS가 켜져 있고, 본인 행만 읽기/쓰기 가능하다(`user_id = auth.jwt() ->> 'sub'`). service_role은 우회(서버 사이드 접기용).
클라이언트가 접던 구 `update-user-memory` 엣지 함수는 폐기·제거됐고, 쓰기 경로는 workflow-server의 `foldNoteIntoMemory`로 옮겨졌다.

## 화자 식별과의 경계 (명시)

개인 서사 메모리는 화자 식별(speaker-ID)에 "쓰이지 않는다".
측정된 A/B에서 개인 메모리는 화자 식별에 0.0pt의 향상도 주지 못했다.
화자 식별은 저장된 화자 로스터(roster)와 컨텍스트 기반 텍스트 신호(interaction role, self prior, 직접 호명 등)로 동작하지, 개인 메모리로 하지 않는다.
prod에서 `identifySpeakers`는 personalMemory를 넘기지 않으며, 그 블록은 F8 A/B 실험에서만 설정된다.
`extractInsight`의 `personalMemoryContext`도 prod에서는 비활성(inert)이다. note_insight 인덱스는 THIS 회의만을 범위로 하기 때문이다.
