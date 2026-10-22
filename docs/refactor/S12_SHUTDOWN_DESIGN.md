# S12 종료 처리 설계 메모

근거는 REFACTOR_PLAN.md 개정 3의 4.2 S12, 4.6 완료 후 실패 시나리오, 9절과 10절이다.
이 PR은 설계와 실패 재현 테스트만 추가하며 SIGTERM 처리나 production 동작을 구현하지 않는다.
구현은 T1-9b와 S10 뒤에 수행한다.
S4와 S12는 같은 작업이다.

## 종료 순서

| 순서 | 해야 할 일 | 금지 사항 |
| --- | --- | --- |
| 1 | draining으로 전환하고 readiness를 내리며 새 작업 제출을 차단 | 새 job이나 외부 전사 제출을 계속 받지 않음 |
| 2 | orphan sweep과 knowledge delivery, extraction 스케줄을 중지하고 worker의 활성 작업을 취소 | 종료 중 새 작업을 인수하거나 무한 재시도하지 않음 |
| 3 | runner heartbeat와 외부 호출을 중지하거나 제한된 시간만 대기 | 중지하지 않은 실행을 먼저 failed로 바꾸지 않음 |
| 4 | S10 실행권과 generation을 확인한 뒤 비종료 상태와 복구 위치를 기록 | 실행권을 잃은 job에 쓰지 않음 |
| 5 | HTTP 연결, dispatcher, 리스너를 정리하고 종료 대기 시간 안에 종료 | 후처리 대기로 종료를 무한히 연장하지 않음 |

새 제출 거부는 재시도 가능한 503 응답을 권장하며, 클라이언트는 S11의 원본과 제출 기록을 보존해야 한다.
readiness의 외부 노출 경로와 응답 계약은 구현 PR에서 확정하고 별도 동작 변경으로 검사한다.
readiness를 내린 것만으로 기존 요청이나 외부 호출이 중지됐다고 간주하지 않는다.
반복 SIGTERM에도 같은 종료 절차가 한 번만 실행되어야 한다.
기존 keep-alive 연결로 들어오는 새 제출도 차단한다.

worker의 스케줄 중지와 활성 실행 중지는 별개다.
중단한 worker의 lease는 기존 내구성 있는 만료 규칙에 따라 재인수할 수 있어야 한다.
취소한 외부 호출이 공급자 서버에서도 취소됐다고 가정하지 않으며 S10의 저장된 전사 id와 결과 불명 제출 정책을 따른다.
종료 시 queued로 되돌리는 쓰기는 소유자, generation, 비종료 status 조건을 한 DB 트랜잭션에서 확인해야 한다.
새 인스턴스가 실행권을 인수한 뒤 도착한 구 인스턴스의 갱신은 0행이어야 한다.

## 본문 완료와 후처리 분리

processSummarizeJob은 completed를 저장한 뒤에도 finalizeNoteMemory와 heartbeat를 계속 실행한다.
따라서 메모리에 남아 있다는 이유만으로 모든 실행을 failed로 바꾸면 성공한 job을 실패로 돌리는 회귀가 생긴다.
completed는 유지하고 memory, speaker, insight의 미완료 상태와 재실행에 필요한 출처를 별도로 기록한다.
후처리도 S10 generation 확인과 멱등성을 가져야 한다.
완료 응답을 이미 받은 사용자가 같은 음원을 다시 전사하도록 유도하지 않는다.

## SIGKILL과 배포 중첩

SIGKILL은 정리 함수를 실행할 수 없다.
복구 안전성의 최종 근거는 종료 핸들러가 아니라 S10의 영속 lease, generation, 전사 id와 checkpoint다.
배포 중 구 인스턴스와 새 인스턴스의 중첩, DB 응답 지연, lease 만료 직후 종료 신호를 함께 시험한다.
Render의 실제 종료 대기 시간과 중첩 동작은 Andrew가 S2에서 확인한다.
이번 작업에서는 Render에 접속하거나 설정을 변경하지 않았다.
종료 deadline은 확인된 Render 대기 시간보다 짧게 정하고, 구현 전까지 구체적인 운영 값을 가정하지 않는다.
무료 플랜을 유지하며 서버를 깨워 두는 주기 ping은 추가하지 않는다.

## 테스트와 정상 테스트 전환

`workflow-server/src/s12-shutdown.todo.test.ts`와 test-support/signal-child.ts는 실제 index.ts를 import한다.
가짜 서비스로 실제 runner를 전사 또는 요약 처리 중에 멈추거나 completed 뒤 후처리 중에 멈춘다.
별도 자식 테스트 프로세스에만 SIGTERM과 SIGKILL을 보낸다.
부모 테스트 프로세스나 운영 프로세스에는 신호를 보내지 않는다.
테스트의 15초 제한은 자식 프로세스 유출 방지용이며 Render 종료 대기 시간의 가정이 아니다.

현재 네 실패 단언은 SIGTERM 리스너 부재, 비정상 종료와 비종료 handoff 부재, 후처리 pending 기록 부재, SIGKILL 전 영속 lease와 generation 부재를 드러낸다.
node:test todo로 표시하므로 실패 재현이 있어도 CI 종료 코드는 0이다.
종료 단계 순서와 HTTP 제출 차단은 runner 취소 seam과 S10 계약이 없어 이유를 적은 skip이다.

1. T1-9b 뒤 runner 취소와 worker 중지 경계를 연결한다.
2. S10의 조건부 인수와 영속 복구 상태를 연결한다.
3. readiness 전환, 새 제출 차단, sweep과 두 worker 중지, heartbeat와 외부 호출 중지, 소유권 조건부 저장, 종료 순서를 이벤트로 단언하고 skip을 제거한다.
4. 실제 저장 fixture를 프로세스 밖에 유지하고 SIGTERM 또는 SIGKILL 후 새 인스턴스를 시작한다.
   같은 job과 note로 수렴하며 구 generation 쓰기는 거부되어야 한다.
5. completed 뒤 종료와 후처리 실패에서도 completed가 남고 후처리 미완료만 기록되는지 검사한다.
6. 모든 단언이 통과한 시나리오에서 todo를 제거한다.
   단언을 지우거나 현재의 실패 동작을 기대하도록 바꾸지 않는다.

스키마가 필요하면 PRE/POST check와 ROLLBACK을 포함한 별도 migration PR을 만들고 Andrew가 SQL Editor에서 적용한다.
테스트는 127.0.0.1, 합성 자격정보와 가짜 외부 경계만 사용한다.
배포와 롤백은 CI와 S1을 통과한 뒤 Andrew가 merge하고 30분 및 실제 작업 한 건을 관찰하는 4.5 절차를 따른다.
