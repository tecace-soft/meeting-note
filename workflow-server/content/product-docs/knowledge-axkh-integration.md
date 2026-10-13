---
title: "지식 인덱스 + AXKH 연동 (프로듀서)"
slug: knowledge-axkh-integration
section: "Integrations"
order: 3
summary: "노트를 검색 가능한 지식으로 만들고, 정책·접근 게이팅된 회의 지식을 AXKH 지식허브로 내구성 있게 전달하는 Meeting Note 쪽(프로듀서) 연동이다."
depends_on:
  - "workflow-server/src/knowledge/"
  - "supabase/migrations/20260807140000_create_note_insight_and_search_indexes.sql"
  - "supabase/migrations/20260810180000_search_notes_rpc.sql"
source_of_truth: "repo code; manual verification 2026-10-13"
---

# 지식 인덱스 + AXKH 연동 (프로듀서)

이것은 AXKH 지식허브(knowledge hub) 연동의 "Meeting Note 쪽", 즉 프로듀서다.
Meeting Note가 지식의 원천(source)이고, AXKH가 소비자다.
흐름은 두 층으로 나뉜다: (1) 노트를 자기 안에서 검색 가능하게 만드는 로컬 지식 인덱스(F4), (2) 정책·접근 게이팅을 거친 회의 지식을 AXKH로 내보내는 전달(delivery) 파이프라인.

## 노트가 검색 가능한 지식이 되는 법 (F4 인덱스)

요약 시점에 note_insight 추출이 돌아 각 노트의 구조화 인덱스를 `public.note_insight`에 노트당 한 행으로 쓴다(개인 메모리 접기와 같은 경로, [memory](./memory) 참고).
여기에 노트 텍스트 컬럼(name / summary / summary_edit / transcription)에 대한 pg_trgm 트라이그램 GIN 인덱스가 전 코퍼스를 즉시 커버한다.

검색은 `public.search_notes(p_user_id, p_query, p_limit)` RPC가 두 신호를 합친 하이브리드다.

- 키워드 유사도·부분일치: 노트 텍스트 컬럼에 대한 pg_trgm.
- 구조화 히트: note_insight의 people / topics / companies 배열(서버 사이드 추출이 노트당 채움).

RPC는 `p_user_id`로 스코프된다.
앱은 RLS가 이미 note/note_insight를 소유자로 제한하고, MCP 서버는 service_role(RLS 우회)이라 이 명시적 user 필터에 의존한다. SECURITY INVOKER라 권한 상승이 없다.
참고: 벡터 단계의 note_chunk(화자 턴 청킹)와 pgvector 시맨틱 검색은 "연기(deferred)"됐다. 현재 F4는 키워드(pg_trgm) + 구조화(note_insight)로 동작한다.

## AXKH로 무엇이 전달되는가 (프로듀서 -> AXKH)

전달은 신뢰할 수 있는 DB 스냅샷에서만 만들어지는 이벤트의 "transactional outbox"로 동작한다. 브라우저가 준 JSON은 절대 신뢰하지 않는다.
이벤트 타입은 다섯 가지다.

- `source.upsert`: 변하지 않은 plaintext와 전체 스팬 커버리지를 담은 콘텐츠/화자 리비전.
- `access.changed`: 접근 리비전, 검증된 참석자/공유 grant, 명시적 deny, 선택적 분류 정책 참조.
- `units.upsert`: 현재 source 리비전에 묶인, evidence-bound 지식 후보(units). 접근을 바꾸지 않는다.
- `source.deleted`: 라이프사이클 리비전. 검색 차단 + 파생물 제거 + 최소 tombstone 유지.
- `integration.disabled`: source와 파생물 차단. 명시 승인된 새 integration generation만 재활성 가능.

모든 이벤트는 `schemaVersion`, `eventId`, source별 `eventSeq`, `integrationGeneration`, `sourceApp`, `sourceId`, `tenantId`, `payloadHash`, `eventType`, `payload`를 담는다.
Microsoft 테넌트·오브젝트 id(UUID)로 식별하며, 표시 이름·이메일·화자 라벨·diarization 추측은 그 자리를 대신하지 못한다.
해시는 소문자 SHA-256이고, `sourceHash`는 unchanged plaintext의 UTF-8 바이트를, 스팬 `textHash`는 해당 슬라이스를 해시한다.

## 전달·ACK·리스

`startMeetingKnowledgeDelivery`(delivery worker)가 outbox를 돌린다.
전달 경로는 `claim -> prepare -> ack / fail`이다.

- `claim`: 테넌트 스코프로 전달할 이벤트를 리스(lease)로 집는다.
- `prepare`: DB 스냅샷에서 이벤트를 결정적으로 빌드·봉인(`validateMeetingOutboxSeal`)한다. 스키마·해시·이벤트/테넌트/source/시퀀스 바인딩을 검증한다.
- AXKH ingest 엔드포인트(`<AXKH_URL>/api/integrations/meeting-note/v1/events`)로 HTTPS POST 한다. 전달 키(`MEETING_KNOWLEDGE_INGEST_KEY`)는 access 키와 반드시 다르며, 엔드포인트는 HTTPS 전용(유저/패스워드/쿼리/해시 불가)이다.
- `ack`: 전달 성공 시 payloadHash로 확정(acknowledge)한다. 실패는 `fail`로 코드와 함께 기록된다.

`eventSeq`는 dedup·추적·gap 탐지를 지원하지, last-write-wins 클록이 아니다.
콘텐츠와 접근 리비전은 독립적으로 전진한다. 접근 이벤트가 콘텐츠보다 먼저 와도 콘텐츠를 버리지 않고, 늦게 온 콘텐츠가 더 오래된 접근을 되살리지 않는다.
이벤트/소스 스냅샷 1MB 등 바이트 상한이 걸려 있고, 단일 메시지로 완결되는 v1 리비전이다(멀티파트 미구현).

## 지식 후보 추출 (units)

`startMeetingExtractionWorker`(extraction worker)가 source 리비전별로 evidence-bound 지식 후보(units)를 뽑아 `units.upsert`로 전달한다.
모델 사용은 "model policy"로 게이팅된다(`createMeetingModelPolicyClient` / `authorizeModel`): 관리자 승인된 분류·모델 정책이 있어야 모델 컨텍스트에 콘텐츠를 쓴다.
units는 현재 source 리비전에만 수락되며 접근을 바꾸지 못한다.
추출에는 청크 수 상한(`MEETING_KNOWLEDGE_EXTRACTION_MAX_CHUNKS`, 기본 16)과 30초 모델 데드라인이 걸린다.

## 접근은 교집합 (AXKH 쪽 검색 게이트)

AXKH가 회의 유래 지식을 검색·모델에 쓰기 전, 접근은 여러 조건의 교집합이어야 한다.

1. AXKH가 로그인 Microsoft `tenantId + objectId`, 활성 계정, read 역할, 현재 S1–S5 clearance를 자기 권위로 검증.
2. 관리자 승인된 콘텐츠 분류 정책 해석. 정책이 없으면 콘텐츠는 pending으로 남고 검색/모델에 쓰이지 않는다. source가 사용자의 clearance를 지정할 수 없다.
3. 유효한 확정 참석자, 직접 공유, 또는 자격 있는 프로젝트 공유 grant. 명시 revocation이 참석 이력·다른 grant보다 우선. 노트 관리 소유권만으로는 AXKH 검색 권한이 생기지 않는다.
4. source 서버가 모델 컨텍스트에 evidence를 쓰기 직전, 그리고 회의 유래 답을 내기 직전에 현재 접근·콘텐츠/접근 리비전을 다시 확인. 확인 불가면 그 회의에 대해 fail-closed.

Meeting Note 쪽은 이 게이트를 위한 라우트와 사설 ledger를 제공한다.

## /knowledge/* HTTP 라우트

`handleMeetingKnowledgeRequest`(`knowledge/http.ts`의 핸들러)가 다른 라우팅보다 먼저 가로채며, 자체 CORS·자격 증명·콘텐츠 없는 에러를 소유한다.
세 라우트가 있고 각각 자기 환경 플래그로 게이팅된다. 플래그가 'true'가 아니면 404다.

- `POST /knowledge/v1/access-check`: 한 테넌트로 스코프된 전용 서버 키(`MEETING_KNOWLEDGE_ACCESS_KEY`, timing-safe 비교)로 인증. 호출자의 정확한 바인딩과 `allowed`만 반환.
- `POST /knowledge/v1/evidence-fetch`: 같은 access 키. 버전 바인딩된 audience 접근이 맞는 evidence만 반환하며, 실패는 식별자·메타데이터를 노출하지 않고 균일하게 404.
- `POST /knowledge/v1/source-access`: 소유자 관리(owner-management) 명령. 서버 검증된 업그레이드 owner JWT(테넌트 allowlist + SUPABASE_JWT_SECRET)로 인증하고, initialize / confirm_participant / revoke / restore / enable / disable / resync / status를 처리. 최소한의 리비전·활성 ack만 반환.

브라우저/유저 역할은 이 사설 ledger 테이블·RPC를 실행할 수 없다.
에러는 SQL 오류·식별자·JWT·업스트림 진단 텍스트를 호스트 로거로 흘리지 않는다.
요청 본문은 8KB로 제한되고 JSON만 받는다.

## 환경 플래그

전달·추출·접근·관리가 각각 독립 플래그로 켜진다.

- `MEETING_KNOWLEDGE_DELIVERY_ENABLED` — outbox 전달 worker.
- `MEETING_KNOWLEDGE_EXTRACTION_ENABLED` — units 추출 worker.
- `MEETING_KNOWLEDGE_ACCESS_ENABLED` — access-check / evidence-fetch 라우트.
- `MEETING_KNOWLEDGE_MANAGEMENT_ENABLED` — source-access 관리 라우트.

`MEETING_KNOWLEDGE_TENANT_ID`, AXKH URL·키들, note base URL, timezone 등 설정이 유효하지 않으면 라우트는 503(`KNOWLEDGE_CONFIG_UNAVAILABLE`)로 fail-closed 한다.

## 계약 미러링

transport 계약(`contract.ts`, `event.schema.json`, `synthetic-fixtures.json`, `access-contract.ts`)은 AXKH 레포의 `lib/meeting-knowledge/`와 바이트 단위로 동일해야 한다.
어느 한쪽을 바꾸면 양쪽에서 검증한 뒤에야 연동을 켤 수 있다.
레포에 커밋된 예시는 전부 synthetic이며, 실제 전사·평가 답변은 공개 레포에 두지 않는다.
