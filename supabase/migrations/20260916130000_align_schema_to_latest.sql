-- ============================================================================
-- 综合迁移：把数据库结构对齐到最新 schema.ts
-- 幂等设计：可重复执行，已存在的字段/索引不会重复创建，已删除的字段不会报错
-- 涵盖范围：
--   1) meeting_records：补字段 + 删除 9 个未使用字段
--   2) feishu_projects：加 Base 字段 + 删除 starts_at/ends_at
--   3) feishu_project_org_targets：删除 Base 相关字段
--   4) sessions：删除 user_agent/ip_address
--   5) feishu_integrations：required_permissions 默认值同步
-- 注意：feishu_integrations.project_id 的加列、回填、索引
--       已由 20260916120000_add_integration_project_id_binding.sql 处理
-- ============================================================================

set local lock_timeout = '5s';

-- ----------------------------------------------------------------------------
-- 1. meeting_records：补字段
-- ----------------------------------------------------------------------------
alter table if exists public.meeting_records
  add column if not exists transcript text,
  add column if not exists transcript_stored_at timestamp with time zone,
  add column if not exists organizer_open_id text,
  add column if not exists project_id uuid,
  add column if not exists org_target_id uuid,
  add column if not exists base_record_id text,
  add column if not exists feishu_meeting_id text,
  add column if not exists minute_token text,
  add column if not exists status text not null default 'meeting_ended',
  add column if not exists topic text,
  add column if not exists report_url text,
  add column if not exists analyzed_at timestamp with time zone,
  add column if not exists last_error_type text,
  add column if not exists last_error_message text,
  add column if not exists updated_at timestamp with time zone default now() not null;

-- 处理 feishu_meeting_id 的 not null 约束（仅在有数据且无 NULL 时才能加 not null）
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_name = 'meeting_records'
      and column_name = 'feishu_meeting_id'
      and is_nullable = 'YES'
  ) and not exists (
    select 1 from public.meeting_records where feishu_meeting_id is null
  ) then
    alter table public.meeting_records alter column feishu_meeting_id set not null;
  end if;
exception
  when others then
    raise notice '跳过 feishu_meeting_id not null 约束: %', sqlerrm;
end $$;

-- meeting_records 唯一索引：integration_id + feishu_meeting_id
create unique index if not exists meeting_records_integration_meeting_uidx
  on public.meeting_records (integration_id, feishu_meeting_id);

-- meeting_records 普通索引
create index if not exists meeting_records_user_id_idx
  on public.meeting_records (user_id);
create index if not exists meeting_records_integration_id_idx
  on public.meeting_records (integration_id);
create index if not exists meeting_records_project_id_idx
  on public.meeting_records (project_id);
create index if not exists meeting_records_org_target_id_idx
  on public.meeting_records (org_target_id);
create index if not exists meeting_records_report_public_id_idx
  on public.meeting_records (report_public_id);
create index if not exists meeting_records_base_record_id_idx
  on public.meeting_records (base_record_id);
create index if not exists meeting_records_status_idx
  on public.meeting_records (status);

-- ----------------------------------------------------------------------------
-- 2. meeting_records：删除 9 个未使用字段
-- ----------------------------------------------------------------------------
alter table if exists public.meeting_records
  drop column if exists meeting_url,
  drop column if exists meeting_status,
  drop column if exists meeting_created_at,
  drop column if exists meeting_started_at,
  drop column if exists meeting_ended_at,
  drop column if exists note_id,
  drop column if exists host_name,
  drop column if exists host_open_id,
  drop column if exists metadata;

-- ----------------------------------------------------------------------------
-- 3. feishu_projects：加 Base 字段 + 删除 starts_at/ends_at
-- ----------------------------------------------------------------------------
alter table if exists public.feishu_projects
  add column if not exists bitable_app_token_encrypted text,
  add column if not exists bitable_table_id text;

alter table if exists public.feishu_projects
  drop column if exists starts_at,
  drop column if exists ends_at;

create index if not exists feishu_projects_status_idx
  on public.feishu_projects (status);
create unique index if not exists feishu_projects_project_key_uidx
  on public.feishu_projects (project_key);

-- ----------------------------------------------------------------------------
-- 4. feishu_project_org_targets：删除 Base 相关字段
--    （Base 配置已上移到 feishu_projects 项目级）
-- ----------------------------------------------------------------------------
alter table if exists public.feishu_project_org_targets
  drop column if exists base_app_token_encrypted,
  drop column if exists table_id,
  drop column if exists base_url;

-- ----------------------------------------------------------------------------
-- 5. sessions：删除 user_agent/ip_address
--    （不再追踪客户端设备信息）
-- ----------------------------------------------------------------------------
alter table if exists public.sessions
  drop column if exists user_agent,
  drop column if exists ip_address;

-- ----------------------------------------------------------------------------
-- 6. feishu_integrations：required_permissions 默认值同步
--    （Base 读写改用应用权限，用户 OAuth scope 不再申请 bitable:app）
-- ----------------------------------------------------------------------------
alter table if exists public.feishu_integrations
  alter column required_permissions set default
    '["auth:user.id:read","minutes:minutes.basic:read","minutes:minutes.transcript:export","vc:meeting.meetingevents:read","offline_access"]'::jsonb;

-- ----------------------------------------------------------------------------
-- 7. 验证查询：迁移完成后跑一遍，所有 active 集成应已绑定 project_id
-- ----------------------------------------------------------------------------
-- select id, name, is_active, selected_org_target_id, project_id
-- from public.feishu_integrations
-- where is_active = true and project_id is null;
-- 期望：0 行返回
