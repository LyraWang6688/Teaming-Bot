export async function register() {
  const { startFeishuMeetingPipelineWorker } = await import('./lib/feishu/meetingPipelineWorker');
  const { recoverFeishuMeetingPipelinesOnStartup } = await import('./lib/feishu/webhookProcessor');

  startFeishuMeetingPipelineWorker();
  await recoverFeishuMeetingPipelinesOnStartup();
}
