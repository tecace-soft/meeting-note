---
id: DEC-0002
date: 2026-10-09
status: active
question: upload-then-record 스토리지 버킷의 RLS를 무엇으로 소유자 한정할 것인가
options:
  - public.file 테이블과의 join으로 소유자 판정
  - storage.objects.owner_id = auth.jwt()->>'sub'
chosen: owner_id = auth.jwt()->>'sub'로 정책을 한정한다.
reason: 클라이언트가 업로드, 스토리지 확인 poll, 그 다음에 file 행을 쓰므로 file join SELECT 정책은 확인 poll을 막아 업로드를 깨뜨린다. owner_id는 업로드 시점에 Supabase가 채우며 file.user_id와 같다.
paths:
  - supabase/migrations/*recordings*
  - supabase/migrations/*storage*
supersedes: []
source: AGENTS.md "Storage RLS on upload-then-record buckets", supabase/migrations/20261009120000_scope_meeting_recordings_rls.sql
---
## 맥락

원래 정책은 bucket_id만 검사해 인증된 아무 사용자가 다른 사용자의 원본 오디오를 조회, 덮어쓰기, 삭제할 수 있었다.
2026-10-09에 owner_id 기준으로 고치고 prod에서 검증했다.
