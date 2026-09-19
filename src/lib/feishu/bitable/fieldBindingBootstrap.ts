/**
 * 字段绑定 bootstrap：迁移上线 / 服务启动时，对所有已配置 Base 的项目
 * 主动拉取一次字段清单并落绑定（bound / type_mismatch / unbound）。
 *
 * 不依赖「等第一条会议同步时懒加载」，保证第四期存量项目上线即完成补绑定，
 * type_mismatch / unbound 立即可见（运维视图、listUnreadyBindings）。
 */
import { logFeishuMonitor } from '../common/monitor';
import { listConfiguredFeishuProjects } from '../projects/projectConfigStore';
import { forceRefreshFieldBindings, listUnreadyBindings } from './fieldBinding';
import type { FeishuBitableAccess } from './bitableOpenApi';

const globalForBootstrap = globalThis as typeof globalThis & {
  __feishuFieldBindingBootstrapStarted?: boolean;
};

/**
 * 对所有已配置项目补绑定。每个项目独立 try/catch，单个项目失败不影响其他项目。
 * 返回每个项目的未就绪字段摘要（供启动日志观测）。
 */
export async function bootstrapFieldBindingsForAllProjects(options?: {
  force?: boolean;
}): Promise<
  Array<{
    projectId: string;
    projectKey: string;
    tableId: string | null;
    unready: Array<{ key: string; status: string; required: boolean }>;
    error?: string;
  }>
> {
  if (!options?.force && globalForBootstrap.__feishuFieldBindingBootstrapStarted) {
    return [];
  }
  globalForBootstrap.__feishuFieldBindingBootstrapStarted = true;

  const projects = await listConfiguredFeishuProjects();
  const results: Awaited<ReturnType<typeof bootstrapFieldBindingsForAllProjects>> = [];

  for (const project of projects) {
    if (!project.bitableAppToken || !project.bitableTableId) continue;

    const access: FeishuBitableAccess = {
      appToken: project.bitableAppToken,
      tableId: project.bitableTableId,
      projectIdOverride: project.id,
      integrationId: 'field-binding-bootstrap',
      userId: 'system',
    };

    try {
      await forceRefreshFieldBindings(access, 'bootstrap');
      const unready = await listUnreadyBindings({
        projectId: project.id,
        tableId: project.bitableTableId,
      });
      results.push({
        projectId: project.id,
        projectKey: project.projectKey,
        tableId: project.bitableTableId,
        unready: unready.map((item) => ({
          key: item.key,
          status: item.status,
          required: item.required,
        })),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        projectId: project.id,
        projectKey: project.projectKey,
        tableId: project.bitableTableId,
        unready: [],
        error: message,
      });
      logFeishuMonitor('warn', 'base_field_binding_bootstrap_project_failed', {
        projectId: project.id,
        projectKey: project.projectKey,
        tableId: project.bitableTableId,
        message,
      });
    }
  }

  logFeishuMonitor('info', 'base_field_binding_bootstrap_finished', {
    projectTotal: projects.length,
    results,
  });

  return results;
}
