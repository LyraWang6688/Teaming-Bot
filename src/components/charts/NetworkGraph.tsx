'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { NetworkEdgeV2, NetworkNodeV2, PlayerRoleV2 } from '@/types';

export const ROLE_VISUAL: Record<PlayerRoleV2, { fill: string; stroke: string; soft: string; label: string; text: string }> = {
  mover: { fill: '#d89f25', stroke: '#a9750d', soft: '#fff5d8', label: '推动', text: '#ffffff' },
  follower: { fill: '#4f86c6', stroke: '#31679f', soft: '#eaf3ff', label: '承接', text: '#ffffff' },
  opposer: { fill: '#d95f52', stroke: '#a63f37', soft: '#fff0ef', label: '挑战', text: '#ffffff' },
  bystander: { fill: '#8765b3', stroke: '#66428f', soft: '#f3edff', label: '观察', text: '#ffffff' },
  silent: { fill: '#cbd5e1', stroke: '#94a3b8', soft: '#f1f5f9', label: '未明显观察到', text: '#334155' },
};
const EDGE = { strong: { width: 4, opacity: 0.85 }, moderate: { width: 2.6, opacity: 0.7 }, light: { width: 1.45, opacity: 0.52 } };

export default function NetworkGraph({ nodes, edges }: { nodes: NetworkNodeV2[]; edges: NetworkEdgeV2[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(620);
  useEffect(() => {
    if (!ref.current) return;
    const resize = () => setWidth(ref.current?.clientWidth || 620);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  const height = width < 440 ? 430 : 470;
  const radii = useMemo(
    () => new Map(nodes.map((node) => [node.name, radiusFor(node.speakingShare || 0, nodes.length, node.name.length)])),
    [nodes],
  );
  const positions = useMemo(() => layout(nodes, edges, width, height, radii), [nodes, edges, width, height, radii]);

  return (
    <figure ref={ref} className="w-full">
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-2 text-[10px] font-semibold text-slate-600">
        {(['mover', 'follower', 'opposer', 'bystander'] as PlayerRoleV2[]).map((role) => (
          <span key={role} className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full" style={{ background: ROLE_VISUAL[role].fill }} />{ROLE_VISUAL[role].label}</span>
        ))}
        {nodes.some((node) => node.playerRole === 'silent') && <span className="inline-flex items-center gap-1.5"><i className="h-2.5 w-2.5 rounded-full bg-slate-300" />未明显观察到</span>}
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label="会议语义互动网络">
        <defs>
          <marker id="meeting-arrow" viewBox="0 0 10 10" refX="8.2" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M 0 0 L 10 5 L 0 10 z" fill="#64748b" /></marker>
        </defs>
        {edges.map((edge, index) => {
          const source = positions.get(edge.source);
          const target = positions.get(edge.target);
          if (!source || !target) return null;
          const trimmed = trimLine(source, target, (radii.get(edge.source) || 28) + 5, (radii.get(edge.target) || 28) + 8);
          const style = EDGE[edge.weight] || EDGE.light;
          const reverse = edges.some((candidate) => candidate.source === edge.target && candidate.target === edge.source);
          const bend = reverse ? (edge.source.localeCompare(edge.target) > 0 ? 15 : -15) : 0;
          const cx = (trimmed.x1 + trimmed.x2) / 2 + bend * (trimmed.y2 - trimmed.y1) / 100;
          const cy = (trimmed.y1 + trimmed.y2) / 2 - bend * (trimmed.x2 - trimmed.x1) / 100;
          const midX = (trimmed.x1 + trimmed.x2 + cx) / 3;
          const midY = (trimmed.y1 + trimmed.y2 + cy) / 3;
          return (
            <g key={`${edge.source}-${edge.target}-${index}`}>
            <path
              d={`M ${trimmed.x1} ${trimmed.y1} Q ${cx} ${cy} ${trimmed.x2} ${trimmed.y2}`}
              fill="none"
              stroke="#64748b"
              strokeWidth={style.width}
              strokeOpacity={style.opacity}
              strokeLinecap="round"
              markerEnd="url(#meeting-arrow)"
            />
            {edge.nature && <text x={midX} y={midY - 5} textAnchor="middle" fill="#64748b" fontSize="9" paintOrder="stroke" stroke="#fff" strokeWidth="4">{shorten(edge.nature, 10)}</text>}
            <title>{edge.source} → {edge.target}：{edge.nature || '直接语义互动'}{edge.count ? `（${edge.count} 次）` : ''}</title>
            </g>
          );
        })}
        {nodes.map((node) => {
          const point = positions.get(node.name);
          if (!point) return null;
          const role = ROLE_VISUAL[node.playerRole];
          const radius = radii.get(node.name) || 28;
          const nameLines = splitName(node.name, radius);
          return (
            <g key={node.name}>
              <circle cx={point.x} cy={point.y} r={radius} fill={role.fill} stroke={role.stroke} strokeWidth="2.2" />
              {nameLines.map((line, index) => (
                <text
                  key={line + index}
                  x={point.x}
                  y={point.y - 8 - ((nameLines.length - 1) * 11) / 2 + index * 11}
                  textAnchor="middle"
                  fill={role.text}
                  fontSize={nameLines.length >= 3 ? 8 : nameLines.length > 1 ? 9 : 10.5}
                  fontWeight="700"
                >
                  {line}
                </text>
              ))}
              <text x={point.x} y={point.y + 9 + ((nameLines.length - 1) * 11) / 2} textAnchor="middle" fill={role.text} fontSize="9.5" fontWeight="700">{Math.round(node.speakingShare || 0)}%</text>
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 grid gap-2 border-t border-slate-200 pt-3 text-[10px] leading-5 text-slate-500 sm:grid-cols-2">
        <p className="flex items-center gap-2"><i className="inline-block h-4 w-4 rounded-full border-2 border-slate-500 bg-white" />圆圈大小：发言占比</p>
        <p className="flex items-center gap-2"><i className="inline-block h-3 w-6 rounded-full bg-gradient-to-r from-amber-400 via-blue-500 to-purple-500" />节点颜色：主要功能</p>
        <p className="flex items-center gap-2"><span className="text-base text-slate-600">→</span>箭头：回应方向</p>
        <p className="flex items-center gap-2"><i className="inline-block h-[3px] w-7 rounded bg-slate-500" />线宽：互动频次</p>
      </figcaption>
    </figure>
  );
}

function radiusFor(share: number, count: number, nameLength: number) {
  const base = count >= 8 ? 23 : 27;
  const shareRadius = Math.min(base + 20, base + Math.sqrt(Math.max(0, share)) * 2.2);
  const nameRadius = Math.min(50, base + Math.max(0, nameLength - 4) * 1.15);
  return Math.max(base, shareRadius, nameRadius);
}

function layout(nodes: NetworkNodeV2[], edges: NetworkEdgeV2[], width: number, height: number, radii: Map<string, number>) {
  const positions = new Map<string, { x: number; y: number }>();
  if (!nodes.length) return positions;
  const degree = new Map(nodes.map((node) => [node.name, 0]));
  edges.forEach((edge) => {
    degree.set(edge.source, (degree.get(edge.source) || 0) + (edge.count || 1));
    degree.set(edge.target, (degree.get(edge.target) || 0) + (edge.count || 1));
  });
  const ordered = [...nodes].sort((a, b) => (degree.get(b.name) || 0) - (degree.get(a.name) || 0));
  const hubCount = nodes.length >= 5 ? 2 : 1;
  const hubs = ordered.slice(0, hubCount);
  const ring = ordered.slice(hubCount);
  const cx = width / 2;
  const cy = height / 2 - 18;
  hubs.forEach((node, index) => positions.set(node.name, hubCount === 1 ? { x: cx, y: cy } : { x: cx + (index ? 62 : -62), y: cy }));
  const largestRadius = Math.max(...nodes.map((node) => radii.get(node.name) || 28));
  const rx = Math.max(105, width / 2 - largestRadius - 22);
  const ry = Math.max(125, height / 2 - largestRadius - 34);
  ring.forEach((node, index) => {
    const angle = (-145 + (ring.length === 1 ? 0 : index * (290 / (ring.length - 1)))) * Math.PI / 180;
    positions.set(node.name, { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
  });
  return positions;
}

function trimLine(source: { x: number; y: number }, target: { x: number; y: number }, sourcePadding: number, targetPadding: number) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.max(1, Math.sqrt(dx * dx + dy * dy));
  const ux = dx / length;
  const uy = dy / length;
  return { x1: source.x + ux * sourcePadding, y1: source.y + uy * sourcePadding, x2: target.x - ux * targetPadding, y2: target.y - uy * targetPadding };
}

function splitName(name: string, radius: number) {
  const preferredWidth = Math.max(4, Math.floor(radius / 4.4));
  if (name.length <= preferredWidth) return [name];
  const lineCount = Math.min(3, Math.ceil(name.length / preferredWidth));
  const charactersPerLine = Math.ceil(name.length / lineCount);
  return Array.from({ length: lineCount }, (_, index) => name.slice(index * charactersPerLine, (index + 1) * charactersPerLine)).filter(Boolean);
}

function shorten(value: string, max: number) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
