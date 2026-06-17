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
    setBatchItems(prev => prev.map(it => it.id === item.id ? { ...it, status: 'ANALYZING', error: undefined } : it));

    try {
      const result = await analyzeMeetingMinutes(item.file);
      setBatchItems(prev => prev.map(it => it.id === item.id ? { ...it, status: 'COMPLETE', result } : it));

    } catch (error: unknown) {
      console.error(`Error analyzing ${item.file.name}:`, error);
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
        return { ...item, status: 'PENDING', error: undefined };
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
                console.error(`Failed to generate PDF for ${item.file.name}:`, error);
              }
            }, 2000); // 等待 2 秒让 React 组件完全渲染并应用字体
          });

          // 清理临时元素
          container.removeChild(wrapper);

          // 短暂延迟以避免浏览器阻塞
          await new Promise(resolve => setTimeout(resolve, 500));
        } catch (error) {
          console.error(`Failed to generate PDF for ${item.file.name}:`, error);
        }
      }

      // 清理容器
      document.body.removeChild(container);
    } catch (error) {
      console.error('Batch PDF generation failed:', error);
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

// 调用后端 API 进行分析（支持 txt 和 docx 文件）
async function analyzeMeetingMinutes(file: File): Promise<AnalysisResult> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch('/api/analyze', {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Analysis failed');
  }

  return response.json();
}

export default function Home() {
  return <HomeContent />;
}
