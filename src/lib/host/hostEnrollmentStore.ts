/**
 * 宿主接入码与凭证。
 *
 * ## 解决什么
 *
 * 改造前，宿主报告接口靠全局 `HOST_REPORT_INTEGRATION_ID` 决定归属，
 * 所有调用方共用一个 `HOST_API_TOKEN`：
 *
 *   · 数据混在一起，无法分辨来源
 *   · 一个 token 泄漏影响所有用户
 *   · 出问题无法定位是谁
 *
 * 这里引入两级：
 *
 * ```
 * 接入码（运营侧生成，绑到某个集成）
 *    ↓ 用户在 MCP 里 `teaming setup --code XXXX` 兑换
 * 宿主凭证（只属于这次安装的 host_token）
 *    ↓ 之后每次上传都带它
 * 服务端据此判定归属
 * ```
 *
 * ## 凭证规则（对齐 AGENTS.md 4.2）
 *
 * - `token_hash` 只存 SHA-256，**不存明文**，可单独吊销。
 * - 明文 token 只在兑换那一刻返回一次，之后服务端无法再取回。
 * - 日志、错误输出里一律不出现完整 token。
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { getDb } from '@/lib/db/client';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { hostCredentials, hostEnrollmentCodes } from '@/lib/db/schema';

/** 接入码：去掉易混淆字符（0/O、1/I/L），便于人工转述 */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function generateCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function hashHostToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type EnrollmentCodeView = {
  code: string;
  integrationId: string;
  label: string | null;
  useCount: number;
  maxUses: number;
  expiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

export async function createEnrollmentCode(input: {
  integrationId: string;
  label?: string | null;
  maxUses?: number;
  expiresAt?: Date | null;
}): Promise<EnrollmentCodeView> {
  const db = getDb();
  // 极小概率撞码：重试几次即可
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateCode();
    const [row] = await db
      .insert(hostEnrollmentCodes)
      .values({
        code,
        integrationId: input.integrationId,
        label: input.label ?? null,
        maxUses: input.maxUses ?? 5,
        expiresAt: input.expiresAt ?? null,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row as EnrollmentCodeView;
  }
  throw new Error('生成接入码失败：连续多次撞码。');
}

export type RedeemFailure =
  | 'code_not_found'
  | 'code_revoked'
  | 'code_expired'
  | 'code_exhausted';

export type RedeemResult =
  | { ok: true; token: string; integrationId: string; credentialId: string }
  | { ok: false; reason: RedeemFailure };

/**
 * 用接入码兑换一个宿主凭证。
 *
 * 返回的 `token` 是**明文**，只在这一次返回；服务端只留 hash。
 */
export async function redeemEnrollmentCode(input: {
  code: string;
  installationId?: string | null;
  label?: string | null;
}): Promise<RedeemResult> {
  const db = getDb();
  const normalized = input.code.trim().toUpperCase();

  const [record] = await db
    .select()
    .from(hostEnrollmentCodes)
    .where(eq(hostEnrollmentCodes.code, normalized))
    .limit(1);

  if (!record) return { ok: false, reason: 'code_not_found' };
  if (record.revokedAt) return { ok: false, reason: 'code_revoked' };
  if (record.expiresAt && record.expiresAt.getTime() <= Date.now()) {
    return { ok: false, reason: 'code_expired' };
  }
  if (record.useCount >= record.maxUses) return { ok: false, reason: 'code_exhausted' };

  const token = `tmh_${randomBytes(24).toString('hex')}`;
  const [credential] = await db
    .insert(hostCredentials)
    .values({
      tokenHash: hashHostToken(token),
      integrationId: record.integrationId,
      installationId: input.installationId ?? null,
      label: input.label ?? record.label ?? null,
    })
    .returning({ id: hostCredentials.id });

  await db
    .update(hostEnrollmentCodes)
    .set({
      useCount: sql`${hostEnrollmentCodes.useCount} + 1`,
      lastUsedAt: new Date(),
      lastInstallationId: input.installationId ?? null,
    })
    .where(eq(hostEnrollmentCodes.code, normalized));

  return {
    ok: true,
    token,
    integrationId: record.integrationId,
    credentialId: credential.id,
  };
}

export type HostCredentialContext = {
  credentialId: string;
  integrationId: string;
  installationId: string | null;
  label: string | null;
};

/** 按明文 token 查有效凭证；查不到或已吊销返回 null。 */
export async function findActiveHostCredential(
  token: string
): Promise<HostCredentialContext | null> {
  if (!token) return null;
  const db = getDb();
  const [row] = await db
    .select({
      credentialId: hostCredentials.id,
      integrationId: hostCredentials.integrationId,
      installationId: hostCredentials.installationId,
      label: hostCredentials.label,
    })
    .from(hostCredentials)
    .where(
      and(
        eq(hostCredentials.tokenHash, hashHostToken(token)),
        isNull(hostCredentials.revokedAt)
      )
    )
    .limit(1);
  return row ?? null;
}

/** 记录一次使用（用于排查"谁在用"）。失败不影响主流程。 */
export async function touchHostCredential(credentialId: string): Promise<void> {
  try {
    const db = getDb();
    await db
      .update(hostCredentials)
      .set({ lastUsedAt: new Date() })
      .where(eq(hostCredentials.id, credentialId));
  } catch {
    // 使用时间只用于排查，写失败不该让请求失败
  }
}

/** 新安装标识：用户机器换一次就换一个，便于区分设备 */
export function newInstallationId(): string {
  return randomUUID();
}
