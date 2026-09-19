import { and, desc, eq } from 'drizzle-orm';
import { getDb } from '@/lib/db/client';
import {
  feishuProjectOrgTargets,
  feishuProjects,
  type FeishuProjectOrgTargetRow,
  type FeishuProjectRow,
} from '@/lib/db/schema';
import { decrypt } from '@/lib/security/crypto';

export type FeishuProjectView = {
  id: string;
  projectKey: string;
  name: string;
  status: string;
  bitableAppToken: string | null;
  bitableTableId: string | null;
};

export type FeishuOrgTargetView = {
  id: string;
  projectId: string;
  orgKey: string;
  orgName: string;
  enabled: boolean;
};

export type FeishuOrgTargetContext = FeishuOrgTargetView;

export type ActiveProjectOrgTargets = {
  project: FeishuProjectView | null;
  targets: FeishuOrgTargetView[];
};

function mapProject(row: FeishuProjectRow): FeishuProjectView {
  return {
    id: row.id,
    projectKey: row.projectKey,
    name: row.name,
    status: row.status,
    bitableAppToken: row.bitableAppTokenEncrypted ? decrypt(row.bitableAppTokenEncrypted) : null,
    bitableTableId: row.bitableTableId,
  };
}

function mapTarget(row: FeishuProjectOrgTargetRow): FeishuOrgTargetView {
  return {
    id: row.id,
    projectId: row.projectId,
    orgKey: row.orgKey,
    orgName: row.orgName,
    enabled: row.enabled,
  };
}

function mapTargetContext(row: FeishuProjectOrgTargetRow): FeishuOrgTargetContext {
  return mapTarget(row);
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

/** 按固定 projectId 读取项目（交付任务执行时使用，不随「当前 active 项目」漂移） */
export async function getFeishuProjectById(projectId: string): Promise<FeishuProjectView | null> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(feishuProjects)
    .where(eq(feishuProjects.id, projectId))
    .limit(1);

  return row ? mapProject(row) : null;
}

/** 列出所有已配置 appToken + tableId 的项目（供字段绑定 bootstrap 补绑定） */
export async function listConfiguredFeishuProjects(): Promise<FeishuProjectView[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(feishuProjects)
    .orderBy(desc(feishuProjects.updatedAt));

  return rows
    .map(mapProject)
    .filter((project) => Boolean(project.bitableAppToken) && Boolean(project.bitableTableId));
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
