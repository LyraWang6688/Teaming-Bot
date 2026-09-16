'use client';

import type { AnalysisResultV1, AnalysisResultV2 } from '@/types';
import AnalysisDashboardV1 from '@/components/AnalysisDashboardV1';
import AnalysisDashboardV2 from '@/components/AnalysisDashboardV2';

export function PersistentReportView({
  analysis,
  analysisSchemaVersion,
  topic,
}: {
  analysis: AnalysisResultV1 | AnalysisResultV2;
  analysisSchemaVersion?: number | null;
  topic?: string | null;
}) {
  const isV2 = (analysisSchemaVersion ?? 1) >= 2;
  const reset = () => {
    window.location.href = '/';
  };

  if (isV2) {
    return (
      <AnalysisDashboardV2
        result={analysis as AnalysisResultV2}
        onReset={reset}
        customTitle={topic || undefined}
      />
    );
  }

  return (
    <AnalysisDashboardV1
      result={analysis as AnalysisResultV1}
      onReset={reset}
      customTitle={topic || undefined}
    />
  );
}
