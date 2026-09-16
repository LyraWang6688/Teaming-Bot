'use client';

import type { TeamStateV2, TeamZoneV2 } from '@/types';

const BASE_POSITION: Record<Exclude<TeamZoneV2, 'Difficult to Judge'>, { x: number; y: number }> = {
  Comfort: { x: 25, y: 25 },
  Learning: { x: 75, y: 25 },
  Apathy: { x: 25, y: 75 },
  Anxiety: { x: 75, y: 75 },
};

export default function TeamStateChart({ data }: { data: TeamStateV2 }) {
  const position = getPosition(data);
  return (
    <figure className="mx-auto w-full max-w-[520px]">
      <div className="grid grid-cols-[42px_1fr] gap-2">
        <div className="relative min-h-0">
          <span className="absolute left-1/2 top-0 -translate-x-1/2 text-[10px] font-bold text-slate-500">高</span>
          <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 [writing-mode:vertical-rl] text-[11px] font-bold tracking-[0.16em] text-slate-600">心理安全感</span>
          <span className="absolute bottom-0 left-1/2 -translate-x-1/2 text-[10px] font-bold text-slate-500">低</span>
        </div>
        <div>
          <div className="relative aspect-[1.18/1] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-inner">
            <div className="absolute inset-0 grid grid-cols-2 grid-rows-2">
              <Quadrant label="舒适区" detail="心理安全较高｜要求较低" className="bg-[#fff8e7] text-amber-900" />
              <Quadrant label="学习区" detail="心理安全较高｜要求较高" className="bg-[#eaf3ff] text-blue-900" />
              <Quadrant label="冷漠区" detail="心理安全较低｜要求较低" className="bg-slate-50 text-slate-600" />
              <Quadrant label="焦虑区" detail="心理安全较低｜要求较高" className="bg-[#fff0ef] text-rose-900" />
            </div>
            <div className="absolute left-1/2 top-0 h-full w-px bg-slate-300" />
            <div className="absolute left-0 top-1/2 h-px w-full bg-slate-300" />
            {position ? (
              <>
                <div className="absolute h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-[4px] border-white bg-blue-700 shadow-[0_0_0_5px_rgba(29,78,216,0.18)]" style={{ left: `${position.x}%`, top: `${position.y}%` }} />
                <span className="absolute -translate-x-1/2 translate-y-4 whitespace-nowrap rounded-full bg-white/95 px-2.5 py-1 text-[10px] font-bold text-blue-800 shadow-sm" style={{ left: `${position.x}%`, top: `${position.y}%` }}>本次定位</span>
              </>
            ) : (
              <div className="absolute left-1/2 top-1/2 w-44 -translate-x-1/2 -translate-y-1/2 rounded-xl border border-dashed border-slate-300 bg-white/95 px-4 py-3 text-center text-sm font-bold text-slate-600 shadow-sm">信息不足，本次暂不定位</div>
            )}
          </div>
          <div className="mt-2 grid grid-cols-[28px_1fr_28px] items-center text-[10px] font-bold text-slate-500">
            <span>低</span><span className="text-center text-[11px] text-slate-600">高要求与责任承担</span><span className="text-right">高</span>
          </div>
        </div>
      </div>
    </figure>
  );
}

function getPosition(data: TeamStateV2) {
  if (data.zone === 'Difficult to Judge') return null;
  const value = { ...BASE_POSITION[data.zone] };
  if (data.psychologicalSafety.direction === 'insufficient') value.y = 50;
  if (data.accountability.direction === 'insufficient') value.x = 50;
  if (data.psychologicalSafety.direction === 'insufficient' || data.accountability.direction === 'insufficient') return value;
  if (data.positionHint === 'near_horizontal_boundary') value.y = data.zone === 'Learning' || data.zone === 'Comfort' ? 43 : 57;
  if (data.positionHint === 'near_vertical_boundary') value.x = data.zone === 'Learning' || data.zone === 'Anxiety' ? 57 : 43;
  return value;
}

function Quadrant({ label, detail, className }: { label: string; detail: string; className: string }) {
  return <div className={`flex flex-col items-center justify-center p-4 text-center ${className}`}><strong className="text-sm sm:text-base">{label}</strong><span className="mt-1 max-w-36 text-[9px] leading-4 opacity-70 sm:text-[10px]">{detail}</span></div>;
}
