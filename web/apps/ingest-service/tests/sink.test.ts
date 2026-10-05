import { describe, expect, it, vi } from 'vitest';
import { PgSink } from '../src/sink';

describe('PgSink identity admission', () => {
  it('rejects placeholders before buffering or opening a database connection', async () => {
    const sink = new PgSink('postgresql://unused/unused');
    const connect = vi.spyOn(sink.pool, 'connect');
    try {
      for (const name of ['客户甲', '客户乙']) {
        await expect(sink.push({ name, id_card: '未知' })).rejects.toThrow('invalid_id_card_format');
      }
      await expect(sink.push({ name: '客户' })).rejects.toThrow('id_card_required');
      await sink.flush();
      expect(connect).not.toHaveBeenCalled();
    } finally {
      await sink.abort();
    }
  });

  it('deduplicates compatible forms by normalized identity and keeps the last row', async () => {
    const sink = new PgSink('postgresql://unused/unused');
    const query = vi.fn().mockResolvedValue({ rows: [{ count: 0 }], rowCount: 1 });
    vi.spyOn(sink.pool, 'connect').mockResolvedValue({
      query, release: vi.fn(),
    } as never);
    try {
      await sink.push({ name: '旧记录', id_card: '510223741013721' });
      const last = { name: '新记录', id_card: '510223197410137219' };
      await sink.push(last);
      last.id_card = '未知';
      await sink.flush();
      const loadCall = query.mock.calls.find(([sql]) => String(sql).includes('jsonb_to_recordset'));
      expect(JSON.parse(loadCall?.[1][0])).toMatchObject([
        { name: '新记录', id_card: '510223197410137219' },
      ]);
      expect(sink.stats.duplicateRows).toBe(1);
    } finally {
      await sink.abort();
    }
  });
});
