'use client';

import type { AnalysisResult } from '@/types';
import AnalysisDashboard from '@/components/AnalysisDashboard';

export function PersistentReportView({
  analysis,
  topic,
}: {
  analysis: AnalysisResult;
  topic?: string | null;
}) {
  return (
    <AnalysisDashboard
      result={analysis}
      onReset={() => {
        window.location.href = '/';
      }}
      customTitle={topic || undefined}
    />
  );
}
