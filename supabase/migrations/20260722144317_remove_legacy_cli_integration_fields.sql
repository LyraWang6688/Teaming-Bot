-- Deploy application code that no longer selects these columns before applying
-- this contraction migration to production.
set local lock_timeout = '5s';

alter table public.feishu_integrations
  drop column if exists base_app_token_encrypted,
  drop column if exists meeting_table_id,
  drop column if exists profile_name,
  drop column if exists cli_config_dir;

alter table public.feishu_integrations
  alter column required_permissions set default
    '["auth:user.id:read","minutes:minutes.basic:read","minutes:minutes.transcript:export","offline_access","bitable:app"]'::jsonb;
