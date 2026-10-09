# 2026-10-09 배치 수동 적용 체크리스트

이 배치(Group A/B/C + 형제 취약점 + R01)의 코드는 모두 커밋/푸시됨.
백엔드(workflow-server)는 main에서 자동 배포되지만, 아래는 자동화되지 않는 수동 작업이다.
순서가 중요한 곳은 명시했다.

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

`ALLOWED_MS_TENANT_IDS` 또는 `ALLOWED_EMAIL_DOMAINS` 중 하나는 반드시 있어야 함. 없으면:

```
npx supabase@latest secrets set ALLOWED_MS_TENANT_IDS=<tenant-id> ALLOWED_EMAIL_DOMAINS=tecace.com
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
