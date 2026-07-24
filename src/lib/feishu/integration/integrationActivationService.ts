import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import { feishuIntegrations, users } from '@/lib/db/schema';

type IntegrationActivationMember = {
  integrationId: string;
  userId: string;
  selectedOrgTargetId: string | null;
  feishuUnionId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type IntegrationActivationResult = {
  feishuUnionId: string | null;
  selectedOrgTargetId: string | null;
  activeIntegrationId: string;
  supersededIntegrationIds: string[];
  isCurrentActive: boolean;
};

async function getActivationMember(
  integrationId: string
): Promise<IntegrationActivationMember | null> {
  const db = getDb();
  const [row] = await db
    .select({
      integrationId: feishuIntegrations.id,
      userId: feishuIntegrations.userId,
      selectedOrgTargetId: feishuIntegrations.selectedOrgTargetId,
      feishuUnionId: users.feishuUnionId,
      createdAt: feishuIntegrations.createdAt,
      updatedAt: feishuIntegrations.updatedAt,
    })
    .from(feishuIntegrations)
    .leftJoin(users, eq(feishuIntegrations.userId, users.id))
    .where(and(eq(feishuIntegrations.id, integrationId), isNull(feishuIntegrations.deletedAt)))
    .limit(1);

  return row || null;
}

export async function isFeishuIntegrationActive(integrationId: string): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({
      isActive: feishuIntegrations.isActive,
    })
    .from(feishuIntegrations)
    .where(and(eq(feishuIntegrations.id, integrationId), isNull(feishuIntegrations.deletedAt)))
    .limit(1);

  return row?.isActive ?? false;
}

export async function activateLatestFeishuIntegrationInGroup(
  integrationId: string
): Promise<IntegrationActivationResult | null> {
  const current = await getActivationMember(integrationId);
  if (!current) return null;

  const db = getDb();
  const now = new Date();

  const groupRows = current.feishuUnionId && current.selectedOrgTargetId
    ? await db
        .select({
          integrationId: feishuIntegrations.id,
          userId: feishuIntegrations.userId,
          selectedOrgTargetId: feishuIntegrations.selectedOrgTargetId,
          feishuUnionId: users.feishuUnionId,
          createdAt: feishuIntegrations.createdAt,
          updatedAt: feishuIntegrations.updatedAt,
        })
        .from(feishuIntegrations)
        .innerJoin(users, eq(feishuIntegrations.userId, users.id))
        .where(
          and(
            isNull(feishuIntegrations.deletedAt),
            eq(users.feishuUnionId, current.feishuUnionId),
            eq(feishuIntegrations.selectedOrgTargetId, current.selectedOrgTargetId)
          )
        )
        .orderBy(desc(feishuIntegrations.createdAt), desc(feishuIntegrations.updatedAt))
    : [current];

  const activeMember = groupRows[0];
  if (!activeMember) {
    return null;
  }

  const supersededIntegrationIds = groupRows
    .filter((row) => row.integrationId !== activeMember.integrationId)
    .map((row) => row.integrationId);

  await db.transaction(async (tx) => {
    if (supersededIntegrationIds.length > 0) {
      await tx
        .update(feishuIntegrations)
        .set({
          isActive: false,
          supersededAt: now,
          supersededByIntegrationId: activeMember.integrationId,
          updatedAt: now,
        })
        .where(inArray(feishuIntegrations.id, supersededIntegrationIds));
    }

    await tx
      .update(feishuIntegrations)
      .set({
        isActive: true,
        activatedAt: now,
        supersededAt: null,
        supersededByIntegrationId: null,
        updatedAt: now,
      })
      .where(eq(feishuIntegrations.id, activeMember.integrationId));
  });

  return {
    feishuUnionId: current.feishuUnionId,
    selectedOrgTargetId: current.selectedOrgTargetId,
    activeIntegrationId: activeMember.integrationId,
    supersededIntegrationIds,
    isCurrentActive: activeMember.integrationId === integrationId,
  };
}
