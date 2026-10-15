/**
 * 宿主用户开通 —— 可复用的核心逻辑。
 *
 * ## 为什么单独抽出来
 *
 * 这套流程有两个入口：
 *
 *   1. 命令行：`scripts/onboardHostUser.mjs --name "张三"`（运维手动开）
 *   2. 飞书表单：用户提交 → 多维表格多一行 → worker 扫到 → 自动开
 *
 * 两个入口必须产出**完全一致**的结果（同样的用户复用规则、同样的占位凭证、
 * 同样的隔离设置）。所以核心逻辑只写一份，两边都调它。
 *
 * ## 宿主集成的隔离机制
 *
 * 网页版链路、事件监听、token 刷新、投递健康检查，全都通过
 * `listActiveFeishuIntegrationContextsWithBase()` 取集成，而那个函数
 * **要求 `selected_org_target_id IS NOT NULL`**。
 *
 * 所以宿主集成**故意不设这个字段**——等于不进任何飞书链路：
 * 不订阅事件、不刷新 token、不调飞书 API。
 *
 * 同时 `app_id` / `app_secret_encrypted` 填占位值（表要求非空），
 * 因为宿主通道用户根本不需要飞书自建应用。
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { and, eq, isNull, sql } from 'drizzle-orm';

import { getDb } from '@/lib/db/client';
import { feishuIntegrations, feishuProjects, hostEnrollmentCodes, users } from '@/lib/db/schema';
import { encrypt } from '@/lib/security/crypto';
import { writeAuditLog } from '@/lib/feishu/integration/integrationStore';

/** 占位 app_id：一眼能看出这是宿主通道的集成，不是真的飞书应用 */
export const HOST_CHANNEL_APP_ID = 'host-channel-no-feishu-app';

/** 接入码字符集：去掉易混淆的 0/O、1/I/L */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

export type ProvisionInput = {
  /** 用户姓名（用于建 user 与集成名） */
  name: string;
  /** 可选邮箱；给了就按「姓名 + 邮箱」复用 user */
  email?: string | null;
  /** 备注，写进集成名便于辨认来源 */
  note?: string | null;
  /** 接入码可用次数，默认 5 */
  maxUses?: number;
  /** 接入码有效天数，默认 90 */
  days?: number;
  /** 指定项目（期数）；不传就用当前 active 的 */
  projectId?: string | null;
};

export type ProvisionResult = {
  userId: string;
  integrationId: string;
  code: string;
  expiresAt: Date;
  /** 用户是不是复用了已有的（而不是新建） */
  reusedUser: boolean;
  /** 集成是不是复用了已有的 */
  reusedIntegration: boolean;
};

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/**
 * 开通一个宿主通道用户。
 *
 * 幂等：同一姓名（+邮箱）会复用 user，同一 user 会复用宿主集成。
 * 每次调用**会生成新的接入码**——这是有意的：重发就是发一张新券，
 * 旧券可以单独吊销。
 */
export async function provisionHostUser(input: ProvisionInput): Promise<ProvisionResult> {
  const name = input.name.trim();
  if (!name) throw new Error('姓名不能为空');

  const db = getDb();
  const email = input.email?.trim() || null;
  const maxUses = input.maxUses ?? 5;
  const days = input.days ?? 90;

  // ── 1) 用户：按姓名（+邮箱）复用，否则新建 ──
  let userId: string;
  let reusedUser = false;
  const existingUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(
      email
        ? and(eq(users.feishuName, name), eq(users.feishuEmail, email))
        : eq(users.feishuName, name),
    )
    .limit(1);

  if (existingUsers.length) {
    userId = existingUsers[0].id;
    reusedUser = true;
  } else {
    // 宿主通道用户没有飞书 open_id。数据库要求它非空且唯一，
    // 所以用带前缀的随机值占住这两个约束，同时一眼能看出这不是真 open_id。
    const inserted = await db
      .insert(users)
      .values({
        feishuOpenId: `host-user-${randomUUID()}`,
        feishuName: name,
        feishuEmail: email,
      })
      .returning({ id: users.id });
    userId = inserted[0].id;
  }

  // ── 2) 集成：占位凭证 + 不设 selected_org_target_id（隔离）──
  const existingHost = await db
    .select({ id: feishuIntegrations.id })
    .from(feishuIntegrations)
    .where(
      and(
        eq(feishuIntegrations.userId, userId),
        eq(feishuIntegrations.appId, HOST_CHANNEL_APP_ID),
        isNull(feishuIntegrations.deletedAt),
      ),
    )
    .limit(1);

  let integrationId: string;
  let reusedIntegration = false;

  if (existingHost.length) {
    integrationId = existingHost[0].id;
    reusedIntegration = true;
  } else {
    let projectId = input.projectId ?? null;
    if (!projectId) {
      const active = await db
        .select({ id: feishuProjects.id })
        .from(feishuProjects)
        .where(eq(feishuProjects.status, 'active'))
        .limit(1);
      projectId = active[0]?.id ?? null;
    }

    const inserted = await db
      .insert(feishuIntegrations)
      .values({
        userId,
        name: `宿主通道-${name}${input.note ? `（${input.note}）` : ''}`,
        status: 'success',
        setupStep: 'host_channel',
        appId: HOST_CHANNEL_APP_ID,
        // 随机值而不是固定串：即使某处意外泄漏也不会变成一个可复用的"口令"
        appSecretEncrypted: encrypt(randomBytes(32).toString('hex')),
        oauthScope: '',
        requiredEvents: [],
        requiredPermissions: [],
        isActive: true,
        activatedAt: new Date(),
        projectId,
        initializedAt: new Date(),
        firstInitializedAt: new Date(),
      })
      .returning({ id: feishuIntegrations.id });
    integrationId = inserted[0].id;
  }

  // ── 3) 接入码 ──
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  let code = generateCode();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const dup = await db
      .select({ one: sql`1` })
      .from(hostEnrollmentCodes)
      .where(eq(hostEnrollmentCodes.code, code))
      .limit(1);
    if (!dup.length) break;
    code = generateCode();
  }
  await db.insert(hostEnrollmentCodes).values({
    code,
    integrationId,
    label: `宿主通道-${name}`,
    maxUses,
    expiresAt,
  });

  // ── 4) 审计 ──
  await writeAuditLog({
    userId,
    integrationId,
    action: 'host_user.onboarded',
    result: 'success',
    summary: `宿主通道用户开通：${name}（可用 ${maxUses} 次，${days} 天）`,
    metadata: { name, email, maxUses, days, reusedUser, reusedIntegration },
  });

  return { userId, integrationId, code, expiresAt, reusedUser, reusedIntegration };
}
