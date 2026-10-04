import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomerService } from '../src/modules/customer.service';
import { PrismaService } from '../src/prisma/prisma.service';

const runId = `integration-${Date.now()}`;
const huji = (suffix: string) => `98${String(Date.now()).slice(-7)}${suffix}`;
const idCard = (suffix: string) => `99${String(Date.now()).slice(-10)}${suffix.padStart(6, '0')}`;

describe.sequential('CustomerService PostgreSQL integration', () => {
  const prisma = new PrismaService();
  const service = new CustomerService(prisma);

  beforeAll(async () => {
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    const rows = await prisma.customer.findMany({
      where: { ingest_batch: { startsWith: runId } },
      select: { customer_id: true, ingest_month: true },
    });
    const ids = rows.map((row) => row.customer_id);
    await prisma.ingestRowIdentity.deleteMany({ where: { ingest_batch: { startsWith: runId } } });
    await prisma.customerIdentity.deleteMany({ where: { customer_id: { in: ids } } });
    for (const row of rows) {
      await prisma.customer.delete({
        where: {
          customer_id_ingest_month: {
            customer_id: row.customer_id,
            ingest_month: row.ingest_month,
          },
        },
      });
    }
    await prisma.onModuleDestroy();
  });

  it('serializes concurrent writes for the same global id_card', async () => {
    const key = idCard('01');
    const [left, right] = await Promise.all([
      service.upsertBatch([{
        huji_no: huji('01'),
        id_card: key,
        name: 'left',
        source_file: 'concurrent.xlsx',
        source_row: 1,
        ingest_batch: `${runId}-concurrent-a`,
      }]),
      service.upsertBatch([{
        huji_no: huji('02'),
        id_card: key,
        name: 'right',
        source_file: 'concurrent.xlsx',
        source_row: 1,
        ingest_batch: `${runId}-concurrent-b`,
      }]),
    ]);
    expect(left.inserted + right.inserted).toBe(1);
    expect(left.updated + right.updated).toBe(1);
    expect(await prisma.customer.count({
      where: { id_card: key, is_deleted: false },
    })).toBe(1);
    expect(await prisma.customerIdentity.count({ where: { id_card: key } })).toBe(1);
  });

  it('keeps the same huji_no when id_card values differ', async () => {
    const hujiNo = huji('03');
    const result = await service.upsertBatch([
      {
        huji_no: hujiNo,
        name: 'first',
        id_card: idCard('03'),
        source_file: 'id-card.xlsx',
        source_row: 1,
        ingest_batch: `${runId}-id-card`,
      },
      {
        huji_no: hujiNo,
        name: 'second',
        id_card: idCard('04'),
        source_file: 'id-card.xlsx',
        source_row: 2,
        ingest_batch: `${runId}-id-card`,
      },
    ]);
    expect(result.inserted).toBe(2);
    expect(await prisma.customer.count({
      where: { huji_no: hujiNo, is_deleted: false },
    })).toBe(2);
  });

  it('rejects rows without id_card', async () => {
    await expect(service.upsertBatch([{
      name: 'missing-id-card',
      source_file: 'missing.xlsx',
      source_row: 1,
      ingest_batch: `${runId}-missing`,
    }])).rejects.toThrow('id_card_required');
  });

  it('skips an already committed source row during replay', async () => {
    const row = {
      huji_no: huji('04'),
      id_card: idCard('05'),
      name: 'idempotent',
      source_file: 'retry.xlsx',
      source_row: 1,
      ingest_batch: `${runId}-retry`,
    };
    const first = await service.upsertBatch([row]);
    const replay = await service.upsertBatch([{ ...row, name: 'must-not-overwrite' }]);
    expect(first.inserted).toBe(1);
    expect(replay).toMatchObject({ inserted: 0, updated: 0, skipped: 1 });
  });

  it('keeps the last row when one batch repeats an id_card', async () => {
    const key = idCard('06');
    const lastHuji = huji('06');
    const result = await service.upsertBatch([
      {
        huji_no: huji('05'),
        id_card: key,
        name: 'first',
        source_file: 'same-id.xlsx',
        source_row: 1,
        ingest_batch: `${runId}-same-id`,
      },
      {
        huji_no: lastHuji,
        id_card: key,
        name: 'last',
        source_file: 'same-id.xlsx',
        source_row: 2,
        ingest_batch: `${runId}-same-id`,
      },
    ]);
    expect(result).toMatchObject({ inserted: 1, updated: 0 });
    expect(await prisma.customer.findFirst({
      where: { id_card: key, is_deleted: false },
      select: { name: true, huji_no: true },
    })).toEqual({ name: 'last', huji_no: lastHuji });
  });
});
