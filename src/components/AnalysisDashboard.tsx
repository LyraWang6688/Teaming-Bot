'use client';

import React, { useMemo, useRef, useState } from 'react';
import { jsPDF } from 'jspdf';
import {
  ArrowLeft,
  Download,
  Eye,
  EyeOff,
  HelpCircle,
  Info,
  Loader2,
  Shield,
  Sparkles,
  Users,
} from 'lucide-react';
import { toJpeg } from 'html-to-image';

import { logClientMonitor, toClientErrorContext } from '@/lib/platform/clientMonitor';
import { AnalysisResult } from '@/types';
import { ZONE_CONFIG } from '@/utils';

import NetworkGraph from './charts/NetworkGraph';
import TeamStateChart from './charts/TeamStateChart';

interface AnalysisDashboardProps {
  result: AnalysisResult;
  onReset?: () => void;
  hideControls?: boolean;
  customTitle?: string;
}

function extractNamesFromText(text: string): string[] {
  const names: string[] = [];
  const chineseSurnames = '王李张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段雷钱汤尹黎葛薛庞'.split('');
  const chineseNamePattern = new RegExp(`[${chineseSurnames.join('')}][\\u4e00-\\u9fa5]{1,2}`, 'g');
  const chineseNames = text.match(chineseNamePattern) || [];
  names.push(...chineseNames);

  const englishNamePattern = /\b[A-Z][a-z]{1,19}\b/g;
  const englishNames = text.match(englishNamePattern) || [];
  const nonPersonWords = ['The', 'This', 'That', 'What', 'When', 'Where', 'Why', 'How', 'Yes', 'No', 'OK', 'And', 'But', 'Or', 'So', 'Please', 'Thank', 'Sorry', 'Hello', 'Hi', 'Good', 'Bad', 'Best', 'Better', 'Worse', 'Right', 'Left', 'Up', 'Down', 'In', 'On', 'At', 'To', 'From', 'With', 'For', 'Of', 'About', 'As', 'By', 'If', 'Then', 'Now', 'Later', 'Today', 'Tomorrow', 'Yesterday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'First', 'Second', 'Third', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'All', 'Some', 'Many', 'Most', 'Few', 'Any', 'Every', 'Each', 'Both', 'Neither', 'Either', 'Other', 'Another', 'Such', 'Same', 'Different', 'New', 'Old', 'Big', 'Small', 'Large', 'Little', 'Long', 'Short', 'High', 'Low', 'Fast', 'Slow', 'Hard', 'Soft', 'Easy', 'Difficult', 'Important', 'Unimportant', 'Possible', 'Impossible', 'Necessary', 'Unnecessary', 'Tips', 'Own'];
  const filteredEnglishNames = englishNames.filter((name) => !nonPersonWords.includes(name));
  names.push(...filteredEnglishNames);

  return names;
}

const AnalysisDashboard: React.FC<AnalysisDashboardProps> = ({ result, onReset, hideControls = false, customTitle }) => {
  const zoneConfig = ZONE_CONFIG[result.teamState.zone] || ZONE_CONFIG.Apathy;
  const dashboardRef = useRef<HTMLDivElement>(null);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [hideSpeakerNames, setHideSpeakerNames] = useState(false);

  const parseDiagnosisSections = (raw: string) => {
    const sections = {
      zoneReason: '',
      workStandard: '',
      psychSafety: '',
    };

    if (!raw) {
      return sections;
    }

    const pickBracket = (label: string): string => {
      const regex = new RegExp(`【[^】]*${label}[^】]*】([\\s\\S]*?)(?=【[^】]+】|$)`);
      const matched = raw.match(regex);
      return matched ? matched[1].trim() : '';
    };

    let zone = pickBracket('区域判断') || pickBracket('区域');
    let workStandard = pickBracket('工作标准') || pickBracket('标准');
    let psychSafety = pickBracket('心理安全感') || pickBracket('安全感');

    if (!workStandard && !psychSafety) {
      const workStandardIndex = raw.search(/从[^\n。；]{0,5}工作标准[^\n。；]{0,5}来看/);
      const psychSafetyIndex = raw.search(/从[^\n。；]{0,5}心理安全感[^\n。；]{0,5}来看/);

      if (workStandardIndex !== -1) {
        zone = raw.slice(0, workStandardIndex).trim();
        const workStandardStart = workStandardIndex;
        const workStandardEnd = psychSafetyIndex !== -1 && psychSafetyIndex > workStandardIndex
          ? psychSafetyIndex
          : raw.length;

        workStandard = raw
          .slice(workStandardStart, workStandardEnd)
          .replace(/^从[^\n。；]{0,5}工作标准[^\n。；]{0,5}来看[，：:、\s]*/, '')
          .trim();

        if (psychSafetyIndex !== -1 && psychSafetyIndex > workStandardIndex) {
          psychSafety = raw
            .slice(psychSafetyIndex)
            .replace(/^从[^\n。；]{0,5}心理安全感[^\n。；]{0,5}来看[，：:、\s]*/, '')
            .trim();
        }
      }
    }

    if (zone) {
      zone = zone
        .replace(/^[，。\s"「」]+/, '')
        .replace(/^从这场会议来看[，，]?\s*团队目前处于[^，。]+[，。]/, '')
        .replace(/^团队目前处于[^，。]+[，。]/, '')
        .replace(/^[，。\s]+/, '')
        .trim();
    }

    sections.zoneReason = zone;
    sections.workStandard = workStandard;
    sections.psychSafety = psychSafety;

    return sections;
  };

  const diagnosisSections = parseDiagnosisSections(result.teamState.analysis);

  const speakerNameMapping = useMemo(() => {
    const allSpeakers = new Set<string>();

    result.communication.forEach((participant) => {
      allSpeakers.add(participant.name);
      const namesInText = extractNamesFromText(participant.name);
      namesInText.forEach((name) => {
        if (name !== participant.name) {
          allSpeakers.add(name);
        }
      });
    });

    if (result.leaderAdvice?.reasoning) {
      extractNamesFromText(result.leaderAdvice.reasoning).forEach((name) => allSpeakers.add(name));
    }

    if (result.leaderAdvice?.advice) {
      extractNamesFromText(result.leaderAdvice.advice).forEach((name) => allSpeakers.add(name));
    }

    extractNamesFromText(result.teamState.analysis).forEach((name) => allSpeakers.add(name));

    const nameToLetter = new Map<string, string>();
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    let letterIndex = 0;

    allSpeakers.forEach((name) => {
      if (letterIndex < letters.length) {
        nameToLetter.set(name, letters[letterIndex]);
      } else {
        const letter = letters[Math.floor(letterIndex / 26) % 26];
        const number = Math.floor(letterIndex / 26) + 1;
        nameToLetter.set(name, `${letter}${number}`);
      }
      letterIndex += 1;
    });

    return nameToLetter;
  }, [result]);

  const replaceNamesInText = (text: string): string => {
    if (!hideSpeakerNames) {
      return text;
    }

    let replaced = text;
    speakerNameMapping.forEach((letter, name) => {
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escapedName, 'g');
      replaced = replaced.replace(pattern, letter);
    });

    return replaced;
  };

  const generatePdf = async () => {
    if (!dashboardRef.current) {
      return;
    }

    setIsGeneratingPdf(true);

    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const element = dashboardRef.current;
      const dataUrl = await toJpeg(element, {
        quality: 0.85,
        pixelRatio: 1.5,
        cacheBust: true,
        skipFonts: true,
        style: {
          transform: 'none',
          transformOrigin: 'top left',
        },
        filter: (node) => {
          if (node.tagName === 'LINK' && (node as HTMLLinkElement).href) {
            const href = (node as HTMLLinkElement).href;
            if (!href.startsWith(window.location.origin)) {
              return false;
            }
          }
          return true;
        },
      });

      const pdfWidth = 210;
      const img = new Image();

      await new Promise<void>((resolve, reject) => {
        img.onload = () => {
          try {
            const pdfHeight = (img.height * pdfWidth) / img.width;
            const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: [pdfWidth, pdfHeight] });
            pdf.addImage(dataUrl, 'JPEG', 0, 0, pdfWidth, pdfHeight, undefined, 'FAST');
            const safeTimestamp = result.reportTimestamp.replace(/[:-\s]/g, '_');
            pdf.save(`报告-${(customTitle || '未命名').replace(/\s+/g, '_')}-${safeTimestamp}.pdf`);
            resolve();
          } catch (error) {
            reject(error);
          }
        };

        img.onerror = () => reject(new Error('Failed to load image for PDF generation'));
        img.src = dataUrl;
      });
    } catch (error) {
      logClientMonitor('error', 'analysis_dashboard', 'pdf_generation_failed', toClientErrorContext(error));
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  const teamState = result.teamState;
  const metadata = result.metadata;

  return (
    <div className="mx-auto w-full max-w-5xl animate-fade-in pb-10">
      {!hideControls && (
        <div className="mb-6 flex items-center justify-between no-print">
          <div className="flex items-center space-x-3">
            {onReset && (
              <button
                onClick={onReset}
                className="flex items-center space-x-2 rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 transition-all hover:bg-slate-50"
              >
                <ArrowLeft className="h-4 w-4" />
                <span>返回</span>
              </button>
            )}
            <button
              onClick={() => setHideSpeakerNames(!hideSpeakerNames)}
              className={`flex items-center space-x-2 rounded-lg border px-4 py-2 text-sm font-medium transition-all ${
                hideSpeakerNames
                  ? 'border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {hideSpeakerNames ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              <span>{hideSpeakerNames ? '显示姓名' : '隐藏姓名'}</span>
            </button>
          </div>
          <button
            onClick={generatePdf}
            disabled={isGeneratingPdf}
            className="flex items-center space-x-2 rounded-lg bg-blue-900 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-blue-800"
          >
            {isGeneratingPdf ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            <span>导出 PDF</span>
          </button>
        </div>
      )}

      <div ref={dashboardRef} className="space-y-6 rounded-xl border border-slate-200 bg-white p-6 shadow-sm md:p-10">
        <div className="border-b border-slate-100 pb-8">
          <div className="mb-5 flex items-start justify-between">
            <div>
              <h1 className="text-3xl font-bold tracking-tight text-slate-900">Teaming 视角下的会议动力分析报告</h1>
              <p className="mt-2 max-w-3xl text-sm leading-relaxed text-slate-500">
                本报告基于包括 Amy Edmondson 的 Teaming 等在内的团队动力理论，从团队整体状态、发言互动模式、未完形的对话、非共识等角度，帮助领导者看见会议现场呈现的团队动力，并且提出行动建议。
              </p>
              <div className="mt-3 flex items-center space-x-3">
                <span className="rounded border border-blue-100 bg-blue-50 px-2.5 py-0.5 text-base font-semibold text-blue-700">
                  {metadata.meetingType}
                </span>
                <span className="text-base text-slate-400">{result.reportTimestamp}</span>
              </div>
            </div>
            <Sparkles className="h-8 w-8 text-blue-900 opacity-20" />
          </div>
        </div>

        <div className="border-t border-slate-100 pt-6">
          <div className="mb-2 flex items-center space-x-2">
            <Shield className="h-5 w-5 text-blue-700" />
            <h2 className="text-xl font-bold text-slate-900">第一部分：从这场会议来看，团队整体状态如何？</h2>
          </div>
          <p className="mb-4 ml-7 text-sm leading-relaxed text-slate-400">
            下图呈现团队在心理安全感与工作标准两个维度上的位置。横轴是团队对工作质量的要求，纵轴是成员敢不敢说出真实想法。
          </p>

          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="flex items-center justify-center rounded-lg border border-slate-100 bg-slate-50 p-4">
              <TeamStateChart data={teamState} />
            </div>

            <div className="space-y-4 rounded-lg border border-slate-100 bg-slate-50 p-5">
              <p className="text-xs font-bold uppercase tracking-widest text-slate-500">状态解读</p>

              <div>
                <span className="inline-block rounded-md bg-blue-600 px-3 py-1 text-sm font-bold text-white">
                  从这场会议来看，团队目前处于{zoneConfig.label}
                </span>
              </div>

              {diagnosisSections.workStandard && (
                <div className="border-t border-slate-200 pt-4">
                  <div className="mb-2">
                    <span className="inline-block rounded-md bg-blue-600 px-3 py-1 text-sm font-bold text-white">
                      从工作标准来看
                    </span>
                  </div>
                  <p className="text-base leading-relaxed text-slate-700">
                    {replaceNamesInText(diagnosisSections.workStandard).replace(/^从工作标准来看[，,：:]\s*/, '')}
                  </p>
                </div>
              )}

              {diagnosisSections.psychSafety && (
                <div className="border-t border-slate-200 pt-4">
                  <div className="mb-2">
                    <span className="inline-block rounded-md bg-blue-600 px-3 py-1 text-sm font-bold text-white">
                      从心理安全感来看
                    </span>
                  </div>
                  <p className="text-base leading-relaxed text-slate-700">
                    {replaceNamesInText(diagnosisSections.psychSafety).replace(/^从心理安全感来看[，,：:]\s*/, '')}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {result.dialogueNetwork && result.dialogueNetwork.nodes.length > 0 && (
          <div className="border-t border-slate-100 pt-6">
            <div className="mb-2 flex items-center space-x-2">
              <Users className="h-5 w-5 text-red-600" />
              <h2 className="text-xl font-bold text-slate-900">第二部分：团队是如何互动的？</h2>
            </div>
            <p className="mb-4 ml-7 text-sm leading-relaxed text-slate-400">
              下图呈现谁在发言、谁和谁互动、各自扮演什么角色。百分比数字代表发言占比，连线越粗代表互动越频繁。
            </p>

            <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
              <div className="rounded-lg border border-slate-100 bg-slate-50 p-4 pb-3">
                <NetworkGraph
                  nodes={result.dialogueNetwork.nodes.map((node) => ({
                    ...node,
                    name: hideSpeakerNames ? (speakerNameMapping.get(node.name) || node.name) : node.name,
                  }))}
                  edges={result.dialogueNetwork.edges.map((edge) => ({
                    ...edge,
                    source: hideSpeakerNames ? (speakerNameMapping.get(edge.source) || edge.source) : edge.source,
                    target: hideSpeakerNames ? (speakerNameMapping.get(edge.target) || edge.target) : edge.target,
                  }))}
                />
              </div>

              <div className="min-h-[200px] rounded-lg border border-slate-200 bg-slate-50 p-5">
                <p className="mb-3 text-xs font-bold uppercase tracking-widest text-slate-500">互动解读</p>
                <div className="space-y-3 text-base leading-relaxed text-slate-700">
                  {result.dialogueNetwork.analysis ? (
                    <p>{replaceNamesInText(result.dialogueNetwork.analysis).replace(/[。！？\s]+$/, '') + '。'}</p>
                  ) : (
                    <p className="text-slate-400">暂无互动分析数据</p>
                  )}
                  {result.dialogueNetwork.riskAssessment && (
                    <div>
                      <span className="mb-2 inline-block rounded bg-red-600 px-2.5 py-0.5 text-sm font-bold text-white">
                        需要注意的是
                      </span>
                      <p className="text-slate-700">
                        {replaceNamesInText(result.dialogueNetwork.riskAssessment).replace(/^[。！？，,\s]+/, '')}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {((result.unfinishedDialogues && result.unfinishedDialogues.length > 0) || (result.unseenDisagreements && result.unseenDisagreements.length > 0)) && (
          <div className="border-t border-slate-100 pt-6">
            <div className="mb-2 flex items-center space-x-2">
              <HelpCircle className="h-5 w-5 text-red-600" />
              <h2 className="text-xl font-bold text-slate-900">第三部分：有哪些对话是没有完形的？有哪些非共识是值得被看见的？</h2>
            </div>
            <p className="mb-4 ml-7 text-sm leading-relaxed text-slate-400">
              有些话题表面上似乎已经达成一致、聊完了，但实际上关键分歧或未决事项还在；有些不同看法藏在表面一致之下。把它们找出来，是下次开会可以切入的地方。
            </p>

            {result.unfinishedDialogues && result.unfinishedDialogues.length > 0 && (
              <div className="mb-6">
                <p className="mb-3 ml-7 flex items-center text-sm font-bold text-slate-700">
                  <span className="mr-2 inline-block h-4 w-1 rounded-full bg-red-500" />
                  看上去聊完了、但实际上没有完形的对话
                </p>
                <div className="space-y-3">
                  {result.unfinishedDialogues.map((item, index) => (
                    <div key={`unfinished-${index}`} className="rounded-lg border border-red-100 bg-red-50/30 p-4">
                      <p className="mb-2 text-base font-semibold text-slate-900">
                        <span className="mr-1 text-red-600">{index + 1}.</span>
                        {replaceNamesInText(item.topic)}
                      </p>
                      <div className="ml-2 space-y-2">
                        <p className="text-sm leading-relaxed text-slate-600">
                          <span className="font-medium text-red-600">为什么说它没有完形：</span>
                          {replaceNamesInText(item.whyUnfinished)}
                        </p>
                        <p className="text-sm leading-relaxed text-slate-600">
                          <span className="font-medium text-red-600">为什么这里的对话需要完形：</span>
                          {replaceNamesInText(item.whyNeedsClosure)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.unseenDisagreements && result.unseenDisagreements.length > 0 && (
              <div>
                <p className="mb-3 ml-7 flex items-center text-sm font-bold text-slate-700">
                  <span className="mr-2 inline-block h-4 w-1 rounded-full bg-red-500" />
                  值得被看见的非共识
                </p>
                <div className="space-y-3">
                  {result.unseenDisagreements.map((item, index) => (
                    <div key={`disagreement-${index}`} className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                      <p className="mb-2 text-base font-semibold text-slate-900">
                        <span className="mr-1 text-red-600">{index + 1}.</span>
                        {replaceNamesInText(item.topic)}
                      </p>
                      <div className="ml-2 space-y-2">
                        <p className="text-sm leading-relaxed text-slate-600">
                          <span className="font-medium text-blue-700">各方的不同看法：</span>
                          {replaceNamesInText(item.whatEachSideSays)}
                        </p>
                        <p className="text-sm leading-relaxed text-slate-600">
                          <span className="font-medium text-blue-700">为什么值得被看见：</span>
                          {replaceNamesInText(item.whyItMatters)}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="border-t border-slate-100 pt-6">
          <div className="mb-2 flex items-center space-x-2">
            <Sparkles className="h-5 w-5 text-blue-700" />
            <h2 className="text-xl font-bold text-slate-900">第四部分：领导者可以做什么？</h2>
          </div>
          <p className="mb-4 ml-7 text-sm leading-relaxed text-slate-400">
            基于对这次会议的观察，给领导者一个行动上的建议。
          </p>

          {result.leaderAdvice ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-slate-100 bg-slate-50 p-5">
                <p className="whitespace-pre-line text-base leading-relaxed text-slate-700">
                  {replaceNamesInText(result.leaderAdvice.advice)}
                </p>
              </div>
              {result.leaderAdvice.reasoning && (
                <div className="rounded-lg border border-blue-100 bg-blue-50/50 p-4">
                  <p className="mb-2 flex items-center text-xs font-bold uppercase tracking-widest text-blue-600">
                    <Info className="mr-1 h-3.5 w-3.5" />
                    为什么给出这个建议
                  </p>
                  <p className="text-base leading-relaxed text-slate-600">
                    {replaceNamesInText(result.leaderAdvice.reasoning)}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <p className="text-base text-slate-400">暂无建议</p>
          )}
        </div>
      </div>
    </div>
  );
};

export default AnalysisDashboard;
