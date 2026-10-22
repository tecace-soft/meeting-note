# S10 작업 복구 설계 메모

근거는 REFACTOR_PLAN.md 개정 3의 4.2 S10, 4.6 장애 시나리오, 9절과 10절이다.
이 PR은 설계와 실패 재현 테스트만 추가하며 production 코드와 스키마를 바꾸지 않는다.
구현은 T1-9b 이후이며 완전한 자동 재개의 범위는 Andrew가 결정한다.

## 불변 조건과 실행권

- 같은 job 행의 실행권은 동시에 한 인스턴스만 갖는다.
- 동일 note의 활성 job unique index는 같은 행의 이중 실행을 막지 못한다.
- 실행권을 잃은 인스턴스는 job, note, checkpoint, memory, speaker, insight 등 후처리에 쓰지 못한다.
- completed는 종료나 후처리 실패 때문에 failed로 돌아가지 않는다.
- 재전사 비용 회피는 저장된 checkpoint나 전사 id를 재사용하는 구간에만 해당한다.
- 사용자의 원본과 S11 제출 기록은 확정 종료 전까지 보존한다.

필드 후보는 lease_owner, lease_expires_at, execution_generation, assembly_transcript_id, submission_attempt_state이며 이름과 SQL은 구현 PR에서 확정한다.
후처리 상태는 본문 완료 상태와 분리하며 S12와 공유한다.
인수는 조건부 UPDATE RETURNING 한 문장 또는 같은 트랜잭션의 RPC로 한다.
조건은 허용된 비종료 status와 만료된 lease이며 성공한 한 요청만 증가한 generation을 받는다.
lease 만료는 클라이언트가 아닌 DB 시각으로 판정한다.
heartbeat는 id, 소유자, generation을 확인하고 0행이면 실행권 상실로 처리한다.
job UPDATE의 generation 조건만으로는 충분하지 않다.
note와 후처리도 lease 확인과 쓰기를 같은 DB 트랜잭션에서 수행해야 한다.
외부 호출 전후에 실행권을 확인하고 상실 시 취소 신호를 전달하며 이미 발생한 비용을 기록한다.
orphan sweep과 정상 runner는 같은 인수 규칙을 사용한다.

## 상태 전이와 실패 구간

| 현재 상태 또는 구간 | 권장 결과 |
| --- | --- |
| queued 인수 성공 | processing과 새 generation, lease |
| processing heartbeat 정상 | 같은 generation으로 lease 갱신 |
| processing 종료 또는 SIGKILL 후 lease 만료 | 다음 실행자가 조건부 인수 |
| generation 상실 | 상태 쓰기와 후처리 중지 |
| note 저장 후 completed 쓰기 실패 | 소유권을 확인한 뒤 기존 note로 completed 수렴 |
| checkpoint 저장 뒤 재시작 | 전사 생략 후 요약부터 재개 |
| 전사 id 저장 뒤 재시작 | 새 제출 없이 기존 전사 조회 |
| 제출 성공 후 id 저장 전 종료 | 결과 불명 상태 보존, 자동 재제출 보류 |
| completed 뒤 후처리 실패 또는 종료 | completed 유지, 후처리 미완료만 기록 |

제출 전 종료는 같은 note와 제출 기록으로 재시도한다.
제출 성공과 id 저장 사이의 구간은 정확히 한 번 제출을 보장할 수 없다.
별도 제출 시도 기록으로 탐지하며, 공급자의 멱등성이나 조회 보장을 검증하기 전에는 자동으로 재제출하지 않는 것을 기본 제안으로 둔다.
재제출 허용 여부와 비용 기록 정책은 구현 전에 확정한다.
AssemblyAI의 멱등성이나 제출 조회 기능은 이번 작업에서 확인하거나 구현하지 않았다.
구 인스턴스와 새 인스턴스가 겹치거나 DB 응답이 늦어도 한 세대를 두 실행자가 얻을 수 없어야 한다.
heartbeat, orphan sweep, 재개를 따로 설계하면 실행권 충돌이 생기므로 함께 변경한다.

## 테스트와 정상 테스트 전환

`workflow-server/src/s10-recovery.todo.test.ts`는 실제 index.ts의 시작, sweep, job 제출과 runner를 가짜 서비스 경계로 실행한다.
현재 실패하는 다섯 단언을 node:test todo로 표시하므로 CI 종료 코드는 0이다.
실패 원인은 checkpoint 재개 부재, 저장된 id 재조회 부재, lease 보호 부재, generation 없는 쓰기, 제출 id 미저장이다.
조건부 SQL 인수 경합과 결과 불명 제출 구간은 구현 seam과 승인된 스키마가 없어 이유를 적은 skip이다.
가짜 DB는 SQL 원자성의 증거가 아니다.

1. T1-9b의 runner와 store seam에 같은 시나리오를 연결한다.
2. 스키마가 필요하면 별도 migration PR에 PRE/POST check와 ROLLBACK을 포함한다.
   Andrew가 SQL Editor에서 적용한다.
3. 고정 버전 PGlite에서 실제 조건부 인수를 경합시켜 승자가 정확히 하나인지 확인하고 SQL skip을 제거한다.
   늦은 구 실행자의 job, note, 후처리 쓰기가 모두 0행 또는 거부여야 한다.
4. 제출 성공 직후 DB 저장 실패, 응답 지연, lease 만료와 실행 세대 상실을 주입한다.
   공급자 제출과 조회 횟수, 모든 쓰기의 세대 조건을 검사한다.
5. 각 실패 단언이 통과한 뒤 해당 todo를 제거한다.
   단언을 삭제하거나 현재 잘못된 동작을 기대하도록 바꾸지 않는다.
6. S12의 SIGTERM과 SIGKILL 뒤 같은 영속 fixture를 새 인스턴스가 인수하는 검사까지 통과시킨다.

테스트 서버는 127.0.0.1만 사용하고 실제 서비스, .env, 운영 DB에는 접근하지 않는다.
배포와 되돌리기는 4.5의 CI, merge 전 S1 점검, 사람 merge, 배포 후 검증 순서를 따른다.
