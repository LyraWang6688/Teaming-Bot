-- Base access is validated per user integration with that user's OAuth token.
-- Organization targets only locate the shared Base and no longer cache a
-- user-dependent field-template result.
alter table if exists public.feishu_project_org_targets
  drop column if exists field_check_status,
  drop column if exists field_check_details;
