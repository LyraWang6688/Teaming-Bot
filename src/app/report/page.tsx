/**
 * 报告页面
 * 支持通过 recordId 参数从飞书多维表格获取分析数据并渲染报告
 */

'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { AnalysisResult } from '@/types';
import AnalysisDashboard from '@/components/AnalysisDashboard';
import { FEISHU_ACTIVE_PROCESS_STATUSES, FEISHU_PROCESS_STATUS } from '@/lib/feishu/pipeline/status';
import { Loader2, AlertCircle, ArrowLeft } from 'lucide-react';

const ACTIVE_PROCESS_STATUSES = new Set<string>(FEISHU_ACTIVE_PROCESS_STATUSES);

// 加载状态组件
function LoadingState() {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="text-center">
        <Loader2 className="w-12 h-12 text-blue-600 animate-spin mx-auto mb-4" />
        <p className="text-slate-600">正在加载报告...</p>
      </div>
    </div>
  );
}

// 错误状态组件
function ErrorState({ message, onBack }: { message: string; onBack?: () => void }) {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="text-center max-w-md mx-auto p-6">
        <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-slate-800 mb-2">加载失败</h2>
        <p className="text-slate-600 mb-4">{message}</p>
        {onBack && (
          <button
            onClick={onBack}
            className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            返回首页
          </button>
        )}
      </div>
    </div>
  );
}

// 处理中状态组件
function ProcessingState({ status }: { status?: string | null }) {
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center">
      <div className="text-center max-w-md mx-auto p-6">
        <Loader2 className="w-12 h-12 text-blue-600 animate-spin mx-auto mb-4" />
        <h2 className="text-xl font-semibold text-slate-800 mb-2">报告正在生成中</h2>
        <p className="text-slate-600 mb-4">
          {status ? `当前状态：${status}。` : ''}请稍后刷新页面查看结果
        </p>
        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          刷新页面
        </button>
      </div>
    </div>
  );
}

// 报告内容组件
function ReportContent() {
  const searchParams = useSearchParams();
  const recordId = searchParams.get('recordId');
  const integrationId = searchParams.get('integrationId');
  const orgTargetId = searchParams.get('orgTargetId');
  
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [analysisData, setAnalysisData] = useState<AnalysisResult | null>(null);
  const [processStatus, setProcessStatus] = useState<string | null>(null);
  const [topic, setTopic] = useState<string | null>(null);

  useEffect(() => {
    if (!recordId) {
      setError('缺少记录ID参数');
      setLoading(false);
      return;
    }

    if (!integrationId || !orgTargetId) {
      setError('报告链接缺少集成或组织参数，无法定位对应的多维表格');
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      try {
        const requestUrl = new URL('/api/feishu/record', window.location.origin);
        requestUrl.searchParams.set('recordId', recordId);
        requestUrl.searchParams.set('integrationId', integrationId);
        requestUrl.searchParams.set('orgTargetId', orgTargetId);

        const response = await fetch(requestUrl.toString());
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || '获取数据失败');
        }

        const reportData = data.data;
        setProcessStatus(reportData?.processStatus || null);
        setTopic(reportData?.topic || null);

        if (reportData?.analysisData) {
          setAnalysisData(reportData.analysisData);
        } else if (reportData?.processStatus && ACTIVE_PROCESS_STATUSES.has(reportData.processStatus)) {
          // 正在处理中，不设置错误
        } else if (reportData?.processStatus === FEISHU_PROCESS_STATUS.failed) {
          setError('分析处理失败，请重新提交');
        } else {
          setError('暂无分析数据');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '获取数据失败');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [integrationId, orgTargetId, recordId]);

  if (loading) {
    return <LoadingState />;
  }

  if (error) {
    return <ErrorState message={error} onBack={() => window.location.href = '/'} />;
  }

  if (processStatus && ACTIVE_PROCESS_STATUSES.has(processStatus)) {
    return <ProcessingState status={processStatus} />;
  }

  if (!analysisData) {
    return <ErrorState message="暂无分析数据" onBack={() => window.location.href = '/'} />;
  }

  return (
    <AnalysisDashboard 
      result={analysisData} 
      onReset={() => window.location.href = '/'}
      customTitle={topic || undefined}
    />
  );
}

// 主页面组件
export default function ReportPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <ReportContent />
    </Suspense>
  );
}
