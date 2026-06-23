'use client';

import React from 'react';
import { ScatterChart, Scatter, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Label, ZAxis, Cell } from 'recharts';
import { CommunicationParticipant } from '@/types';
import { CHART_COLORS } from '@/utils';

interface CommunicationBubbleChartProps {
  data: CommunicationParticipant[];
  hideSpeakerNames?: boolean;
  speakerNameMapping?: Map<string, string>;
}

type ChartDataPoint = {
  x: number;
  y: number;
  z: number;
  name: string;
  originalName: string;
  label: string;
  index: number;
  color: string;
};

type CustomTooltipProps = {
  active?: boolean;
  payload?: Array<{
    payload: ChartDataPoint;
  }>;
};

// CustomTooltip 移到组件外部，避免在渲染期间创建组件
const CustomTooltip = ({ active, payload }: CustomTooltipProps) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="bg-white/95 backdrop-blur p-4 border border-slate-200 shadow-2xl rounded-2xl text-[11px] z-50">
        <p className="font-black mb-2 flex items-center" style={{ color: data.color }}>
          <span className="w-2 h-2 rounded-full mr-2" style={{ backgroundColor: data.color }}></span>
          {data.name}
        </p>
        <div className="space-y-1.5">
          <div className="flex justify-between gap-8 border-b border-slate-50 pb-1">
            <span className="text-slate-500 font-bold uppercase tracking-tighter">有效占比</span>
            <span className="font-mono font-black text-slate-900">{data.z}%</span>
          </div>
          <div className="flex justify-between gap-8 border-b border-slate-50 pb-1">
            <span className="text-slate-500 font-bold uppercase tracking-tighter">探询</span>
            <span className="font-mono font-black text-indigo-600">{data.x}/10</span>
          </div>
          <div className="flex justify-between gap-8">
            <span className="text-slate-500 font-bold uppercase tracking-tighter">主张</span>
            <span className="font-mono font-black text-indigo-600">{data.y}/10</span>
          </div>
        </div>
      </div>
    );
  }
  return null;
};

const CommunicationBubbleChart: React.FC<CommunicationBubbleChartProps> = ({ data, hideSpeakerNames = false, speakerNameMapping }) => {
  const sortedData = [...data].sort((a, b) => b.speakingShare - a.speakingShare);

  // 获取显示的发言者名称
  const getDisplaySpeakerName = (speakerName: string) => {
    if (!hideSpeakerNames || !speakerNameMapping) {
      return speakerName;
    }
    return speakerNameMapping.get(speakerName) || speakerName;
  };

  const chartData = sortedData.map((p, index) => ({
    x: p.inquiryScore,
    y: p.advocacyScore,
    z: p.speakingShare,
    name: getDisplaySpeakerName(p.name),
    originalName: p.name,
    label: `${getDisplaySpeakerName(p.name)} ${p.speakingShare}%`,
    index: index,
    color: CHART_COLORS[index % CHART_COLORS.length]
  }));

  const xDomain = [0, 10];
  const yDomain = [0, 10];

  return (
    <div className="flex flex-col lg:flex-row items-stretch gap-8">
      <div className="w-full lg:w-3/4 h-96 relative bg-slate-50/50 rounded-3xl border border-slate-100 p-4">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <ScatterChart margin={{ top: 20, right: 30, bottom: 20, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis type="number" dataKey="x" name="Inquiry" domain={xDomain} tickCount={11} tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 600 }}>
               <Label value="探询" offset={-10} position="insideBottom" style={{ fontSize: '11px', fill: '#64748b', fontWeight: 900, textTransform: 'uppercase' }} />
            </XAxis>
            <YAxis type="number" dataKey="y" name="Advocacy" domain={yDomain} tickCount={11} tick={{ fontSize: 10, fill: '#94a3b8', fontWeight: 600 }}>
               <Label value="主张" position="insideLeft" angle={-90} offset={0} style={{ fontSize: '11px', fill: '#64748b', fontWeight: 900, textTransform: 'uppercase' }} />
            </YAxis>
            <ZAxis type="number" dataKey="z" range={[200, 2500]} name="Speaking Share" />
            <Tooltip content={<CustomTooltip />} cursor={{ strokeDasharray: '3 3' }} />
            <Scatter name="Participants" data={chartData}>
               {chartData.map((entry, index) => (
                 <Cell key={`cell-${index}`} fill={entry.color} fillOpacity={0.6} stroke={entry.color} strokeWidth={3} />
               ))}
            </Scatter>
          </ScatterChart>
        </ResponsiveContainer>
      </div>

      <div className="w-full lg:w-1/4 flex flex-col justify-start space-y-3 p-6 bg-white rounded-3xl border border-slate-200 shadow-sm overflow-y-auto max-h-96">
         <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4 border-b border-slate-100 pb-2">有效参与度排行榜</h4>
         {chartData.map((data, idx) => (
           <div key={idx} className="flex items-center justify-between group">
             <div className="flex items-center space-x-3">
               <span className="w-3 h-3 rounded-full shadow-sm ring-2 ring-white" style={{ backgroundColor: data.color }}></span>
               <div className="flex flex-col">
                  <span className="font-black text-slate-800 text-xs truncate max-w-[100px]">{data.name}</span>
               </div>
             </div>
             <span className="font-mono font-black text-indigo-600 text-sm group-hover:scale-110 transition-transform">{data.z}%</span>
           </div>
         ))}
      </div>
    </div>
  );
};

export default CommunicationBubbleChart;
