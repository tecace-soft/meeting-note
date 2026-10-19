# 결정 기록 (Decision records)

결정 1건당 파일 1개를 둔다.
에이전트와 사람이 이미 내려진 결정을 모르고 어기지 않게 하는 것이 목적이다.

## 형식

파일명은 `NNNN-slug.md`이고, `NNNN`은 id 숫자와 같아야 한다.
파일은 YAML frontmatter와 짧은 본문(맥락)으로 구성한다.

| 필드 | 설명 |
| :--- | :--- |
| `id` | `DEC-0001` 형태의 고유 식별자 |
| `date` | 결정일 (YYYY-MM-DD). 원 결정일을 모르면 `source`에 기준을 적는다 |
| `status` | `active`, `superseded`, `retired`, `needs-review` 중 하나 |
| `question` | 무엇을 정해야 했는가 |
| `options` | 검토한 대안 목록 (2개 이상) |
| `chosen` | 선택한 안 |
| `reason` | 이유 (짧게) |
| `paths` | 영향 받는 파일 glob 목록. `active`는 1개 이상 필요 |
| `supersedes` | 대체한 결정 id 목록 (없으면 `[]`) |
| `source` | 원문 위치 (AGENTS.md, 설계 문서, 회의, 커밋) |

frontmatter는 단순한 YAML 부분집합만 지원한다.
`key: 값`, `key: []`, 그리고 `key:` 아래 `  - 항목` 줄이다.
값에 `:`가 들어가면 큰따옴표로 감싼다.

`status: needs-review`는 해석이 불확실한 백필 결정에 쓴다.
검사기는 `active`만 경고 대상으로 삼는다.

## 새 결정 추가

1. 다음 번호로 `docs/decisions/NNNN-slug.md`를 만든다.
2. `paths`는 실제로 존재하는 파일에 맞춰 좁게 쓴다. glob이 넓으면 경고 피로로 무시된다.
3. 비밀 값, 이메일, tenant id, oid, 내부 URL은 쓰지 않는다.
4. 기존 결정을 뒤집으면 새 파일에 `supersedes: [DEC-xxxx]`를 적고, 옛 파일의 `status`를 `superseded`로 바꾼다.
5. `npm run decisions:check`로 형식 오류가 없는지 확인한다.

## 검사기

`npm run decisions:check`는 변경 파일(기본: 작업 트리 vs HEAD, 추적하지 않는 파일 포함)이 `active` 결정의 `paths`와 겹치면 id, question, chosen을 출력한다.
경고일 뿐이며 일치해도 종료 코드는 0이다.
결정 파일 자체의 형식이 틀렸을 때만 종료 코드 1을 반환한다.

```
npm run decisions:check
npm run decisions:check -- --base origin/main...HEAD
npm run decisions:check -- --files path/a.ts path/b.ts
npm run decisions:test
```

glob 문법은 `**`(여러 디렉터리), `*`(한 디렉터리 안), `?`(한 글자)만 지원한다.
CI(`decisions-advisory.yml`)가 PR과 main push에서 같은 검사를 돌려 job summary에 남긴다.
