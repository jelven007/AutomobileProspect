import type { SegmentExpr } from '@leadops/types';

export function emptyExpr(): SegmentExpr {
  return { op: 'AND', children: [] };
}

export function describe(expr: SegmentExpr): string {
  if ('tag_id' in expr) return `tag:${expr.tag_id} ${expr.op} ${JSON.stringify(expr.value)}`;
  if (expr.op === 'NOT') return `NOT (${describe(expr.child)})`;
  return expr.children.map(describe).join(` ${expr.op} `);
}
