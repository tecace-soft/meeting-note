# Meeting Note AX-KH 노드 갱신 절차

팀 공용 AX-KH 노드 "Meeting Note 현황" 1개를 에이전트 세션에서 수동으로 갱신한다.
CI 자동 게시는 없다.
개인 AX-KH 키는 로컬 환경에만 있고, 이 저장소 코드는 키를 읽거나 저장하거나 요구하지 않는다.
이 저장소의 코드는 AX-KH를 호출하지 않는다.
본문 조립, 스캔, 게시 상태 기록만 한다.
게시는 에이전트가 AX-KH MCP 툴 `add_knowledge`로 한다.

## 설정

- 소스 allowlist: `scripts/axkh-node/sources.json` (여기에 없는 파일은 읽지 않는다).
- 수기 관리 "현재 진행 중" 목록: `docs/axkh-node/current-work.md`.
- 수기 관리 "변천" 서사: `docs/axkh-node/story.md`.
- 최근 커밋 목록은 `git log --no-merges`에서 직접 읽으며(`maxCommits`, `scanCommits`), `sources.json`의 `excludeCommitPrefixes`로 제외할 유형(fix(security), fix(auth))을 정한다.
- 게시 상태(추적됨): `docs/axkh-node/published.json`.
- 미리보기 출력(gitignore): `.axkh/meeting-note-node.md`, `.axkh/meeting-note-node.json`.
- 제목은 `Meeting Note 현황`으로 고정한다. 같은 제목이어야 같은 문서가 갱신되고 이전 본문이 이력으로 남는다.
- product slug는 `meeting-note`, 보안 등급 기본값은 S2다.

## 갱신 순서

1. `npm run axkh:node:check`로 갱신이 필요한지 본다. `stale`이면 진행한다.
2. 필요하면 `docs/axkh-node/current-work.md`를 고친다.
3. `npm run axkh:node`를 실행한다.
   스캐너가 이메일, UUID, 내부 URL, 키/토큰, env 값 할당을 하나라도 찾으면 비정상 종료하고 미리보기를 만들지 않는다.
   이때는 allowlist나 소스를 고친다. 스캐너를 약화시키지 않는다.
4. `.axkh/meeting-note-node.md`를 사용자에게 보여 주고 승인을 받는다.
5. `add_knowledge`를 호출한다.
   `product`는 `meeting-note`, `asOf`는 `.axkh/meeting-note-node.json`의 값, `content`는 미리보기 본문 전체, 제목은 `Meeting Note 현황`이다.
6. 1단계 응답의 확인 질문을 사용자에게 그대로 전달한다.
   팀 공유로 저장하면 회의에 참석하지 않은 팀원도 본다는 점을 알린다.
7. 사용자 답을 받아 `confirm:true`로 다시 호출한다.
8. 성공하면 게시 상태를 기록한다.
   `node scripts/axkh-node/assemble.mjs --record-published --doc-key <docKey> --url <노드 url>`
   (기록 직전에 3번을 다시 실행해 미리보기가 게시한 본문과 같게 유지한다.)
9. `docs/axkh-node/published.json` 변경을 일반 커밋으로 남긴다.

## 참고

- 해시는 본문에서 "출처와 기준" 절을 뺀 내용으로 계산한다. 날짜나 커밋만 바뀌면 stale이 되지 않는다.
- `--as-of YYYY-MM-DD`로 기준일을 고정할 수 있다(기본은 오늘).
- 테스트: `npm run axkh:node:test`.
