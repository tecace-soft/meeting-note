# 2026-10-09 배치 수동 적용 체크리스트

> 대체됨 (2026-10-21): 현재 상태는 [docs/refactor/REFACTOR_PLAN.md](../refactor/REFACTOR_PLAN.md) 2절과 6절이 정본이다.
> 이 체크리스트는 이력으로만 남긴다.
> 단계 4(모바일 E2E)는 2026-10-12 통과했고, 웹 삭제 가드는 4436643으로 출시됐다.
> 단계 5(Group B 2-user E2E)만 열려 있다.

이 배치(Group A/B/C + 형제 취약점 + R01)의 코드는 모두 커밋/푸시됨.
백엔드(workflow-server)는 main에서 자동 배포되지만, 아래는 자동화되지 않는 수동 작업이다.
순서가 중요한 곳은 명시했다.

## STATUS (2026-10-09 기준)

- [x] 단계 1: 마이그레이션 3개 적용 + 검증 (MCP로 적용, checkpoint RLS / active-uniq 인덱스 / mcp 702 컬럼 / storage_object_owner 함수 전부 확인)
- [x] 단계 2: R01 blast-radius 확인 → null-owner가 892개 중 508개로 과다 판정
- [x] owner_id 백필: file 기준 113개 + note 기준 266개 = null-owner 508 -> 129 (나머지는 노트가 참조하지 않는 고아 객체). 재생 깨지는 레거시 노트 319 -> 1개(고아/손상 참조) -> **2026-10-13 해결, 319 -> 0**
  - 남은 1건은 note `f2fe2fee-4826-4855-bffd-c42e60f1bdc7` ("260831_Tecace_Ai_Ops_Strategy_Meeting")였다.
  - meeting-recordings 버킷의 storage 객체가 물리적으로 없는 진짜 고아였다.
  - 전사(13506자)와 요약(2858자)은 온전해 비파괴적으로 처리했다.
  - Supabase SQL Editor에서 `update public.note set audio_file=null, audio_file_id=null where id='f2fe2fee-4826-4855-bffd-c42e60f1bdc7';` 실행 후 검증했다(audio_file/audio_file_id null, 전사/요약 유지).
  - 원인(추정 약 75%): 웹 "최근 녹음" 삭제 `deleteRecentAudioFile`(src/pages/TranscriptionSummary.tsx)가 노트 참조 확인 없이 storage 객체와 `public.file` 행을 삭제했다.
  - FK `on delete set null` 때문에 `note.audio_file_id`가 NULL이 되었다.
  - 재발 방지: 웹 삭제 가드 구현(2026-10-14, 미커밋, E2E 대기).
  - 노트가 참조 중인 녹음은 삭제를 차단하고, 조회 실패 시 fail-closed로 동작한다.
  - 진단 주의: `note.audio_file`은 서명 URL이라 `/meeting-recordings/` 접두부와 `?token=...` 쿼리를 모두 제거해야 `storage.objects.name`과 맞출 수 있다.
- [x] 단계 3: Edge function 7개 전부 배포 완료 (note-audio-url은 하이브리드 소유권 게이트 + 백필 이후 배포)
- [ ] 단계 4: 모바일 APK 빌드 + on-device E2E (아래, 아직 남음 — 실기기 필요)
- [ ] 단계 5(선택): Group B 2-user 프로덕션 E2E

아래 원문 절차는 참고용으로 남겨둔다 (이미 수행된 1~3 포함).

## 0. 준비 (edge 배포에만 필요, DB 작업엔 불필요)

Supabase CLI는 설치돼 있지 않으므로 npx로 실행한다 (첫 실행 시 바이너리 자동 다운로드).
`PROJECT_REF`는 Supabase 대시보드 URL `app.supabase.com/project/<여기>`.

```
npx supabase@latest login
npx supabase@latest link --project-ref <PROJECT_REF>
```

## 1. DB 마이그레이션 3개 (Supabase 웹 → SQL Editor, 순서대로)

파일 내용 전체를 복사해 SQL Editor에 붙여넣고 Run. CLI 불필요.

- [ ] **1-1. 신뢰성** (아직 안 했으면): `supabase/migrations/20261009120100_reliability_transcript_checkpoint_and_active_job_uniq.sql`
  검증:
  ```sql
  select relname, relrowsecurity from pg_class where relname='workflow_transcript_checkpoint';
  select indexname from pg_indexes where indexname='workflow_job_active_note_uniq';
  ```
- [ ] **1-2. mcp_tracking 수렴**: `supabase/migrations/20261009130000_reconcile_mcp_tracking_tables.sql`
  검증:
  ```sql
  select column_name from information_schema.columns
  where table_schema='public' and table_name='mcp_tool_call' and column_name in ('tool','time','outcome','input');
  select is_nullable from information_schema.columns
  where table_schema='public' and table_name='mcp_tool_call' and column_name='tool_name';
  ```
- [ ] **1-3. R01 RPC** (note-audio-url 배포보다 **먼저** 적용해야 함): `supabase/migrations/20261009130100_add_storage_object_owner_fn.sql`
  검증:
  ```sql
  select proname from pg_proc where proname='storage_object_owner';
  ```

## 2. R01 blast-radius 확인 (note-audio-url 배포 직전, 1회)

```sql
select count(*) as null_owner_objects
from storage.objects
where bucket_id='meeting-recordings' and owner_id is null;
```

- 0 이면 안전하게 배포.
- 0 이 아니면 그 오브젝트들은 새 정책에서 owner 불명이라 서명 거부됨(= 해당 레거시 노트 오디오 재생 불가). 숫자가 크면 백필 방법을 먼저 정할 것.

## 3. Edge functions 7개 배포 (자동 배포 안 됨)

먼저 allowlist 시크릿 확인 (없으면 함수가 fail-closed로 403/500):

```
npx supabase@latest secrets list
```

> 2026-10-15 변경: 로그인 게이트는 `ALLOWED_MS_TENANT_IDS`(테넌트)만 본다. `ALLOWED_EMAIL_DOMAINS`는 폐기됐고(외부 테넌트가 Graph `mail`을 `@tecace.com`으로 바꿔 통과할 수 있었음) 설정돼 있으면 무시되며 경고 로그만 남는다. 아래 원래 안내 대신 `ALLOWED_MS_TENANT_IDS`만 설정하고 `ALLOWED_EMAIL_DOMAINS`는 `secrets unset`으로 지운다.

(원래 안내, 2026-10-09) `ALLOWED_MS_TENANT_IDS` 또는 `ALLOWED_EMAIL_DOMAINS` 중 하나는 반드시 있어야 함. 없으면:

```
npx supabase@latest secrets set ALLOWED_MS_TENANT_IDS=<tenant-id>
```

배포 (`_shared/msGraphAllowlist.ts`는 각 함수 번들에 자동 포함됨):

```
npx supabase@latest functions deploy generate-profile identify-speakers supabase-token admin-controls admin-analytics mcp-token note-audio-url
```

- [ ] 7개 배포 완료
- [ ] 스모크: 앱에서 **오디오 재생** 1건 (note-audio-url + R01 정상)
- [ ] 스모크: 앱에서 **요약 생성** 1건 (generate-profile / identify-speakers 정상)
- [ ] (가능하면) 조직 밖 계정이 403으로 거부되는지

## 4. 모바일 APK 빌드 + on-device E2E (C1 검증)

```
cd meeting-note-mobile && bash build_apk.sh
```

실기기 설치 후:

- [ ] 녹음 시작 → 약 1분 (실제 오디오가 쌓이게)
- [ ] 앱 **강제 종료** (스와이프 킬, 정상 stop 없이)
- [ ] 재실행 → "중단된 녹음 복구" 카드가 뜨는지 (탐지)
- [ ] **Use** 탭 → 파일이 삭제되지 않고 새 노트 화면으로 가며 "중단됨 / 일부만 저장" 통지가 뜨는지 (예전 "다시 녹음하세요" 아님)
- [ ] **Discard**는 여전히 확인 후 삭제되는지
- [ ] 복구된 파일로 요약 생성까지 되는지 (미완결 m4a가 전사 안 되면 서버측 remux 후속 필요)

## 5. (선택) Group B 2-user 프로덕션 E2E (백엔드 자동 배포 후)

- [ ] #4: Bob이 Alice의 공유 노트를 regenerate → Alice의 `note_insight.user_id`가 그대로 Alice인지, 내용이 Bob 메모리로 새지 않는지
- [ ] #2: 프로젝트에 제3자 소유 노트를 붙인 뒤, 프로젝트 공유자가 project-chat으로 그 내용을 물었을 때 안 나오는지

## 참고: 자동으로 되는 것 (조치 불필요)

- 백엔드(workflow-server, Group B + Gemini 래퍼 통합)는 main 푸시 시 Render 자동 배포.
- 프론트 테스트 / CI 게이트는 다음 PR/푸시부터 GitHub Actions에서 자동 실행.
