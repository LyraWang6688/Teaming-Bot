import { isServerRuntimeEnabled } from './lib/platform/serverRuntime';
import { getProjectPublicUrl } from './lib/platform/env';

export async function register() {
  if (!isServerRuntimeEnabled()) {
    console.info('[Server Runtime] 后台业务未启用，不启动监听和任务执行器。');
    return;
  }
  getProjectPublicUrl(); // 在启动任何消费者之前校验部署域名。
  const { startFeishuMeetingPipelineWorker } = await import('./lib/feishu/pipeline/meetingPipelineWorker');
  const { recoverFeishuMeetingPipelinesOnStartup } = await import('./lib/feishu/pipeline/meetingPipelineProcessor');
  const { startDeliveryWorkers } = await import('./lib/feishu/delivery/deliveryWorker');
  const { bootstrapFieldBindingsForAllProjects } = await import('./lib/feishu/bitable/fieldBindingBootstrap');
  const { recoverStaleSetupAttempts } = await import('./lib/feishu/integration/setupAttemptStore');
  const {
    startFeishuIntegrationCleanupSweeper,
    startAllListeners,
    startInactiveListenerSweeper,
  } = await import('./lib/feishu/events/eventListenerManager');
  const { startFeishuTokenRefreshWorker } = await import(
    './lib/feishu/integration/tokenRefreshWorker'
  );
  const { startFeishuDeliveryHealthWorker } = await import(
    './lib/feishu/integration/integrationHealthWorker'
  );
  const { logFeishuMonitor, toErrorContext } = await import('./lib/feishu/common/monitor');

  startFeishuMeetingPipelineWorker();
  // Base/通知交付 worker：首次轮询立即执行，同时承担重启后租约过期任务的恢复
  startDeliveryWorkers();
  // 主动刷新用户授权：refresh token 只有 7 天有效期，必须脱离业务请求独立续期。
  // 详见 tokenRefreshSweeper.ts 顶部说明。
  startFeishuTokenRefreshWorker();
  // 事件投递健康检查：飞书 2026-10-26 起，未授权用户的事件将不再投递且无法补发。
  // 详见 integrationDeliveryHealth.ts 顶部说明。
  startFeishuDeliveryHealthWorker();
  await recoverFeishuMeetingPipelinesOnStartup();
  await startAllListeners();
  startInactiveListenerSweeper();
  startFeishuIntegrationCleanupSweeper();

  // 字段绑定启动对账（canonical+别名），失败不阻断启动
  try {
    await bootstrapFieldBindingsForAllProjects();
  } catch (error) {
    logFeishuMonitor('error', 'field_binding_bootstrap_failed', toErrorContext(error));
  }

  // 初始化 attempt 崩溃恢复：超时 running → interrupted，失败不阻断启动
  try {
    const recovered = await recoverStaleSetupAttempts();
    if (recovered > 0) {
      logFeishuMonitor('info', 'setup_attempts_recovered_on_startup', { recovered });
    }
  } catch (error) {
    logFeishuMonitor('error', 'setup_attempt_recover_failed', toErrorContext(error));
  }
}
