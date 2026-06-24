import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import {
  feishuAuditLogs,
  feishuAuthorizations,
  feishuIntegrationChecks,
  feishuIntegrations,
  feishuOauthStates,
  type FeishuAuthorizationRow,
  type FeishuIntegrationCheckRow,
  type FeishuIntegrationRow,
} from '@/lib/db/schema';
import { getDefaultFeishuOauthScope } from '@/lib/platform/env';
import {
  createOpaqueToken,
  decrypt,
  encrypt,
  hashForLookup,
  maskSecret,
} from '@/lib/security/crypto';

export type FeishuIntegrationSecrets = {
  appSecret: string;
  webhookVerificationToken: string;
  baseAppToken: string | null;
};

export type FeishuIntegrationView = {
  id: string;
  userId: string;
  name: string;
  status: string;
  setupStep: string;
  appId: string;
  oauthScope: string;
  meetingTableId: string | null;
  initializedAt: string | null;
  lastWebhookReceivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  links: {
    baseUrl: string | null;
  };
  masked: {
    appSecret: string | null;
    webhookVerificationToken: string | null;
    baseAppToken: string | null;
  };
};

export type FeishuIntegrationDetail = FeishuIntegrationView & {
  requiredEvents: string[];
  requiredPermissions: string[];
};

export type FeishuIntegrationContext = FeishuIntegrationDetail & {
  secrets: FeishuIntegrationSecrets;
};

export type FeishuAuthorizationView = {
  integrationId: string;
  status: string;
  authorizedOpenId: string | null;
  authorizedUserName: string | null;
  scope: string | null;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string | null;
  updatedAt: string;
  masked: {
    accessToken: string | null;
    refreshToken: string | null;
  };
};

export type FeishuAuthorizationContext = {
  integrationId: string;
  status: string;
  authorizedOpenId: string | null;
  authorizedUserName: string | null;
  scope: string | null;
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date | null;
  updatedAt: string;
};

export type FeishuCheckStatusView = {
  appCredentialStatus: string;
  permissionStatus: string;
  eventSubscriptionStatus: string;
  webhookStatus: string;
  oauthStatus: string;
  baseStatus: string;
  lastCheckedAt: string | null;
  lastErrorType: string | null;
  lastErrorMessage: string | null;
  details: Record<string, unknown>;
};

type CreateIntegrationInput = {
  userId: string;
  name: string;
  appId: string;
  appSecret: string;
  webhookVerificationToken: string;
  baseAppToken?: string | null;
  meetingTableId?: string | null;
  oauthScope?: string;
};

type UpdateIntegrationInput = {
  name?: string;
  appId?: string;
  appSecret?: string;
  webhookVerificationToken?: string;
  baseAppToken?: string | null;
  meetingTableId?: string | null;
  oauthScope?: string;
  status?: string;
  setupStep?: string;
  initializedAt?: Date | null;
};

type UpsertAuthorizationInput = {
  integrationId: string;
  authorizedOpenId?: string | null;
  authorizedUserName?: string | null;
  accessToken: string;
  refreshToken?: string | null;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt?: Date | null;
  scope?: string | null;
  status?: string;
};

type UpsertCheckStatusInput = Partial<
  Pick<
    FeishuIntegrationCheckRow,
    | 'appCredentialStatus'
    | 'permissionStatus'
    | 'eventSubscriptionStatus'
    | 'webhookStatus'
    | 'oauthStatus'
    | 'baseStatus'
    | 'lastErrorType'
    | 'lastErrorMessage'
  >
> & {
  integrationId: string;
  details?: Record<string, unknown>;
  lastCheckedAt?: Date | null;
};

type AuditLogInput = {
  userId?: string | null;
  integrationId?: string | null;
  action: string;
  result: string;
  summary: string;
  metadata?: Record<string, unknown>;
};

function toIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function buildFeishuBaseUrl(baseAppToken: string | null, meetingTableId: string | null): string | null {
  if (!baseAppToken || !meetingTableId) {
    return null;
  }

  return `https://feishu.cn/base/${baseAppToken}?table=${meetingTableId}`;
}

function mapIntegrationView(row: FeishuIntegrationRow): FeishuIntegrationView {
  const appSecret = decrypt(row.appSecretEncrypted);
  const webhookVerificationToken = decrypt(row.webhookVerificationTokenEncrypted);
  const baseAppToken = row.baseAppTokenEncrypted ? decrypt(row.baseAppTokenEncrypted) : null;

  return {
    id: row.id,
    userId: row.userId,
    name: row.name,
    status: row.status,
    setupStep: row.setupStep,
    appId: row.appId,
    oauthScope: row.oauthScope,
    meetingTableId: row.meetingTableId,
    initializedAt: toIsoString(row.initializedAt),
    lastWebhookReceivedAt: toIsoString(row.lastWebhookReceivedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    links: {
      baseUrl: buildFeishuBaseUrl(baseAppToken, row.meetingTableId),
    },
    masked: {
      appSecret: maskSecret(appSecret),
      webhookVerificationToken: maskSecret(webhookVerificationToken),
      baseAppToken: maskSecret(baseAppToken),
    },
  };
}

function mapIntegrationDetail(row: FeishuIntegrationRow): FeishuIntegrationDetail {
  return {
    ...mapIntegrationView(row),
    requiredEvents: row.requiredEvents,
    requiredPermissions: row.requiredPermissions,
  };
}

function mapIntegrationContext(row: FeishuIntegrationRow): FeishuIntegrationContext {
  return {
    ...mapIntegrationDetail(row),
    secrets: {
      appSecret: decrypt(row.appSecretEncrypted),
      webhookVerificationToken: decrypt(row.webhookVerificationTokenEncrypted),
      baseAppToken: row.baseAppTokenEncrypted ? decrypt(row.baseAppTokenEncrypted) : null,
    },
  };
}

function mapAuthorizationView(row: FeishuAuthorizationRow): FeishuAuthorizationView {
  const accessToken = decrypt(row.accessTokenEncrypted);
  const refreshToken = row.refreshTokenEncrypted ? decrypt(row.refreshTokenEncrypted) : null;

  return {
    integrationId: row.integrationId,
    status: row.status,
    authorizedOpenId: row.authorizedOpenId,
    authorizedUserName: row.authorizedUserName,
    scope: row.scope,
    accessTokenExpiresAt: row.accessTokenExpiresAt.toISOString(),
    refreshTokenExpiresAt: toIsoString(row.refreshTokenExpiresAt),
    updatedAt: row.updatedAt.toISOString(),
    masked: {
      accessToken: maskSecret(accessToken),
      refreshToken: maskSecret(refreshToken),
    },
  };
}

function mapAuthorizationContext(row: FeishuAuthorizationRow): FeishuAuthorizationContext {
  return {
    integrationId: row.integrationId,
    status: row.status,
    authorizedOpenId: row.authorizedOpenId,
    authorizedUserName: row.authorizedUserName,
    scope: row.scope,
    accessToken: decrypt(row.accessTokenEncrypted),
    refreshToken: row.refreshTokenEncrypted ? decrypt(row.refreshTokenEncrypted) : null,
    accessTokenExpiresAt: row.accessTokenExpiresAt,
    refreshTokenExpiresAt: row.refreshTokenExpiresAt,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapCheckStatus(row: FeishuIntegrationCheckRow): FeishuCheckStatusView {
  return {
    appCredentialStatus: row.appCredentialStatus,
    permissionStatus: row.permissionStatus,
    eventSubscriptionStatus: row.eventSubscriptionStatus,
    webhookStatus: row.webhookStatus,
    oauthStatus: row.oauthStatus,
    baseStatus: row.baseStatus,
    lastCheckedAt: toIsoString(row.lastCheckedAt),
    lastErrorType: row.lastErrorType,
    lastErrorMessage: row.lastErrorMessage,
    details: row.details,
  };
}

export async function listUserFeishuIntegrations(userId: string): Promise<FeishuIntegrationView[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(feishuIntegrations)
    .where(and(eq(feishuIntegrations.userId, userId), isNull(feishuIntegrations.deletedAt)))
    .orderBy(desc(feishuIntegrations.updatedAt));

  return rows.map(mapIntegrationView);
}

export async function getUserFeishuIntegrationDetail(
  userId: string,
  integrationId: string
): Promise<FeishuIntegrationDetail | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(feishuIntegrations)
    .where(
      and(
        eq(feishuIntegrations.id, integrationId),
        eq(feishuIntegrations.userId, userId),
        isNull(feishuIntegrations.deletedAt)
      )
    )
    .limit(1);

  return row ? mapIntegrationDetail(row) : null;
}

export async function createUserFeishuIntegration(
  input: CreateIntegrationInput
): Promise<FeishuIntegrationView> {
  const db = getDb();
  const [row] = await db
    .insert(feishuIntegrations)
    .values({
      userId: input.userId,
      name: input.name.trim(),
      appId: input.appId.trim(),
      appSecretEncrypted: encrypt(input.appSecret.trim()),
      webhookVerificationTokenEncrypted: encrypt(input.webhookVerificationToken.trim()),
      webhookVerificationTokenHash: hashForLookup(input.webhookVerificationToken.trim()),
      baseAppTokenEncrypted: input.baseAppToken?.trim() ? encrypt(input.baseAppToken.trim()) : null,
      meetingTableId: input.meetingTableId?.trim() || null,
      oauthScope: input.oauthScope?.trim() || getDefaultFeishuOauthScope(),
      updatedAt: new Date(),
    })
    .returning();

  await writeAuditLog({
    userId: input.userId,
    integrationId: row.id,
    action: 'integration.created',
    result: 'success',
    summary: '创建飞书集成配置',
    metadata: {
      appId: row.appId,
      name: row.name,
    },
  });

  return mapIntegrationView(row);
}

export async function updateUserFeishuIntegration(
  userId: string,
  integrationId: string,
  input: UpdateIntegrationInput
): Promise<FeishuIntegrationView | null> {
  const db = getDb();
  const updateValues: Record<string, unknown> = {
    updatedAt: new Date(),
  };

  if (typeof input.name === 'string') {
    updateValues.name = input.name.trim();
  }
  if (typeof input.appId === 'string') {
    updateValues.appId = input.appId.trim();
  }
  if (typeof input.appSecret === 'string') {
    updateValues.appSecretEncrypted = encrypt(input.appSecret.trim());
  }
  if (typeof input.webhookVerificationToken === 'string') {
    updateValues.webhookVerificationTokenEncrypted = encrypt(input.webhookVerificationToken.trim());
    updateValues.webhookVerificationTokenHash = hashForLookup(input.webhookVerificationToken.trim());
  }
  if (typeof input.baseAppToken === 'string') {
    updateValues.baseAppTokenEncrypted = encrypt(input.baseAppToken.trim());
  }
  if (input.baseAppToken === null) {
    updateValues.baseAppTokenEncrypted = null;
  }
  if (typeof input.meetingTableId === 'string') {
    updateValues.meetingTableId = input.meetingTableId.trim();
  }
  if (input.meetingTableId === null) {
    updateValues.meetingTableId = null;
  }
  if (typeof input.oauthScope === 'string') {
    updateValues.oauthScope = input.oauthScope.trim();
  }
  if (typeof input.status === 'string') {
    updateValues.status = input.status;
  }
  if (typeof input.setupStep === 'string') {
    updateValues.setupStep = input.setupStep;
  }
  if (Object.prototype.hasOwnProperty.call(input, 'initializedAt')) {
    updateValues.initializedAt = input.initializedAt;
  }

  const [row] = await db
    .update(feishuIntegrations)
    .set(updateValues)
    .where(
      and(
        eq(feishuIntegrations.id, integrationId),
        eq(feishuIntegrations.userId, userId),
        isNull(feishuIntegrations.deletedAt)
      )
    )
    .returning();

  if (!row) {
    return null;
  }

  await writeAuditLog({
    userId,
    integrationId,
    action: 'integration.updated',
    result: 'success',
    summary: '更新飞书集成配置',
    metadata: {
      updatedFields: Object.keys(input),
    },
  });

  return mapIntegrationView(row);
}

export async function getFeishuIntegrationByWebhookToken(
  verificationToken: string
): Promise<FeishuIntegrationContext | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(feishuIntegrations)
    .where(
      and(
        eq(feishuIntegrations.webhookVerificationTokenHash, hashForLookup(verificationToken.trim())),
        isNull(feishuIntegrations.deletedAt)
      )
    )
    .limit(1);

  return row ? mapIntegrationContext(row) : null;
}

export async function getUserFeishuIntegrationContext(
  userId: string,
  integrationId: string
): Promise<FeishuIntegrationContext | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(feishuIntegrations)
    .where(
      and(
        eq(feishuIntegrations.id, integrationId),
        eq(feishuIntegrations.userId, userId),
        isNull(feishuIntegrations.deletedAt)
      )
    )
    .limit(1);

  return row ? mapIntegrationContext(row) : null;
}

export async function getLatestFeishuAuthorization(
  integrationId: string
): Promise<FeishuAuthorizationView | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(feishuAuthorizations)
    .where(eq(feishuAuthorizations.integrationId, integrationId))
    .limit(1);

  return row ? mapAuthorizationView(row) : null;
}

export async function getLatestFeishuAuthorizationContext(
  integrationId: string
): Promise<FeishuAuthorizationContext | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(feishuAuthorizations)
    .where(eq(feishuAuthorizations.integrationId, integrationId))
    .limit(1);

  return row ? mapAuthorizationContext(row) : null;
}

export async function upsertFeishuAuthorization(
  input: UpsertAuthorizationInput
): Promise<FeishuAuthorizationView> {
  const db = getDb();
  const [row] = await db
    .insert(feishuAuthorizations)
    .values({
      integrationId: input.integrationId,
      status: input.status || 'authorized',
      authorizedOpenId: input.authorizedOpenId || null,
      authorizedUserName: input.authorizedUserName || null,
      accessTokenEncrypted: encrypt(input.accessToken),
      refreshTokenEncrypted: input.refreshToken ? encrypt(input.refreshToken) : null,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      refreshTokenExpiresAt: input.refreshTokenExpiresAt || null,
      scope: input.scope || null,
      lastRefreshedAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: feishuAuthorizations.integrationId,
      set: {
        status: input.status || 'authorized',
        authorizedOpenId: input.authorizedOpenId || null,
        authorizedUserName: input.authorizedUserName || null,
        accessTokenEncrypted: encrypt(input.accessToken),
        refreshTokenEncrypted: input.refreshToken ? encrypt(input.refreshToken) : null,
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        refreshTokenExpiresAt: input.refreshTokenExpiresAt || null,
        scope: input.scope || null,
        lastRefreshedAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning();

  return mapAuthorizationView(row);
}

export async function upsertFeishuIntegrationCheckStatus(
  input: UpsertCheckStatusInput
): Promise<FeishuCheckStatusView> {
  const db = getDb();
  const [row] = await db
    .insert(feishuIntegrationChecks)
    .values({
      integrationId: input.integrationId,
      appCredentialStatus: input.appCredentialStatus || 'pending',
      permissionStatus: input.permissionStatus || 'pending',
      eventSubscriptionStatus: input.eventSubscriptionStatus || 'pending',
      webhookStatus: input.webhookStatus || 'pending',
      oauthStatus: input.oauthStatus || 'pending',
      baseStatus: input.baseStatus || 'pending',
      lastCheckedAt: input.lastCheckedAt || new Date(),
      lastErrorType: input.lastErrorType || null,
      lastErrorMessage: input.lastErrorMessage || null,
      details: input.details || {},
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: feishuIntegrationChecks.integrationId,
      set: {
        appCredentialStatus: input.appCredentialStatus ?? sql`${feishuIntegrationChecks.appCredentialStatus}`,
        permissionStatus: input.permissionStatus ?? sql`${feishuIntegrationChecks.permissionStatus}`,
        eventSubscriptionStatus:
          input.eventSubscriptionStatus ?? sql`${feishuIntegrationChecks.eventSubscriptionStatus}`,
        webhookStatus: input.webhookStatus ?? sql`${feishuIntegrationChecks.webhookStatus}`,
        oauthStatus: input.oauthStatus ?? sql`${feishuIntegrationChecks.oauthStatus}`,
        baseStatus: input.baseStatus ?? sql`${feishuIntegrationChecks.baseStatus}`,
        lastCheckedAt: input.lastCheckedAt ?? new Date(),
        lastErrorType:
          input.lastErrorType === undefined
            ? sql`${feishuIntegrationChecks.lastErrorType}`
            : input.lastErrorType,
        lastErrorMessage:
          input.lastErrorMessage === undefined
            ? sql`${feishuIntegrationChecks.lastErrorMessage}`
            : input.lastErrorMessage,
        details: input.details ?? sql`${feishuIntegrationChecks.details}`,
        updatedAt: new Date(),
      },
    })
    .returning();

  return mapCheckStatus(row);
}

export async function getFeishuIntegrationCheckStatus(
  integrationId: string
): Promise<FeishuCheckStatusView | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(feishuIntegrationChecks)
    .where(eq(feishuIntegrationChecks.integrationId, integrationId))
    .limit(1);

  return row ? mapCheckStatus(row) : null;
}

export async function markFeishuIntegrationWebhookReceived(
  integrationId: string,
  input?: {
    receivedAt?: Date;
    details?: Record<string, unknown>;
  }
): Promise<void> {
  const db = getDb();
  const receivedAt = input?.receivedAt || new Date();

  await db
    .update(feishuIntegrations)
    .set({
      lastWebhookReceivedAt: receivedAt,
      updatedAt: new Date(),
    })
    .where(eq(feishuIntegrations.id, integrationId));

  await upsertFeishuIntegrationCheckStatus({
    integrationId,
    eventSubscriptionStatus: 'success',
    webhookStatus: 'success',
    lastCheckedAt: receivedAt,
    lastErrorType: null,
    lastErrorMessage: null,
    details: input?.details,
  });
}

export async function createOauthState(input: {
  userId: string;
  integrationId: string;
  redirectTo?: string | null;
  expiresInMinutes?: number;
}): Promise<string> {
  const db = getDb();
  const rawState = createOpaqueToken(32);
  const expiresAt = new Date(Date.now() + (input.expiresInMinutes || 10) * 60_000);

  await db.insert(feishuOauthStates).values({
    userId: input.userId,
    integrationId: input.integrationId,
    stateHash: hashForLookup(rawState),
    redirectTo: input.redirectTo || null,
    expiresAt,
  });

  return rawState;
}

export async function consumeOauthState(rawState: string): Promise<{
  id: string;
  userId: string;
  integrationId: string;
  redirectTo: string | null;
} | null> {
  const db = getDb();
  const stateHash = hashForLookup(rawState);
  const now = new Date();
  const [row] = await db
    .update(feishuOauthStates)
    .set({
      status: 'used',
      usedAt: now,
    })
    .where(
      and(
        eq(feishuOauthStates.stateHash, stateHash),
        eq(feishuOauthStates.status, 'pending')
      )
    )
    .returning();

  if (!row || row.expiresAt <= now) {
    return null;
  }

  return {
    id: row.id,
    userId: row.userId,
    integrationId: row.integrationId,
    redirectTo: row.redirectTo,
  };
}

export async function writeAuditLog(input: AuditLogInput): Promise<void> {
  const db = getDb();
  await db.insert(feishuAuditLogs).values({
    userId: input.userId || null,
    integrationId: input.integrationId || null,
    action: input.action,
    result: input.result,
    summary: input.summary,
    metadata: input.metadata || {},
  });
}
