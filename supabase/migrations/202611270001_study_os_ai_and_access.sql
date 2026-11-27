-- Study OS v93 add-on schema. This migration does NOT modify study_os_sync,
-- its payload, or its existing save/sync function.
create table if not exists public.study_os_user_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'user' check (role in ('admin','manager','user')),
  approved boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.study_os_access_grants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  manager_id uuid not null references auth.users(id) on delete cascade,
  scope text not null check (scope in ('summary','full')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique(owner_id, manager_id),
  check (owner_id <> manager_id)
);

create table if not exists public.study_os_access_audit (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  owner_id uuid references auth.users(id) on delete cascade,
  manager_id uuid references auth.users(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.study_os_ai_usage_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  usage_day date not null default (now() at time zone 'utc')::date,
  request_count integer not null default 0 check (request_count >= 0),
  primary key(user_id, usage_day)
);


create or replace function public.study_os_create_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.study_os_user_profiles(user_id, email, role, approved)
  values (new.id, lower(new.email), 'user', false)
  on conflict (user_id) do update set email = excluded.email, updated_at = now();
  return new;
end;
$$;
revoke all on function public.study_os_create_user_profile() from public, anon, authenticated;
drop trigger if exists study_os_auth_user_profile on auth.users;
create trigger study_os_auth_user_profile
  after insert on auth.users
  for each row execute function public.study_os_create_user_profile();

alter table public.study_os_user_profiles enable row level security;
alter table public.study_os_access_grants enable row level security;
alter table public.study_os_access_audit enable row level security;
alter table public.study_os_ai_usage_daily enable row level security;

-- Read-only self profile, and only one's own grants. Mutations are performed
-- by the authenticated Edge Functions using the server-side service key.
revoke all on public.study_os_user_profiles from anon, authenticated;
revoke all on public.study_os_access_grants from anon, authenticated;
revoke all on public.study_os_access_audit from anon, authenticated;
revoke all on public.study_os_ai_usage_daily from anon, authenticated;
grant select on public.study_os_user_profiles to authenticated;
grant select on public.study_os_access_grants to authenticated;
grant select on public.study_os_access_audit to authenticated;

drop policy if exists "study_os_profiles_self_read" on public.study_os_user_profiles;
create policy "study_os_profiles_self_read" on public.study_os_user_profiles
  for select to authenticated using (user_id = auth.uid());

drop policy if exists "study_os_grants_owner_or_manager_read" on public.study_os_access_grants;
create policy "study_os_grants_owner_or_manager_read" on public.study_os_access_grants
  for select to authenticated using (owner_id = auth.uid() or manager_id = auth.uid());

drop policy if exists "study_os_audit_owner_or_actor_read" on public.study_os_access_audit;
create policy "study_os_audit_owner_or_actor_read" on public.study_os_access_audit
  for select to authenticated using (owner_id = auth.uid() or actor_id = auth.uid());

create or replace function public.study_os_consume_ai_quota(p_user_id uuid, p_daily_limit integer default 5)
returns table(allowed boolean, used integer, daily_limit integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_used integer;
begin
  if p_user_id is null or p_daily_limit < 1 or p_daily_limit > 100 then
    raise exception 'Invalid quota request';
  end if;
  insert into public.study_os_ai_usage_daily(user_id, usage_day, request_count)
  values (p_user_id, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, usage_day)
  do update set request_count = public.study_os_ai_usage_daily.request_count + 1
  returning request_count into v_used;
  return query select (v_used <= p_daily_limit), v_used, p_daily_limit;
end;
$$;
revoke all on function public.study_os_consume_ai_quota(uuid, integer) from public, anon, authenticated;
grant execute on function public.study_os_consume_ai_quota(uuid, integer) to service_role;

comment on table public.study_os_access_grants is 'Explicit owner-to-manager data-sharing grants. All content access must be checked by study-admin Edge Function.';
comment on table public.study_os_access_audit is 'Audit records for invitations, grants, revocations and shared data access.';
comment on table public.study_os_ai_usage_daily is 'Server-enforced per-user daily AI request counts.';
