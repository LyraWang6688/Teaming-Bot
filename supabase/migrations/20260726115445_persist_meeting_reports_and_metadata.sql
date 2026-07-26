-- Persist completed reports in Postgres so historical report access no longer
-- depends on a Feishu app, OAuth token, or Base record being available.
set local lock_timeout = '5s';

alter table public.meeting_records
  add column if not exists host_open_id text,
  add column if not exists host_name text,
  add column if not exists meeting_url text,
  add column if not exists meeting_status text,
  add column if not exists meeting_created_at timestamp with time zone,
  add column if not exists meeting_started_at timestamp with time zone,
  add column if not exists meeting_ended_at timestamp with time zone,
  add column if not exists note_id text,
  add column if not exists report_public_id uuid,
  add column if not exists analysis_result jsonb,
  add column if not exists analysis_schema_version integer,
  add column if not exists analysis_summary text,
  add column if not exists completed_at timestamp with time zone;

update public.meeting_records
set report_public_id = gen_random_uuid()
where report_public_id is null;

alter table public.meeting_records
  alter column report_public_id set default gen_random_uuid(),
  alter column report_public_id set not null;

create unique index if not exists meeting_records_report_public_id_uidx
  on public.meeting_records (report_public_id);

create index if not exists meeting_records_base_record_id_idx
  on public.meeting_records (base_record_id);

alter table public.meeting_records enable row level security;

revoke all on table public.meeting_records from anon, authenticated;
grant select, insert, update, delete on table public.meeting_records to service_role;

alter table public.feishu_integrations
  alter column required_permissions set default
    '["auth:user.id:read","minutes:minutes.basic:read","minutes:minutes.transcript:export","vc:meeting.meetingevent:read","offline_access","bitable:app"]'::jsonb;

update public.feishu_integrations
set
  required_permissions = case
    when required_permissions @> '["vc:meeting.meetingevent:read"]'::jsonb
      then required_permissions
    else required_permissions || '["vc:meeting.meetingevent:read"]'::jsonb
  end,
  oauth_scope = case
    when (' ' || oauth_scope || ' ') like '% vc:meeting.meetingevent:read %'
      then oauth_scope
    else trim(oauth_scope || ' vc:meeting.meetingevent:read')
  end,
  updated_at = now()
where deleted_at is null;
