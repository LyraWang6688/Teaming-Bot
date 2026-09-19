-- =====================================================================
-- Teaming-Bot 第四期上线 · 数据库手动执行包
-- 日期：2026-09-19
-- 用法：Supabase Dashboard → SQL Editor → 新建 query
--       建议【逐段执行】：选中一段 → Run，确认结果后再跑下一段
-- 特性：全部语句幂等，可重复执行；只加列/索引、视图、删一个多余约束，
--       不删除任何业务数据
-- 对应：
--   D1 段1  feishu_setup_attempts 补 registration_session_hash（F05 前置）
--   D2 段1  删除 base_field_bindings 旧 2 态 CHECK（F08 前置）
--   D3 段2  运维视图增强（补 ops_delivery_task_details、升级项目汇总视图）
-- =====================================================================


-- ========================= 段 0 · 执行前预检（只读） =========================
-- 变更前预期：
--   q1 无行（列还不存在）
--   q2 同时看到 base_field_bindings_status_chk(2态)
--      与 base_field_bindings_binding_status_chk(4态)
--   q3 只有 ops_project_user_summary，没有 ops_delivery_task_details
SELECT column_name
FROM information_schema.columns
WHERE table_schema='public' AND table_name='feishu_setup_attempts'
  AND column_name='registration_session_hash';

SELECT conname, pg_get_constraintdef(c.oid) AS def
FROM pg_constraint c
WHERE c.conrelid='public.base_field_bindings'::regclass AND c.contype='c';

SELECT table_name
FROM information_schema.views
WHERE table_schema='ops'
  AND table_name IN ('ops_project_user_summary','ops_delivery_task_details')
ORDER BY table_name;


-- ===================== 段 1 · D1 + D2（整段一次 Run） =====================
-- 说明：Supabase SQL Editor 会把单次运行放在一个事务内，DDL 同样可回滚；
--       若任一句报错，本段不会部分生效，把报错发回即可。
--       （用 psql 执行时可自行在首尾加 BEGIN / COMMIT）

-- D1: F05 创建应用会话关联列（只存 hash，不存明文 sessionToken）
ALTER TABLE public.feishu_setup_attempts
  ADD COLUMN IF NOT EXISTS registration_session_hash text;

COMMENT ON COLUMN public.feishu_setup_attempts.registration_session_hash IS
  '创建应用会话的 hash（非明文），用于注册会话丢失时定位未关联集成的尝试';

CREATE INDEX IF NOT EXISTS feishu_setup_attempts_session_hash_idx
  ON public.feishu_setup_attempts (user_id, registration_session_hash)
  WHERE integration_id IS NULL;

-- D2: 删除与 4 态约束冲突的旧 2 态 CHECK（保留 base_field_bindings_binding_status_chk）
ALTER TABLE public.base_field_bindings
  DROP CONSTRAINT IF EXISTS base_field_bindings_status_chk;


-- ===================== 段 2 · D3 运维视图增强（整段一次 Run） =====================
-- 与仓库迁移 20260920100000_ops_view_enhancements.sql 完全一致，幂等。

-- 1. 项目汇总视图：追加 notification_blocked_reason_distribution
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
     ) t) AS base_blocked_reason_distribution,
  (SELECT COALESCE(jsonb_object_agg(t.last_error_code, t.cnt), '{}'::jsonb)
     FROM (
       SELECT n.last_error_code, count(*) AS cnt
       FROM public.meeting_report_notification_tasks n
       JOIN public.meeting_records mr ON mr.id = n.meeting_record_id
       WHERE mr.project_id = p.id AND n.status = 'blocked'
       GROUP BY n.last_error_code
     ) t) AS notification_blocked_reason_distribution
FROM public.feishu_projects p
LEFT JOIN public.feishu_project_org_targets ot ON ot.project_id = p.id
LEFT JOIN public.feishu_integrations i
  ON i.deleted_at IS NULL
 AND (i.selected_org_target_id = ot.id OR (i.selected_org_target_id IS NULL AND i.project_id = p.id))
LEFT JOIN public.users u ON u.id = i.user_id
GROUP BY p.id, p.project_key, p.name, p.status;

-- 2. 交付任务明细视图：Base 镜像 + 报告通知 UNION ALL
CREATE OR REPLACE VIEW ops.ops_delivery_task_details AS
SELECT
  'base_sync'::text AS task_kind,
  b.id AS task_id,
  b.meeting_record_id,
  mr.feishu_meeting_id,
  mr.topic AS meeting_topic,
  mr.report_url AS meeting_report_url,
  b.project_id,
  b.integration_id,
  b.user_id,
  b.target_key,
  NULL::integer AS report_revision,
  NULL::text AS idempotency_key,
  b.status,
  b.attempt_count,
  b.requested_version,
  b.synced_version,
  b.inflight_version,
  b.partial,
  b.base_record_id,
  NULL::text AS recipient_app_id,
  NULL::text AS recipient_open_id,
  NULL::text AS message_id,
  b.last_error_code,
  b.last_error_summary,
  b.next_run_at,
  b.lease_expires_at,
  b.last_attempt_at,
  b.last_succeeded_at AS finished_at,
  b.created_at,
  b.updated_at
FROM public.meeting_base_sync_tasks b
JOIN public.meeting_records mr ON mr.id = b.meeting_record_id
UNION ALL
SELECT
  'notification'::text AS task_kind,
  n.id AS task_id,
  n.meeting_record_id,
  mr.feishu_meeting_id,
  mr.topic AS meeting_topic,
  n.report_url AS meeting_report_url,
  mr.project_id,
  n.integration_id,
  n.user_id,
  NULL::text AS target_key,
  n.report_revision,
  n.idempotency_key,
  n.status,
  n.attempt_count,
  NULL::integer AS requested_version,
  NULL::integer AS synced_version,
  NULL::integer AS inflight_version,
  false AS partial,
  NULL::text AS base_record_id,
  n.recipient_app_id,
  n.recipient_open_id,
  n.message_id,
  n.last_error_code,
  n.last_error_summary,
  n.next_run_at,
  n.lease_expires_at,
  n.last_attempt_at,
  n.sent_at AS finished_at,
  n.created_at,
  n.updated_at
FROM public.meeting_report_notification_tasks n
JOIN public.meeting_records mr ON mr.id = n.meeting_record_id;

COMMENT ON VIEW ops.ops_delivery_task_details IS 'Base 镜像与报告通知两类交付任务明细；按 status/last_error_code/task_kind 过滤排障';

-- 视图使用调用者权限（PG15+）
DO $$
BEGIN
  IF current_setting('server_version_num')::integer >= 150000 THEN
    EXECUTE 'ALTER VIEW ops.ops_project_user_summary SET (security_invoker = on)';
    EXECUTE 'ALTER VIEW ops.ops_delivery_task_details SET (security_invoker = on)';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    EXECUTE 'GRANT SELECT ON ops.ops_project_user_summary TO service_role';
    EXECUTE 'GRANT SELECT ON ops.ops_delivery_task_details TO service_role';
  END IF;
END $$;


-- ========================= 段 3 · 执行后验证（只读） =========================
-- 预期：
--   v1 返回 registration_session_hash（1 行）
--   v2 只剩 base_field_bindings_binding_status_chk，def 含 type_mismatch/disabled；
--      旧 base_field_bindings_status_chk 不再出现
--   v3 两个视图都在（2 行）
--   v4 返回 notification_blocked_reason_distribution（1 行）
--   v5 第四期行：initialized_integration_total / initialized_user_total 均应为 2
SELECT column_name
FROM information_schema.columns
WHERE table_schema='public' AND table_name='feishu_setup_attempts'
  AND column_name='registration_session_hash';

SELECT conname, pg_get_constraintdef(c.oid) AS def
FROM pg_constraint c
WHERE c.conrelid='public.base_field_bindings'::regclass AND c.contype='c';

SELECT table_name
FROM information_schema.views
WHERE table_schema='ops'
  AND table_name IN ('ops_project_user_summary','ops_delivery_task_details')
ORDER BY table_name;

SELECT column_name
FROM information_schema.columns
WHERE table_schema='ops' AND table_name='ops_project_user_summary'
  AND column_name='notification_blocked_reason_distribution';

SELECT project_name, initialized_integration_total, initialized_user_total,
       base_blocked_total, notification_blocked_total,
       notification_blocked_reason_distribution
FROM ops.ops_project_user_summary
WHERE project_name LIKE '%第四期%';


-- =================== 段 4 ·（可选收尾）补迁移登记 ===================
-- 在 SQL Editor 手工执行不会写 supabase_migrations.schema_migrations。
-- 建议回到本机仓库，用 Supabase CLI 把这两个版本标记为已应用（需先 supabase link）：
--
--   npx supabase migration repair --linked 20260920100000 --status applied
--   npx supabase migration repair --linked 20260920120000 --status applied
--
-- 更早手工执行、同样未登记的迁移（20260724143000 / 20260724162000 /
-- 20260726115445 / 20260916120000 / 20260917120000 / 20260919120000 /
-- 20260919130000）建议在逐一核对对象存在后，再用同样命令补登记，不要盲标。
