import type { BoundaryDimensionV2, TeamZoneV2 } from '@/types';

type LocatedZone = Exclude<TeamZoneV2, 'Difficult to Judge'>;

const ZONE_LABELS: Record<LocatedZone, string> = {
  Learning: '学习区',
  Comfort: '舒适区',
  Anxiety: '焦虑区',
  Apathy: '冷漠区',
};

export function deriveZone(
  psychologicalSafety: 'higher' | 'lower' | 'insufficient',
  accountability: 'higher' | 'lower' | 'insufficient',
): TeamZoneV2 {
  if (psychologicalSafety === 'insufficient' && accountability === 'insufficient') return 'Difficult to Judge';
  if (psychologicalSafety === 'insufficient') return accountability === 'higher' ? 'Anxiety' : 'Apathy';
  if (accountability === 'insufficient') return psychologicalSafety === 'higher' ? 'Comfort' : 'Apathy';
  if (psychologicalSafety === 'higher' && accountability === 'higher') return 'Learning';
  if (psychologicalSafety === 'higher' && accountability === 'lower') return 'Comfort';
  if (psychologicalSafety === 'lower' && accountability === 'higher') return 'Anxiety';
  return 'Apathy';
}

export function deriveInsufficientBoundary(
  psychologicalSafety: 'higher' | 'lower' | 'insufficient',
  accountability: 'higher' | 'lower' | 'insufficient',
): BoundaryDimensionV2 {
  if (psychologicalSafety === 'insufficient' && accountability !== 'insufficient') return 'psychologicalSafety';
  if (accountability === 'insufficient' && psychologicalSafety !== 'insufficient') return 'accountability';
  return 'none';
}

export function deriveAdjacentZone(zone: TeamZoneV2, boundary: BoundaryDimensionV2): LocatedZone | undefined {
  if (zone === 'Difficult to Judge' || boundary === 'none') return undefined;
  if (boundary === 'psychologicalSafety') {
    return ({ Learning: 'Anxiety', Comfort: 'Apathy', Anxiety: 'Learning', Apathy: 'Comfort' } as const)[zone as LocatedZone];
  }
  return ({ Learning: 'Comfort', Comfort: 'Learning', Anxiety: 'Apathy', Apathy: 'Anxiety' } as const)[zone as LocatedZone];
}

export function derivePositionHint(boundary: BoundaryDimensionV2) {
  if (boundary === 'psychologicalSafety') return 'near_horizontal_boundary' as const;
  if (boundary === 'accountability') return 'near_vertical_boundary' as const;
  return 'center' as const;
}

export function canonicalZoneLabel(zone: TeamZoneV2, adjacentZone?: LocatedZone, ambiguous = false) {
  if (zone === 'Difficult to Judge') return '证据不足，暂不定位';
  if (ambiguous && adjacentZone) return `可能是${ZONE_LABELS[zone as LocatedZone]}或${ZONE_LABELS[adjacentZone]}`;
  return adjacentZone
    ? `${ZONE_LABELS[zone as LocatedZone]}，靠近${ZONE_LABELS[adjacentZone]}边界`
    : ZONE_LABELS[zone as LocatedZone];
}
