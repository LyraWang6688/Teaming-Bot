import { getProjectPublicUrl } from '@/lib/platform/env';

export function buildPersistentReportUrl(reportPublicId: string): string {
  return new URL(`/report/${encodeURIComponent(reportPublicId)}`, getProjectPublicUrl()).toString();
}
