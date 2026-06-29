export async function register() {
  const { startFeishuMeetingPipelineWorker } = await import('./lib/feishu/pipeline/meetingPipelineWorker');
  const { recoverFeishuMeetingPipelinesOnStartup } = await import('./lib/feishu/pipeline/meetingPipelineProcessor');

  startFeishuMeetingPipelineWorker();
  await recoverFeishuMeetingPipelinesOnStartup();
}
