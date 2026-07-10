export const runtime = 'nodejs';

export async function register() {
  if (process.env.PLAYWRIGHT_TEST === '1') {
    return;
  }

  const { startFeishuMeetingPipelineWorker } = await import('./lib/feishu/pipeline/meetingPipelineWorker');
  const { recoverFeishuMeetingPipelinesOnStartup } = await import('./lib/feishu/pipeline/meetingPipelineProcessor');
  const { startAllListeners } = await import('./lib/feishu/events/eventListenerManager');

  startFeishuMeetingPipelineWorker();
  await recoverFeishuMeetingPipelinesOnStartup();
  await startAllListeners();
}
