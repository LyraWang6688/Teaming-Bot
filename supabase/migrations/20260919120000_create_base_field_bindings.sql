-- Base 字段绑定表：业务字段 key -> 飞书多维表格 field_id
-- 设计动机：
--   1. 飞书记录写入 API 的 fields 只认 field_name，运营在 Base 里改字段名会导致 FieldNameNotFound
--   2. field_id 在改名后保持稳定，因此绑定 field_id，运行时反查「当前 field_name」写入
--   3. 绑定按 project_id + table_id 隔离，一套代码服务多张表，不硬编码任何一期表的字段名
--   4. 只新增表，不改动任何既有表结构；旧代码不读此表，行为不变

create table if not exists base_field_bindings (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references feishu_projects(id) on delete cascade,
  table_id text not null,
  -- 业务字段标识：meeting_id / meeting_name / meeting_category / direction / creator /
  --              process_status / transcript / analysis_summary / zone / report_url / error_info
  business_key text not null,
  -- 绑定到的飞书字段 ID；unbound 时为 null
  field_id text,
  -- 绑定时的字段名/类型快照，用于审计与变更检测
  field_name_snapshot text,
  field_type_snapshot text,
  -- bound=已绑定；unbound=在目标表找不到约定字段（不写该字段，required 时同步失败）
  binding_status text not null default 'unbound',
  -- true=绑定缺失时同步必须失败；false=缺失时跳过该字段并告警
  required boolean not null default false,
  mapping_version integer not null default 1,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint base_field_bindings_status_chk
    check (binding_status in ('bound', 'unbound'))
);

-- 一个项目的一张表内，一个业务字段 key 只有一条绑定
create unique index if not exists base_field_bindings_project_table_key_uidx
  on base_field_bindings (project_id, table_id, business_key);

create index if not exists base_field_bindings_project_table_idx
  on base_field_bindings (project_id, table_id);
