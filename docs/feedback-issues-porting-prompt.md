<!-- 피드백 / 이슈 — 이식 명세 · slug=feedback-porting · 확인 버전 v0.45.0 · 앱 v0.49.0 -->
> **출처** — 이 명세는 TecAce Revenue Strategy **v0.32.0** 의 "피드백 / 이슈" 탭에서 나온 기준 명세를 그대로 옮긴 것입니다. AXKH 구현(v0.45.0, `/feedback`)이 따른 원본이며, AXKH 쪽 사용 안내는 [피드백 / 이슈](../features/feedback.md) 에 있습니다.

# FEEDBACK-ISSUES SPEC — 앱 내 피드백/이슈 트래커 (동일 구현용 명세)

| 항목 | 값 |
|---|---|
| 기준 구현 | TecAce Revenue Strategy **v0.32.0** 의 "피드백 / 이슈" 탭 |
| 문서 목적 | 다른 시스템에 **같은 기능을 같은 동작으로** 다시 만든다 |
| 독자 | 대상 리포에서 일하는 코딩 에이전트 (기준 리포를 **볼 수 없다고 가정**) |
| 자기완결성 | 이 문서만으로 구현 가능해야 한다. 필요한 규칙 · 문구 · 데이터 모델 · 참조 코드가 모두 들어 있다 |

---

## 0. 사람용 (3줄)

1. 이 파일을 대상 리포 `docs/` 에 넣는다.
2. 에이전트에게: **"docs/feedback-issues-porting-prompt.md 를 끝까지 읽고 §1 계약대로, TecAce 피드백 기능과 똑같이 이 리포에 구현해 줘."**
3. 에이전트가 §1.6 의 **Phase 0 보고서**를 내면 확인하고 "진행" 이라고 답한다.

---

## 1. 에이전트 계약 — 먼저 읽고 그대로 따른다

### 1.1 하는 일

로그인한 사용자가 앱 안에서 버그 · 개선 요청 · 질문을 등록하고(스크린샷 붙여넣기), 처리 담당자가 분류 · 배정하고,
처리 결과가 등록자에게 돌아가는 **미니 이슈 트래커 화면 하나**를 대상 앱에 추가한다.

### 1.2 "똑같이" 의 정의 (Parity)

| 구분 | 내용 |
|---|---|
| **반드시 같게** | §3 의 모든 MUST 요구사항 · §4 데이터 모델의 필드와 의미 · §6 참조 로직의 입력→출력 · §8.4 화면 문구(대상 UI 언어가 한국어일 때) · 상태/권한/알림 규칙 · 화면 배치 순서와 반응형 동작 |
| **대상 앱에 맞춰 바꾼다** | 프레임워크 · 폴더 구조 · 네이밍 · 상태관리 방식 · 컴포넌트 라이브러리 · 색과 간격(대상 디자인 토큰) · 아이콘 세트 · 인증/권한/DB/저장소/메일/LLM 의 **구현 수단**(§10) · "화면(영역)" 목록과 그 키워드(§6.4) · 메일 하단 서명 · 딥링크 형식 |
| **바꾸면 안 된다** | 요구사항을 "더 좋게" 재설계하지 않는다. 필드를 줄이거나 상태를 늘리거나 KPI 카드를 되살리지 않는다. 개선 아이디어는 최종 보고서의 "제안" 칸에만 적는다 |
| **지킬 수 없을 때** | 우회하지 말고 §1.5 에 따라 멈추고 보고한다 |

### 1.3 우선순위 (충돌 시 위가 이긴다)

1. §3 의 **MUST** 요구사항 (보안 · 데이터 · 피드백 루프)
2. 대상 리포의 규칙 파일(CLAUDE.md, AGENTS.md, CONTRIBUTING 등)과 관례
3. 이 문서의 SHOULD 요구사항, 화면 세부, 참조 코드의 형태

### 1.4 기본값 — 묻지 말고 이 값으로 진행한다

| 결정 | 기본값 |
|---|---|
| 구현 범위 | §11 의 모듈 전부 (필수 + 권장 + 선택). 대상 환경에 능력이 없는 모듈만 빠진다 (§10) |
| 처리자(Triage) 권한 | 대상 앱의 **관리자 역할**. 레벨 체계가 있으면 "팀장 위 2단계" 정도 (기준: 5단계 중 3) |
| 알림 설정 권한 | 처리자보다 한 단계 위 (기준: 5단계 중 4). 역할이 둘뿐이면 관리자 |
| 첫 알림 수신자 | 대상 앱 관리자 1명 (리포의 설정/시드에서 찾는다. 못 찾으면 질문 목록에) |
| UI 언어 | 대상 앱의 언어. 한국어면 §8.4 문구를 글자 그대로 쓴다 |
| 화면(영역) 목록 | 대상 앱의 메뉴/탭 목록 + `general`(일반) |
| 첨부 | 비공개 저장소, 10MB, 이미지 + PDF, 서명 URL 수명 화면 1시간 · 메일 30일 · LLM 15분. 저장소의 최대 수명이 더 짧으면(예: S3 presigned 최대 7일) 그 최대값을 쓰고 Parity 예외로 보고 — STOP 아님 |
| 레거시 호환 | **새로 만드는 시스템이면 적용하지 않는다**: DATA-3 의 옛 상태 변환, §5.2 의 삭제 RPC 폴백, RCPT-2/R-NOTABLE 의 '테이블 없음' 폴백. 기존 데이터·배포가 있는 시스템에 붙일 때만 구현 |
| 역할이 둘뿐인 시스템의 문구 | '로그인 허용 사용자/목록' → '이 앱의 사용자', '알림 수신자 설정 권한' → '관리자 권한', '처리 권한' → '관리자 권한' |
| LLM 설정 대응 | 구조화 출력 = 공급자의 JSON 스키마 응답 형식(예: OpenAI `response_format: {type: 'json_schema', strict: true}`), 추론 강도 = 공급자의 중간 단계(있으면), 출력 상한 = 공급자 권장 범위에서 충분히(기준 16000) |
| LLM | 대상 앱이 이미 쓰는 공급자. 없으면 AI 해결책 모듈 제외 |
| 메일 | 대상 앱의 서버 메일 수단. 없으면 알림 모듈은 화면 확인만 남기고 발송 제외 |
| 이슈 번호 접두어 | `FB` |

### 1.5 멈추고 물어야 하는 경우 (이 외에는 묻지 않는다)

- **STOP-1** 서버(또는 DB)에서 권한을 검사할 지점이 없다 (클라이언트가 DB 에 직접 쓰는데 행 단위 보안도 없음)
- **STOP-2** 파일 저장소가 공개 URL 만 지원한다
- **STOP-3** 새 비밀값(API 키) · 새 외부 서비스 · 새 패키지가 필요하다
- **STOP-4** 운영 DB 에 마이그레이션을 실행해야 한다 → 파일과 실행 순서만 준비하고 사람에게 넘긴다 (직접 실행 금지)
- **STOP-5** 대상 리포 규칙이 §3 의 MUST 와 정면으로 충돌한다

### 1.6 진행 순서와 보고

| Phase | 할 일 | 끝나면 |
|---|---|---|
| **0 조사** | 대상 리포에서 §10 의 능력 C1~C10 을 찾아 매핑표를 채운다. 화면 목록 · 권한 체계 · 관리자 계정을 찾는다 | **Phase 0 보고서**(아래 양식) 제출 후 ✋ 대기 |
| 1 데이터·권한 | §4 마이그레이션 · §5 권한 구현 · 권한 함수 | 마이그레이션 파일 + 실행 순서 (실행은 사람이) |
| 2 순수 로직 | §6 참조 로직을 대상 언어로 옮긴다 (분류 · 필터 · 번호 · 상수 · draft · 메일 결정 · 수신자 표시) | §12.1 LOGIC 테스트 통과 (L15~L18 은 메일 모듈을 빼도 순수 함수라 그대로 만든다 — 저장 줄 문구에 쓰인다) |
| 3 데이터 계층 | 서비스(CRUD) · 목록 상태 · 변경 후 다시 읽기 | |
| 4 화면 | §8 화면 · §8.4 문구 | |
| 5 선택 모듈 | 첨부 → 알림 → 수신자 설정 → AI 해결책 → 활동 로그 연동 (능력이 있는 것만) | |
| 6 검증 | §12 수용 기준 전부 + 권한 우회 테스트 | **최종 보고서** 제출 |

**Phase 0 보고서 양식**

```markdown
## Phase 0 — 환경 매핑
| 능력 | 대상 시스템에서 쓸 것 (파일/모듈 경로) | 상태 |  ← 상태: 있음 / 대체 / 없음(모듈 제외)
|---|---|---|
| C1 신원 | ... | |
| ... C10 | | |

## 확정한 기본값
- 처리자 권한: ...   - 알림 설정 권한: ...   - 첫 알림 수신자: ...
- 화면(영역) 목록: general, ...  (키워드 표 초안 첨부)
- 포함 모듈: 핵심 / 첨부 / 알림 / 수신자 설정 / AI / 활동 로그 (각 ✅/❌ + 사유)

## 기준과 달라지는 점 (Parity 예외)
- REQ-ID — 무엇이 왜 다른가

## STOP 항목 / 질문
- (없으면 "없음")
```

**최종 보고서 양식**

```markdown
## 구현 결과
- 추가/변경 파일 목록
- 마이그레이션 실행 순서 (사람이 실행)
## 요구사항 체크  ← §3 의 모든 REQ-ID 를 한 줄씩: ✅ / ⚠️ 예외(사유) / ❌ 미구현(사유)
## 수용 기준 결과  ← §12 항목별 통과 여부 + 확인 방법
## 제안 (구현하지 않은 개선 아이디어)
```

---

## 2. 용어

| 용어 | 내부 값 | 화면 표시 (한국어) | 뜻 |
|---|---|---|---|
| 이슈 | `feedback_issues` 행 | 이슈 | 등록 한 건 |
| 이슈 번호 | `issue_key` | `FB-20261008-3F2A91C0` | 사람이 읽는 고유 키 |
| 종류 | `purpose`: bug / feature / question / other | 버그 / 개선 요청 / 질문 / 기타 | |
| 화면 | `area`: general / (대상 앱 화면들) | 일반 / … | 문제가 난 화면 |
| 상태 | `status`: OPEN / IN_PROGRESS / DONE / CLOSED | 접수 / 진행 중 / 완료 / 닫힘 | 닫힘 = 처리하지 않고 종결 |
| 미종결 | status ∉ {DONE, CLOSED} | 미종결 | |
| 긴급도 | `priority`: P1 / P2 / P3 / P4 | 긴급 / 높음 / 보통 / 낮음 | 사람이 고르는 유일한 중요도 |
| 심각도 | `severity`: Critical / High / Medium / Low | (표시 안 함) | 긴급도에서 계산해 저장 |
| 분류 필요 | `triaged_at IS NULL` | 분류 필요 | 아직 아무도 분류 저장을 안 함 |
| 분류(Triage) | 종류·화면·긴급도·상태·담당자·메모 저장 | 이슈 분류 | 처리자 권한 |
| 처리 메모 | `triage_note` | 처리 메모 | 완료·닫힘 알림 메일에 포함 |
| 자동 분류 제안 | `ai_suggestion` | 자동 분류 제안 | 규칙 기반 (LLM 아님) |
| AI 해결책 | `resolution` | AI 해결책 | LLM 이 만든 원인 가설 + 수정 계획 |
| 등록자 / 처리자 / 담당자 | `author_*` / 권한 보유자 / `assignee_*` | | |

---

## 3. 요구사항 (ID 로 추적한다)

`MUST` = 반드시 · `SHOULD` = 대상 환경이 허락하면 반드시 · `MAY` = 선택. 각 항목의 **검증** 은 §12 에서 쓴다.

### 3.1 보안 · 권한 (SEC)

| ID | 레벨 | 요구사항 | 검증 |
|---|---|---|---|
| SEC-1 | MUST | 모든 권한 판정은 **서버 또는 DB** 에서 한다. UI 에서 숨기는 것은 편의일 뿐이다 | 직접 API 호출로 우회 시도 → 거부 |
| SEC-2 | MUST | 권한 3단계: `issues`(읽기·등록·본인 삭제·첨부) / `issues.triage`(분류 저장·AI 해결책) / `issues.notify`(알림 수신자 변경) | §5.1 표 |
| SEC-3 | MUST | 새 이슈는 서버가 초기 상태로만 받는다: status=OPEN, 담당자 없음, triaged_at 없음, resolution 없음, deleted_at 없음 | 등록 요청에 status=DONE 실어 보내기 → 거부/무시 |
| SEC-4 | MUST | `author_email` 은 서버가 인증 정보로 채운다 (클라이언트 값 무시) | 남의 이메일로 등록 → 요청자로 저장 |
| SEC-4b | SHOULD | `author_name` · `triaged_by` · `triaged_at` · `severity` · `added_by` 도 서버가 채우거나 계산한다 (기준 구현은 클라이언트가 보내고 DB 가 `author_email` 만 덮어쓴다 — 방식 B 로 만들면 전부 서버에서) | |
| SEC-5 | MUST | 삭제 = 작성자 본인만, `deleted_at` 설정(소프트 삭제). 하드 삭제 없음 | 남의 이슈 삭제 → 거부 |
| SEC-6 | MUST | 삭제된 이슈는 분류 저장 불가, 분류 저장으로 삭제(`deleted_at` 설정) 불가 | |
| SEC-7 | MUST | 첨부 저장소는 비공개. 보기는 짧은 수명 서명 URL. 이슈에 붙은 파일은 삭제 불가 | 로그인 없이 첨부 URL 열기 → 실패 |
| SEC-8 | MUST | LLM 호출은 서버 전용 엔드포인트에서, `issues.triage` 검사 후. API 키는 브라우저로 나가지 않는다 | 처리 권한 없이 엔드포인트 호출 → 403 |
| SEC-9 | MUST | 알림 수신자 변경은 `issues.notify` 를 서버가 검사, `added_by` 는 서버가 채운다 | |
| SEC-10 | MUST | UI 쪽 권한 함수와 서버 쪽 권한 함수는 같은 규칙. 두 곳에 서로를 가리키는 주석 | 코드 리뷰 |
| SEC-11 | SHOULD | "본인" 비교에 쓰는 이메일은 서버가 인증에 쓰는 값과 같은 출처 (SSO 로그인 ID 와 메일 주소가 다를 수 있다) | |

### 3.2 데이터 (DATA)

| ID | 레벨 | 요구사항 |
|---|---|---|
| DATA-1 | MUST | §4.2 의 필드를 모두 둔다 (이름은 대상 관례로 바꿔도 되고 의미는 같게) |
| DATA-2 | MUST | 이슈 번호 형식 `FB-YYYYMMDD-XXXXXXXX` (날짜 + 대문자 16진수 8자리), UNIQUE 는 이 키에만. **서버(또는 DB 기본값)가 만든다**(기준 구현은 브라우저가 만들었다 — 방식 A 에서 그대로 따라도 됨). 날짜는 만드는 쪽의 로컬 날짜(서버면 앱의 업무 타임존). UNIQUE 위반이면 최대 3회 다시 만든다 |
| DATA-3 | MUST | 상태는 4개뿐. 예전 데이터에 다른 값(TRIAGE 등)이 있으면 읽을 때 OPEN 으로 |
| DATA-4 | MUST | 저장 시 `severity = severityOf(priority)` (P1→Critical, P2→High, P3→Medium, P4→Low) |
| DATA-5 | MUST | 모든 목록 조회는 `deleted_at IS NULL`. 단 **읽기 권한 규칙에서는 삭제된 행을 숨기지 않는다** (소프트 삭제 UPDATE 직후 재조회가 실패하는 DB 가 있다) |
| DATA-6 | MUST | 첨부는 `path` 가 기준. 공개 URL 을 저장하지 않는다 |
| DATA-7 | MUST | 마이그레이션은 한 파일로 완결 (테이블 + 인덱스 + 권한 + 저장소 정책), 머리 주석에 선행 조건 · 실행 전 확인 쿼리 · 되돌리기 블록. 저장소가 DB 밖(S3 등)이면 정책은 업로드/삭제 API 핸들러에서 검사하고(크기 · MIME · 미첨부 확인) 버킷 설정 절차를 마이그레이션 머리 주석에 적는다. '앱은 마이그레이션 전후 모두 동작' 은 기존 배포에 붙일 때만 (§1.4 레거시 호환) |
| DATA-8 | SHOULD | `updated_at` 자동 갱신 (대상 앱에 트리거/훅이 있으면 재사용) |

### 3.3 등록 (CREATE)

| ID | 레벨 | 요구사항 |
|---|---|---|
| CREATE-1 | MUST | 입력: 제목(필수) · 설명(필수) · 종류(버튼 4개) · 화면(선택 목록) · 첨부 |
| CREATE-2 | MUST | 자동 저장: 입력이 500ms 멈추면 사용자별 키로 `{title, description, purposeOverride, areaOverride, attachments, savedAt}` 저장. 전부 비면 저장본 삭제 |
| CREATE-3 | MUST | 복원: 마운트 시 저장본이 있으면 채우고 배너 "쓰던 내용을 불러왔습니다. [새로 작성]". 저장본을 지우는 것은 **등록 성공**과 **[새로 작성]** 뿐 (화면 이동 · 언마운트로 지우지 않는다). [새로 작성] 은 복원된 첨부를 저장소에서도 지운다 |
| CREATE-4 | MUST | 저장본에는 **사용자가 직접 고른 값(override)** 만 넣는다. 자동 추천 결과는 넣지 않는다 |
| CREATE-5 | MUST | 자동 분류: 제목·설명·override 가 바뀔 때마다 `suggestTriage(title, description, purposeOverride)` (§6.4). 표시값 = `override ?? 추천값`, 렌더 시 계산 (effect 로 동기화 금지) |
| CREATE-6 | MUST | 제목·설명이 모두 비었으면 종류 버튼을 하나도 강조하지 않는다. 추천을 따르는 중이고 글이 있으면 버튼 아래 근거: `{reason} 다르면 바꿔 주세요.` |
| CREATE-7 | MUST | 사용자가 종류를 직접 고르면 긴급도도 그 종류 기준으로 다시 계산된다 |
| CREATE-8 | MUST | 제출 시 제목·설명을 trim. 둘 중 하나라도 비면 폼 안 오류 `제목과 설명을 모두 입력해 주세요.` |
| CREATE-9 | MUST | 서버로 보내는 값: title, description, purpose(표시값), area(표시값), priority·severity(= `suggestTriage(title, description, purposeOverride)` 의 값), ai_suggestion(**같은 호출의 결과 전체** — override 가 있으면 근거가 '직접 고른 종류에…' 로 저장된다. 기준 동작 그대로), attachments. issue_key·상태·담당자·작성자는 보내지 않거나 서버가 무시 (DATA-2, SEC-3, SEC-4) |
| CREATE-10 | MUST | 성공 후 **완료 화면**으로 폼을 대체: 이슈 번호, 알림 받은 사람(§6.9 형식), 안내, [목록에서 보기] [새 이슈 쓰기]. `role="status"` |
| CREATE-11 | MUST | 알림 수신자를 **먼저 확정**한 뒤(화면에 보여주기 위해) 메일 발송(비동기, best-effort). 수신자 0명이면 완료 화면이 "메일은 보내지 않았습니다" 라고 말한다 |
| CREATE-12 | MUST | 새 이슈는 목록에서 강조(초록). 완료 화면을 닫아도 강조는 다음 등록까지 유지 |
| CREATE-13 | MUST | [목록에서 보기] = 새 이슈 선택 + 분류 패널 열기 + 좁은 화면이면 목록 탭으로 전환 |
| CREATE-14 | SHOULD | 권한 시뮬레이션/읽기 전용 모드가 있으면 폼 대신 `시뮬레이션 중에는 이슈를 등록할 수 없습니다 (읽기 전용).` |

### 3.4 목록 (LIST)

| ID | 레벨 | 요구사항 |
|---|---|---|
| LIST-1 | MUST | 상단 보기 탭 4개, **각 탭에 개수**. 별도 KPI 카드는 두지 않는다. 정의는 §6.5 (기본 탭 = 미종결) |
| LIST-2 | MUST | '분류 필요' 개수가 1 이상이면 그 배지만 호박색 |
| LIST-3 | MUST | 검색(제목 · 이슈 번호 · 등록자 이름/이메일 · 설명, 대소문자 무시 부분 일치) + 담당자 필터(모든 담당자 / 미배정 / 사람별). '사람별' 과 분류 패널의 담당자 후보는 **같은 목록 = 사용자 디렉터리 전체**(C3), 라벨 = 표시 이름(없으면 메일 아이디), 디렉터리 순서 |
| LIST-4 | MUST | 종류별 그룹(버그 → 개선 요청 → 질문 → 기타 순), 접기/펼치기, **빈 그룹은 그리지 않는다**. 전부 비면 `조건에 맞는 이슈가 없습니다.` |
| LIST-5 | MUST | 항목 1줄: 긴급도 배지 + 제목. 2줄: 상태 배지 · (분류 필요면) "분류 필요" · 화면 이름 · (첨부 있으면) 클립 아이콘+개수 · 오른쪽 끝 `등록자 · M. D. HH:mm · 담당 {담당자|미배정}` (24시간제) |
| LIST-6 | MUST | 선택 항목 강조 + `aria-current`. 새 이슈 강조(CREATE-12)는 선택 강조보다 약하다 |
| LIST-7 | MUST | 정렬: 등록 시각 내림차순 |
| LIST-8 | SHOULD | 로딩은 스켈레톤 3줄 |
| LIST-9 | SHOULD | 앱에 "되돌리기/다른 곳에서 데이터 변경" 이벤트가 있으면 구독해서 다시 읽는다 |

### 3.5 분류 패널 (TRIAGE)

| ID | 레벨 | 요구사항 |
|---|---|---|
| TRIAGE-1 | MUST | 순서: 머리(번호 · 상태 배지 / 제목 / 등록자 · 등록 시각 · 분류한 사람) → 설명(줄바꿈 유지) → 첨부 썸네일 → (권한 없음 안내) → 자동 분류 제안 카드 → 입력 → AI 해결책 → 저장 줄 |
| TRIAGE-2 | MUST | 입력: [종류 · 화면] [긴급도 · 상태] [담당자] [처리 메모]. 심각도 입력 없음 |
| TRIAGE-3 | MUST | 자동 분류 제안 카드: 등록 시점의 `ai_suggestion` 의 종류 · 화면 · **긴급도(굵게)** + 근거. [제안 적용] = draft 의 종류·화면·긴급도를 제안값으로 (저장은 따로). draft 가 이미 같으면 버튼이 "적용됨"(비활성) |
| TRIAGE-4 | MUST | draft 규칙 §6.6: 다른 이슈를 고르면 서버 값으로 초기화. **같은 이슈가 갱신되면 손대지 않은 경우에만** 새 서버 값으로 |
| TRIAGE-5 | MUST | 넓은 화면의 고정 패널과 좁은 화면의 슬라이드오버가 **같은 draft** 를 쓴다 (보드 상위에서 한 번만 만든다) |
| TRIAGE-6 | MUST | 저장: 버튼 또는 Ctrl/Cmd+Enter (패널 안에서). 보내는 값 §7.2. 저장 중 중복 클릭 무시 |
| TRIAGE-7 | MUST | 저장 후 메일 결정 §6.8 (배정 메일 / 등록자 처리 알림) |
| TRIAGE-8 | MUST | 저장 줄에 결과 `✓ 저장됨 HH:mm[ · {담당자}에게 배정 메일][ · 등록자에게 처리 알림]` (`role="status"`). 다른 이슈를 고르면 지운다. 저장 전에는 `Ctrl+Enter 로 저장` 안내 |
| TRIAGE-9 | MUST | 처리 권한이 없으면: 입력 전부 비활성, 제안 카드의 [제안 적용] 없음, 저장 버튼 없음, AI 생성 버튼 없음, 안내 문장 표시(§8.4 T-NOPERM). 툴팁만으로 안내하지 않는다 |
| TRIAGE-10 | MUST | 저장 줄은 패널 하단에 붙어 스크롤해도 보인다. 구성: [저장](처리 권한) · 안내/결과 · [삭제](작성자). 처리 권한이 없어도 **작성자면 저장 줄을 그리고 [삭제]만** 둔다. 처리 권한 없음 · 작성자 아님 · 저장 결과 없음이 모두 참일 때만 저장 줄을 그리지 않는다 |
| TRIAGE-11 | MUST | 선택된 이슈가 없으면 빈 상태: 아이콘 + `목록에서 이슈를 고르면 여기서 분류하고 담당자를 정합니다.` |
| TRIAGE-12 | MAY | 동시 수정 검사 — 기준 구현은 마지막 저장이 이긴다. 대상 앱에 낙관적 잠금 관례가 있으면 적용 |

### 3.6 삭제 (DELETE)

| ID | 레벨 | 요구사항 |
|---|---|---|
| DELETE-1 | MUST | [삭제] 버튼은 작성자 본인에게만, 저장 줄 오른쪽 |
| DELETE-2 | MUST | 확인 `{issueKey} 이슈를 삭제할까요?` → 서버 삭제 경로 → 목록 다시 읽기, 선택 해제, 패널 닫기 |
| DELETE-3 | MUST | 확인 문구에 "되돌릴 수 있다" 고 쓰지 않는다 (일반 사용자가 실제로 되돌릴 수 있을 때만 예외) |

### 3.7 알림 (NOTIFY) — 메일 수단이 있을 때

| ID | 레벨 | 요구사항 |
|---|---|---|
| NOTIFY-1 | MUST | 신규 등록 → 알림 수신자 전원 (§9 템플릿 N1) |
| NOTIFY-2 | MUST | 담당자가 **바뀌었고** 새 담당자가 있고 저장한 사람이 아니면 → 새 담당자 (N2) |
| NOTIFY-3 | MUST | 상태가 미종결 → 완료/닫힘 으로 **바뀌었고** 등록자가 저장한 사람이 아니면 → 등록자 (N3) |
| NOTIFY-4 | MUST | 모든 메일은 best-effort: 실패해도 저장은 성공, 실패는 로그만, 예외를 던지지 않는다 |
| NOTIFY-5 | MUST | 사용자 입력은 HTML 이스케이프, 스크린샷은 `<img>` 인라인(30일 서명 URL), 앱 딥링크 버튼 |
| NOTIFY-6 | SHOULD | 서버에서 발송 (기준 구현은 브라우저에서 로그인 사용자 계정으로 보냈다 — 토큰 실패 시 조용히 누락되는 약점이 있다) |

### 3.8 알림 수신자 설정 (RCPT) — 선택 모듈

| ID | 레벨 | 요구사항 |
|---|---|---|
| RCPT-1 | MUST | 수신자는 DB 테이블(§4.3). 코드에 하드코딩하지 않는다 (마이그레이션 전 폴백 1명만 예외) |
| RCPT-2 | MUST | `resolveNotifyEmails()`: 테이블을 읽을 수 없으면(없음/오류) 폴백 수신자, 읽었는데 비었으면 빈 배열 (§6.9) |
| RCPT-3 | MUST | 탭 머리 오른쪽에 작은 [알림 설정] 버튼. 수신자 0명일 때만 경고색 + `알림 수신자 없음` |
| RCPT-4 | MUST | 대화상자: 현재 수신자 목록(이니셜 원 · 이름 · 레벨/역할 배지 · 이메일 · [제외]) → 사용자 검색 추가 → 변경 요약 → [취소] [저장]. 저장을 눌러야 반영 |
| RCPT-5 | MUST | 검색: 디렉터리(로그인 허용 사용자)에서 이름/이메일 부분 일치, 이미 고른 사람 제외, 최대 6개, ↑↓ 이동 · Enter 추가 · Esc 는 검색어가 있으면 검색어만 지움(대화상자는 안 닫힘) |
| RCPT-6 | MUST | 디렉터리에 없는 주소는 표시하되 경고 `로그인 허용 목록에 없는 주소입니다 — 메일은 계속 갑니다`. 이번에 추가한 사람은 `추가 예정` 표시 |
| RCPT-7 | MUST | 0명이면 경고 `수신자가 없습니다. 이대로 두면 새 이슈가 등록돼도 알림 메일이 아무에게도 가지 않습니다.` |
| RCPT-8 | MUST | 권한 없음: 보기 전용 + 이유 문장 + [닫기]만. 테이블 없음: 마이그레이션 안내 + 현재 폴백 수신자 + [닫기]만 (목록을 그리지 않는다 — "아무에게도 안 감" 경고와 모순되므로) |

### 3.9 AI 해결책 (AI) — 선택 모듈

| ID | 레벨 | 요구사항 |
|---|---|---|
| AI-1 | MUST | 엔드포인트 계약 §7.1, 출력 스키마 §7.3, 프롬프트 §7.4 |
| AI-2 | MUST | 공급자의 **구조화 출력(JSON 스키마)** 기능을 쓴다. 문자열 파싱 + 재시도 루프를 직접 짜지 않는다. 거절 응답은 오류로 |
| AI-3 | MUST | 엔드포인트는 DB 를 쓰지 않고 결과만 반환. 저장은 분류 저장과 같은 권한(`issues.triage`)으로 하되 **`resolution`, `resolution_generated_at`(=now), `resolution_model` 세 컬럼만** 바꾼다 (`triaged_at` 등은 건드리지 않음 — 해결책 생성이 '분류 필요' 를 지우지 않는다). 재생성은 덮어쓰기 |
| AI-4 | MUST | 이미지 최대 3장, 15분 서명 URL 로 전달 (또는 서버가 base64 로) |
| AI-5 | MUST | 화면: 없으면 한 줄 설명 + [해결책 생성]. 있으면 **접힌 카드**(아이콘 · "AI 해결책" · 요약 한 줄 말줄임 · 신뢰도 배지 · 펼침 화살표), 펼치면 4개 번호 목록 + 생성 시각 + [다시 생성] |
| AI-6 | MUST | 신뢰도 배지: high `신뢰도 높음`(초록) / medium `신뢰도 보통`(호박) / low `정보 부족 — 확인 필요`(빨강) |
| AI-7 | MUST | 생성 중 버튼 `분석 중… (20초쯤)`. 실패는 원문 표시. "생성은 됐는데 저장 실패" 를 구분: `해결책은 만들어졌지만 저장하지 못했습니다 — {사유}` |
| AI-8 | MUST | 응답이 JSON 이 아니면 `해결책 생성 서버({경로})에 연결하지 못했습니다 (HTTP {n}). 배포가 아직 안 됐거나 개발 서버 프록시 설정을 확인하세요.` |
| AI-9 | SHOULD | 감사/활동 로그에 `issue.resolution` 이벤트 (이슈 번호, 모델) |

### 3.10 첨부 (ATT) — 선택 모듈

| ID | 레벨 | 요구사항 |
|---|---|---|
| ATT-1 | MUST | Ctrl+V 리스너는 **document** 에 (폼이 화면에 있는 동안). 클립보드에 파일이 있을 때만 `preventDefault`. `files` 가 비면 `items` 에서 한 번 더 (§6.7) |
| ATT-2 | MUST | 드롭 영역 자체에 클릭 핸들러를 달지 않는다. 파일 선택은 별도 [파일 선택] 버튼 (accept `image/*,.pdf`, 여러 개) |
| ATT-3 | MUST | 붙여넣기/드롭/선택 즉시 업로드. 경로 `screenshots/{Date.now()}-{random7}.{ext}`(확장자 없으면 png). 붙여넣은 `image.png` 는 표시 이름 `스크린샷-{n}.png` |
| ATT-4 | MUST | 10MB 초과는 건너뛰고 `{파일명} 은 10MB 를 넘어 건너뛰었습니다.` 를 폼 오류로 |
| ATT-5 | MUST | 등록 전 [빼기] = 목록에서 제거 + 저장소에서 삭제. [빼기] 버튼은 **항상 보인다**(호버 전용 금지), 크기 28px 이상, `aria-label="{이름} 빼기"` |
| ATT-6 | MUST | 썸네일 3열 그리드(등록 폼) / 가로 나열(분류 패널), 클릭 시 원본 새 탭. 서명 실패 시 파일 아이콘 |
| ATT-7 | MUST | 저장소 오류는 사람이 읽을 문장. 버킷 없음 → `업로드 저장소(issues 버킷)가 아직 없습니다. … 만들어 주세요.` 그 외 `{파일명} 업로드 실패: {원문}` |

### 3.11 화면 · 접근성 (UI)

| ID | 레벨 | 요구사항 |
|---|---|---|
| UI-1 | MUST | 반응형 배치 §8.1 (3단 / 2단+슬라이드오버 / 전환 탭) |
| UI-2 | MUST | 슬라이드오버 = 대화상자: `role="dialog"` `aria-modal="true"` `aria-label="이슈 분류"`, 열면 패널로 포커스, Tab 을 패널 안에서 순환, Esc 닫기, 바깥 클릭 닫기, 닫으면 열기 전 요소로 포커스 복귀 (§6.10) |
| UI-3 | MUST | 모든 입력은 label 과 연결 (`for/id` 또는 감싸기). 종류 버튼 묶음은 `fieldset`+`legend`, 각 버튼 `aria-pressed` |
| UI-4 | MUST | 그룹 접기 버튼 `aria-expanded` + `aria-controls`. 보기 탭 `role="tablist"`/`role="tab"`/`aria-selected` |
| UI-5 | MUST | 결과 알림 `role="status"`(등록 완료 · 저장 결과), 오류 `role="alert"`, 업로드 중 문구 `aria-live="polite"` |
| UI-6 | MUST | 글자 대비 4.5:1 이상 (보조 글자 포함, placeholder 포함). 주 버튼은 대상 앱의 주 버튼 (밝은 하늘색 바탕 + 흰 글자처럼 4.5:1 미만 조합 금지) |
| UI-7 | MUST | 포커스 링은 키보드 포커스(`:focus-visible`)에서, 대비 3:1 이상 |
| UI-8 | MUST | 아이콘은 대상 앱의 아이콘 라이브러리. 이모지를 아이콘으로 쓰지 않는다 |
| UI-9 | MUST | 내부 값(OPEN, P1, Triage Note 등)을 화면에 노출하지 않는다. 문구 §8.4. 기준 구현에 남아 있는 'Triage' 두 곳은 대상에서는 바꾼다: 분류 근거 `Triage에서 필요하면 조정하세요.` → `분류에서 필요하면 조정하세요.`, 오류 `Triage 저장 실패` → `분류 저장 실패` (허용된 Parity 예외) |
| UI-10 | MUST | 색만으로 구분하지 않는다 — 모든 배지에 글자 |
| UI-11 | SHOULD | 터치 대상 44px (전환 탭 · 파일 선택 · 슬라이드오버 닫기) |
| UI-12 | SHOULD | 움직임은 슬라이드오버 진입 · 펼침 회전 · 배경 전환만, 150~250ms, `prefers-reduced-motion` 이면 끈다 |

### 3.12 오류 처리 (ERR)

| ID | 레벨 | 요구사항 |
|---|---|---|
| ERR-1 | MUST | 실패 사유를 삼키지 않는다: `{동작} 실패: {원문}` (+ 알려진 원인이면 조치) |
| ERR-2 | MUST | "컬럼/테이블을 찾을 수 없음" 계열 원문이면 뒤에 ` 마이그레이션이 모두 적용됐는지 확인하세요.` |
| ERR-3 | MUST | 목록 읽기 실패는 `이슈 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.` (페이지 배너, `role="alert"`) |
| ERR-4 | MUST | 변경 성공 시 이전 오류 배너를 지운다 |

---

## 4. 데이터 모델

### 4.1 도메인 타입 (TypeScript 표기 — 대상 언어로 옮긴다)

```ts
type PurposeId   = 'bug' | 'feature' | 'question' | 'other';
type AreaId      = 'general' | string;                               // 대상 앱 화면들
type IssueStatus = 'OPEN' | 'IN_PROGRESS' | 'DONE' | 'CLOSED';
type PriorityId  = 'P1' | 'P2' | 'P3' | 'P4';
type SeverityId  = 'Critical' | 'High' | 'Medium' | 'Low';

type IssueAttachment = { name: string; path: string; type: string };   // type = MIME

type TriageSuggestion = {
  purpose: PurposeId; area: AreaId; priority: PriorityId; severity: SeverityId;
  reason: string;
};

type IssueResolution = {
  summary: string; rootCauses: string[]; checks: string[];
  fixPlan: string[]; verification: string[];
  confidence: 'low' | 'medium' | 'high';
};

type Issue = {
  id: string; issueKey: string; title: string; description: string;
  purpose: PurposeId; area: AreaId; status: IssueStatus;
  priority: PriorityId; severity: SeverityId;
  assigneeEmail: string | null; assigneeName: string | null;
  triageNote: string | null; aiSuggestion: TriageSuggestion | null;
  attachments: IssueAttachment[];
  resolution: IssueResolution | null; resolutionGeneratedAt: string | null; resolutionModel: string | null;
  authorEmail: string; authorName: string | null;
  triagedAt: string | null; triagedBy: string | null;
  createdAt: string; updatedAt: string;
};

type TriagePatch = {   // 분류 패널의 편집 상태(draft)
  purpose: PurposeId; area: AreaId; status: IssueStatus; priority: PriorityId;
  assigneeEmail: string | null; assigneeName: string | null; triageNote: string;
};
```

### 4.2 이슈 테이블 (PostgreSQL 기준)

```sql
CREATE TABLE IF NOT EXISTS feedback_issues (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  issue_key      TEXT NOT NULL UNIQUE,
  title          TEXT NOT NULL,
  description    TEXT NOT NULL,
  purpose        TEXT NOT NULL,
  area           TEXT NOT NULL DEFAULT 'general',
  status         TEXT NOT NULL DEFAULT 'OPEN',
  priority       TEXT NOT NULL DEFAULT 'P3',
  severity       TEXT NOT NULL DEFAULT 'Medium',
  assignee_email TEXT,
  assignee_name  TEXT,               -- 배정 시점의 표시 이름
  triage_note    TEXT,
  ai_suggestion  JSONB,              -- TriageSuggestion (등록 시점, 표시 전용)
  attachments    JSONB NOT NULL DEFAULT '[]'::jsonb,
  resolution     JSONB,
  resolution_generated_at TIMESTAMPTZ,
  resolution_model TEXT,
  author_email   TEXT NOT NULL,      -- 서버가 채운다 (SEC-4)
  author_name    TEXT,
  triaged_at     TIMESTAMPTZ,        -- NULL = 분류 필요
  triaged_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_feedback_issues_created  ON feedback_issues (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_issues_active   ON feedback_issues (deleted_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_feedback_issues_assignee ON feedback_issues (assignee_email);
-- updated_at 트리거: 대상 앱에 공용 트리거 함수가 있으면 재사용
```

Postgres 가 아니면: 필드 구성 유지, JSONB → JSON 문서/문자열 필드, 부분 인덱스 → 일반 인덱스.

### 4.3 알림 수신자 테이블 (RCPT 모듈)

```sql
CREATE TABLE IF NOT EXISTS issue_notify_recipients (
  email     TEXT PRIMARY KEY CHECK (email = lower(email) AND position('@' IN email) > 1),
  added_by  TEXT,                    -- 서버가 요청자로 채운다 (기본값을 인증 정보로 두는 방식 권장)
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 시드: 비어 있을 때만 첫 수신자 1명 (재실행이 관리자가 바꾼 목록을 덮지 않게)
INSERT INTO issue_notify_recipients (email, added_by)
SELECT '<첫 수신자>', 'migration' WHERE NOT EXISTS (SELECT 1 FROM issue_notify_recipients);
```

### 4.4 저장소

- 버킷/컨테이너 `issues`, **비공개**, 파일 크기 상한 10MB.
- 정책: 읽기·업로드 = `issues` 권한, 삭제 = `issues` 권한 + "그 경로가 어느 이슈의 `attachments` 에도 없음" (삭제된 이슈 포함 — 되돌리기로 살아날 수 있으므로).

---

## 5. 권한 구현

### 5.1 동작별 판정표

| 동작 | 권한 | 서버 추가 검사 |
|---|---|---|
| 목록 · 상세 읽기 | `issues` | — |
| 등록 | `issues` | SEC-3 초기 상태, SEC-4 작성자 덮어쓰기 |
| 첨부 업로드 | `issues` | 10MB, 비공개 |
| 첨부 삭제 | `issues` | 어느 이슈에도 붙지 않은 파일만 |
| 분류 저장 · 해결책 저장 | `issues.triage` | 삭제 안 된 행만, `deleted_at` 변경 불가 |
| 삭제 | `issues` | 작성자 본인 (대소문자 무시 비교), `deleted_at` 만 설정 |
| AI 해결책 생성 | `issues.triage` | — |
| 알림 수신자 읽기 | `issues` | (등록자 쪽에서 알림을 보내는 구조일 때 필요. 서버 발송이면 서버만) |
| 알림 수신자 추가/제외 | `issues.notify` | `added_by` = 요청자 |

대상 앱에 기능 키가 없으면 역할로: `issues` = 로그인 사용자, `issues.triage` = 관리자(또는 처리자 역할), `issues.notify` = 관리자.
**요점은 이름이 아니라 3단계 분리 + 서버 검사다.**

### 5.2 방식 A — DB 행 단위 보안 (클라이언트가 DB 에 직접 쓰는 구조)

```sql
ALTER TABLE feedback_issues ENABLE ROW LEVEL SECURITY;
-- 기존에 열린 정책이 있으면 먼저 지운다 (허용 정책은 OR 로 합쳐져 잠금을 무력화한다)

CREATE POLICY "feedback_issues read by feature" ON feedback_issues FOR SELECT TO authenticated
  USING (has_feature_access(auth_email(), 'issues'));

CREATE POLICY "feedback_issues insert by feature" ON feedback_issues FOR INSERT TO authenticated
  WITH CHECK (has_feature_access(auth_email(), 'issues')
              AND status = 'OPEN' AND assignee_email IS NULL AND triaged_at IS NULL
              AND resolution IS NULL AND deleted_at IS NULL);

CREATE POLICY "feedback_issues update by triage" ON feedback_issues FOR UPDATE TO authenticated
  USING      (has_feature_access(auth_email(), 'issues.triage') AND deleted_at IS NULL)
  WITH CHECK (has_feature_access(auth_email(), 'issues.triage') AND deleted_at IS NULL);

-- 작성자 = 로그인한 사람
CREATE FUNCTION feedback_issues_stamp_author() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF auth_email() IS NOT NULL THEN NEW.author_email := lower(auth_email()); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER trg_feedback_issues_stamp_author BEFORE INSERT ON feedback_issues
  FOR EACH ROW EXECUTE FUNCTION feedback_issues_stamp_author();

-- 삭제: RLS 로 "작성자는 deleted_at 만" 을 표현하기 어려워 권한 상승 함수로
CREATE FUNCTION soft_delete_feedback_issue(p_id UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_email TEXT := lower(auth_email());
BEGIN
  IF v_email IS NULL OR NOT has_feature_access(v_email, 'issues') THEN
    RAISE EXCEPTION '이슈를 삭제할 권한이 없습니다.' USING ERRCODE = '42501';
  END IF;
  UPDATE feedback_issues SET deleted_at = now()
   WHERE id = p_id AND deleted_at IS NULL AND lower(author_email) = v_email;
  IF NOT FOUND THEN
    RAISE EXCEPTION '본인이 등록한 이슈만 삭제할 수 있습니다.' USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION soft_delete_feedback_issue(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION soft_delete_feedback_issue(UUID) TO authenticated;
```

- `auth_email()` = 요청 토큰의 이메일 클레임 (Supabase: `auth.jwt()->>'email'`). `has_feature_access(email, key)` = 대상 앱의 권한 규칙 (§3.1 SEC-10: UI 쪽 함수와 같은 규칙).
- 클라이언트는 삭제 RPC 가 없으면(마이그레이션 전) 예전 직접 UPDATE 로 폴백해도 된다 — 마이그레이션 후에는 RLS 가 막는다.

### 5.3 방식 B — 서버 API 계층

모든 쓰기를 엔드포인트로. 핸들러 첫 줄에서 `requireFeature(user, key)`. 엔드포인트별 권한 · 서버가 채우는 값 · 무시할 필드 · 오류는 **§7.5 표** 하나에 모았다.
DB 쓰기 권한은 서버만 갖는다.

---

## 6. 참조 로직 — 입력→출력이 같아야 한다

TypeScript 로 적었다. 대상 언어로 옮기되 **결과가 같아야** 한다 (§12 LOGIC 테스트).

### 6.1 상수

```ts
const PURPOSE_LABEL  = { bug: '버그', feature: '개선 요청', question: '질문', other: '기타' };
const STATUS_LABEL   = { OPEN: '접수', IN_PROGRESS: '진행 중', DONE: '완료', CLOSED: '닫힘' };
const PRIORITY_LABEL = { P1: '긴급', P2: '높음', P3: '보통', P4: '낮음' };
const SEVERITY_BY_PRIORITY = { P1: 'Critical', P2: 'High', P3: 'Medium', P4: 'Low' } as const;
const PURPOSE_ORDER  = ['bug', 'feature', 'question', 'other'] as const;   // 목록 그룹 · 버튼 순서

const severityOf  = (p: PriorityId): SeverityId => SEVERITY_BY_PRIORITY[p];
const isOpenStatus = (s: IssueStatus): boolean => s !== 'DONE' && s !== 'CLOSED';
const readStatus  = (raw: string): IssueStatus =>                   // DATA-3
  (['OPEN', 'IN_PROGRESS', 'DONE', 'CLOSED'].includes(raw) ? raw : 'OPEN') as IssueStatus;

/** 사람 표기: 이름이 있으면 이름, 없으면 메일 아이디 */
const personLabel = (name: string | null, email: string | null): string =>
  name?.trim() || email?.split('@')[0] || '-';
const assigneeLabel = (i: Issue): string => i.assigneeEmail ? personLabel(i.assigneeName, i.assigneeEmail) : '미배정';
```

### 6.2 이슈 번호

```ts
const buildIssueKey = (now = new Date()): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const ymd = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const rand = Math.random().toString(16).slice(2, 10).toUpperCase().padEnd(8, '0');
  return `FB-${ymd}-${rand}`;
};
```

### 6.3 첨부 경로 · 표시 이름

```ts
const buildPath = (file: File): string => {
  const ext = file.name.includes('.') ? file.name.split('.').pop() : 'png';
  return `screenshots/${Date.now()}-${Math.random().toString(36).slice(2, 9)}.${ext}`;
};
const displayName = (file: File, index: number): string =>
  file.name && file.name !== 'image.png' ? file.name : `스크린샷-${index + 1}.png`;
```

### 6.4 자동 분류 `suggestTriage`

```ts
type PurposeRule = { purpose: PurposeId; priority: PriorityId; severity: SeverityId; keywords: string[]; reason: string };

const PURPOSE_RULES: PurposeRule[] = [                    // 위에서부터 처음 맞는 것
  { purpose: 'bug', priority: 'P2', severity: 'High',
    keywords: ['안 됨','안됨','안 돼','안돼','안 되','안되','에러','오류','크래시','깨짐','안 뜸','안뜸','실패','멈춤','error','fail','crash','bug'],
    reason: '오류를 뜻하는 표현이 있어 버그로 분류했습니다.' },
  { purpose: 'feature', priority: 'P3', severity: 'Medium',
    keywords: ['추가','개선','요청','했으면','주세요','필요합니다','지원','기능','feature','support'],
    reason: '기능 추가/개선 요청으로 보여 그렇게 분류했습니다.' },
  { purpose: 'question', priority: 'P4', severity: 'Low',
    keywords: ['?','인가요','있나요','문의','어떻게','방법','궁금'],
    reason: '문의성 표현이 있어 질문으로 분류했습니다.' },
];
const FALLBACK_RULE: PurposeRule = { purpose: 'other', priority: 'P4', severity: 'Low', keywords: [],
  reason: '긴급 키워드는 없어 일반 피드백으로 분류했습니다. 분류에서 필요하면 조정하세요.' };   // 기준 구현: 'Triage에서' (UI-9)

// ▼ 대상 앱의 화면으로 다시 만든다. 순서 = 우선순위 (구체적인 것을 위로). 아래는 기준 앱의 예.
const AREA_RULES: { area: AreaId; keywords: string[] }[] = [
  { area: 'mcp',     keywords: ['mcp','커넥터','bearer','개인 키','개인키'] },
  { area: 'invoice', keywords: ['인보이스','invoice','청구','수금'] },
  { area: 'cost',    keywords: ['비용','cost','원가'] },
  { area: 'profit',  keywords: ['p&l','손익','이익','대시보드'] },
  { area: 'data',    keywords: ['매출 관리','매출관리','그리드','메모','셀'] },
  { area: 'revenue', keywords: ['매출','revenue','시뮬','예측'] },
  { area: 'sync',    keywords: ['동기화','sync','excel','반영'] },
  { area: 'auth',    keywords: ['로그인','권한','접속','sso','계정'] },
];

// '전체' 처럼 흔한 말은 넣지 않는다 — 평범한 요청까지 긴급도가 오른다
const URGENT_KEYWORDS = ['긴급','급함','급하','아무도','못함','못 함','전혀','urgent','asap','critical'];

const PRIORITY_LADDER: PriorityId[] = ['P4','P3','P2','P1'];
const SEVERITY_LADDER: SeverityId[] = ['Low','Medium','High','Critical'];
const escalate = <T>(ladder: T[], cur: T): T => ladder[Math.min(ladder.indexOf(cur) + 1, ladder.length - 1)];

// 영문 키워드는 단어 앞머리에서만 ('bug' ≠ 'debug', 'fail' = 'failed'). 한글은 부분 포함 (조사가 붙으므로)
const matchesKeyword = (text: string, kw: string): boolean =>
  /^[a-z]/.test(kw) ? new RegExp(`(^|[^a-z])${kw}`).test(text) : text.includes(kw);
const hasKeyword = (text: string, kws: string[]) => kws.some(kw => matchesKeyword(text, kw));

// 부분 문자열 충돌 정규화 — 기준 앱: '엑셀' 안의 '셀' 이 'data' 규칙에 먼저 걸려서 'excel' 로 바꾼다.
// ▼ 대상 앱의 키워드 표에서 같은 충돌을 찾아 여기에 추가한다.
const normalize = (title: string, description: string): string =>
  `${title} ${description}`.toLowerCase().replace(/엑셀/g, 'excel');

function suggestTriage(title: string, description: string, purposeOverride: PurposeId | null = null): TriageSuggestion {
  const text = normalize(title, description);
  const rule = purposeOverride
    ? { ...(PURPOSE_RULES.find(r => r.purpose === purposeOverride) ?? FALLBACK_RULE),
        purpose: purposeOverride, reason: '직접 고른 종류에 맞춰 긴급도를 정했습니다.' }
    : PURPOSE_RULES.find(r => hasKeyword(text, r.keywords)) ?? FALLBACK_RULE;
  const area = AREA_RULES.find(r => hasKeyword(text, r.keywords))?.area ?? null;
  const urgent = hasKeyword(text, URGENT_KEYWORDS);
  const reason = [rule.reason,
    ...(area ? ['본문에서 관련 영역을 감지했습니다.'] : []),
    ...(urgent ? ['긴급 표현이 있어 우선순위를 한 단계 올렸습니다.'] : [])].join(' ');
  return {
    purpose: rule.purpose,
    area: area ?? 'general',
    priority: urgent ? escalate(PRIORITY_LADDER, rule.priority) : rule.priority,
    severity: urgent ? escalate(SEVERITY_LADDER, rule.severity) : rule.severity,
    reason,
  };
}
```

UI 언어가 한국어가 아니면 키워드 표 · 근거 문장을 그 언어로 다시 만든다 (구조와 매칭 규칙은 같게).

### 6.5 목록 필터 · 개수

```ts
type ListView = 'open' | 'untriaged' | 'mine' | 'all';
const VIEW_OPTIONS = [
  { id: 'open', label: '미종결' }, { id: 'untriaged', label: '분류 필요' },
  { id: 'mine', label: '내 담당' }, { id: 'all', label: '전체' },
];
// 주의: same(null, null) = false (§6.8 의 sameEmail(null, null) = true 와 다르다 — 두 함수를 합치지 말 것)
const same = (a: string | null, b: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

const matchesView = (i: Issue, view: ListView, me: string | null): boolean =>
  view === 'open'      ? isOpenStatus(i.status) :
  view === 'untriaged' ? !i.triagedAt && isOpenStatus(i.status) :
  view === 'mine'      ? same(i.assigneeEmail, me) && isOpenStatus(i.status) :   // 끝난 일은 세지 않는다
  true;

const matchesQuery = (i: Issue, q: string): boolean => {
  const s = q.trim().toLowerCase();
  return !s || [i.title, i.issueKey, i.authorName ?? '', i.authorEmail, i.description].some(f => f.toLowerCase().includes(s));
};
const matchesAssignee = (i: Issue, a: string): boolean =>      // 'all' | 'none' | email
  a === 'all' ? true : a === 'none' ? !i.assigneeEmail : same(i.assigneeEmail, a);

const filterIssues = (list: Issue[], f: { view: ListView; query: string; assignee: string }, me: string | null) =>
  list.filter(i => matchesView(i, f.view, me) && matchesQuery(i, f.query) && matchesAssignee(i, f.assignee));

const countByView = (list: Issue[], me: string | null) => ({
  open: list.filter(i => matchesView(i, 'open', me)).length,
  untriaged: list.filter(i => matchesView(i, 'untriaged', me)).length,
  mine: list.filter(i => matchesView(i, 'mine', me)).length,
  all: list.length,
});
// 그룹: PURPOSE_ORDER 순서로 묶고 빈 그룹은 버린다. 목록은 createdAt 내림차순.
```

개수는 검색어 · 담당자 필터와 **무관하게** 전체 이슈 기준이다. 좁은 화면 전환 탭의 `목록 · N` 의 N = 미종결 개수.

### 6.6 분류 패널 draft (TRIAGE-4)

```ts
const toPatch = (i: Issue): TriagePatch => ({
  purpose: i.purpose, area: i.area, status: i.status, priority: i.priority,
  assigneeEmail: i.assigneeEmail, assigneeName: i.assigneeName, triageNote: i.triageNote ?? '',
});
const samePatch = (a: TriagePatch | null, b: TriagePatch | null) => JSON.stringify(a) === JSON.stringify(b);

// 상태: draft, base(마지막으로 맞춘 서버 값), currentId
// 실행 시점: 선택된 이슈의 (id, updatedAt) 이 바뀔 때
function onIssueChanged(issue: Issue | null) {
  const next = issue ? toPatch(issue) : null;
  const switched = currentId !== (issue?.id ?? null);
  const prevBase = base;                 // 갱신 함수가 늦게 실행될 수 있으니 지금 값을 잡아 둔다
  currentId = issue?.id ?? null;
  base = next;
  setDraft(prev => (switched || samePatch(prev, prevBase) ? next : prev));
}
// 제안 적용: draft.purpose/area/priority = issue.aiSuggestion 의 값 (저장은 하지 않음)
```

### 6.7 클립보드 파일 추출 (ATT-1)

```ts
const extractFiles = (data: DataTransfer | null): File[] => {
  if (!data) return [];
  const direct = Array.from(data.files);
  if (direct.length > 0) return direct;
  return Array.from(data.items).filter(it => it.kind === 'file')
    .map(it => it.getAsFile()).filter((f): f is File => f !== null);
};
// document.addEventListener('paste', e => { const f = extractFiles(e.clipboardData); if (f.length) { e.preventDefault(); onFiles(f); } })
// 리스너는 한 번만 붙이고 최신 핸들러는 ref 로 잡는다 (렌더마다 다시 붙이지 않는다)
```

### 6.8 저장 후 메일 결정 (TRIAGE-7, NOTIFY-2/3)

```ts
function mailAfterSave(before: Issue, updated: Issue, actor: { email: string }) {
  const reassigned = !sameEmail(before.assigneeEmail, updated.assigneeEmail)
    && !!updated.assigneeEmail && !sameEmail(updated.assigneeEmail, actor.email);
  const resolved = isOpenStatus(before.status) && !isOpenStatus(updated.status)
    && !sameEmail(updated.authorEmail, actor.email);
  if (reassigned) sendAssignedMail(updated, actor);   // 비동기, 기다리지 않음
  if (resolved)   sendResolvedMail(updated, actor);
  return { assigneeMailed: reassigned ? updated.assigneeEmail : null, authorMailed: resolved };   // 저장 줄 문구용
}
// 주의: sameEmail(null, null) = true — '담당자가 바뀌었나' 판정에서 null→null 을 변화 없음으로 본다 (§6.5 same 과 합치지 말 것)
const sameEmail = (a: string | null, b: string | null) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();
// sendAssignedMail / sendResolvedMail = §9 템플릿 N2 / N3 발송 (best-effort, NOTIFY-4)
```

### 6.9 알림 수신자 · 표시

```ts
// RCPT-2: 못 읽음 → 폴백, 비어 있음 → []
// fetchRecipients(): 수신자 테이블 읽기. 테이블 없음(스키마 오류) → 'missing_table', 그 외 오류 → 'error'
// LEGACY_NOTIFY_EMAIL: 테이블이 없을 때 쓰는 1명 = §1.4 '첫 알림 수신자' 와 같은 값 (새 시스템이면 폴백 자체를 빼도 된다 — §1.4 레거시 호환)
async function resolveNotifyEmails(): Promise<string[]> {
  const r = await fetchRecipients();      // { status: 'ok', recipients } | { status: 'missing_table' } | { status: 'error' }
  return r.status === 'ok' ? r.recipients.map(x => x.email) : [LEGACY_NOTIFY_EMAIL];
}

// 완료 화면 문구용: "Hansoo Lee" / "Hansoo Lee 외 1명"
const describeRecipients = (emails: string[], directory: { email: string; displayName: string | null }[]) => {
  const nameOf = (e: string) => directory.find(d => d.email.toLowerCase() === e.toLowerCase())?.displayName?.trim() || e.split('@')[0];
  if (emails.length === 0) return '';
  return emails.length === 1 ? nameOf(emails[0]) : `${nameOf(emails[0])} 외 ${emails.length - 1}명`;
};

// 저장 줄: "저장됨 14:02 · Hansoo Lee에게 배정 메일 · 등록자에게 처리 알림"
const hhmm = (d: Date) => d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });   // 24시간제 HH:mm
const savedText = (at: Date, o: { assigneeMailed: string | null; authorMailed: boolean }, assigneeName: string | null) =>
  [`저장됨 ${hhmm(at)}`,
   ...(o.assigneeMailed ? [`${assigneeName ?? o.assigneeMailed.split('@')[0]}에게 배정 메일`] : []),
   ...(o.authorMailed ? ['등록자에게 처리 알림'] : [])].join(' · ');
```

### 6.10 슬라이드오버 포커스 (UI-2)

```ts
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function useDialogFocus(open: boolean, onClose: () => void) {
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;   // ★ onClose 를 effect 의존성에 넣지 않는다
  useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();                                       // 패널은 tabIndex=-1
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab' && panelRef.current) {
        const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (!items.length) return;
        const [first, last] = [items[0], items[items.length - 1]];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); returnTo?.focus(); };
  }, [open]);
  return panelRef;
}
```

React 가 아니면 같은 동작(포커스 이동 · 순환 · Esc · 복귀)을 대상 프레임워크의 대화상자 기능으로 구현한다. 대상 앱에 접근성 있는 대화상자/시트 컴포넌트가 있으면 그것을 쓴다.

---

## 7. 서버 계약

### 7.1 AI 해결책 엔드포인트

```
POST /api/issue-resolution          (경로는 대상 앱 관례로)
Authorization: <대상 앱의 인증>
Request  { issueKey, title, description, purpose, area, priority, severity, imageUrls: string[] }
Response 200 { resolution: IssueResolution, model: string }
         400 { error: '제목과 설명이 필요합니다.' }
         401/403 { error }      // issues.triage 없음
         405 { error }          // POST 외
         500 { error: <원문> }
```

- 항상 JSON 으로 응답. 처리 순서: 메서드 검사 → `issues.triage` 검사 → 입력 검사 → LLM → (감사 로그) → 반환.
- 누락 필드 기본값: issueKey `-`, purpose `other`, area `general`, priority `P3`, severity `Medium`, imageUrls `[]`.
- 서버 함수 실행 시간 한도는 넉넉히 (기준: 300초). 이미지는 앞에서부터 3장.

### 7.2 분류 저장 (쓰기 경로)

```
보낼 값: purpose, area, status, priority, severity = severityOf(priority),
        assignee_email, assignee_name, triage_note = trim() || null,
        triaged_at = now(), triaged_by = 요청자 이메일
반환: 갱신된 행 전체 (화면이 목록을 다시 읽고 메일 결정에 쓴다)
```

### 7.3 해결책 출력 스키마

```json
{
  "type": "object",
  "properties": {
    "summary":      { "type": "string", "description": "한 줄 요약" },
    "rootCauses":   { "type": "array", "items": { "type": "string" }, "description": "원인 가설 (가능성 높은 순)" },
    "checks":       { "type": "array", "items": { "type": "string" }, "description": "확인 절차" },
    "fixPlan":      { "type": "array", "items": { "type": "string" }, "description": "수정 방향 (순서대로)" },
    "verification": { "type": "array", "items": { "type": "string" }, "description": "검증 방법" },
    "confidence":   { "type": "string", "enum": ["low", "medium", "high"] }
  },
  "required": ["summary", "rootCauses", "checks", "fixPlan", "verification", "confidence"],
  "additionalProperties": false
}
```

### 7.4 시스템 프롬프트 (`<…>` 를 대상 앱 정보로 채운다)

```
너는 사내 <앱 이름>("<한 줄 설명>")을 유지보수하는 시니어 엔지니어다.
스택: <프론트엔드>, <DB>, <서버 런타임>, <인증>, <외부 연동>.
주요 화면: <화면 목록>.

접수된 이슈를 읽고 담당자가 바로 착수할 수 있는 해결책을 작성한다. 규칙:
- 한국어로, 각 항목은 한 문장씩. 군더더기 없이 실행 가능한 내용만 쓴다.
- rootCauses 는 확인되지 않은 가설임을 전제로 가능성이 높은 순서로 쓴다.
- checks 는 담당자가 실제로 눌러보거나 조회해 볼 수 있는 확인 절차로 쓴다.
- fixPlan 은 손대야 할 위치와 방향을 순서대로 쓴다. 확실하지 않은 파일명을 지어내지 않는다.
- verification 은 수정 후 무엇이 어떻게 보이면 해결로 볼 수 있는지 쓴다.
- 정보가 부족하면 추측을 늘리지 말고 confidence 를 low 로 두고 checks 에 무엇을 더 확인해야 하는지 적는다.
```

사용자 메시지 = 이미지 블록(최대 3장, URL) + 텍스트:

```
이슈 번호: <issueKey>
제목: <title>
목적/영역: <purpose> / <area>
우선순위/심각도: <priority> / <severity>

설명:
<description>
```

모델은 공급자의 현재 권장 모델, 이름은 코드 한 곳에. 기준 설정: 출력 토큰 상한 16000, 추론 강도 중간.

### 7.5 방식 B 엔드포인트 (서버 API 계층으로 만들 때)

| 엔드포인트 | 권한 | 서버가 채우거나 강제하는 값 | 클라이언트 값 무시 | 응답 | 실패 |
|---|---|---|---|---|---|
| `GET /issues` | `issues` | `deleted_at IS NULL`, `created_at DESC`, 상태 읽기 변환(레거시만) | — | `Issue[]` | 401/403 |
| `POST /issues` | `issues` | issue_key(DATA-2) · status=OPEN · assignee/triaged/resolution/deleted = null · author_email/name = 요청자 · severity=f(priority) | issue_key, status, assignee_*, triaged_*, resolution*, author_*, deleted_at | `{ issue, notifiedEmails }` — 서버 발송이면 수신자를 여기서 확정해 돌려준다 (CREATE-10/11) | 400 `{error}` (제목/설명 없음), 403 |
| `PATCH /issues/:id/triage` | `issues.triage` | severity=f(priority) · triaged_at=now · triaged_by=요청자 · 삭제된 행이면 409 | deleted_at, author_*, resolution* | `{ issue, assigneeMailed, authorMailed }` — 메일 결정(§6.8)을 서버에서 | 403, 404, 409 |
| `PUT /issues/:id/resolution` | `issues.triage` | resolution_generated_at=now · 세 컬럼만 (AI-3) | 그 외 전부 | `{ issue }` | 403, 404 |
| `DELETE /issues/:id` | `issues` + 작성자 | deleted_at=now 만 | — | 204 | 403 `본인이 등록한 이슈만 삭제할 수 있습니다.` |
| `POST /issues/uploads` | `issues` | 경로(§6.3) · 10MB · MIME(image/*, application/pdf) | 경로 | `{ path, uploadUrl }`(presign) 또는 업로드 결과 | 413 / 415 + ATT-4·7 문구 |
| `DELETE /issues/uploads?path=` | `issues` | 그 경로가 어느 이슈(삭제된 것 포함)의 attachments 에도 없을 때만 | — | 204 | 409 |
| `POST /issues/signed-urls` | `issues` | 만료(화면 1h · 메일 30d(또는 저장소 최대) · LLM 15m) | — | `{ [path]: url }` | 403 |
| `POST /issue-resolution` | `issues.triage` | §7.1 | — | §7.1 | §7.1 |
| `GET /issue-recipients` | `issues` (서버 발송이면 관리자만) | — | — | `{ email, addedBy, addedAt }[]` | |
| `PUT /issue-recipients` | `issues.notify` | added_by = 요청자, email 소문자 | added_by | `{ added: string[], removed: string[] }` 를 받아 반영 후 최신 목록 | 403 |

---

## 8. 화면 명세

### 8.1 배치

| 폭 (기준: 왼쪽 앱 사이드바 16rem 가 있는 셸) | 배치 |
|---|---|
| ≥ 1536px | 3단 그리드 `[360px | minmax(0,1fr) | 440px]`, 간격 16px, 위 정렬. 분류 패널 고정 |
| 1280 ~ 1535px | 2단 `[360px | minmax(0,1fr)]` + 분류는 오른쪽 슬라이드오버 (최대 폭 448px) |
| < 1280px | 상단 전환 탭 `[새 이슈 | 목록 · N]` (2등분, 높이 44px) — 선택한 쪽만 보임. 분류는 전체 폭 슬라이드오버 |

- 대상 앱 셸의 폭에 맞춰 breakpoint 를 옮겨도 된다. 단 **슬라이드오버가 숨는 폭 = 3단이 시작되는 폭** 이어야 한다.
- 보기 탭(미종결/분류 필요/…)은 폭 < 640px 에서 2×2 격자, 그 이상은 한 줄. 알림 설정 버튼 글자도 < 640px 에서 숨기고 아이콘만(라벨은 `aria-label` 로).

### 8.2 화면 구성 (위→아래)

```
머리: [제목 "피드백 / 이슈" + 설명 한 줄]                      [⚙ 알림 설정]
(오류 배너 — 있을 때만)
(좁은 화면: [새 이슈 | 목록 · N] 전환 탭)
┌ 등록 카드 ─────────────┐┌ 이슈 목록 카드 ──────────────────┐┌ 분류 패널 ─────────────┐
│ 새 이슈 등록            ││ 이슈 목록                         ││ FB-… [접수]             │
│ 쓰는 동안 자동 저장됩니다.││ [미종결 3][분류 필요 2][내 담당 1][전체 4] ││ 제목 (굵게)             │
│ (복원 배너)             ││ [🔍 검색……………] [모든 담당자 ▾]   ││ 등록자 · 시각 · 분류: … │
│ 제목                    ││ ⌄ 버그 1                          ││ 설명                    │
│ 무엇을 하다가, …?        ││   [높음] 제목                     ││ [썸네일][썸네일]        │
│ 무엇에 관한 건가요?      ││   [접수][분류 필요] 화면 📎2  등록자·시각·담당 ││ ┌ 자동 분류 제안 [제안 적용] ┐ │
│ [버그][개선][질문][기타] ││ ⌄ 개선 요청 1                     ││ └───────────────┘ │
│ (추천 근거)             ││   …                               ││ 종류 | 화면             │
│ 어느 화면인가요? ▾       ││                                   ││ 긴급도 | 상태           │
│ [이미지 Ctrl+V… 파일 선택]││                                   ││ 담당자                  │
│ (썸네일 + 빼기)         ││                                   ││ 처리 메모               │
│ (폼 오류)               ││                                   ││ ┌ AI 해결책 ▾ ┐         │
│ [      이슈 등록      ] ││                                   ││ [저장] ✓ 저장됨 …  [삭제]│
└────────────────────────┘└───────────────────────────────────┘└────────────────────────┘
```

(그림의 📎 · 🔍 · ⚙ 는 자리 표시일 뿐 — 실제로는 아이콘 라이브러리의 아이콘, UI-8)

### 8.3 시각 규칙 (대상 디자인 시스템의 토큰으로 옮긴다)

| 요소 | 규칙 |
|---|---|
| 카드 | 흰 바탕, 1px 연한 테두리, 둥근 모서리(큰 편), 아주 옅은 그림자. 카드 안에 카드를 넣지 않는다 |
| 주 버튼 | 대상 앱 주 버튼 (기준: 남색 바탕 흰 글자, 대비 ≈13:1). [이슈 등록] 은 폼 폭 전체 |
| 보조 버튼 | 흰 바탕 + 테두리 + 본문색 글자 |
| 긴급도 배지 | 긴급 = 빨강 계열(빨강 50 바탕 + 대비 충족 빨강 글자 + 빨강 테두리) / 높음 = 주황 / 보통 = 중립 회색 바탕 / 낮음 = 흰 바탕 회색 글자 |
| 상태 배지 | 접수 = 브랜드 연한 바탕 + 브랜드 진한 글자 / 진행 중 = 파랑 / 완료 = 초록 / 닫힘 = 회색 |
| "분류 필요" | 호박색 연한 바탕 + 진한 호박 글자 + 둥근 알약 |
| 종류 버튼 | 4등분, 아이콘(버그/전구/물음표/말풍선) + 라벨, 선택 = 주 색 테두리 + 연한 바탕 |
| 목록 항목 | 기본 테두리 투명, 호버 시 연한 바탕 / 선택 = 강조색 테두리 + 연한 강조 바탕 / 새 이슈 = 초록 테두리 + 연한 초록 |
| 제안 카드 | 브랜드 연한 바탕 + 연한 보라/브랜드 테두리, 마법봉 아이콘 |
| 등록 완료 | 연한 초록 바탕 + 초록 테두리, 체크 원 아이콘 |
| 글자 크기 | 본문 14px, 보조 12px. **12px 미만 금지**. 이슈 번호는 고정폭 글꼴 |
| 예약색 | 대상 앱에서 다른 의미로 쓰는 색(차트 계열색, 회사 구분색 등)은 배지에 쓰지 않는다 |

### 8.4 화면 문구 (UI 언어가 한국어면 글자 그대로)

| ID | 위치 | 문구 |
|---|---|---|
| H-TITLE | 탭 제목 | `피드백 / 이슈` |
| H-DESC | 탭 설명 | `쓰다가 막힌 점·바라는 점을 남기면 담당자가 분류하고 처리합니다.` |
| H-NOTIFY | 알림 버튼 | `알림 설정` / 0명: `알림 수신자 없음` |
| P-NEW / P-LIST | 전환 탭 | `새 이슈` / `목록 · {미종결 수}` |
| C-TITLE | 등록 카드 | `새 이슈 등록` / 부제 `쓰는 동안 자동 저장됩니다.` |
| C-RESTORE | 복원 배너 | `쓰던 내용을 불러왔습니다.` + 버튼 `새로 작성` |
| C-L-TITLE | 라벨 | `제목` · placeholder `예: <대상 앱의 실제 화면>에서 <동작>을 누르면 오류` (기준: `예: 매출 관리에서 Excel 반영을 누르면 오류`) |
| C-L-DESC | 라벨 | `무엇을 하다가, 무엇이 일어났나요?` · placeholder `하려던 일, 실제로 일어난 일, 기대한 결과를 적어 주세요.` |
| C-L-PURPOSE | legend | `무엇에 관한 건가요?` · 버튼 `버그` `개선 요청` `질문` `기타` |
| C-REASON | 추천 근거 | `{reason} 다르면 바꿔 주세요.` |
| C-L-AREA | 라벨 | `어느 화면인가요?` |
| C-ATT | 첨부 영역 | 폭 ≥ 640px `Ctrl+V 로 붙여넣기` / < 640px `스크린샷 첨부` · 둘째 줄 `끌어 놓기도 됩니다 · 최대 10MB` · 버튼 `파일 선택` · 업로드 중 `올리는 중…` |
| C-SUBMIT | 버튼 | `이슈 등록` / 진행 중 `등록 중…` |
| C-ERR-EMPTY | 폼 오류 | `제목과 설명을 모두 입력해 주세요.` |
| C-DONE | 완료 | `등록했어요 · {issueKey}` / `{수신자}에게 알림 메일을 보냈습니다. 처리되면 메일로 알려 드려요.` / 0명: `알림 받을 사람이 정해져 있지 않아 메일은 보내지 않았습니다. 처리되면 메일로 알려 드려요.` / 버튼 `목록에서 보기` `새 이슈 쓰기` |
| L-TITLE | 목록 카드 | `이슈 목록` |
| L-VIEWS | 보기 탭 | `미종결` `분류 필요` `내 담당` `전체` (+ 개수) |
| L-SEARCH | 검색 | placeholder `제목 · 번호 · 등록자로 찾기` (숨은 라벨 `이슈 검색`) |
| L-ASSIGNEE | 담당자 필터 | `모든 담당자` / `미배정` / 사람 이름 |
| L-EMPTY | 결과 없음 | `조건에 맞는 이슈가 없습니다.` |
| L-NEEDS | 표시 | `분류 필요` |
| L-META | 항목 끝 | `{등록자} · {M. D. HH:mm} · 담당 {이름|미배정}` |
| T-EMPTY | 패널 빈 상태 | `목록에서 이슈를 고르면 여기서 분류하고 담당자를 정합니다.` |
| T-NOPERM | 권한 없음 | `분류·담당자 지정은 처리 권한이 있는 사람이 합니다. 정해지면 메일로 알려 드려요.` |
| T-SUGGEST | 제안 카드 | `자동 분류 제안` · `{종류} · {화면} · **{긴급도}**` · 버튼 `제안 적용` / `적용됨` |
| T-FIELDS | 라벨 | `종류` `화면` `긴급도` `상태` `담당자`(첫 항목 `미배정`) · `처리 메모` + `(선택 · 완료·닫힘 알림 메일에 함께 갑니다)` · placeholder `판단 근거나 처리 방향` |
| T-AI | AI 카드 | 없을 때 `AI 해결책 — 제목·설명·스크린샷으로 원인 가설과 수정 계획을 만듭니다.` · 버튼 `해결책 생성` / `다시 생성` / `분석 중… (20초쯤)` · 소제목 `원인 가설` `확인 절차` `수정 방향` `검증 방법` · `{날짜 시각} 생성` |
| T-SAVE | 저장 줄 | 버튼 `저장` / `저장 중…` · 안내 `Ctrl+Enter 로 저장` · 결과 §6.9 `savedText` · 버튼 `삭제` |
| T-DELETE | 확인 | `{issueKey} 이슈를 삭제할까요?` |
| T-SLIDE | 슬라이드오버 | 제목 `이슈 분류` · 닫기 버튼 라벨 `닫기` |
| R-DIALOG | 수신자 대화상자 | 제목 `신규 이슈 알림 수신자` · 부제 `새 이슈가 등록되면 이 사람들에게 메일이 갑니다` · `수신자 {n}명` · `사람 추가` · placeholder `이름 또는 이메일로 찾기` · `추가 예정` · 요약 `저장하면 {n}명 추가 · {n}명 제외` · 버튼 `취소` `저장` / 보기 전용 `닫기` |
| R-EMPTY | 0명 | `수신자가 없습니다. 이대로 두면 새 이슈가 등록돼도 알림 메일이 아무에게도 가지 않습니다.` |
| R-NOMATCH | 검색 결과 없음 | `일치하는 사용자가 없습니다. 로그인 허용 사용자만 고를 수 있습니다.` / 다 고름 `추가할 수 있는 사용자를 모두 골랐습니다.` |
| R-UNKNOWN | 디렉터리 밖 | `로그인 허용 목록에 없는 주소입니다 — 메일은 계속 갑니다` |
| R-NOPERM | 권한 없음 | `보기 전용입니다. 바꾸려면 '알림 수신자 설정' 권한이 필요합니다.` |
| R-NOTABLE | 테이블 없음 | `아직 설정 테이블이 없어 바꿀 수 없습니다. <마이그레이션 파일명> 을 실행하면 여기서 고를 수 있습니다. 지금은 {폴백} 에게 갑니다.` |
| E-LIST | 목록 오류 | `이슈 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.` |
| E-OP | 변경 오류 | `이슈 등록 실패: {원문}` / `분류 저장 실패: {원문}` / `이슈 삭제 실패: {원문}` / `해결책 저장 실패: {원문}` (+ ERR-2 조치) |
| E-SIM | 읽기 전용 | `시뮬레이션 중에는 이슈를 등록할 수 없습니다 (읽기 전용).` |

### 8.5 날짜 표기

- 목록: `M. D. HH:mm` (24시간제, 연도 없음). 예 `10. 7. 02:00`
- 패널 머리: 날짜(중간 길이) + 시각(짧게). 예 `2026. 10. 7. 오전 2:00` (대상 로캘 표준 형식)
- 저장 줄: `HH:mm` (24시간제)

---

## 9. 메일 템플릿

공통 뼈대 (표 형식 본문, 딥링크 버튼, 하단 서명):

```html
<div style="font-family: Arial, sans-serif; color: #1e293b;">
  <h2 style="color: {강조색};">{제목}</h2>
  <p>{리드 문장}</p>
  <table style="border-collapse: collapse; margin: 16px 0;">
    <tr><td style="padding:4px 12px;color:#64748b;">{라벨}</td><td style="padding:4px 12px;">{값}</td></tr> …
  </table>
  {추가 블록: 스크린샷 / AI 해결책}
  <p><a href="{앱 URL}?tab=issues" style="display:inline-block;padding:8px 16px;background-color:{강조색};color:#fff;text-decoration:none;border-radius:6px;font-size:14px;font-weight:bold;">피드백/이슈 바로가기 →</a></p>
  <p style="font-size:12px;color:#94a3b8;">— <대상 앱 이름> 자동 알림</p>
</div>
```

공통 5행 (순서): `Issue`(번호 굵게) · `제목` · `종류 / 화면`(`버그 · 매출 관리` 형식) · `긴급도` · `등록자`(이름 없으면 이메일). 모든 사용자 입력은 `& < >` 이스케이프, 설명의 줄바꿈은 `<br/>`.

| ID | 받는 사람 | 메일 제목(subject) | 본문 h2 | 강조색 | 리드 | 표 행 (순서) | 추가 블록 (순서) |
|---|---|---|---|---|---|---|---|
| N1 신규 | 알림 수신자 전원 | `[Issue] {key} — {title}` | `새 이슈가 등록되었습니다` | `#0284c7` | `<strong>{이름}</strong>({이메일}) 님이 새 이슈를 등록했습니다.` | 공통 5행 + `설명` | 스크린샷 |
| N2 배정 | 새 담당자 | `[Issue Assigned] {key} — {title}` | `이슈가 배정되었습니다` | `#059669` | `<strong>{이름}</strong> 님이 이 이슈를 회원님께 배정했습니다.` | 공통 5행 + `상태`(한국어) + `처리 메모` | 스크린샷 → AI 해결책 → `<p>설명: …</p>` |
| N3 완료 | 등록자 | `[Issue Done] {key} — {title}` | `올리신 이슈가 처리되었습니다` | `#047857` | `<strong>{이름}</strong> 님이 이 이슈를 <strong>완료</strong>(으)로 바꿨습니다.` | 공통 5행 + `처리 메모` | — |
| N3 닫힘 | 등록자 | `[Issue Closed] {key} — {title}` | `올리신 이슈가 닫혔습니다` | `#475569` | `… <strong>닫힘</strong>(으)로 바꿨습니다.` | 공통 5행 + `처리 메모` | — |

값이 없는 칸은 `-`. 링크 버튼 문구 `피드백/이슈 바로가기 →`. 강조색은 메일 HTML 안에서만 쓰는 값이라 hex 그대로 둔다(메일 클라이언트는 CSS 변수를 지원하지 않는다).

- 스크린샷 블록: 소제목 `스크린샷`, 이미지 첨부만 각 `<a href><img max-width:260px …></a>` (30일 서명 URL).
- AI 해결책 블록: 왼쪽 3px 강조선 박스(메일 안에서는 허용), 소제목 `이슈 해결책`, 요약(굵게), 소제목+글머리 목록 4개(원인 가설 · 확인 절차 · 수정 방향 · 검증 방법), 빈 목록은 생략.

---

## 10. 환경 매핑 (Phase 0 에서 채운다)

| # | 능력 | 기능이 필요로 하는 것 | 기준 구현 | 없을 때 (묻지 않고 이렇게) |
|---|---|---|---|---|
| C1 | 신원 | 현재 사용자 `{email, name}`, 서버가 요청자 검증 | SSO(Azure MSAL), 서버가 토큰 검증 | **STOP-1** |
| C2 | 권한 판정 | 서버 쪽 `can(user, key)` + 같은 규칙의 UI 쪽 함수 | 기능 키 테이블(키별 최소 레벨 + 역할) + DB 함수 · 브라우저 함수 | 역할 2단계로 단순화(§5.1). 서버 검사 지점이 없으면 STOP-1 |
| C3 | 사용자 디렉터리 | 담당자 · 수신자 후보 `{email, displayName, level?}[]` | 로그인 허용 사용자 목록 API | 담당자 = 이메일 직접 입력(형식 검사), 레벨 배지 생략 |
| C4 | DB 쓰기 경로 | 이슈 CRUD + 권한 검사 위치 | 클라이언트 → DB 직접 + 행 단위 보안(서버 서명 토큰의 email 클레임) | §5.3 방식 B |
| C5 | 파일 저장소 | 비공개 업로드 · 서명 URL(만료) · 삭제 | 비공개 버킷 + 서명 URL | 저장소 없음 → 첨부 모듈 제외. 공개만 → STOP-2 |
| C6 | 메일 | `send(to[], subject, html)` | 브라우저에서 로그인 사용자 계정으로 위임 발송 | 메일 발송 제외(화면 확인은 유지, 완료 문구를 "처리되면 이 목록에서 확인할 수 있어요." 로) |
| C7 | LLM | 서버에서 이미지+텍스트 → JSON 스키마 출력 | 서버리스 함수 + Anthropic API | AI 모듈 제외 |
| C8 | 감사/활동 로그 | 변경 기록 · 이벤트 기록 · 되돌리기 이벤트 | DB 트리거 → 활동 로그, 전역 되돌리기 | 제외 (`triaged_by`, `updated_at` 는 유지) |
| C9 | UI 기반 | 컴포넌트 · 아이콘 · 토큰 · 대화상자 · 딥링크 라우팅 | React 19 + Tailwind v4 + shadcn/ui + lucide, `?tab=issues` | 대상 앱 것 사용 |
| C10 | 로컬 저장 | 사용자별 임시 저장 | localStorage `issue_draft_<email>` (읽기/쓰기 실패는 조용히 무시) | 서버 draft 또는 메모리(새로고침 시 유실은 보고서에 예외로) |

---

## 11. 모듈과 구현 순서

| 순서 | 모듈 | 등급 | 포함 REQ | 필요 능력 |
|---|---|---|---|---|
| 1 | 데이터 · 권한 | 필수 | SEC-1~6,10,11 · DATA-* | C1 C2 C4 |
| 2 | 순수 로직 | 필수 | §6.1~6.6 | — |
| 3 | 등록 · 목록 · 분류 · 삭제 | 필수 | CREATE-* · LIST-* · TRIAGE-* · DELETE-* · UI-* · ERR-* | C9 C10 |
| 4 | 첨부 | 권장 | ATT-* · SEC-7 | C5 |
| 5 | 알림 메일 | 권장 | NOTIFY-* | C6 |
| 6 | 알림 수신자 설정 | 선택 | RCPT-* · SEC-9 | C3 C6 |
| 7 | AI 해결책 | 선택 | AI-* · SEC-8 | C7 |
| 8 | 활동 로그 연동 | 선택 | LIST-9 · AI-9 | C8 |

각 단계가 끝날 때마다 대상 리포의 타입 검사/린트/테스트를 통과시킨다. 메일 · AI 모듈이 빠져도 3단계 화면은 완전해야 한다.

권장 모듈 구성 (대상 구조로 바꾼다): `types` · `constants` · `triageRules` · `listFilter` · `service`(CRUD + 행 매핑) ·
`upload`/`fileUrls` · `notify` · `recipients` · `resolutionApi` · 훅(`useIssuesSync`(목록+변경+메일 결정, 결과 반환) ·
`useIssueBoard`(선택 · 패널 · 등록 완료 · 저장 결과 · 제안 적용) · `useTriageDraft` · `useIssueFormState`(필드+자동 저장+override) ·
`useIssueCreateForm`(업로드 · 붙여넣기 · 제출)) · 컴포넌트(Board · CreateForm/Fields/PurposePicker/Success/DraftBanner/AttachmentField ·
ListPanel/Filters/Group/Item · TriagePanel/SuggestionCard/Fields/ResolutionSection/SaveBar/SlideOver · NotifyRecipients Button/Dialog/List/Picker).

---

## 12. 수용 기준

### 12.1 LOGIC — 자동 테스트로 확인 (대상 리포에 테스트 러너가 있으면 테스트로, 없으면 스크립트로)

| # | 입력 | 기대 |
|---|---|---|
| L1 | `suggestTriage('엑셀 반영이 안 돼요', '')` | purpose bug, area **sync**(기준 표), priority P2, severity High — **area 기대값은 대상 앱의 화면 표로 다시 쓴다** (L5 의 auth 도 마찬가지) |
| L2 | `suggestTriage('debug 로그 추가해주세요', '')` | purpose **feature** (bug 아님) |
| L3 | `suggestTriage('저장 failed', '')` | purpose bug |
| L4 | `suggestTriage('전체 목록 보기 추가', '')` | feature, P3 (긴급 상향 없음) |
| L5 | `suggestTriage('로그인이 전혀 안 돼요', '')` | bug, area auth, **P1 / Critical** (상향) |
| L6 | `suggestTriage('엑셀 반영이 안 돼요', '', 'question')` | question, P4, reason 이 `직접 고른 종류에 맞춰 긴급도를 정했습니다.` 로 시작 |
| L7 | `suggestTriage('', '')` | other, general, P4, Low |
| L8 | `buildIssueKey(new Date(2026, 9, 8))` | `/^FB-20261008-[0-9A-F]{8}$/` |
| L9 | `severityOf('P1')` / `('P4')` | Critical / Low |
| L10 | `countByView` — 완료 상태인데 나에게 배정된 이슈 1건 | mine = 0, all = 1 |
| L11 | `countByView` — 미종결 · triaged_at 없음 1건 + 완료 · triaged_at 없음 1건 | untriaged = 1 |
| L12 | `readStatus('TRIAGE')` | OPEN |
| L13 | draft: 담당자를 바꾼 뒤 같은 이슈의 updatedAt 만 바뀜 | 바꾼 담당자 유지 |
| L14 | draft: 아무것도 안 바꾼 상태에서 같은 이슈의 updatedAt 이 바뀜 | 새 서버 값 |
| L15 | `mailAfterSave` — 담당자 null→A, 저장한 사람 B | assigneeMailed = A |
| L16 | `mailAfterSave` — 담당자를 나 자신으로 | assigneeMailed = null |
| L17 | `mailAfterSave` — OPEN→DONE, 등록자 ≠ 저장한 사람 | authorMailed = true / 등록자 = 저장한 사람이면 false |
| L18 | `describeRecipients([a, b], dir)` | `{a 이름} 외 1명` |

### 12.2 UI — 직접 눌러서 확인

- [ ] 메뉴와 딥링크 양쪽으로 진입된다
- [ ] 빈 폼: 종류 버튼 강조 없음 / 제목 입력 → 추천 종류 강조 + 근거 문장
- [ ] 종류를 직접 고른 뒤 설명을 더 써도 선택 유지, 근거 문장은 사라짐
- [ ] 다른 화면 갔다 오기 → 내용 · 첨부 복원 + 배너, [새로 작성] → 비워지고 첨부가 저장소에서 삭제
- [ ] 설명란에 커서를 둔 채 Ctrl+V(이미지) → 첨부 / 텍스트 Ctrl+V → 텍스트만 들어감
- [ ] 11MB 파일 → 건너뛰고 폼 오류
- [ ] [빼기] 가 마우스를 올리지 않아도 보이고, 누르면 저장소에서도 사라진다
- [ ] 등록 → 완료 화면(번호 · 수신자 · 버튼), 목록 맨 위 새 이슈 초록 강조, [목록에서 보기] → 선택 + 패널
- [ ] 보기 탭 숫자 = 각 탭의 실제 항목 수, 빈 그룹 안 보임, 결과 없음 문구
- [ ] [제안 적용] → 값 채워지고 "적용됨", 저장 전 AI 생성 → 고른 담당자 유지
- [ ] 저장 → `✓ 저장됨 HH:mm · …` / Ctrl+Enter 저장 / 다른 이슈 선택 시 결과 문구 사라짐
- [ ] 처리 권한 없는 계정: 입력 비활성 + T-NOPERM, 저장 · 제안 적용 · AI 버튼 없음, 저장 줄 없음
- [ ] 작성자에게만 [삭제], 확인 후 목록에서 사라짐
- [ ] 1280px: 2단 + 슬라이드오버 / 390px: 전환 탭 · 보기 탭 2×2 · 가로 스크롤 없음
- [ ] 슬라이드오버: 열면 포커스 이동, Tab 이 안에서만, Esc 닫힘, 닫으면 누른 항목으로 포커스
- [ ] 키보드만으로 등록 → 분류 → 저장 가능, 대비 4.5:1 위반 없음, 12px 미만 글자 없음

### 12.3 알림 — 메일 수단이 있을 때

- [ ] 등록 → 수신자 전원에게 N1 (스크린샷 인라인), 수신자 0명 → 발송 없음 + 완료 문구 변경
- [ ] 다른 사람에게 배정 → N2 / 나에게 배정 → 메일 없음
- [ ] 남이 올린 이슈를 완료로 → 등록자에게 N3(처리 메모 포함) / 내 이슈 → 메일 없음
- [ ] 메일 수단을 일부러 실패시켜도 등록 · 저장은 성공

### 12.4 SEC — UI 를 거치지 않고 직접 호출로 확인

- [ ] 인증 없이 목록 읽기 → 실패/빈 결과
- [ ] 등록 권한만 있는 계정으로 분류 저장 → 거부
- [ ] 등록 요청에 `status: 'DONE'`, `assignee_email` → 거부(또는 초기값으로 저장)
- [ ] 등록 요청에 남의 `author_email` → 요청자로 저장
- [ ] 남의 이슈 삭제 → 거부 / 내 이슈 삭제 → `deleted_at` 만 설정
- [ ] 분류 저장으로 `deleted_at` 설정 → 거부
- [ ] 이슈에 붙은 첨부 삭제 → 거부 / 첨부 경로를 인증 없이 열기 → 실패
- [ ] 처리 권한 없이 AI 엔드포인트 → 403
- [ ] 알림 설정 권한 없이 수신자 추가 → 거부

### 12.5 견고성

- [ ] 마이그레이션 하나를 빠뜨린 상태에서 등록/업로드 → 무엇이 빠졌는지 화면에 뜬다 (ERR-2, ATT-7)
- [ ] 수신자 테이블이 없을 때 → 폴백 수신자에게 발송, 설정 대화상자에 R-NOTABLE

---

## 13. 기준 구현이 실제로 겪은 문제 (같은 실수를 하지 않기 위해)

| 문제 | 증상 | 대응 REQ |
|---|---|---|
| 권한을 UI 에서만 막음 | 공개 키만으로 누구나 이슈 조회·분류 변경 | SEC-1 |
| 공개 저장소 + 누구나 삭제 | 스크린샷 URL 유출, 남의 첨부 삭제 | SEC-7 |
| 등록 후 확인 없음 | 같은 내용 중복 등록 | CREATE-10 |
| 갱신이 편집 중 draft 를 덮음 | 담당자를 고르고 AI 생성을 누르면 선택이 사라짐 | TRIAGE-4 |
| 상태 TRIAGE 와 "분류 필요" 중복 | 상태는 TRIAGE 인데 분류 필요 표시 없음 | DATA-3 |
| 우선순위·심각도 따로 선택 | P1 + Low 같은 모순 | DATA-4, TRIAGE-2 |
| 키워드 부분 문자열 | '엑셀'→'셀' 규칙, 'debug'→bug, '전체'→긴급 | §6.4 |
| 직접 고른 종류와 긴급도 불일치 | 버그를 골라도 긴급도 '낮음' | CREATE-7 |
| SSO 로그인 ID ≠ 메일 주소 | 본인 이슈인데 삭제 버튼이 안 보임 | SEC-4, SEC-11 |
| 알림 수신자 하드코딩 | 바꾸려면 배포 필요 | RCPT-1 |
| "내 담당" 에 끝난 일 포함 | 할 일 숫자가 줄지 않음 | §6.5 |
| 오류 원문을 삼킴 | 버킷 없음 · 컬럼 없음을 헛짚음 | ERR-1, ERR-2 |
| SQL 일부만 붙여넣어 실행 | `$$` 미종결 오류 | DATA-7 (파일 끝 표시 줄, 한 파일 한 번 실행) |
| 정책 변경 후 옛 앱 | 저장소 비공개 전환 뒤 옛 버전의 공개 URL 이 깨짐 | DATA-7 (앱 배포 → 마이그레이션 순서를 머리 주석에) |
| 대화상자 닫기 콜백이 effect 의존성 | 렌더마다 포커스가 패널 처음으로 튐 | §6.10 |
| 브라우저 위임 메일 | 토큰 실패 시 조용히 누락 | NOTIFY-6 |
| 상단 KPI 카드 + 별도 상태 필터 | 같은 숫자를 두 번 보여주고 눌러도 아무 일 없음 | LIST-1 |
| 이모지 아이콘 · 10px 글자 · 4.1:1 버튼 | 접근성 미달 | UI-6, UI-8, §8.3 |
