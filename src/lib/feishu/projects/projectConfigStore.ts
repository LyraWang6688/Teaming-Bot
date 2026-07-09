import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import {
  feishuProjectOrgTargets,
  feishuProjects,
  type FeishuProjectOrgTargetRow,
  type FeishuProjectRow,
} from '@/lib/db/schema';
import { decrypt, maskSecret } from '@/lib/security/crypto';

export type FeishuProjectView = {
  id: string;
  projectKey: string;
  name: string;
  status: string;
  startsAt: string | null;
  endsAt: string | null;
};

export type FeishuOrgTargetView = {
  id: string;
  projectId: string;
  orgKey: string;
  orgName: string;
  tableId: string;
  baseUrl: string;
  enabled: boolean;
  fieldCheckStatus: string;
  fieldCheckDetails: Record<string, unknown>;
  masked: {
    baseAppToken: string | null;
  };
};

export type FeishuOrgTargetContext = FeishuOrgTargetView & {
  baseAppToken: string;
};

export type ActiveProjectOrgTargets = {
  project: FeishuProjectView | null;
  targets: FeishuOrgTargetView[];
};

function toIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function mapProject(row: FeishuProjectRow): FeishuProjectView {
  return {
    id: row.id,
    projectKey: row.projectKey,
    name: row.name,
    status: row.status,
    startsAt: toIsoString(row.startsAt),
    endsAt: toIsoString(row.endsAt),
  };
}

function mapTarget(row: FeishuProjectOrgTargetRow): FeishuOrgTargetView {
  const baseAppToken = decrypt(row.baseAppTokenEncrypted);

  return {
    id: row.id,
    projectId: row.projectId,
    orgKey: row.orgKey,
    orgName: row.orgName,
    tableId: row.tableId,
    baseUrl: row.baseUrl,
    enabled: row.enabled,
    fieldCheckStatus: row.fieldCheckStatus,
    fieldCheckDetails: row.fieldCheckDetails,
    masked: {
      baseAppToken: maskSecret(baseAppToken),
    },
  };
}

function mapTargetContext(row: FeishuProjectOrgTargetRow): FeishuOrgTargetContext {
  return {
    ...mapTarget(row),
    baseAppToken: decrypt(row.baseAppTokenEncrypted),
  };
}

export async function getActiveFeishuProject(): Promise<FeishuProjectView | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(feishuProjects)
    .where(eq(feishuProjects.status, 'active'))
    .orderBy(desc(feishuProjects.updatedAt))
    .limit(1);

  return row ? mapProject(row) : null;
}

export async function listActiveProjectOrgTargets(): Promise<ActiveProjectOrgTargets> {
  const project = await getActiveFeishuProject();
  if (!project) {
    return {
      project: null,
      targets: [],
    };
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(feishuProjectOrgTargets)
    .where(
      and(
        eq(feishuProjectOrgTargets.projectId, project.id),
        eq(feishuProjectOrgTargets.enabled, true)
      )
    )
    .orderBy(feishuProjectOrgTargets.orgName);

  return {
    project,
    targets: rows.map(mapTarget),
  };
}

export async function getOrgTargetContextById(
  orgTargetId: string
): Promise<FeishuOrgTargetContext | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(feishuProjectOrgTargets)
    .where(eq(feishuProjectOrgTargets.id, orgTargetId))
    .limit(1);

  return row ? mapTargetContext(row) : null;
}

export async function getEnabledOrgTargetContextById(
  orgTargetId: string
): Promise<FeishuOrgTargetContext | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(feishuProjectOrgTargets)
    .where(
      and(
        eq(feishuProjectOrgTargets.id, orgTargetId),
        eq(feishuProjectOrgTargets.enabled, true)
      )
    )
    .limit(1);

  return row ? mapTargetContext(row) : null;
}

export async function updateOrgTargetFieldCheckStatus(input: {
  orgTargetId: string;
  status: 'pending' | 'success' | 'failed';
  details: Record<string, unknown>;
}) {
  const db = getDb();
  await db
    .update(feishuProjectOrgTargets)
    .set({
      fieldCheckStatus: input.status,
      fieldCheckDetails: input.details,
      enabled: input.status === 'failed' ? false : undefined,
      updatedAt: new Date(),
    })
    .where(eq(feishuProjectOrgTargets.id, input.orgTargetId));
}
