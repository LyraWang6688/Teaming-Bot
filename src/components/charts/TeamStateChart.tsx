'use client';

import React from 'react';
import { ScatterChart, XAxis, YAxis, ResponsiveContainer, ReferenceArea, ReferenceLine } from 'recharts';
import { TeamState } from '@/types';
import { ZONE_CONFIG } from '@/utils';

interface TeamStateChartProps {
  data: TeamState;
}

const TeamStateChart: React.FC<TeamStateChartProps> = ({ data }) => {
  const currentZone = data.zone;

  return (
    <div className="w-full h-96 relative pt-6 pb-12 px-12">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
          <XAxis type="number" dataKey="x" domain={[0, 10]} hide />
          <YAxis type="number" dataKey="y" domain={[0, 10]} hide />

          {/* Quadrant Backgrounds with active highlighting */}
          <ReferenceArea
            x1={0} x2={5} y1={0} y2={5}
            fill={ZONE_CONFIG.Apathy.chartFill}
            fillOpacity={currentZone === 'Apathy' ? 1.0 : 0.3}
            stroke={currentZone === 'Apathy' ? "#64748b" : "transparent"}
            strokeDasharray="3 3"
          />
          <ReferenceArea
            x1={5} x2={10} y1={0} y2={5}
            fill={ZONE_CONFIG.Comfort.chartFill}
            fillOpacity={currentZone === 'Comfort' ? 1.0 : 0.3}
            stroke={currentZone === 'Comfort' ? "#3b82f6" : "transparent"}
            strokeDasharray="3 3"
          />
          <ReferenceArea
            x1={0} x2={5} y1={5} y2={10}
            fill={ZONE_CONFIG.Anxiety.chartFill}
            fillOpacity={currentZone === 'Anxiety' ? 1.0 : 0.3}
            stroke={currentZone === 'Anxiety' ? "#ef4444" : "transparent"}
            strokeDasharray="3 3"
          />
          <ReferenceArea
            x1={5} x2={10} y1={5} y2={10}
            fill={ZONE_CONFIG.Learning.chartFill}
            fillOpacity={currentZone === 'Learning' ? 1.0 : 0.3}
            stroke={currentZone === 'Learning' ? "#10b981" : "transparent"}
            strokeDasharray="3 3"
          />

          {/* Main Axis Lines */}
          <ReferenceLine x={5} stroke="#cbd5e1" strokeWidth={2} />
          <ReferenceLine y={5} stroke="#cbd5e1" strokeWidth={2} />
        </ScatterChart>
      </ResponsiveContainer>

      {/* Axis Labels */}
      <div className="absolute top-0 left-1/2 -translate-x-1/2 text-[11px] font-black text-slate-500 uppercase tracking-widest">工作标准高</div>
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-[11px] font-black text-slate-500 uppercase tracking-widest">工作标准低</div>
      <div className="absolute top-1/2 left-0 -translate-y-1/2 -rotate-90 text-[11px] font-black text-slate-500 uppercase tracking-widest">心理安全感低</div>
      <div className="absolute top-1/2 right-0 -translate-y-1/2 rotate-90 text-[11px] font-black text-slate-500 uppercase tracking-widest">心理安全感高</div>

      {/* Quadrant Names */}
      <div className={`absolute top-[20%] left-[25%] -translate-x-1/2 text-center pointer-events-none transition-all duration-500 ${currentZone === 'Anxiety' ? 'opacity-100 scale-150' : 'opacity-40'}`}>
        <div className={`font-black uppercase tracking-tighter ${currentZone === 'Anxiety' ? 'text-lg text-red-900' : 'text-[12px] text-red-800'}`}>焦虑区</div>
      </div>
      <div className={`absolute top-[20%] right-[25%] translate-x-1/2 text-center pointer-events-none transition-all duration-500 ${currentZone === 'Learning' ? 'opacity-100 scale-150' : 'opacity-40'}`}>
        <div className={`font-black uppercase tracking-tighter ${currentZone === 'Learning' ? 'text-lg text-emerald-900' : 'text-[12px] text-emerald-800'}`}>学习区</div>
      </div>
      <div className={`absolute bottom-[25%] left-[25%] -translate-x-1/2 text-center pointer-events-none transition-all duration-500 ${currentZone === 'Apathy' ? 'opacity-100 scale-150' : 'opacity-40'}`}>
        <div className={`font-black uppercase tracking-tighter ${currentZone === 'Apathy' ? 'text-lg text-slate-900' : 'text-[12px] text-slate-700'}`}>冷漠区</div>
      </div>
      <div className={`absolute bottom-[25%] right-[25%] translate-x-1/2 text-center pointer-events-none transition-all duration-500 ${currentZone === 'Comfort' ? 'opacity-100 scale-150' : 'opacity-40'}`}>
        <div className={`font-black uppercase tracking-tighter ${currentZone === 'Comfort' ? 'text-lg text-blue-900' : 'text-[12px] text-blue-800'}`}>舒适区</div>
      </div>
    </div>
  );
};

export default TeamStateChart;
