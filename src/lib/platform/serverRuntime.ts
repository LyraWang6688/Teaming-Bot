/** Background business is opt-in and only supported in the deployed production service. */
export function isServerRuntimeEnabled(): boolean {
  return process.env.NODE_ENV === 'production' && process.env.FEISHU_RUNTIME_ENABLED === 'true';
}

export function assertServerRuntimeEnabled(): void {
  if (!isServerRuntimeEnabled()) {
    throw new Error('SERVER_RUNTIME_DISABLED：本环境禁止启动飞书监听或消费业务任务。请使用服务器部署。');
  }
}

/** Reject bad persisted URLs as well as bad deployment configuration. */
export function assertPublicReportUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('INVALID_REPORT_URL：报告地址必须是有效的公网 HTTPS 地址。'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password ||
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      !host.includes('.') || host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    throw new Error('INVALID_REPORT_URL：禁止向用户交付本地、IP 或非 HTTPS 报告地址。');
  }
  return url;
}
