-- 为 feishu_integrations 增加项目级直接绑定字段 project_id
-- 设计动机：
--   1. 让集成与项目的归属关系不再依赖 feishu_project_org_targets 间接链路
--   2. 与项目级 Base 配置层级对齐（bitableAppToken/tableId 已上移到 feishu_projects）
--   3. 项目失活级联场景可直接 where project_id = any(...) 而无需 join

-- 1) 加列（nullable，兼容存量未选方向的集成）
alter table feishu_integrations
  add column if not exists project_id uuid;

-- 2) 回填存量数据：根据 selected_org_target_id 反查所属 project_id
update feishu_integrations i
  set project_id = t.project_id,
      updated_at = now()
  from feishu_project_org_targets t
  where i.selected_org_target_id = t.id
    and i.project_id is null;

-- 3) 加索引（与 schema.ts 中 feishu_integrations_project_id_idx 对齐）
create index if not exists feishu_integrations_project_id_idx
  on feishu_integrations (project_id);

-- 4) 顺带清理 required_permissions 默认值中的 bitable:app
--    （与新 OAuth scope 一致：Base 读写不再依赖用户权限）
--    仅修改 default，存量数据保持不动（避免误改用户实际授权状态）
alter table feishu_integrations
  alter column required_permissions
  set default '["auth:user.id:read","minutes:minutes.basic:read","minutes:minutes.transcript:export","vc:meeting.meetingevents:read","offline_access"]'::jsonb;
