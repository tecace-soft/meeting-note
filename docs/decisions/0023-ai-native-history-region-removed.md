---
id: DEC-0023
date: 2026-10-27
status: active
question: AI-native 문서 훅이 history.md에 최근 커밋 목록을 자동 생성하는 것을 유지할 것인가(DEC-0007 보완)
options:
  - (a) history 자동 영역을 없애고, intro.md 구조 트리는 추적 파일(git ls-files)로 만들고, AX-KH 조립은 git log를 직접 읽는다
  - (b) 현행 유지하고 충돌이 날 때마다 수동으로 해소한다
  - (c) 훅을 끄고 생성은 main에서만 CI로 돌린다
chosen: (a). 생성기는 intro.md의 structure 영역만 갱신한다. history.md에는 자동 영역 대신 최근 변경은 git log와 GitHub 병합 이력에 있다는 한 줄 안내만 둔다. 구조 트리와 하위 시스템 표는 디스크가 아니라 추적 파일 목록에서 만들어 clone과 브랜치가 달라도 결과가 같다. AX-KH 노드 조립은 history.md 대신 git log --no-merges의 커밋 제목을 읽고(sources.json의 maxCommits, excludeCommitPrefixes 의미 유지, scanCommits로 읽는 범위를 제한), 테스트에서는 커밋 제목을 주입한다. 훅은 구조 영역만 갱신하고 최근 이력은 git에서 가져온다.
reason: history 영역은 현재 HEAD의 마지막 40개 커밋으로 만들어져 브랜치마다 내용이 달라, 모든 PR에서 history.md 병합 충돌이 났다. 구조 트리는 디스크를 읽어 추적하지 않는 로컬 폴더가 가짜 diff로 새어 들어왔다. 이 영역을 읽는 자동 소비자는 AX-KH 노드 조립 하나뿐이어서 git을 직접 읽게 하면 충분하다. 2026-10-27 Andrew 결정.
paths:
  - scripts/ai-native-docs/generate.mjs
  - scripts/ai-native-docs/generate.test.mjs
  - scripts/axkh-node/assemble.mjs
  - scripts/axkh-node/lib.mjs
  - scripts/axkh-node/sources.json
  - docs/ai-native/history.md
supersedes: []
source: 2026-10-27 Andrew 결정(history 영역 제거와 git 직접 읽기 승인), DEC-0007
---
## 맥락

DEC-0007의 훅 방식(결정적 생성기, pre-commit, 마커 영역)은 그대로 유효하다.
이 결정은 그중 history 영역 생성만 철회하고, structure 영역의 입력을 추적 파일로 바꾼다.
그래서 DEC-0007은 대체하지 않고 보완한다.
