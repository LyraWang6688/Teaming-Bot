-- 宿主接入码与宿主凭证
--
-- 目的：让"把 MCP 交给别人用"这件事有可验证的身份绑定。
--
-- 改造前的问题：宿主报告接口用全局 HOST_REPORT_INTEGRATION_ID 决定归属，
-- 所有调用方的报告都挂到同一个集成，且共用一个 HOST_API_TOKEN。
-- 后果是数据混、无法分辨来源、一个 token 泄漏影响所有人。
--
-- 改造后：
--   1. 运营侧为某个集成生成一个【接入码】
--   2. 用户在宿主里执行 `npx teaming-mcp setup --code XXXX`
--   3. MCP 用码换一个【只属于这次安装】的 host_token
--   4. 之后每次上传都带这个 token，服务端据此判定归属
--
-- 安全：host_token 服务端只存 hash（对齐 AGENTS.md 4.2），可单独吊销。

create table if not exists host_enrollment_codes (
  code                 text primary key,
  integration_id       uuid not null references feishu_integrations(id) on delete cascade,
  label                text,
  -- 允许多次使用：同一个人可能有多台机器。用次数与最后使用时间留痕。
  use_count            integer not null default 0,
  max_uses             integer not null default 5,
  last_used_at         timestamptz,
  last_installation_id text,
  expires_at           timestamptz,
  revoked_at           timestamptz,
  created_at           timestamptz not null default now()
);

comment on table host_enrollment_codes is '宿主接入码：运营侧生成，用户在 MCP 里兑换成 host_token';

create index if not exists host_enrollment_codes_integration_idx
  on host_enrollment_codes (integration_id);

create table if not exists host_credentials (
  id              uuid primary key default gen_random_uuid(),
  -- 只存 hash，不存明文 token
  token_hash      text not null,
  integration_id  uuid not null references feishu_integrations(id) on delete cascade,
  installation_id text,
  label           text,
  last_used_at    timestamptz,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now()
);

comment on table host_credentials is '宿主凭证：每次 setup 兑换一个，服务端只存 token 的 hash';

create unique index if not exists host_credentials_token_hash_uidx
  on host_credentials (token_hash);

create index if not exists host_credentials_integration_idx
  on host_credentials (integration_id);
