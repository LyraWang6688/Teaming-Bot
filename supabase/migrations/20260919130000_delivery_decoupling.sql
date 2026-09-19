-- 2026-09-19 双维度改造（Base/通知与主链路解耦）增量迁移
-- 原则：幂等（可重复执行）；只做增量 ALTER / CREATE IF NOT EXISTS；不删除旧列旧表。
-- 包含：
--   1. meeting_records 增加数据版本 / 报告修订 / 通知接收人绑定列（不加 meeting_type 列，复用 analysis_result jsonb）
--   2. base_field_bindings 增加 bound_by / bound_at，binding_status 扩展为 bound/unbound/type_mismatch/disabled
--   3. feishu_integrations 增加 first_initialized_at / first_initialized_evidence（只写一次）
--   4. feishu_setup_attempts 初始化尝试表
--   5. meeting_base_sync_tasks Base 交付任务表
--   6. meeting_report_notification_tasks 通知交付任务表
--   7. ops schema 运维视图（调用者权限，不对普通用户授权）

-- ============================================================
-- 0. ops schema
-- ============================================================
CREATE SCHEMA IF NOT EXISTS ops;

-- ============================================================
-- 1. meeting_records 新列
-- ============================================================
ALTER TABLE public.meeting_records
  ADD COLUMN IF NOT EXISTS data_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS report_revision integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recipient_open_id text,
  ADD COLUMN IF NOT EXISTS recipient_app_id text,
  ADD COLUMN IF NOT EXISTS recipient_source text,
  ADD COLUMN IF NOT EXISTS recipient_verified_at timestamptz(6);

COMMENT ON COLUMN public.meeting_records.data_version IS '会议数据版本：Supabase 内容每次推进 +1（建档=1，文字稿=2，终态=3）';
COMMENT ON COLUMN public.meeting_records.report_revision IS '报告修订版本：每次终态报告（含失败终态）+1，用于通知任务修订号';
COMMENT ON COLUMN public.meeting_records.recipient_open_id IS '通知接收人 open_id，取门槛校验通过的会议创建人';
COMMENT ON COLUMN public.meeting_records.recipient_app_id IS '通知接收时固定使用的集成 app_id，不允许运行时自动换人换应用';
COMMENT ON COLUMN public.meeting_records.recipient_source IS '接收人来源，当前固定 meeting_gate_verified';

-- ============================================================
-- 2. base_field_bindings 细化
-- ============================================================
ALTER TABLE public.base_field_bindings
  ADD COLUMN IF NOT EXISTS bound_by text,
  ADD COLUMN IF NOT EXISTS bound_at timestamptz(6);

COMMENT ON COLUMN public.base_field_bindings.bound_by IS '绑定来源：bootstrap（上线补绑定）/ auto（运行时自动）/ manual（人工）';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'base_field_bindings_binding_status_chk'
  ) THEN
    ALTER TABLE public.base_field_bindings
      ADD CONSTRAINT base_field_bindings_binding_status_chk
      CHECK (binding_status IN ('bound', 'unbound', 'type_mismatch', 'disabled'));
  END IF;
END $$;

-- 历史脏值兜底：未知状态归一为 unbound
UPDATE public.base_field_bindings
SET binding_status = 'unbound'
WHERE binding_status NOT IN ('bound', 'unbound', 'type_mismatch', 'disabled');

-- ============================================================
-- 3. feishu_integrations 首次初始化事实（只写一次，替换/恢复都不覆盖）
-- ============================================================
ALTER TABLE public.feishu_integrations
  ADD COLUMN IF NOT EXISTS first_initialized_at timestamptz(6),
  ADD COLUMN IF NOT EXISTS first_initialized_evidence text;

COMMENT ON COLUMN public.feishu_integrations.first_initialized_at IS '该集成首次完成初始化（全部检查通过+监听就绪）的时间，落库后不再被覆盖';
COMMENT ON COLUMN public.feishu_integrations.first_initialized_evidence IS '首次初始化事实证据，如 live_transition:<eventId>';

-- ============================================================
-- 4. feishu_setup_attempts 初始化尝试表
-- ============================================================
CREATE TABLE IF NOT EXISTS public.feishu_setup_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  integration_id uuid,
  project_id uuid,
  org_target_id uuid,
  setup_trace_id text NOT NULL,
  current_step text NOT NULL DEFAULT 'create_app',
  status text NOT NULL DEFAULT 'running',
  started_at timestamptz(6) NOT NULL DEFAULT now(),
  step_started_at timestamptz(6),
  last_progress_at timestamptz(6),
  finished_at timestamptz(6),
  last_error_code text,
  last_error_summary text,
  next_action_code text,
  end_reason text,
  state_version integer NOT NULL DEFAULT 1,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT feishu_setup_attempts_status_chk
    CHECK (status IN ('running', 'waiting_user', 'succeeded', 'failed', 'expired', 'interrupted', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS feishu_setup_attempts_trace_uidx
  ON public.feishu_setup_attempts(setup_trace_id);
CREATE INDEX IF NOT EXISTS feishu_setup_attempts_user_idx
  ON public.feishu_setup_attempts(user_id);
CREATE INDEX IF NOT EXISTS feishu_setup_attempts_integration_idx
  ON public.feishu_setup_attempts(integration_id);
CREATE INDEX IF NOT EXISTS feishu_setup_attempts_status_updated_idx
  ON public.feishu_setup_attempts(status, updated_at);

-- ============================================================
-- 5. meeting_base_sync_tasks Base 交付任务
-- ============================================================
CREATE TABLE IF NOT EXISTS public.meeting_base_sync_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_record_id uuid NOT NULL REFERENCES public.meeting_records(id) ON DELETE CASCADE,
  integration_id uuid NOT NULL,
  user_id uuid NOT NULL,
  project_id uuid,
  org_target_id uuid,
  target_key text NOT NULL,
  target_config_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  mapping_version integer,
  requested_version integer NOT NULL DEFAULT 0,
  synced_version integer NOT NULL DEFAULT 0,
  inflight_version integer,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_run_at timestamptz(6),
  lease_token text,
  lease_expires_at timestamptz(6),
  base_record_id text,
  partial boolean NOT NULL DEFAULT false,
  last_error_code text,
  last_error_summary text,
  last_attempt_at timestamptz(6),
  last_succeeded_at timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT meeting_base_sync_tasks_status_chk
    CHECK (status IN ('pending', 'running', 'retry_wait', 'succeeded', 'blocked', 'unknown', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS meeting_base_sync_tasks_record_target_uidx
  ON public.meeting_base_sync_tasks(meeting_record_id, target_key);
CREATE INDEX IF NOT EXISTS meeting_base_sync_tasks_status_next_run_idx
  ON public.meeting_base_sync_tasks(status, next_run_at);
CREATE INDEX IF NOT EXISTS meeting_base_sync_tasks_lease_idx
  ON public.meeting_base_sync_tasks(lease_expires_at);
CREATE INDEX IF NOT EXISTS meeting_base_sync_tasks_integration_idx
  ON public.meeting_base_sync_tasks(integration_id);
CREATE INDEX IF NOT EXISTS meeting_base_sync_tasks_base_record_idx
  ON public.meeting_base_sync_tasks(base_record_id);

COMMENT ON TABLE public.meeting_base_sync_tasks IS 'Base 镜像交付任务；与分析/通知独立，blocked/partial 不阻断主链路';
COMMENT ON COLUMN public.meeting_base_sync_tasks.target_key IS '稳定目标键（project:<projectId>；未绑定项目时 project:unbound），同会议只保留当前目标一个任务';
COMMENT ON COLUMN public.meeting_base_sync_tasks.requested_version IS '已请求镜像的 Supabase data_version';
COMMENT ON COLUMN public.meeting_base_sync_tasks.synced_version IS '已成功镜像的 data_version';

-- ============================================================
-- 6. meeting_report_notification_tasks 通知交付任务
-- ============================================================
CREATE TABLE IF NOT EXISTS public.meeting_report_notification_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_record_id uuid NOT NULL REFERENCES public.meeting_records(id) ON DELETE CASCADE,
  report_revision integer NOT NULL,
  integration_id uuid NOT NULL,
  user_id uuid NOT NULL,
  recipient_app_id text NOT NULL,
  recipient_open_id text NOT NULL,
  report_url text NOT NULL,
  meeting_title_snapshot text,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  next_run_at timestamptz(6),
  lease_token text,
  lease_expires_at timestamptz(6),
  message_id text,
  last_error_code text,
  last_error_summary text,
  last_attempt_at timestamptz(6),
  sent_at timestamptz(6),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT meeting_report_notification_tasks_status_chk
    CHECK (status IN ('pending', 'running', 'retry_wait', 'succeeded', 'blocked', 'unknown', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS meeting_report_notification_tasks_recipient_uidx
  ON public.meeting_report_notification_tasks(meeting_record_id, report_revision, recipient_app_id, recipient_open_id);
CREATE UNIQUE INDEX IF NOT EXISTS meeting_report_notification_tasks_idem_uidx
  ON public.meeting_report_notification_tasks(idempotency_key);
CREATE INDEX IF NOT EXISTS meeting_report_notification_tasks_status_next_run_idx
  ON public.meeting_report_notification_tasks(status, next_run_at);
CREATE INDEX IF NOT EXISTS meeting_report_notification_tasks_lease_idx
  ON public.meeting_report_notification_tasks(lease_expires_at);
CREATE INDEX IF NOT EXISTS meeting_report_notification_tasks_integration_idx
  ON public.meeting_report_notification_tasks(integration_id);

COMMENT ON TABLE public.meeting_report_notification_tasks IS '报告通知交付任务；接收人/app 在任务创建时固定，blocked 不允许自动换人换应用';

-- ============================================================
-- 7. 运维视图（ops schema，调用者权限；仅授予 service_role）
-- ============================================================
CREATE OR REPLACE VIEW ops.ops_integration_overview AS
SELECT
  i.id AS integration_id,
  i.user_id,
  u.feishu_name AS user_name,
  u.feishu_open_id,
  COALESCE(p.id, i.project_id) AS project_id,
  p.project_key,
  p.name AS project_name,
  ot.org_key,
  ot.org_name,
  i.app_id,
  i.status,
  i.is_active,
  i.setup_step,
  i.superseded_at,
  i.activated_at,
  i.initialized_at,
  i.first_initialized_at,
  i.first_initialized_evidence,
  a.status AS oauth_authorization_status,
  a.access_token_expires_at,
  a.refresh_token_expires_at,
  c.app_credential_status,
  c.permission_status,
  c.minute_subscription_status,
  c.event_subscription_status,
  c.oauth_status AS check_oauth_status,
  c.base_status,
  c.last_checked_at,
  c.last_error_type,
  c.last_error_message,
  sa.current_step AS latest_attempt_step,
  sa.status AS latest_attempt_status,
  sa.updated_at AS latest_attempt_at,
  (SELECT count(*) FROM public.meeting_records mr WHERE mr.integration_id = i.id) AS meeting_total,
  (SELECT count(*)
     FROM public.meeting_base_sync_tasks b
     JOIN public.meeting_records mr ON mr.id = b.meeting_record_id
    WHERE mr.integration_id = i.id AND b.status = 'blocked') AS base_blocked_total,
  (SELECT count(*)
     FROM public.meeting_base_sync_tasks b
     JOIN public.meeting_records mr ON mr.id = b.meeting_record_id
    WHERE mr.integration_id = i.id AND b.status = 'unknown') AS base_unknown_total,
  (SELECT count(*)
     FROM public.meeting_report_notification_tasks n
     JOIN public.meeting_records mr ON mr.id = n.meeting_record_id
    WHERE mr.integration_id = i.id AND n.status = 'blocked') AS notification_blocked_total
FROM public.feishu_integrations i
JOIN public.users u ON u.id = i.user_id
LEFT JOIN public.feishu_project_org_targets ot ON ot.id = i.selected_org_target_id
LEFT JOIN public.feishu_projects p ON p.id = COALESCE(ot.project_id, i.project_id)
LEFT JOIN public.feishu_authorizations a ON a.integration_id = i.id
LEFT JOIN public.feishu_integration_checks c ON c.integration_id = i.id
LEFT JOIN LATERAL (
  SELECT current_step, status, updated_at
  FROM public.feishu_setup_attempts
  WHERE integration_id = i.id
  ORDER BY updated_at DESC
  LIMIT 1
) sa ON true
WHERE i.deleted_at IS NULL;

CREATE OR REPLACE VIEW ops.ops_setup_attempt_overview AS
SELECT
  sa.id,
  sa.setup_trace_id,
  sa.user_id,
  u.feishu_name AS user_name,
  sa.integration_id,
  i.app_id,
  sa.project_id,
  p.project_key,
  sa.org_target_id,
  ot.org_name,
  sa.current_step,
  sa.status,
  sa.started_at,
  sa.step_started_at,
  sa.last_progress_at,
  sa.finished_at,
  sa.last_error_code,
  sa.last_error_summary,
  sa.next_action_code,
  sa.end_reason,
  sa.state_version,
  sa.updated_at
FROM public.feishu_setup_attempts sa
JOIN public.users u ON u.id = sa.user_id
LEFT JOIN public.feishu_integrations i ON i.id = sa.integration_id
LEFT JOIN public.feishu_projects p ON p.id = sa.project_id
LEFT JOIN public.feishu_project_org_targets ot ON ot.id = sa.org_target_id;

CREATE OR REPLACE VIEW ops.ops_project_user_summary AS
SELECT
  p.id AS project_id,
  p.project_key,
  p.name AS project_name,
  p.status AS project_status,
  count(DISTINCT i.id) FILTER (WHERE i.first_initialized_at IS NOT NULL) AS initialized_integration_total,
  count(DISTINCT i.user_id) FILTER (WHERE i.first_initialized_at IS NOT NULL) AS initialized_user_total,
  count(DISTINCT i.user_id) AS bound_user_total,
  count(DISTINCT u.feishu_union_id) FILTER (WHERE i.first_initialized_at IS NOT NULL) AS initialized_union_total,
  (SELECT count(*)
     FROM public.meeting_records mr
    WHERE mr.project_id = p.id) AS meeting_total,
  (SELECT count(*)
     FROM public.meeting_base_sync_tasks b
     JOIN public.meeting_records mr ON mr.id = b.meeting_record_id
    WHERE mr.project_id = p.id AND b.status = 'blocked') AS base_blocked_total,
  (SELECT count(*)
     FROM public.meeting_report_notification_tasks n
     JOIN public.meeting_records mr ON mr.id = n.meeting_record_id
    WHERE mr.project_id = p.id AND n.status = 'blocked') AS notification_blocked_total,
  (SELECT COALESCE(jsonb_object_agg(t.last_error_code, t.cnt), '{}'::jsonb)
     FROM (
       SELECT b.last_error_code, count(*) AS cnt
       FROM public.meeting_base_sync_tasks b
       JOIN public.meeting_records mr ON mr.id = b.meeting_record_id
       WHERE mr.project_id = p.id AND b.status = 'blocked'
       GROUP BY b.last_error_code
     ) t) AS base_blocked_reason_distribution
FROM public.feishu_projects p
LEFT JOIN public.feishu_project_org_targets ot ON ot.project_id = p.id
LEFT JOIN public.feishu_integrations i
  ON i.deleted_at IS NULL
 AND (i.selected_org_target_id = ot.id OR (i.selected_org_target_id IS NULL AND i.project_id = p.id))
LEFT JOIN public.users u ON u.id = i.user_id
GROUP BY p.id, p.project_key, p.name, p.status;

-- 视图使用调用者权限（PG15+），避免 view owner 提权
DO $$
BEGIN
  IF current_setting('server_version_num')::integer >= 150000 THEN
    EXECUTE 'ALTER VIEW ops.ops_integration_overview SET (security_invoker = on)';
    EXECUTE 'ALTER VIEW ops.ops_setup_attempt_overview SET (security_invoker = on)';
    EXECUTE 'ALTER VIEW ops.ops_project_user_summary SET (security_invoker = on)';
  END IF;
END $$;

-- 撤销 PUBLIC 默认权限，仅向存在的 service_role 授予只读
REVOKE ALL ON SCHEMA ops FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA ops TO service_role';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA ops TO service_role';
  END IF;
END $$;
