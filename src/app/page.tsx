'use client';

import React, { useState, useEffect } from 'react';
import Layout from '@/components/Layout';
import InputForm from '@/components/InputForm';
import AnalysisDashboard from '@/components/AnalysisDashboard';
import { AnalysisResult, BatchItem } from '@/types';
import { FileText, Loader2, RefreshCw, FileDown } from 'lucide-react';
import { toJpeg } from 'html-to-image';
import { jsPDF } from 'jspdf';
import { ZONE_CONFIG } from '@/utils';
import { logClientMonitor, toClientErrorContext } from '@/lib/platform/clientMonitor';

const ANALYSIS_TASK_POLL_INTERVAL_MS = 2000;
const ANALYSIS_TASK_TIMEOUT_MS = 20 * 60 * 1000;

function HomeContent() {
  const [batchItems, setBatchItems] = useState<BatchItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [elapsedTime, setElapsedTime] = useState(0);
  const [currentView, setCurrentView] = useState<'LIST' | 'DETAIL'>('LIST');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [isGeneratingAllPdfs, setIsGeneratingAllPdfs] = useState(false);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null;
    if (isProcessing) {
      interval = setInterval(() => {
        setElapsedTime((prev) => prev + 1);
      }, 1000);
    } else {
      setElapsedTime(0);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isProcessing]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}分${secs.toString().padStart(2, '0')}秒`;
  };

  const processSingleItem = async (item: BatchItem) => {
    setBatchItems(prev => prev.map(it => it.id === item.id ? { ...it, status: 'ANALYZING', error: undefined, result: undefined, taskId: undefined } : it));

    try {
      const result = await analyzeMeetingMinutes(item.file, (taskId) => {
        setBatchItems(prev => prev.map(it => it.id === item.id ? { ...it, taskId } : it));
      });
      setBatchItems(prev => prev.map(it => it.id === item.id ? { ...it, status: 'COMPLETE', result } : it));

    } catch (error: unknown) {
      logClientMonitor('error', 'home_page', 'file_analysis_failed', {
        ...toClientErrorContext(error),
        fileName: item.file.name,
      });
      const message = error instanceof Error ? error.message : 'Analysis failed';
      setBatchItems(prev => prev.map(it => it.id === item.id ? { ...it, status: 'ERROR', error: message } : it));
    }
  };

  const handleAnalyzeFiles = async (files: File[]) => {
    const newItems: BatchItem[] = files.map(file => ({
      id: Math.random().toString(36).substring(7),
      file,
      status: 'PENDING'
    }));

    setBatchItems(newItems);
    setIsProcessing(true);
    setCurrentView('LIST');

    for (let i = 0; i < newItems.length; i++) {
      await processSingleItem(newItems[i]);
    }

    setIsProcessing(false);
  };

  const handleRetryItem = async (id: string) => {
    const item = batchItems.find(it => it.id === id);
    if (!item) return;

    setIsProcessing(true);
    await processSingleItem(item);

    const stillAnalyzing = batchItems.some(it => it.status === 'ANALYZING');
    if (!stillAnalyzing) {
      setIsProcessing(false);
    }
  };

  const handleReanalyzeAll = async () => {
    setIsProcessing(true);

    // 将所有已完成的项重置为 PENDING 状态
    setBatchItems(prev => prev.map(item => {
      if (item.status === 'COMPLETE' || item.status === 'ERROR') {
        return { ...item, status: 'PENDING', error: undefined, result: undefined, taskId: undefined };
      }
      return item;
    }));

    // 重新分析所有项
    const itemsToReanalyze = [...batchItems];
    for (let i = 0; i < itemsToReanalyze.length; i++) {
      await processSingleItem(itemsToReanalyze[i]);
    }

    setIsProcessing(false);
  };

  const handleDownloadAllReports = async () => {
    const completedItems = batchItems.filter((item): item is BatchItem & { result: AnalysisResult } => 
      item.status === 'COMPLETE' && item.result !== undefined
    );
    if (completedItems.length === 0) return;

    setIsGeneratingAllPdfs(true);

    try {
      // 创建一个临时的隐藏容器来渲染每个报告
      const container = document.createElement('div');
      container.style.position = 'absolute';
      container.style.left = '-9999px';
      container.style.width = '1200px';
      container.style.backgroundColor = 'white';
      document.body.appendChild(container);

      // 等待字体加载完成
      await document.fonts.ready;

      // 使用与 AnalysisDashboard 相同的渲染方式
      for (const item of completedItems) {
        try {
          // 创建临时 div 用于渲染 AnalysisDashboard
          const wrapper = document.createElement('div');
          wrapper.className = 'temp-dashboard-wrapper';
          container.appendChild(wrapper);

          // 使用 React 动态渲染 AnalysisDashboard
          const { createRoot } = await import('react-dom/client');
          const root = createRoot(wrapper);
          
          // 创建一个 Promise 来等待 PDF 生成完成
          await new Promise<void>((resolve) => {
            root.render(
              React.createElement(
                React.Suspense,
                { fallback: React.createElement('div', { style: { padding: '40px', background: 'white' } }, '加载中...') },
                React.createElement(AnalysisDashboard, {
                  result: item.result,
                  hideControls: true,
                  customTitle: item.file.name,
                })
              )
            );
            
            // 等待内容渲染完成并确保字体已应用
            setTimeout(async () => {
              try {
                // 找到渲染后的内容
                const dashboardElement = wrapper.querySelector('.space-y-8') as HTMLElement;
                if (!dashboardElement) {
                  throw new Error('Dashboard element not found');
                }

                // 等待额外时间确保字体渲染完成
                await new Promise(r => setTimeout(r, 500));

                // 使用 html-to-image 生成 JPEG（相比 PNG 大幅压缩体积）
                const dataUrl = await toJpeg(dashboardElement, {
                  quality: 0.85,
                  pixelRatio: 1.5,
                  cacheBust: true,
                  style: {
                    transform: 'none',
                    transformOrigin: 'top left',
                  },
                  filter: (node) => {
                    // 排除外部样式表链接，避免 cssRules 访问错误
                    if (node.tagName === 'LINK' && (node as HTMLLinkElement).href) {
                      const href = (node as HTMLLinkElement).href;
                      if (!href.startsWith(window.location.origin)) {
                        return false;
                      }
                    }
                    return true;
                  },
                });

                // 创建 PDF
                const pdfWidth = 210;
                const img = new Image();

                await new Promise<void>((pdfResolve, pdfReject) => {
                  img.onload = async () => {
                    try {
                      const pdfHeight = (img.height * pdfWidth) / img.width;
                      const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: [pdfWidth, pdfHeight] });
                      pdf.addImage(dataUrl, 'JPEG', 0, 0, pdfWidth, pdfHeight, undefined, 'FAST');
                      const safeTS = (item.result.reportTimestamp || '').replace(/[:-\s]/g, '_');
                      pdf.save(`报告-${item.file.name.replace(/\s+/g, '_')}-${safeTS}.pdf`);
                      pdfResolve();
                    } catch (e) {
                      pdfReject(e);
                    }
                  };
                  img.onerror = () => {
                    pdfReject(new Error('Failed to load image'));
                  };
                  img.src = dataUrl;
                });

                // 清理 React root
                root.unmount();
                resolve();
              } catch (error) {
                root.unmount();
                resolve();
                logClientMonitor('error', 'home_page', 'batch_pdf_item_failed', {
                  ...toClientErrorContext(error),
                  fileName: item.file.name,
                });
              }
            }, 2000); // 等待 2 秒让 React 组件完全渲染并应用字体
          });

          // 清理临时元素
          container.removeChild(wrapper);

          // 短暂延迟以避免浏览器阻塞
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          logClientMonitor('error', 'home_page', 'batch_pdf_item_failed', {
            ...toClientErrorContext(error),
            fileName: item.file.name,
          });
        }
      }

      // 清理容器
      document.body.removeChild(container);
    } catch (error) {
      logClientMonitor('error', 'home_page', 'batch_pdf_generation_failed', toClientErrorContext(error));
    } finally {
      setIsGeneratingAllPdfs(false);
    }
  };

  const handleReset = () => {
    setBatchItems([]);
    setIsProcessing(false);
    setCurrentView('LIST');
    setDetailId(null);
  };

  const viewDetail = (id: string) => {
    setDetailId(id);
    setCurrentView('DETAIL');
  };

  const backToList = () => {
    setDetailId(null);
    setCurrentView('LIST');
  };

  // 详情视图 - 从本地上传的文件
  if (currentView === 'DETAIL' && detailId) {
    const selectedItem = batchItems.find(item => item.id === detailId);
    if (selectedItem && selectedItem.status === 'COMPLETE' && selectedItem.result) {
      return (
        <Layout>
          <AnalysisDashboard
            result={selectedItem.result}
            onReset={backToList}
            customTitle={selectedItem.file.name}
          />
        </Layout>
      );
    }
  }

  // 列表视图
  const completedCount = batchItems.filter(item => item.status === 'COMPLETE').length;

  if (batchItems.length === 0) {
    return (
      <Layout>
        <InputForm onAnalyzeFiles={handleAnalyzeFiles} isLoading={isProcessing} />
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="max-w-6xl mx-auto">
        <div className="mb-6 flex items-center justify-between">
          <button
            onClick={handleReset}
            className="flex items-center space-x-2 px-5 py-2.5 bg-white text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50 transition-all font-bold text-sm"
          >
            <RefreshCw className="w-4 h-4" />
            <span>重新导入报告</span>
          </button>

          {completedCount > 0 && (
            <button
              onClick={handleDownloadAllReports}
              disabled={isGeneratingAllPdfs}
              className="flex items-center space-x-2 px-5 py-2.5 bg-indigo-600 text-white border border-indigo-700 rounded-xl hover:bg-indigo-700 transition-all font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isGeneratingAllPdfs ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>生成中...</span>
                </>
              ) : (
                <>
                  <FileDown className="w-4 h-4" />
                  <span>下载所有报告 ({completedCount})</span>
                </>
              )}
            </button>
          )}

          {completedCount > 0 && !isProcessing && (
            <button
              onClick={handleReanalyzeAll}
              disabled={isProcessing}
              className="flex items-center space-x-2 px-5 py-2.5 bg-emerald-600 text-white border border-emerald-700 rounded-xl hover:bg-emerald-700 transition-all font-bold text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <RefreshCw className="w-4 h-4" />
              <span>重新分析一遍 ({completedCount})</span>
            </button>
          )}
        </div>

        {isProcessing && (
          <div className="mb-6 p-4 bg-indigo-50 border border-indigo-200 rounded-xl flex items-center space-x-3">
            <Loader2 className="w-5 h-5 text-indigo-600 animate-spin" />
            <div>
              <p className="font-bold text-slate-800">正在分析中...</p>
              <p className="text-sm text-slate-600">已用时: {formatTime(elapsedTime)}</p>
            </div>
          </div>
        )}

        <div className="space-y-4">
          {batchItems.map((item) => (
            <div
              key={item.id}
              className={`bg-white border-2 rounded-xl p-6 transition-all ${
                item.status === 'COMPLETE' ? 'border-emerald-200 shadow-md' :
                item.status === 'ANALYZING' ? 'border-indigo-200 shadow-md' :
                item.status === 'ERROR' ? 'border-red-200 shadow-md' :
                'border-slate-200'
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${
                    item.status === 'COMPLETE' ? 'bg-emerald-100' :
                    item.status === 'ANALYZING' ? 'bg-indigo-100' :
                    item.status === 'ERROR' ? 'bg-red-100' :
                    'bg-slate-100'
                  }`}>
                    {item.status === 'COMPLETE' && <FileText className="w-6 h-6 text-emerald-600" />}
                    {item.status === 'ANALYZING' && <Loader2 className="w-6 h-6 text-indigo-600 animate-spin" />}
                    {item.status === 'ERROR' && <RefreshCw className="w-6 h-6 text-red-600" />}
                    {item.status === 'PENDING' && <FileText className="w-6 h-6 text-slate-400" />}
                  </div>

                  <div className="flex-1">
                    <p className="font-bold text-slate-900">{item.file.name}</p>
                    <p className="text-sm text-slate-500 mb-2">
                      {item.status === 'COMPLETE' && '分析完成'}
                      {item.status === 'ANALYZING' && '正在分析...'}
                      {item.status === 'ERROR' && `分析失败: ${item.error}`}
                      {item.status === 'PENDING' && '等待分析'}
                    </p>
                    {item.status === 'COMPLETE' && item.result && (
                      <div className="flex items-center space-x-2">
                        <span className="text-xs font-semibold text-slate-600">团队状态：</span>
                        <span className={`px-3 py-1 rounded-lg font-bold text-xs ${ZONE_CONFIG[item.result.teamState.zone]?.style || 'bg-slate-100 text-slate-800'}`}>
                          {ZONE_CONFIG[item.result.teamState.zone]?.label || item.result.teamState.zone}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex items-center space-x-2">
                  {item.status === 'COMPLETE' && (
                    <button
                      onClick={() => viewDetail(item.id)}
                      className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-all font-semibold text-sm"
                    >
                      查看报告
                    </button>
                  )}

                  {item.status === 'ERROR' && (
                    <button
                      onClick={() => handleRetryItem(item.id)}
                      className="flex items-center space-x-2 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-all font-semibold text-sm"
                    >
                      <RefreshCw className="w-4 h-4" />
                      <span>重试</span>
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Layout>
  );
}

async function readAnalyzeResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('json')) {
    return response.json().catch(() => null);
  }

  return response.text().catch(() => null);
}

type ApiResponse<T> = {
  success?: boolean;
  data?: T;
  error?: string;
};

type WebAnalysisTaskPayload = {
  id: string;
  status: 'pending' | 'analyzing' | 'completed' | 'failed';
  result?: AnalysisResult;
  error?: string;
};

function getServerErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const message = record.error ?? record.message;
  return typeof message === 'string' && message.trim() ? message : null;
}

function createAnalyzeError(response: Response, payload: unknown): Error {
  const serverMessage = getServerErrorMessage(payload);
  if (serverMessage) {
    return new Error(serverMessage);
  }

  if (response.status === 504) {
    return new Error('分析请求超过网关等待时间（504 Gateway Time-out）。服务器可能仍在分析，请稍后重试；若持续出现，请调大 Nginx 代理超时时间。');
  }

  if (response.status === 413) {
    return new Error('上传文件超过网关允许大小（413 Payload Too Large）。请压缩文件，或调大 Nginx client_max_body_size。');
  }

  const statusText = response.statusText ? ` ${response.statusText}` : '';
  const responseType = typeof payload === 'string' && payload.trim()
    ? '服务器返回了非 JSON 错误页'
    : '服务器没有返回可解析的错误信息';
  return new Error(`分析请求失败（HTTP ${response.status}${statusText}）：${responseType}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getTaskPayload(payload: unknown): WebAnalysisTaskPayload {
  if (!payload || typeof payload !== 'object') {
    throw new Error('分析接口返回了非 JSON 内容，请检查服务器或反向代理日志。');
  }

  const response = payload as ApiResponse<WebAnalysisTaskPayload>;
  if (response.success === false) {
    throw new Error(response.error || '分析任务请求失败');
  }

  if (!response.data?.id || !response.data.status) {
    throw new Error('分析任务返回数据不完整，请重新尝试。');
  }

  return response.data;
}

async function createAnalyzeTask(file: File): Promise<WebAnalysisTaskPayload> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch('/api/analyze/tasks', {
    method: 'POST',
    body: formData,
  });

  const payload = await readAnalyzeResponse(response);

  if (!response.ok) {
    throw createAnalyzeError(response, payload);
  }

  return getTaskPayload(payload);
}

async function fetchAnalyzeTask(taskId: string): Promise<WebAnalysisTaskPayload> {
  const response = await fetch(`/api/analyze/tasks/${taskId}`, {
    method: 'GET',
    cache: 'no-store',
  });

  const payload = await readAnalyzeResponse(response);

  if (!response.ok) {
    throw createAnalyzeError(response, payload);
  }

  return getTaskPayload(payload);
}

async function waitForAnalyzeTask(taskId: string): Promise<AnalysisResult> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < ANALYSIS_TASK_TIMEOUT_MS) {
    const task = await fetchAnalyzeTask(taskId);

    if (task.status === 'completed') {
      if (!task.result) {
        throw new Error('分析任务已完成，但缺少报告数据。');
      }
      return task.result;
    }

    if (task.status === 'failed') {
      throw new Error(task.error || '分析任务失败，请重新尝试。');
    }

    await sleep(ANALYSIS_TASK_POLL_INTERVAL_MS);
  }

  throw new Error('分析任务等待超时，请稍后重试。');
}

// 创建后端异步任务并轮询结果（支持 txt 和 docx 文件）
async function analyzeMeetingMinutes(
  file: File,
  onTaskCreated?: (taskId: string) => void
): Promise<AnalysisResult> {
  const task = await createAnalyzeTask(file);
  onTaskCreated?.(task.id);
  return waitForAnalyzeTask(task.id);
}

export default function Home() {
  return <HomeContent />;
}
