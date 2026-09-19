-- ============================================================
-- 运维视图增强：
-- 1. ops.ops_project_user_summary 增加通知 blocked 原因分布
-- 2. 新增 ops.ops_delivery_task_details：Base/通知两类交付任务明细（排障用）
-- 幂等：可重复执行
-- ============================================================

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
