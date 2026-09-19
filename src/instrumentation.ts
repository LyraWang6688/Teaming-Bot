export async function register() {
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
  const { logFeishuMonitor, toErrorContext } = await import('./lib/feishu/common/monitor');

  startFeishuMeetingPipelineWorker();
  // Base/通知交付 worker：首次轮询立即执行，同时承担重启后租约过期任务的恢复
  startDeliveryWorkers();
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
