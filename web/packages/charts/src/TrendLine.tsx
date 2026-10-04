import type { CSSProperties } from 'react';

export interface TrendPoint {
  x: string;
  y: number;
}

export default function TrendLine({ points, style }: { points: TrendPoint[]; style?: CSSProperties }) {
  if (points.length === 0) return null;
  const w = 320;
  const h = 80;
  const max = Math.max(...points.map((p) => p.y));
  const min = Math.min(...points.map((p) => p.y));
  const span = max - min || 1;
  const path = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p.y - min) / span) * h;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={w} height={h} style={style}>
      <path d={path} fill="none" stroke="#3b82f6" strokeWidth={2} />
    </svg>
  );
}
