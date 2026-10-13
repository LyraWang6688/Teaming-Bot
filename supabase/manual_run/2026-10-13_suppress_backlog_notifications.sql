-- =====================================================================
-- 补历史积压：只写多维表格、不推卡片
--
-- 背景：2026-09-30 流水线 worker 因一次数据库查询永久挂起而静默停摆，
--       到 2026-10-13 已积压 51 条 pending 任务。修好 worker 后这些任务会被
--       自动重放；为了不一次性打扰用户，先给它们打上"抑制推送"标记。
--
-- 效果：报告照常分析、照常写入多维表格；
--       通知任务以 `cancelled` 入队（留痕：收件人、报告 URL、标题都在），
--       交付 worker 只领取 pending/retry_wait，因此不会被发送。
--
-- 前置：代码包含 `suppressNotification` 支持（meetingPipelineProcessor.ts +
--       notificationTaskStore.ts），且 worker 已用新版重启。
--
-- 用法：逐段执行。先跑【段 0】预检，确认数字后再跑【段 1】。
-- 本文件只改 payload 和 status，不删除任何业务数据。
-- =====================================================================


-- ============ 段 0 · 执行前预检（只读，不改任何东西） ============
-- 预期：51 条待处理任务、0 条已带标记、0 条 cancelled 通知任务

select count(*) as 待打标记的积压任务
from meeting_pipeline_tasks
where status = 'pending'
  and coalesce(payload->'delivery'->>'suppressNotification', 'false') <> 'true';

select count(*) as 已带标记的任务
from meeting_pipeline_tasks
where payload->'delivery'->>'suppressNotification' = 'true';

select count(*) as 当前_cancelled_通知任务
from meeting_report_notification_tasks
where status = 'cancelled';


-- ============ 段 1 · 打标记（只影响待处理任务） ============
-- 幂等：重复执行不会重复累加。
-- 注意：只标记 `pending`——已经 completed/skipped/failed 的任务不会再被处理，
--       给它们加标记没有意义，也会污染历史记录。

update meeting_pipeline_tasks
set payload = coalesce(payload, '{}'::jsonb)
              || jsonb_build_object(
                   'delivery',
                   jsonb_build_object('suppressNotification', true)
                 ),
    updated_at = now()
where status = 'pending';


-- ============ 段 2 · 执行后核对 ============
-- 预期：待打标记的积压任务 = 0，已带标记的任务 = 段 0 查到的数量

select count(*) as 待打标记的积压任务
from meeting_pipeline_tasks
where status = 'pending'
  and coalesce(payload->'delivery'->>'suppressNotification', 'false') <> 'true';

select status, count(*) as n
from meeting_pipeline_tasks
group by status
order by n desc;


-- ============ 附 A · 撤销标记（如果决定照常推卡片） ============
-- 只对还没被处理的任务生效；已处理的任务不受影响。
--
-- update meeting_pipeline_tasks
-- set payload = payload - 'delivery',
--     updated_at = now()
-- where status = 'pending'
--   and payload->'delivery'->>'suppressNotification' = 'true';


-- ============ 附 B · 补推（事后想推卡片时执行） ============
-- 把被抑制的通知任务放回队列。交付 worker 下一轮（5 秒内）就会领取。
-- 幂等键仍然有效，不会重复发送同一份报告。
--
-- update meeting_report_notification_tasks
-- set status = 'pending',
--     next_run_at = now(),
--     attempt_count = 0,
--     last_error_code = null,
--     last_error_summary = null,
--     updated_at = now()
-- where status = 'cancelled';


-- ============ 附 C · 只补推某一段时间（推荐先小范围试） ============
-- 例如先补推 10-08 之后的，观察几张卡片的表现再决定是否全推。
--
-- update meeting_report_notification_tasks
-- set status = 'pending', next_run_at = now(), attempt_count = 0,
--     last_error_code = null, last_error_summary = null, updated_at = now()
-- where status = 'cancelled'
--   and created_at >= '2026-10-08 00:00+08';


-- ============ 附 D · 查看被抑制的通知任务明细 ============
--
-- select to_char(n.created_at at time zone 'Asia/Shanghai','MM-DD HH24:MI') as 登记时间,
--        u.feishu_name as 姓名, n.meeting_title_snapshot as 会议, n.report_url,
--        n.recipient_open_id
-- from meeting_report_notification_tasks n
-- left join users u on u.id = n.user_id
-- where n.status = 'cancelled'
-- order by n.created_at;
