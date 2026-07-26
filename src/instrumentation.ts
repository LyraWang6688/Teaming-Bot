export async function register() {
  const { startFeishuMeetingPipelineWorker } = await import('./lib/feishu/pipeline/meetingPipelineWorker');
  const { recoverFeishuMeetingPipelinesOnStartup } = await import('./lib/feishu/pipeline/meetingPipelineProcessor');
  const {
    startFeishuIntegrationCleanupSweeper,
    startAllListeners,
    startInactiveListenerSweeper,
  } = await import('./lib/feishu/events/eventListenerManager');

  startFeishuMeetingPipelineWorker();
  await recoverFeishuMeetingPipelinesOnStartup();
  await startAllListeners();
  startInactiveListenerSweeper();
  startFeishuIntegrationCleanupSweeper();
}
