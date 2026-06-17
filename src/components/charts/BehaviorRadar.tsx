'use client';

import React from 'react';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer } from 'recharts';
import { TeamBehaviors } from '@/types';
import { BEHAVIOR_LABELS } from '@/utils';

interface BehaviorRadarProps {
  data: TeamBehaviors;
}

// 保证每个维度至少有最小值，避免面积为0或退化成线段

const MIN_VISIBLE = 0.3;

const BehaviorRadar: React.FC<BehaviorRadarProps> = ({ data }) => {

  const chartData = [
    {
      subject: BEHAVIOR_LABELS.speakingUp,
      val: Math.max(data.speakingUp.score, MIN_VISIBLE),
      full: 10,
      high: 7,
      mid: 5,
    },
    {
      subject: BEHAVIOR_LABELS.collaboration,
      val: Math.max(data.collaboration.score, MIN_VISIBLE),
      full: 10,
      high: 7,
      mid: 5,
    },
    {
      subject: BEHAVIOR_LABELS.experimentation,
      val: Math.max(data.experimentation.score, MIN_VISIBLE),
      full: 10,
      high: 7,
      mid: 5,
    },
    {
      subject: BEHAVIOR_LABELS.reflection,
      val: Math.max(data.reflection.score, MIN_VISIBLE),
      full: 10,
      high: 7,
      mid: 5,
    },
  ];

  return (
    <div className="w-full h-80 relative">
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <RadarChart cx="50%" cy="50%" outerRadius="80%" data={chartData}>
          <PolarGrid stroke="#e2e8f0" />
          <PolarAngleAxis
            dataKey="subject"
            tick={{ fill: '#475569', fontSize: 11, fontWeight: 800 } as any}
          />
          <PolarRadiusAxis
            domain={[0, 10]}
            ticks={[5, 7, 10] as any}
            tick={false}
            axisLine={false}
          />

          <Radar
            name="Healthy"
            dataKey="full"
            stroke="transparent"
            fill="#10b981"
            fillOpacity={0.05}
            isAnimationActive={false}
          />

          <Radar
            name="Good"
            dataKey="high"
            stroke="transparent"
            fill="#3b82f6"
            fillOpacity={0.05}
            isAnimationActive={false}
          />

          <Radar
            name="Alert"
            dataKey="mid"
            stroke="transparent"
            fill="#ef4444"
            fillOpacity={0.05}
            isAnimationActive={false}
          />

          <Radar
            name="组队行为"
            dataKey="val"
            stroke="#4f46e5"
            strokeWidth={2.5}
            fill="#6366f1"
            fillOpacity={0.35}
            dot={{ r: 4, fill: '#4f46e5', stroke: '#fff', strokeWidth: 2 }}
            activeDot={{ r: 5, fill: '#4f46e5', stroke: '#fff', strokeWidth: 2 }}
          />
        </RadarChart>
      </ResponsiveContainer>

      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center space-x-4">
        <div className="flex items-center space-x-1">
          <div className="w-2 h-2 rounded-full bg-emerald-500/20 border border-emerald-500/30"></div>
          <span className="text-[9px] font-bold text-slate-400">健康</span>
        </div>
        <div className="flex items-center space-x-1">
          <div className="w-2 h-2 rounded-full bg-blue-500/20 border border-blue-500/30"></div>
          <span className="text-[9px] font-bold text-slate-400">良好</span>
        </div>
        <div className="flex items-center space-x-1">
          <div className="w-2 h-2 rounded-full bg-red-500/20 border border-red-500/30"></div>
          <span className="text-[9px] font-bold text-slate-400">警惕</span>
        </div>
      </div>
    </div>
  );
};

export default BehaviorRadar;
