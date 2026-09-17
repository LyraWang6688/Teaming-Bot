import { getProjectPublicUrl } from '@/lib/platform/env';

/**
 * 构建会议报告永久链接
 *
 * 版本路由：
 * - V1 报告（analysisSchemaVersion < 2）：保持 /report/{uuid} 兼容存量链接
 * - V2+ 报告：走 /report/v2/{uuid}，从 URL 即可看出分析模板版本
 *
 * 真正决定渲染哪个版本组件的是数据库里的 analysisSchemaVersion 字段，
 * URL 上的 v2 路径段只是展示标识，渲染层 PersistentReportView 会按
 * analysisSchemaVersion 自动分流。
 */
export function buildPersistentReportUrl(
  reportPublicId: string,
  schemaVersion?: number | null
): string {
  const encodedId = encodeURIComponent(reportPublicId);
  const path =
    schemaVersion && schemaVersion >= 2
      ? `/report/v2/${encodedId}`
      : `/report/${encodedId}`;
  return new URL(path, getProjectPublicUrl()).toString();
}
