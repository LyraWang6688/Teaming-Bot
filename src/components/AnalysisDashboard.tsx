'use client';

import React, { useRef, useState, useMemo } from 'react';
import { AnalysisResult, BehaviorMetric } from '@/types';
import TeamStateChart from './charts/TeamStateChart';
import BehaviorRadar from './charts/BehaviorRadar';
import {
  Shield, Sparkles, Quote, Download, Loader2, ArrowLeft,
  CheckSquare, Zap, Info,
  Eye, EyeOff
} from 'lucide-react';
import { toJpeg } from 'html-to-image';
import { jsPDF } from 'jspdf';
import { LEVEL_CONFIG, ZONE_CONFIG, BEHAVIOR_LABELS, cleanEvidence } from '@/utils';

interface AnalysisDashboardProps {
  result: AnalysisResult;
  onReset?: () => void;
  hideControls?: boolean;
  customTitle?: string;
}

const AnalysisDashboard: React.FC<AnalysisDashboardProps> = ({ result, onReset, hideControls = false, customTitle }) => {
  const zoneConfig = ZONE_CONFIG[result.teamState.zone] || ZONE_CONFIG['Apathy'];
  const dashboardRef = useRef<HTMLDivElement>(null);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [hideSpeakerNames, setHideSpeakerNames] = useState(false);

  // 从文本中提取所有可能的名字（包括发言者和对话中提到的名字）
  const extractNamesFromText = (text: string): string[] => {
    const names: string[] = [];
    
    // 匹配中文名字：常见姓氏 + 1-2个字
    const chineseSurnames = '王李张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段雷钱汤尹黎葛薛庞'.split('');
    const chineseNamePattern = new RegExp(`[${chineseSurnames.join('')}][\\u4e00-\\u9fa5]{1,2}`, 'g');
    const chineseNames = text.match(chineseNamePattern) || [];
    names.push(...chineseNames);
    
    // 匹配英文名字：首字母大写的单词（2-20个字母）
    const englishNamePattern = /\b[A-Z][a-z]{1,19}\b/g;
    const englishNames = text.match(englishNamePattern) || [];
    // 过滤掉常见的非人名大写单词
    const nonPersonWords = ['The', 'This', 'That', 'What', 'When', 'Where', 'Why', 'How', 'Yes', 'No', 'OK', 'And', 'But', 'Or', 'So', 'Please', 'Thank', 'Sorry', 'Hello', 'Hi', 'Good', 'Bad', 'Best', 'Better', 'Worse', 'Right', 'Left', 'Up', 'Down', 'In', 'On', 'At', 'To', 'From', 'With', 'For', 'Of', 'About', 'As', 'By', 'If', 'Then', 'Now', 'Later', 'Today', 'Tomorrow', 'Yesterday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'First', 'Second', 'Third', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'All', 'Some', 'Many', 'Most', 'Few', 'Any', 'Every', 'Each', 'Both', 'Neither', 'Either', 'Other', 'Another', 'Such', 'Same', 'Different', 'New', 'Old', 'Big', 'Small', 'Large', 'Little', 'Long', 'Short', 'High', 'Low', 'Fast', 'Slow', 'Hard', 'Soft', 'Easy', 'Difficult', 'Important', 'Unimportant', 'Possible', 'Impossible', 'Necessary', 'Unnecessary', 'Good', 'Bad', 'Right', 'Wrong', 'True', 'False', 'Real', 'Fake'];
    const filteredEnglishNames = englishNames.filter(name => !nonPersonWords.includes(name));
    names.push(...filteredEnglishNames);
    
    return names;
  };

  // 从所有文本中收集所有名字
  const extractAllNames = (): Set<string> => {
    const allNames = new Set<string>();
    
    // 收集发言者姓名（从沟通参与度中提取）
    result.communication.forEach(participant => {
      allNames.add(participant.name);
      // 从参与者的发言中提取名字
      const namesInText = extractNamesFromText(participant.name);
      namesInText.forEach(name => {
        if (name !== participant.name) {
          allNames.add(name);
        }
      });
    });
    
    // 从建议综合论述中提取名字
    if (result.leaderAdvice?.reasoning) {
      const namesInReasoning = extractNamesFromText(result.leaderAdvice.reasoning);
      namesInReasoning.forEach(name => allNames.add(name));
    }
    
    // 从建议正文中提取名字
    if (result.leaderAdvice?.advice) {
      const namesInAdvice = extractNamesFromText(result.leaderAdvice.advice);
      namesInAdvice.forEach(name => allNames.add(name));
    }
    
    // 从总结中提取名字
    const namesInSummary = extractNamesFromText(result.summary);
    namesInSummary.forEach(name => allNames.add(name));
    
    // 从分析中提取名字
    const namesInAnalysis = extractNamesFromText(result.teamState.analysis);
    namesInAnalysis.forEach(name => allNames.add(name));
    
    return allNames;
  };

  // 创建姓名到字母的映射
  const speakerNameMapping = useMemo(() => {
    const allSpeakers = extractAllNames();
    
    // 将姓名映射为字母 A, B, C, D, E...
    const nameToLetter = new Map<string, string>();
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    let letterIndex = 0;
    
    allSpeakers.forEach(name => {
      if (letterIndex < letters.length) {
        nameToLetter.set(name, letters[letterIndex]);
        letterIndex++;
      } else {
        // 如果超过26人，使用 A1, A2, B1, B2 等
        const letter = letters[Math.floor(letterIndex / 26) % 26];
        const num = Math.floor(letterIndex / 26) + 1;
        nameToLetter.set(name, `${letter}${num}`);
        letterIndex++;
      }
    });
    
    return nameToLetter;
  }, [result]);

  // 替换文本中的所有名字
  const replaceNamesInText = (text: string): string => {
    if (!hideSpeakerNames) return text;
    
    let result = text;
    speakerNameMapping.forEach((letter, name) => {
      // 使用正则表达式全局替换，避免部分匹配
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escapedName, 'g');
      result = result.replace(pattern, letter);
    });
    
    return result;
  };

  const generatePdf = async () => {
    if (!dashboardRef.current) return;
    setIsGeneratingPdf(true);
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      const element = dashboardRef.current;

      // 使用 html-to-image 生成 JPEG（相比 PNG 大幅压缩体积）
      // 禁用字体嵌入以避免跨域 cssRules 访问错误
      const dataUrl = await toJpeg(element, {
        quality: 0.85,
        pixelRatio: 1.5,
        cacheBust: true,
        skipFonts: true,  // 跳过字体嵌入，避免跨域样式表访问错误
        style: {
          transform: 'none',
          transformOrigin: 'top left',
        },
        filter: (node) => {
          // 排除外部样式表链接
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

      await new Promise<void>((resolve, reject) => {
        img.onload = () => {
          try {
            const pdfHeight = (img.height * pdfWidth) / img.width;
            const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: [pdfWidth, pdfHeight] });
            pdf.addImage(dataUrl, 'JPEG', 0, 0, pdfWidth, pdfHeight, undefined, 'FAST');
            const safeTS = result.reportTimestamp.replace(/[:-\s]/g, '_');
            pdf.save(`报告-${(customTitle || '未命名').replace(/\s+/g, '_')}-${safeTS}.pdf`);
            resolve();
          } catch (e) {
            reject(e);
          }
        };
        img.onerror = () => {
          reject(new Error('Failed to load image for PDF generation'));
        };
        img.src = dataUrl;
      });
    } catch (error) {
      console.error('PDF generation failed:', error);
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const ts = result.teamState;
  const meta = result.metadata;

  return (
    <div className="max-w-6xl mx-auto animate-fade-in w-full pb-10">
      {!hideControls && (
        <div className="flex justify-between items-center mb-6 no-print">
          <div className="flex items-center space-x-3">
            {onReset && (
              <button onClick={onReset} className="flex items-center space-x-2 px-5 py-2.5 bg-white text-slate-600 border border-slate-200 rounded-xl hover:bg-slate-50 transition-all font-bold text-sm">
                <ArrowLeft className="w-4 h-4" />
                <span>返回</span>
              </button>
            )}
            <button
              onClick={() => setHideSpeakerNames(!hideSpeakerNames)}
              className={`flex items-center space-x-2 px-5 py-2.5 rounded-xl transition-all font-bold text-sm ${
                hideSpeakerNames
                  ? 'bg-amber-100 text-amber-700 border-amber-300 hover:bg-amber-200'
                  : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              } border`}
            >
              {hideSpeakerNames ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              <span>{hideSpeakerNames ? '显示姓名' : '隐藏姓名'}</span>
            </button>
          </div>
          <button onClick={generatePdf} disabled={isGeneratingPdf} className="flex items-center space-x-2 px-5 py-2.5 bg-indigo-600 text-white rounded-xl hover:bg-indigo-700 transition-all shadow-lg text-sm font-bold">
            {isGeneratingPdf ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            <span>导出报告</span>
          </button>
        </div>
      )}

      <div ref={dashboardRef} className="space-y-8 bg-slate-50 p-6 md:p-10 rounded-2xl w-full border border-slate-200 shadow-xl">
        {/* Header Section */}
        <div className="bg-white rounded-3xl shadow-sm border border-slate-200 p-8">
          <div className="flex justify-between items-start mb-6">
            <div className="flex items-center space-x-3">
              <Sparkles className="text-indigo-600 w-12 h-12" />
              <div>
                <h1 className="text-3xl font-black text-slate-900 tracking-tight">会议分析报告</h1>
                <div className="flex items-center space-x-2 mt-1">
                  <span className="px-2 py-0.5 bg-indigo-50 text-indigo-600 text-[10px] font-black rounded border border-indigo-100 uppercase tracking-widest">{meta.meetingType}</span>
                </div>
              </div>
            </div>
            <div className="text-right">
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1">分析完成时间</p>
              <p className="text-xs font-mono font-bold text-slate-700 bg-slate-100 px-3 py-1.5 rounded-full border border-slate-200">{result.reportTimestamp}</p>
            </div>
          </div>
          <div className="bg-slate-900 rounded-2xl p-6 text-white shadow-xl relative overflow-hidden group">
             <Quote className="absolute -right-4 -bottom-4 w-32 h-32 text-white/5 rotate-12" />
             <p className="text-[10px] font-black text-indigo-400 uppercase tracking-[0.2em] mb-2">组队动力综述</p>
             <p className="text-lg font-medium leading-relaxed italic relative z-10">{replaceNamesInText(result.summary)}</p>
          </div>
        </div>

        {/* 1. 团队整体状态定位 */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className="lg:col-span-7 bg-white rounded-3xl shadow-sm border border-slate-200 p-8 flex flex-col">
            <div className="flex items-center justify-between mb-8">
              <div className="flex items-center space-x-2">
                <Shield className="text-indigo-600 w-6 h-6" />
                <h3 className="text-xl font-bold text-slate-900">团队整体状态定位</h3>
              </div>
              <div className="flex items-center space-x-2">
                <span className={`px-4 py-1 rounded-full text-xs font-black uppercase tracking-tight ${zoneConfig.style}`}>
                  {zoneConfig.label}
                </span>
              </div>
            </div>

            <TeamStateChart data={result.teamState} />

            <div className="mt-6 p-4 bg-indigo-50/50 rounded-2xl border border-indigo-100 flex-grow">
               <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-1">动力诊断</p>
               <p className="text-slate-700 text-xs font-bold leading-relaxed italic">{replaceNamesInText(ts.analysis)}</p>
            </div>
          </div>

          <div className="lg:col-span-5 bg-white rounded-3xl shadow-sm border border-slate-200 p-8 flex flex-col">
            <div className="flex items-center space-x-2 mb-8">
              <Zap className="text-amber-500 w-6 h-6" />
              <h3 className="text-xl font-bold text-slate-900">组队行为评估</h3>
            </div>
            <BehaviorRadar data={result.behaviors} />
            <div className="grid grid-cols-2 gap-3 mt-6">
              {(Object.entries(result.behaviors) as [string, BehaviorMetric][]).map(([key, metric]) => {
                const config = LEVEL_CONFIG[metric.level] || LEVEL_CONFIG.Grey;
                return (
                  <div key={key} className={`p-3 rounded-xl border flex items-center justify-between ${config.style} bg-opacity-40`}>
                    <div>
                        <p className="text-[9px] font-black text-slate-500 mb-0.5 uppercase tracking-tighter">{BEHAVIOR_LABELS[key]}</p>
                        <p className="text-sm font-black text-slate-900">{config.label}</p>
                    </div>
                    <config.Icon className={`w-5 h-5 ${config.iconColor}`} />
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* 2. 详细评估证据 */}
        <div className="space-y-6">
           <div className="flex items-center space-x-2 px-2">
             <CheckSquare className="text-indigo-600 w-6 h-6" />
             <h2 className="text-2xl font-bold text-slate-900">具体分析</h2>
           </div>
           <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              {(Object.entries(result.behaviors) as [string, BehaviorMetric][]).map(([key, metric]) => (
                <div key={key} className="bg-white rounded-3xl shadow-sm border border-slate-200 overflow-hidden flex flex-col">
                  <div className={`px-6 py-4 border-b flex items-center justify-between ${(LEVEL_CONFIG[metric.level] || LEVEL_CONFIG.Grey).style} bg-opacity-20`}>
                    <h4 className="font-black text-slate-900 text-lg uppercase tracking-tight">{BEHAVIOR_LABELS[key]}</h4>
                    <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${(LEVEL_CONFIG[metric.level] || LEVEL_CONFIG.Grey).style}`}>
                      {(LEVEL_CONFIG[metric.level] || LEVEL_CONFIG.Grey).label}
                    </span>
                  </div>
                  <div className="p-6 flex-grow flex flex-col">
                    <p className="text-slate-700 mb-6 font-medium leading-relaxed bg-slate-50 p-4 rounded-2xl border border-slate-100 text-sm italic">
                      {replaceNamesInText(metric.summary)}
                    </p>
                    <div className="mt-auto space-y-3">
                      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">举例</p>
                      {metric.evidence.map((ev, i) => (
                        <div key={i} className="flex items-start space-x-3 text-sm text-slate-700 bg-white p-3 rounded-xl border border-slate-100 italic shadow-sm">
                          <Quote className="w-4 h-4 text-indigo-200 mt-1 flex-shrink-0" />
                          <p>{replaceNamesInText(cleanEvidence(ev))}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
           </div>
        </div>

        {/* 3. 给领导者的建议 */}
        <div className="bg-white rounded-3xl shadow-sm border border-slate-200 p-8">
          <div className="flex items-center space-x-2 mb-10 border-b border-slate-100 pb-4">
             <Sparkles className="text-orange-500 w-6 h-6" />
             <h2 className="text-2xl font-bold text-slate-900">给领导者的建议</h2>
          </div>
          {result.leaderAdvice ? (
            <div className="space-y-6">
              {/* 建议正文 */}
              <div className="p-6 bg-slate-50 rounded-2xl border border-slate-100">
                <p className="text-base text-slate-700 leading-relaxed whitespace-pre-line">{replaceNamesInText(result.leaderAdvice.advice)}</p>
              </div>
              {/* 为什么给出这个建议 */}
              {result.leaderAdvice.reasoning && (
                <div className="p-4 bg-orange-50/50 rounded-xl border border-orange-100">
                  <p className="text-[10px] font-black text-orange-600 uppercase tracking-widest mb-2 flex items-center">
                     <Info className="w-3 h-3 mr-1" /> 为什么给出这个建议
                  </p>
                  <p className="text-sm text-slate-600 leading-relaxed">{replaceNamesInText(result.leaderAdvice.reasoning)}</p>
                </div>
              )}
            </div>
          ) : (
            <p className="text-slate-400 text-sm">暂无建议</p>
          )}
        </div>
      </div>
    </div>
  );
};

export default AnalysisDashboard;
