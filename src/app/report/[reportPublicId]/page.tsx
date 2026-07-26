import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PersistentReportView } from '@/components/reports/PersistentReportView';
import { getMeetingReportByPublicId } from '@/lib/reports/meetingReportStore';
import { logRuntimeMonitor } from '@/lib/platform/runtimeMonitor';

export const dynamic = 'force-dynamic';

type ReportPageProps = {
  params: Promise<{
    reportPublicId: string;
  }>;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function generateMetadata({ params }: ReportPageProps): Promise<Metadata> {
  const { reportPublicId } = await params;
  if (!UUID_PATTERN.test(reportPublicId)) {
    return { title: '会议报告不存在' };
  }

  const report = await getMeetingReportByPublicId(reportPublicId);
  return {
    title: report?.topic || '会议动力分析报告',
    robots: {
      index: false,
      follow: false,
    },
  };
}

export default async function PersistentReportPage({ params }: ReportPageProps) {
  const { reportPublicId } = await params;
  if (!UUID_PATTERN.test(reportPublicId)) {
    notFound();
  }

  const report = await getMeetingReportByPublicId(reportPublicId);
  if (!report || !report.analysisResult || !report.completedAt) {
    logRuntimeMonitor('warn', 'meeting_report', 'meeting_report_not_found', {
      reportPublicId,
      found: Boolean(report),
      status: report?.status || null,
      hasAnalysis: Boolean(report?.analysisResult),
    });
    notFound();
  }

  logRuntimeMonitor('info', 'meeting_report', 'meeting_report_loaded', {
    reportPublicId,
    meetingRecordId: report.id,
    meetingId: report.feishuMeetingId,
    integrationId: report.integrationId,
    projectId: report.projectId,
    orgTargetId: report.orgTargetId,
  });

  return (
    <PersistentReportView
      analysis={report.analysisResult}
      topic={report.topic}
    />
  );
}
