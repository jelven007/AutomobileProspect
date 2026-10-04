import type { CSSProperties } from 'react';

export interface FunnelStep {
  label: string;
  value: number;
}

export default function FunnelChart({ steps, style }: { steps: FunnelStep[]; style?: CSSProperties }) {
  const max = Math.max(...steps.map((s) => s.value));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, ...style }}>
      {steps.map((s) => (
        <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 96, fontSize: 12 }}>{s.label}</span>
          <div style={{ flex: 1, background: '#eef2f7', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ width: `${(s.value / max) * 100}%`, height: 14, background: '#3b82f6' }} />
          </div>
          <span style={{ width: 72, textAlign: 'right', fontSize: 12 }}>{s.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}
