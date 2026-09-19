-- ============================================================
-- 第四期上线修复（接手补遗），幂等，可重复执行
-- D1: feishu_setup_attempts 增加 registration_session_hash
--     F05「点创建应用即登记初始化尝试」需要；只存会话 hash，不存明文 sessionToken
-- D2: 删除 base_field_bindings 旧 2 态 CHECK（bound/unbound）
--     它与 20260919130000 新增的 4 态 CHECK 并存、AND 后实际仍只允许 2 态，
--     导致 F08 无法写入 type_mismatch/disabled；新约束
--     base_field_bindings_binding_status_chk 保留
--
-- 全新环境顺序：20260919120000(建旧check) → 20260919130000(加新check)
--              → 本迁移(drop旧check)，最终仅保留 4 态约束
-- ============================================================

-- D1 ----------------------------------------------------------------
ALTER TABLE public.feishu_setup_attempts
  ADD COLUMN IF NOT EXISTS registration_session_hash text;

COMMENT ON COLUMN public.feishu_setup_attempts.registration_session_hash IS
  '创建应用会话的 hash（非明文），用于注册会话丢失时定位未关联集成的尝试';

-- interruptLostRegistration 谓词：user_id + hash 且 integration_id IS NULL
CREATE INDEX IF NOT EXISTS feishu_setup_attempts_session_hash_idx
  ON public.feishu_setup_attempts (user_id, registration_session_hash)
  WHERE integration_id IS NULL;

-- D2 ----------------------------------------------------------------
ALTER TABLE public.base_field_bindings
  DROP CONSTRAINT IF EXISTS base_field_bindings_status_chk;
