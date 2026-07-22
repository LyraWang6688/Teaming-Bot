'use client';

import { useEffect, useRef, useState } from 'react';

import type { NetworkEdge, NetworkNode, PlayerRole } from '@/types';

interface NetworkGraphProps {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
}

const ROLE_CONFIG: Record<PlayerRole, { fill: string; stroke: string; text: string; label: string }> = {
  mover: { fill: '#D4A027', stroke: '#A87D1A', text: 'white', label: '发起者' },
  follower: { fill: '#3D7294', stroke: '#2A5570', text: 'white', label: '跟随者' },
  opposer: { fill: '#C43E22', stroke: '#962E18', text: 'white', label: '反对者' },
  bystander: { fill: '#7A55A2', stroke: '#5C3E80', text: 'white', label: '旁观者' },
  silent: { fill: '#e2e8f0', stroke: '#94a3b8', text: '#475569', label: '无明显参与' },
};

const EDGE_CONFIG = {
  strong: { width: 2.5, color: '#94a3b8', opacity: 0.8 },
  moderate: { width: 1.5, color: '#cbd5e1', opacity: 0.6 },
  light: { width: 1, color: '#e2e8f0', opacity: 0.5 },
};

const NODE_RADIUS = 22;

function getNodeRadius(): number {
  return NODE_RADIUS;
}

function computeStaticLayout(nodes: NetworkNode[], width: number, height: number) {
  const cx = width / 2;
  const cy = height / 2;
  const padding = 60;
  const radius = Math.min(width, height) / 2 - padding;

  const groups: Record<PlayerRole, NetworkNode[]> = {
    mover: [],
    follower: [],
    opposer: [],
    bystander: [],
    silent: [],
  };

  nodes.forEach((node) => groups[node.playerRole]?.push(node));

  const sectorAngles: Record<PlayerRole, [number, number]> = {
    mover: [-90, -90],
    follower: [-50, 40],
    opposer: [-180, -80],
    bystander: [40, 130],
    silent: [130, 220],
  };

  const positions = new Map<string, { x: number; y: number }>();

  const movers = groups.mover;
  movers.forEach((node, index) => {
    if (movers.length === 1) {
      positions.set(node.name, { x: cx, y: cy - radius * 0.05 });
      return;
    }

    const angle = ((index / movers.length) * 360 - 90) * Math.PI / 180;
    const moverRadius = radius * 0.2;
    positions.set(node.name, {
      x: cx + moverRadius * Math.cos(angle),
      y: cy + moverRadius * Math.sin(angle),
    });
  });

  (['follower', 'opposer', 'bystander', 'silent'] as PlayerRole[]).forEach((role) => {
    const members = groups[role];
    if (members.length === 0) {
      return;
    }

    const [startDeg, endDeg] = sectorAngles[role];
    const span = endDeg - startDeg;

    members.forEach((node, index) => {
      const step = members.length > 1 ? span / (members.length + 1) : 0;
      const deg = members.length > 1 ? startDeg + step * (index + 1) : startDeg + span / 2;
      const rad = deg * Math.PI / 180;
      const outerRadius = radius * 0.7;

      positions.set(node.name, {
        x: cx + outerRadius * Math.cos(rad),
        y: cy + outerRadius * Math.sin(rad),
      });
    });
  });

  return positions;
}

export default function NetworkGraph({ nodes, edges }: NetworkGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 500, height: 420 });

  useEffect(() => {
    if (!containerRef.current) {
      return undefined;
    }

    const update = () => {
      const width = containerRef.current?.clientWidth ?? 500;
      setDimensions({ width, height: Math.max(400, Math.min(480, width)) });
    };

    update();

    const observer = new ResizeObserver(update);
    observer.observe(containerRef.current);

    return () => observer.disconnect();
  }, []);

  const { width, height } = dimensions;
  const positions = computeStaticLayout(nodes, width, height);

  return (
    <div ref={containerRef} className="w-full">
      <svg width={width} height={height} className="overflow-visible">
        {edges.map((edge, index) => {
          const source = positions.get(edge.source);
          const target = positions.get(edge.target);
          if (!source || !target) {
            return null;
          }

          const config = EDGE_CONFIG[edge.weight] || EDGE_CONFIG.light;

          return (
            <line
              key={`edge-${index}`}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              stroke={config.color}
              strokeWidth={config.width}
              strokeOpacity={config.opacity}
              strokeLinecap="round"
            />
          );
        })}

        {nodes.map((node) => {
          const position = positions.get(node.name);
          if (!position) {
            return null;
          }

          const config = ROLE_CONFIG[node.playerRole];
          const radius = getNodeRadius();
          const displayName = node.name.length > 4 ? node.name.slice(0, 4) : node.name;
          const shareValue = node.speakingShare != null && !Number.isNaN(node.speakingShare)
            ? Math.round(node.speakingShare)
            : null;
          const shareText = shareValue != null ? `${shareValue}%` : '--%';
          const isRightSide = position.x < width / 2;
          const textX = isRightSide ? position.x + radius + 8 : position.x - radius - 8;
          const textAnchor = isRightSide ? 'start' : 'end';

          return (
            <g key={`node-${node.name}`}>
              <circle
                cx={position.x}
                cy={position.y}
                r={radius}
                fill={config.fill}
                stroke={config.stroke}
                strokeWidth={1.5}
                opacity={node.playerRole === 'silent' ? 0.7 : 0.95}
              />
              <text
                x={position.x}
                y={position.y}
                textAnchor="middle"
                dominantBaseline="middle"
                fill={config.text}
                fontSize={11}
                fontWeight={600}
              >
                {displayName}
              </text>
              <text
                x={textX}
                y={position.y + 4}
                textAnchor={textAnchor}
                dominantBaseline="middle"
                fill="#1e293b"
                fontSize={12}
                fontWeight={700}
              >
                {shareText}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="mt-2 border-t border-slate-200 pt-2 text-xs text-slate-600">
        <div className="space-y-1">
          <p className="leading-relaxed">
            <span className="mr-1 inline-flex items-center font-bold" style={{ color: ROLE_CONFIG.mover.fill }}>
              <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: ROLE_CONFIG.mover.fill }} />
              发起者
            </span>
            提出主张、目标或行动建议。
          </p>
          <p className="leading-relaxed">
            <span className="mr-1 inline-flex items-center font-bold" style={{ color: ROLE_CONFIG.follower.fill }}>
              <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: ROLE_CONFIG.follower.fill }} />
              跟随者
            </span>
            支持提议并补充、落实和推进。
          </p>
          <p className="leading-relaxed">
            <span className="mr-1 inline-flex items-center font-bold" style={{ color: ROLE_CONFIG.opposer.fill }}>
              <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: ROLE_CONFIG.opposer.fill }} />
              反对者
            </span>
            质疑假设、指出风险或提出不同意见。
          </p>
          <p className="leading-relaxed">
            <span className="mr-1 inline-flex items-center font-bold" style={{ color: ROLE_CONFIG.bystander.fill }}>
              <span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: ROLE_CONFIG.bystander.fill }} />
              旁观者
            </span>
            暂时跳出立场、观察并描述整体情况。
          </p>
          <p className="leading-relaxed text-slate-500">
            <span className="mr-1 inline-flex items-center font-medium" style={{ color: '#64748b' }}>
              <span
                className="mr-1 inline-block h-2 w-2 rounded-full"
                style={{ background: ROLE_CONFIG.silent.fill, border: `1px solid ${ROLE_CONFIG.silent.stroke}` }}
              />
              灰色节点
            </span>
            表示无明显参与，整场会议发言极少。
          </p>
        </div>

        <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-slate-100 pt-2 text-slate-500">
          <span className="inline-flex items-center">
            <svg width="24" height="14" className="mr-1">
              <circle cx="12" cy="7" r="6" fill="#94a3b8" />
            </svg>
            百分比数字 = 发言占比
          </span>
          <span className="inline-flex items-center">
            <svg width="30" height="10" className="mr-1">
              <line x1="2" y1="5" x2="28" y2="5" stroke="#94a3b8" strokeWidth="1" strokeLinecap="round" />
              <line x1="2" y1="8" x2="28" y2="8" stroke="#64748b" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
            连线越粗 = 互动越频繁
          </span>
        </div>
      </div>
    </div>
  );
}
