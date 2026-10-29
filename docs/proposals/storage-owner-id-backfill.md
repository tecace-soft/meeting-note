# 제안: meeting-recordings owner_id 백필 (적용 전 승인 필요)

상태는 PROPOSAL이다. 어떤 도구도 이 SQL을 자동 적용하지 않는다.
이 SQL은 `supabase/migrations/`에 두지 않았다(CI나 `db push`가 필수 적용으로 취급하지 않도록).
Andrew가 적용 여부를 결정하고, 적용한다면 SQL Editor에서 직접 실행한다.

## 배경

`meeting-recordings` 버킷의 RLS는 `storage.objects.owner_id`로 소유자를 판정한다(20261009120000).
2026-10-28 기준 930개 객체 중 129개가 `owner_id IS NULL`이고, 모두 `android/` 경로 밖에 있다.
NULL 소유자 객체는 소유자 본인도 RLS 경로로 읽을 수 없다(서비스 롤 경로인 note-audio-url은 영향 없음).
이 백필은 `public.file.user_id`에서 소유자를 복원한다.

## 1. 적용 전 점검 (읽기 전용)

```sql
-- PRE-1. NULL 소유자 객체 수 (기대: 약 129).
select count(*) as null_owner_total
from storage.objects
where bucket_id = 'meeting-recordings' and owner_id is null;

-- PRE-2. 객체별 일치하는 file 행 수 분포. 1이면 백필 대상, 0 또는 2 이상이면 건너뛴다.
select match_count, count(*) as objects
from (
  select o.id, count(f.*) as match_count
  from storage.objects o
  left join public.file f on f.bucket = o.bucket_id and f.storage_path = o.name
  where o.bucket_id = 'meeting-recordings' and o.owner_id is null
  group by o.id
) t
group by match_count
order by match_count;

-- PRE-3. 전체 객체 수와 소유자 있는 객체 수 (기록용).
select count(*) filter (where owner_id is null) as null_owner,
       count(*) filter (where owner_id is not null) as with_owner,
       count(*) as total
from storage.objects where bucket_id = 'meeting-recordings';
```

## 2. 제안 SQL

file 행이 정확히 1개인 객체만 갱신한다. 모호한 객체(0개 또는 2개 이상)는 건너뛴다.
`owner_id`는 text이므로 `user_id`를 text로 변환한다.
`user_id`가 NULL인 file 행은 대상에서 제외한다.

```sql
begin;

update storage.objects o
set owner_id = m.user_id::text
from (
  select o2.id as object_id, min(f.user_id::text) as user_id
  from storage.objects o2
  join public.file f on f.bucket = o2.bucket_id and f.storage_path = o2.name
  where o2.bucket_id = 'meeting-recordings'
    and o2.owner_id is null
  group by o2.id
  having count(*) = 1 and min(f.user_id::text) is not null
) m
where o.id = m.object_id
  and o.bucket_id = 'meeting-recordings'
  and o.owner_id is null;

-- 결과 행 수를 확인한 뒤 commit 한다. 예상과 다르면 rollback 한다.
-- commit;
```

`owner_id`는 Supabase 내부 열이다. `owner`(uuid, deprecated) 열은 건드리지 않는다.

## 3. 적용 후 점검 (읽기 전용)

```sql
-- POST-1. 남은 NULL 소유자 수. PRE-2의 match_count가 0 또는 2 이상이던 객체 수와 같아야 한다.
select count(*) as still_null
from storage.objects
where bucket_id = 'meeting-recordings' and owner_id is null;

-- POST-2. 백필된 객체 수 = PRE-1 - POST-1.

-- POST-3. 남은 NULL 객체가 왜 남았는지 (file 행 없음 vs 중복).
select o.name, count(f.*) as file_rows
from storage.objects o
left join public.file f on f.bucket = o.bucket_id and f.storage_path = o.name
where o.bucket_id = 'meeting-recordings' and o.owner_id is null
group by o.name
order by file_rows, o.name;
```

남은 객체는 소유자를 확정할 수 없으므로 수동 검토 대상이다.

## 4. 롤백

백필 전에 대상 목록을 백업해 둔다. 적용 SQL 실행 직전에 아래를 실행한다.

```sql
create table if not exists public._owner_backfill_20261028 as
select o.id as object_id, o.name
from storage.objects o
where o.bucket_id = 'meeting-recordings' and o.owner_id is null;
```

롤백은 백업 테이블에 있는 객체의 owner_id를 다시 NULL로 되돌린다.

```sql
update storage.objects o
set owner_id = null
from public._owner_backfill_20261028 b
where o.id = b.object_id and o.bucket_id = 'meeting-recordings';
-- 확인 후 백업 테이블 삭제: drop table public._owner_backfill_20261028;
```

원래 NULL이던 객체만 되돌리므로 다른 객체에는 영향이 없다.
