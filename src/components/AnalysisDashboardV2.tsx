'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, BookOpenCheck, Download, Eye, EyeOff, Lightbulb, Loader2, Quote, Sparkles } from 'lucide-react';
import type { AnalysisResultV2, DimensionAssessmentV2, LeaderAdviceV2, PlayerRoleV2 } from '@/types';
import { ZONE_CONFIG } from '@/utils';
import { buildReportPdf, downloadBlob } from '@/lib/reportPdf';
import TeamStateChart from './charts/TeamStateChart';
import NetworkGraph, { ROLE_VISUAL } from './charts/NetworkGraph';

interface Props {
  result: AnalysisResultV2;
  onReset?: () => void;
  hideControls?: boolean;
  customTitle?: string;
  onReportElement?: (element: HTMLDivElement | null) => void;
}

const ROLE_LABELS: Record<PlayerRoleV2, string> = {
  mover: '推动', follower: '承接', opposer: '挑战', bystander: '观察', silent: '未观察到明显功能',
};
const DIRECTION_LABELS = { higher: '积极信号较充分', lower: '存在明显限制', insufficient: '信息不足' };
const LEADERSHIP_ACTION_LABELS: Record<LeaderAdviceV2['action'], string> = {
  frame_for_learning: '为学习框定情境',
  create_psychological_safety: '营造心理安全',
  learn_from_failure: '从失败中学习',
  cross_boundaries: '跨越边界',
};
const LEADERSHIP_ACTIONS = Object.keys(LEADERSHIP_ACTION_LABELS) as LeaderAdviceV2['action'][];

const PART_ONE_INTRO = '研究表明，提出问题、寻求反馈、讨论错误、开展试验、反思过程以及向团队外部获取信息等团队学习行为，能够促进团队适应并有助于绩效达成。心理安全感降低成员承担人际风险的顾虑，为发声、求助、承认错误、提出不同意见和寻求反馈创造条件；高要求与责任承担则使这些学习行为持续围绕清晰目标、质量标准和结果责任展开，并推动讨论转化为行动与闭环。因此，本报告尝试从这两个维度定位本次会议中的团队学习状态。';
const PART_TWO_INTRO = '团队学习不仅取决于成员说了多少，也取决于观点能否被提出、承接、挑战和重新审视。David Kantor 的互动角色模型将这些互动功能概括为推动、承接、挑战与观察。它们会随着议题和情境动态变化，共同影响团队如何整合不同视角、推进思考与形成行动。';
const PART_THREE_INTRO = '团队学习并不只发生在达成共识的时候，也发生在团队愿意保留问题、检验假设和继续处理不同意见的时候。未完成的重要对话提示团队仍有哪些关键问题需要共同理解；值得被看见的非共识则帮助团队避免过早收敛，并保留可能影响判断与行动的不同视角。';
const PART_FOUR_INTRO = '在 Amy Edmondson 的 Organizing to Learn 框架中，领导者的作用并非替团队提供所有答案，而是为学习创造条件：为学习框定情境、营造心理安全、引导团队从失败与试验中学习，并跨越边界获取所需的信息和资源，从而帮助团队在行动中持续学习和调整。';

export default function AnalysisDashboard({ result, onReset, hideControls = false, customTitle, onReportElement }: Props) {
  const reportRef = useRef<HTMLDivElement>(null);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [pdfError, setPdfError] = useState('');
  const [hideNames, setHideNames] = useState(false);
  const nameMap = useMemo(() => buildNameMap(result), [result]);
  const redact = (text = '') => hideNames ? replaceNames(text, nameMap) : text;
  const nodes = result.dialogueNetwork.nodes.map((node) => ({ ...node, name: redact(node.name) }));
  const edges = result.dialogueNetwork.edges.map((edge) => ({ ...edge, source: redact(edge.source), target: redact(edge.target) }));

  const generatePdf = async () => {
    if (!reportRef.current) return;
    setIsGeneratingPdf(true);
    setPdfError('');
    try {
      const output = await buildReportPdf(reportRef.current, customTitle);
      downloadBlob(output.blob, output.filename);
    } catch (error) {
      setPdfError(error instanceof Error ? error.message : 'PDF 生成失败，请稍后重试');
    } finally {
      setIsGeneratingPdf(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1180px] pb-12">
      {!hideControls && (
        <div className="no-print mb-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2">
            {onReset && <ToolbarButton onClick={onReset} icon={<ArrowLeft />} label="返回报告列表" />}
            <ToolbarButton onClick={() => setHideNames((value) => !value)} icon={hideNames ? <EyeOff /> : <Eye />} label={hideNames ? '显示姓名' : '匿名查看'} />
          </div>
          <div className="flex flex-col items-end gap-1.5">
            <button onClick={generatePdf} disabled={isGeneratingPdf} className="inline-flex items-center gap-2 rounded-xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white shadow-lg transition hover:bg-blue-800 disabled:opacity-60">
              {isGeneratingPdf ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {isGeneratingPdf ? '正在生成…' : '下载 PDF 报告'}
            </button>
            {pdfError && <p role="alert" className="max-w-xs text-right text-xs text-red-600">{pdfError}</p>}
          </div>
        </div>
      )}

      <div
        data-report-root
        ref={(element) => {
          reportRef.current = element;
          onReportElement?.(element);
        }}
        className="space-y-4 rounded-[22px] border border-slate-200 bg-[#edf3f8] p-3 shadow-xl md:p-4"
      >
        <ReportPage page="01">
          <Opening result={result} />
          <PartHeading number="01" title="团队学习是否正在发生？" intro={PART_ONE_INTRO} />
          <div className="grid items-stretch gap-4 lg:grid-cols-2">
            <Panel className="p-4"><TeamStateChart data={result.teamState} /></Panel>
            <Panel className="bg-blue-50/70 p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[11px] font-bold tracking-[0.12em] text-blue-700">整体区域判断</span>
                <span className={`rounded-full px-3 py-1 text-sm font-bold ${ZONE_CONFIG[result.teamState.zone]?.style || 'bg-slate-100 text-slate-700'}`}>
                  {result.teamState.zone === 'Difficult to Judge' ? '本次暂不定位' : result.teamState.zoneLabel}
                </span>
              </div>
              <p className="mt-3 text-sm leading-7 text-slate-700">{redact(result.teamState.analysis)}</p>
            </Panel>
          </div>
          <div className="mt-4 grid items-stretch gap-4 lg:grid-cols-2">
            <DimensionCard title="心理安全感" dimension={result.teamState.psychologicalSafety} redact={redact} />
            <DimensionCard title="高要求与责任承担" dimension={result.teamState.accountability} redact={redact} />
          </div>
          {result.crossBoundaryLearning && (
            <Panel className="mt-4 border-violet-200 bg-violet-50/70 p-5">
              <p className="text-xs font-bold text-violet-800">跨边界学习</p>
              <p className="mt-2 text-sm leading-7 text-slate-700">{redact(result.crossBoundaryLearning.summary)}</p>
              {result.crossBoundaryLearning.evidence && <QuoteBox text={redact(result.crossBoundaryLearning.evidence)} />}
            </Panel>
          )}
          <Panel className="mt-4 border-amber-200 bg-amber-50 p-5">
            <div className="flex items-center gap-2 text-sm font-bold text-amber-900"><Lightbulb className="h-4 w-4" />最值得抓住的团队学习契机</div>
            <p className="mt-2 text-sm leading-7 text-amber-950/80">{redact(result.teamState.learningOpportunity)}</p>
          </Panel>
        </ReportPage>

        <ReportPage page="02" footer="互动功能描述的是本次会议中发挥的作用，而不是固定人格标签">
          <PartHeading number="02" title="团队是怎样互动的？" intro={PART_TWO_INTRO} />
          <div className="grid items-start gap-4 lg:grid-cols-[0.92fr_1.08fr]">
            <Panel className="p-4"><p className="mb-2 text-sm font-bold text-slate-900">语义互动网络</p><NetworkGraph nodes={nodes} edges={edges} /></Panel>
            <div className="space-y-4">
              <TextPanel title="互动结构" text={redact(result.dialogueNetwork.analysis)} tone="blue" />
              <TextPanel title="值得领导者留意" text={redact(result.dialogueNetwork.noteworthyPattern)} tone="purple" />
            </div>
          </div>
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            {result.dialogueNetwork.nodes.map((node) => <ParticipantCard key={node.name} node={node} redact={redact} />)}
          </div>
        </ReportPage>

        <ReportPage page="03">
          <PartHeading number="03" title="哪些对话尚未完成？哪些非共识值得被看见？" intro={PART_THREE_INTRO} />
          <div className="grid gap-4 lg:grid-cols-2">
            <DialogueColumn
              title="未完形的对话"
              empty="本次会议没有发现需要特别跟进的关键未完形对话。"
              items={result.unfinishedDialogues.map((item) => ({
                title: item.topic,
                fields: [
                  ['对话走到了哪里', item.conversationSoFar || item.whyUnfinished || ''],
                  ['尚未完成的是', item.whatRemains || item.whyNeedsClosure || ''],
                ],
              }))}
              redact={redact}
            />
            <DialogueColumn
              title="值得被看见的非共识"
              empty="本次会议未发现需要单独提示的关键非共识。"
              items={result.unseenDisagreements.map((item) => ({
                title: item.topic,
                fields: [
                  ['不同关注', item.differentConcerns || item.whatEachSideSays || ''],
                  ['背后的共同目标', item.sharedGoal || ''],
                  ['为什么值得被看见', item.whyItMatters],
                ],
              }))}
              redact={redact}
            />
          </div>

          <div className="mt-7 border-t border-slate-200 pt-6">
            <PartHeading number="04" title="领导者可以做什么？" intro={PART_FOUR_INTRO} />
            <div className="mb-4 flex flex-wrap gap-2">
              {LEADERSHIP_ACTIONS.map((action) => {
                const active = result.leaderAdvice.some((advice) => advice.action === action);
                return <span key={action} className={`rounded-full border px-3 py-1.5 text-[11px] font-semibold ${active ? 'border-blue-700 bg-blue-700 text-white' : 'border-slate-200 bg-white text-slate-500'}`}>{LEADERSHIP_ACTION_LABELS[action]}</span>;
              })}
            </div>
            <div className="space-y-4">
              {result.leaderAdvice.length ? result.leaderAdvice.map((advice, index) => <AdviceCard key={`${advice.action}-${index}`} advice={advice} redact={redact} />) : <EmptyState text="本次会议尚不足以支撑一条可靠的领导行动建议。" />}
            </div>
          </div>
        </ReportPage>
      </div>
    </div>
  );
}

function Opening({ result }: { result: AnalysisResultV2 }) {
  return (
    <header className="border-b border-slate-200 pb-4">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-700"><Sparkles className="h-3.5 w-3.5" />组队会议分析</div>
          <h1 className="mt-3 text-3xl font-bold tracking-[-0.035em] text-slate-950 md:text-[36px] md:leading-[1.1]">本次会议的团队学习状态评估与建议报告</h1>
          <p className="mt-3 max-w-5xl text-xs leading-6 text-slate-600">本报告参考 Amy Edmondson 的团队学习、Teaming 与心理安全理论，以及 David Kantor 的互动角色模型，从团队学习状态、互动功能、重要的未完成对话和领导行动四个方面观察本次会议。</p>
        </div>
        <BookOpenCheck className="hidden h-10 w-10 shrink-0 text-blue-200 md:block" />
      </div>
      <div className="mt-4 flex flex-wrap gap-2 text-xs">
        <span className="rounded-full bg-slate-950 px-3 py-1.5 font-semibold text-white">{result.metadata.meetingType}</span>
        {result.metadata.participantCount && <MetaPill>{result.metadata.participantCount} 人</MetaPill>}
        {result.metadata.meetingStartedAt && <MetaPill>{result.metadata.meetingStartedAt}</MetaPill>}
        {result.metadata.durationLabel && <MetaPill>{result.metadata.durationLabel}</MetaPill>}
      </div>
      {result.metadata.analysisMode === 'basic_fallback' && (
        <div className="mt-4 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-xs leading-6 text-amber-950"><strong>当前为基础事实版。</strong> 模型服务未完成核心分析，建议稍后重新分析；现有内容不应被视为正式团队诊断。</div>
      )}
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <MetaCard label="AI 对会议的理解" text={result.metadata.contextSummary} />
        <MetaCard label="AI 对本次会议预期产出的理解" text={result.metadata.meetingPurpose} />
      </div>
    </header>
  );
}

function ReportPage({ page, footer = '组队会议分析 · 让团队看见如何一起学习', children }: { page: string; footer?: string; children: ReactNode }) {
  return (
    <section data-pdf-page className="mx-auto w-full max-w-[1080px] rounded-xl border border-slate-200 bg-white px-5 py-5 shadow-[0_18px_48px_rgba(15,23,42,0.08)] md:px-7 md:py-6">
      {children}
      <footer className="mt-6 flex items-center justify-between border-t border-slate-200 pt-3 text-[10px] text-slate-400"><span>{footer}</span><span>{page}</span></footer>
    </section>
  );
}

function PartHeading({ number, title, intro }: { number: string; title: string; intro: string }) {
  return (
    <div className="mb-4 mt-5 flex items-start gap-3">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-slate-950 text-xs font-bold text-white">{number}</span>
      <div><h2 className="text-xl font-bold tracking-tight text-slate-950 md:text-2xl">{title}</h2><p className="mt-1.5 max-w-5xl text-xs leading-6 text-slate-600">{intro}</p></div>
    </div>
  );
}

function DimensionCard({ title, dimension, redact }: { title: string; dimension: DimensionAssessmentV2; redact: (text: string) => string }) {
  const tone = dimension.direction === 'higher' ? 'border-emerald-200 bg-emerald-50/55' : dimension.direction === 'lower' ? 'border-rose-200 bg-rose-50/55' : 'border-slate-200 bg-slate-50';
  return (
    <Panel className={`p-5 ${tone}`}>
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-bold text-slate-900">{title}</h3><span className="rounded-full bg-white/85 px-2.5 py-1 text-[10px] font-semibold text-slate-600">{DIRECTION_LABELS[dimension.direction]}</span></div>
      <p className="mt-2 text-sm leading-7 text-slate-700">{redact(dimension.summary)}</p>
      {dimension.evidence.map((item, index) => <QuoteBox key={index} text={redact(item)} />)}
      {dimension.limitation && <p className="mt-3 text-[11px] leading-5 text-slate-500">{redact(dimension.limitation)}</p>}
    </Panel>
  );
}

function ParticipantCard({ node, redact }: { node: AnalysisResultV2['dialogueNetwork']['nodes'][number]; redact: (text: string) => string }) {
  const role = ROLE_VISUAL[node.playerRole];
  return (
    <article className="rounded-xl border bg-white p-5" style={{ borderColor: role.stroke }}>
      <div className="flex flex-wrap items-start gap-2">
        <strong className="text-base text-slate-950">{redact(node.name)}</strong>
        <span className="rounded-full px-2.5 py-1 text-[10px] font-bold" style={{ color: role.stroke, background: role.soft }}>主要发挥：{ROLE_LABELS[node.playerRole]}</span>
        <span className="ml-auto rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-semibold text-slate-600">发言占比：{Math.round(node.speakingShare || 0)}%</span>
      </div>
      <p className="mt-3 text-sm leading-7 text-slate-600">{redact(node.playerReason)}</p>
      {node.evidence?.slice(0, 1).map((item, index) => <div key={index} className="mt-3"><p className="mb-1 text-[10px] font-bold text-slate-400">代表性片段</p><QuoteBox text={redact(item)} /></div>)}
    </article>
  );
}

function DialogueColumn({ title, empty, items, redact }: { title: string; empty: string; items: { title: string; fields: [string, string][] }[]; redact: (text: string) => string }) {
  return (
    <div>
      <h3 className="mb-3 text-base font-bold text-slate-900">{title}</h3>
      <div className="space-y-3">
        {items.length ? items.map((item, index) => (
          <article key={`${item.title}-${index}`} className="rounded-xl border border-slate-200 bg-slate-50/70 p-5">
            <div className="flex items-center gap-3"><span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white text-xs font-bold text-blue-700 shadow-sm">{index + 1}</span><h4 className="font-bold leading-6 text-slate-900">{redact(item.title)}</h4></div>
            <div className="mt-3 space-y-3">{item.fields.filter(([, text]) => text).map(([label, text]) => <div key={label}><p className="text-[10px] font-bold tracking-wide text-blue-700">{label}</p><p className="mt-1 text-sm leading-7 text-slate-600">{redact(text)}</p></div>)}</div>
          </article>
        )) : <EmptyState text={empty} />}
      </div>
    </div>
  );
}

function AdviceCard({ advice, redact }: { advice: LeaderAdviceV2; redact: (text: string) => string }) {
  return (
    <article className="overflow-hidden rounded-xl border border-blue-200 bg-blue-50/70 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2"><span className="rounded-full bg-blue-700 px-3 py-1 text-[10px] font-bold text-white">本次最优先建议</span><span className="text-[11px] font-semibold text-blue-800">对应：{LEADERSHIP_ACTION_LABELS[advice.action]}</span></div>
      <Field label="建议做什么" text={redact(advice.advice)} emphasize />
      {advice.optionalScript && <Field label="可以怎么说" text={`“${redact(advice.optionalScript.replace(/^[“”\"]+|[“”\"]+$/g, ''))}”`} quote />}
      <div className="mt-4 grid gap-3 md:grid-cols-3"><MiniCard label="为什么推荐" text={redact(advice.reasoning)} /><MiniCard label="什么时候做" text={redact(advice.timing || '在相关议题再次进入讨论时')} /><MiniCard label="如何验收" text={redact(advice.signalToWatch || '观察新的信息是否进入并改变共同判断')} /></div>
    </article>
  );
}

function Field({ label, text, emphasize = false, quote = false }: { label: string; text: string; emphasize?: boolean; quote?: boolean }) {
  return <div className="mt-4"><p className="text-[10px] font-bold tracking-wide text-blue-700">{label}</p><p className={`mt-1.5 leading-7 ${emphasize ? 'text-base font-semibold text-slate-900' : 'text-sm text-slate-700'} ${quote ? 'rounded-lg border-l-4 border-blue-600 bg-white px-4 py-3' : ''}`}>{text}</p></div>;
}

function TextPanel({ title, text, tone }: { title: string; text: string; tone: 'blue' | 'purple' }) {
  return <Panel className={`p-5 ${tone === 'blue' ? 'border-blue-200 bg-blue-50/70' : 'border-purple-200 bg-purple-50/70'}`}><p className={`text-sm font-bold ${tone === 'blue' ? 'text-blue-900' : 'text-purple-900'}`}>{title}</p><p className="mt-2 text-sm leading-7 text-slate-700">{text}</p></Panel>;
}

function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-slate-200 bg-white ${className}`}>{children}</div>;
}

function QuoteBox({ text }: { text: string }) {
  return <div className="mt-3 flex gap-2 rounded-lg bg-white/85 px-3 py-2 text-[11px] leading-5 text-slate-600"><Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-500" />{text}</div>;
}

function MetaPill({ children }: { children: ReactNode }) {
  return <span className="rounded-full border border-slate-200 bg-white px-3 py-1.5 text-slate-600">{children}</span>;
}

function MetaCard({ label, text }: { label: string; text: string }) {
  return <div className="rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3"><p className="text-[10px] font-bold tracking-wide text-slate-400">{label}</p><p className="mt-1 text-xs leading-6 text-slate-700">{text}</p></div>;
}

function MiniCard({ label, text }: { label: string; text: string }) {
  return <div className="rounded-lg bg-white/90 p-4"><p className="text-[10px] font-bold text-blue-700">{label}</p><p className="mt-1.5 text-xs leading-6 text-slate-600">{text}</p></div>;
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-5 py-8 text-center text-sm leading-7 text-slate-500">{text}</div>;
}

function ToolbarButton({ onClick, icon, label }: { onClick: () => void; icon: ReactNode; label: string }) {
  return <button onClick={onClick} className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-600 shadow-sm transition hover:bg-slate-50 [&_svg]:h-4 [&_svg]:w-4">{icon}{label}</button>;
}

function buildNameMap(result: AnalysisResultV2) {
  const names = new Set<string>([...result.communication.map((item) => item.name), ...result.dialogueNetwork.nodes.map((item) => item.name)]);
  const map = new Map<string, string>();
  [...names].filter(Boolean).sort((a, b) => b.length - a.length).forEach((name, index) => map.set(name, String.fromCharCode(65 + (index % 26)) + (index >= 26 ? Math.floor(index / 26) + 1 : '')));
  return map;
}

function replaceNames(text: string, mapping: Map<string, string>) {
  let value = text;
  mapping.forEach((alias, name) => { value = value.replace(new RegExp(escapeRegex(name), 'g'), alias); });
  return value;
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
