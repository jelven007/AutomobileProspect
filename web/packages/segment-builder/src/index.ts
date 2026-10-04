import type { SegmentExpr } from '@leadops/types';

export function emptyExpr(): SegmentExpr {
  return { op: 'AND', children: [] };
}

export function describe(expr: SegmentExpr): string {
  if ('field' in expr) return `${expr.field} ${expr.op} ${JSON.stringify(expr.value)}`;
  return expr.children.map(describe).join(` ${expr.op} `);
}
