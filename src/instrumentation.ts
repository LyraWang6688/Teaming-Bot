export async function register() {
  const { recoverFeishuMeetingPipelinesOnStartup } = await import('./lib/feishu/webhookProcessor');

  await recoverFeishuMeetingPipelinesOnStartup();
}
