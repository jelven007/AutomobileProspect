import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { normalizeIdCardForStorage } from '@leadops/ingest-service';
import { PgSink } from '@leadops/ingest-service';
import { CustomerController } from '../src/modules/customer.controller';
import type { CustomerExportService } from '../src/modules/customer-export.service';
import { CustomerService } from '../src/modules/customer.service';
import { PrismaService } from '../src/prisma/prisma.service';

const runId = `integration-${Date.now()}`;
const huji = (suffix: string) => `98${String(Date.now()).slice(-7)}${suffix}`;
const testDistrict = `99${String(Date.now()).slice(-4)}`;
const idCard = (suffix: string) => normalizeIdCardForStorage(
  `${testDistrict}19900101${suffix.padStart(3, '0')}`,
).value;

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
    await prisma.auditLog.deleteMany({ where: { OR: [
      { entity_id: { in: ids } }, { entity_id: { startsWith: runId } },
    ] } });
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

  it('does not write or merge distinct people sharing an invalid identity', async () => {
    await expect(service.upsertBatch([
      { name: '客户甲', id_card: '未知', ingest_batch: `${runId}-invalid` },
      { name: '客户乙', id_card: '未知', ingest_batch: `${runId}-invalid` },
    ])).rejects.toThrow('invalid_id_card_format');
    expect(await prisma.customer.count({
      where: { ingest_batch: `${runId}-invalid` },
    })).toBe(0);
    expect(await prisma.customerIdentity.count({ where: { id_card: '未知' } })).toBe(0);
  });

  it('merges 15/17/18 digit representations using one canonical identity', async () => {
    const key = idCard('07');
    const oldKey = key.slice(0, 6) + key.slice(8, 17);
    const batch = `${runId}-normalized`;
    const first = await service.upsertBatch([{ name: '首次', id_card: oldKey, ingest_batch: batch }]);
    const second = await service.upsertBatch([{ name: '更新', id_card: key.slice(0, 17), ingest_batch: batch }]);
    expect(first.inserted).toBe(1);
    expect(second.updated).toBe(1);
    expect(await prisma.customer.findMany({
      where: { id_card: key },
      select: { name: true, version: true },
    })).toEqual([{ name: '更新', version: 2 }]);
    expect(await prisma.customerIdentity.count({ where: { id_card: key } })).toBe(1);
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

  it('separates equal passport and organization numbers across BFF, CLI and manual edits', async () => {
    const key = 'G12345678'; // Valid in both namespaces, so explicit types are mandatory.
    const batch = `${runId}-documents`;
    const common = { id_card: key, source_file: 'documents.xlsx', ingest_batch: batch };
    const sink = new PgSink(process.env.DATABASE_URL as string, 1);
    try {
      const result = await service.upsertBatch([
        { ...common, name: '组织', id_type: 'organization_code', source_row: 1 },
        { ...common, name: '个人', id_type: 'passport_cn', source_row: 2 },
      ]);
      expect(result.inserted).toBe(2);
      await sink.push({ ...common, name: '组织更新', id_type: 'organization_code', source_row: 3 });
      expect(sink.stats.updated).toBe(1);
      expect(await prisma.customer.findMany({
        where: { ingest_batch: batch }, select: { name: true, id_type: true }, orderBy: { name: 'asc' },
      })).toEqual(expect.arrayContaining([
        { name: '组织更新', id_type: 'organization_code' },
        { name: '个人', id_type: 'passport_cn' },
      ]));
      const controller = new CustomerController(prisma, {} as CustomerExportService);
      await expect(controller.create({
        name: '重复机构', id_card: 'G1234567-8', id_type: 'organization_code',
      }, { headers: {} })).rejects.toMatchObject({ status: 409 });
      const org = await prisma.customer.findFirstOrThrow({
        where: { id_type: 'organization_code', id_card: key },
      });
      // Type-only edits must also detect an existing identity in the destination namespace.
      await expect(controller.update(org.customer_id, {
        version: org.version, id_type: 'passport_cn',
      }, { headers: {} })).rejects.toMatchObject({ status: 409 });
      const edited = await controller.update(org.customer_id, {
        version: org.version, id_card: '56432454-5',
      }, { headers: {} });
      expect(edited).toMatchObject({ id_type: 'organization_code', id_card: '564324545' });
      expect(await prisma.customerIdentity.count({ where: { id_card: key } })).toBe(1);
      expect(await prisma.customerIdentity.count({ where: { id_card: '564324545' } })).toBe(1);
    } finally {
      await sink.abort();
    }
  });

  it('serializes BFF and CLI writes to the same organization identity', async () => {
    const common = {
      id_card: '59697086-7', id_type: 'organization_code', source_file: 'organization.xlsx',
      ingest_batch: `${runId}-concurrent-org`,
    };
    const sink = new PgSink(process.env.DATABASE_URL as string, 1);
    try {
      const [bff] = await Promise.all([
        service.upsertBatch([{ ...common, name: 'BFF', source_row: 1 }]),
        sink.push({ ...common, name: 'CLI', source_row: 2 }),
      ]);
      expect(bff.inserted + sink.stats.inserted).toBe(1);
      expect(bff.updated + sink.stats.updated).toBe(1);
    } finally {
      await sink.abort();
    }
  });

  it('merges hashes into an existing resident identity and preserves replay idempotency', async () => {
    const key = idCard('08');
    const common = { source_file: 'hash.xlsx', ingest_batch: `${runId}-hash` };
    await service.upsertBatch([{ ...common, name: '原始', id_card: key, source_row: 1 }]);
    const wrapped = { ...common, name: '修复', id_card: `#${key}#`, source_row: 2 };
    const audit = { actor: 'test', jobId: common.ingest_batch };
    expect(await service.upsertBatch([wrapped], undefined, audit)).toMatchObject({ inserted: 0, updated: 1 });
    expect(await service.upsertBatch([wrapped], undefined, audit)).toMatchObject({ inserted: 0, updated: 0, skipped: 1 });
    expect(await prisma.customerIdentity.count({ where: { id_card: key } })).toBe(1);
    const snapshots = await prisma.auditLog.findMany({ where: { entity_id: audit.jobId } });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].before_data).toEqual([expect.objectContaining({ name: '原始', version: 1 })]);
    expect(snapshots[0].after_data).toMatchObject({
      inserted: 0, updated: 1, customers: [expect.objectContaining({ name: '修复', version: 2 })],
    });
  });

  it('canonicalizes HK IDs across BFF, CLI, replay and manual edits with repair audit', async () => {
    const row = {
      name: '香港客户', id_card: 'Ａ１２３４５６（３）', id_type: 'hongkong_id',
      ingest_batch: `${runId}-hk`, source_file: 'hk.xlsx', source_row: 1,
    };
    const audit = { actor: 'test', jobId: row.ingest_batch };
    expect(await service.upsertBatch([row], undefined, audit)).toMatchObject({ inserted: 1, updated: 0 });
    expect(await service.upsertBatch([{ ...row, id_card: 'A1234563' }], undefined, audit))
      .toMatchObject({ inserted: 0, updated: 0, skipped: 1 });
    const sink = new PgSink(process.env.DATABASE_URL as string, 1);
    try {
      await sink.push({ ...row, id_card: 'A1234563', name: '香港更新', source_row: 2 });
      expect(sink.stats.updated).toBe(1);
    } finally {
      await sink.abort();
    }
    const controller = new CustomerController(prisma, {} as CustomerExportService);
    await expect(controller.create({ name: '重复', id_card: 'A123456(3)' }, { headers: {} }))
      .rejects.toMatchObject({ status: 409 });
    await expect(service.upsertBatch([{ ...row, id_card: 'A123456(4)', source_row: 3 }]))
      .rejects.toThrow('invalid_id_card_format');
    const hk = await prisma.customer.findFirstOrThrow({ where: { ingest_batch: row.ingest_batch } });
    expect(hk.id_card).toBe('A123456(3)');
    expect(await controller.update(hk.customer_id, { version: hk.version, id_card: 'A1234563' }, { headers: {} }))
      .toMatchObject({ id_type: 'hongkong_id', id_card: 'A123456(3)' });
    const snapshots = await prisma.auditLog.findMany({ where: { entity_id: audit.jobId } });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].before_data).toEqual([]);
    expect(snapshots[0].after_data).toMatchObject({
      inserted: 1, updated: 0, customers: [expect.objectContaining({ id_type: 'hongkong_id', id_card: 'A123456(3)' })],
    });
  });

  it('isolates pending documents and supports verified type edits without bypassing admission', async () => {
    const common = { id_card: 'G12345678', ingest_batch: `${runId}-pending`, source_file: 'pending.xlsx' };
    await service.upsertBatch([
      { ...common, name: '待核实', id_type: 'pending_document', source_row: 1 },
      { ...common, name: '护照', id_type: 'passport_cn', source_row: 2 },
    ]);
    expect(await prisma.customerIdentity.count({ where: { id_card: common.id_card } })).toBe(2);
    const pending = await prisma.customer.findFirstOrThrow({
      where: { id_card: common.id_card, id_type: 'pending_document' },
    });
    const controller = new CustomerController(prisma, {} as CustomerExportService);
    await expect(controller.update(pending.customer_id, { version: pending.version, id_type: 'passport_cn' }, { headers: {} }))
      .rejects.toMatchObject({ status: 409 });
    const verified = await controller.update(pending.customer_id, {
      version: pending.version, id_type: 'organization_code',
    }, { headers: {} });
    expect(verified).toMatchObject({ id_type: 'organization_code', id_card: common.id_card });
    expect(await prisma.customerIdentity.count({ where: { id_type: 'pending_document' } })).toBe(0);
    for (const id_card of ['NULL', '13812345678', '12345678']) {
      await expect(service.upsertBatch([{ ...common, name: '无效', id_card, id_type: 'pending_document' }]))
        .rejects.toThrow('invalid_id_card_format');
    }
  });

  it('supports first, middle, last and out-of-range pages with combined document filters', async () => {
    const batch = `${runId}-pages`;
    await service.upsertBatch(Array.from({ length: 8 }, (_, i) => ({
      name: `${batch}-${i}`, id_card: idCard(String(90 + i)), id_type: 'resident_id',
      gender: 'M' as const, city: '分页测试市', ingest_batch: batch,
    })));
    await service.upsertBatch([{
      name: `${batch}-passport`, id_card: 'G87654321', id_type: 'passport_cn',
      gender: 'M', city: '分页测试市', ingest_batch: batch,
    }]);
    await prisma.customer.updateMany({ where: { name: `${batch}-7` }, data: { is_deleted: true } });
    const controller = new CustomerController(prisma, {} as CustomerExportService);
    const list = (page: string, type = 'resident_id', q = batch) =>
      controller.list(q, undefined, undefined, '分页测试市', undefined, 'M', undefined, '3', type, page);
    const expected = await prisma.customer.findMany({
      where: { ingest_batch: batch, id_type: 'resident_id', is_deleted: false },
      orderBy: { customer_id: 'desc' },
    });
    for (const [page, offset] of [['1', 0], ['2', 3], ['3', 6], ['9999', 6]] as const) {
      const result = await list(page);
      expect(result).toMatchObject({ total: 7, total_pages: 3, page: Math.min(Number(page), 3) });
      expect(result.items.map((row) => row.customer_id)).toEqual(expected.slice(offset, offset + 3).map((row) => row.customer_id));
      expect(result.has_more).toBe(offset < 6);
    }
    expect(await list('3', 'passport_cn')).toMatchObject({ total: 1, total_pages: 1, page: 1 });
    expect(await list('3', 'resident_id', 'no-such-fixture')).toMatchObject({
      items: [], total: 0, total_pages: 0, page: 1, has_more: false,
    });
    for (const page of ['0', '-1', '1.5', 'Infinity', '9007199254740992']) {
      await expect(list(page)).rejects.toMatchObject({ status: 400 });
    }
    const first = await controller.list(batch, undefined, undefined, undefined, undefined, undefined, undefined, '3');
    const next = await controller.list(batch, undefined, undefined, undefined, undefined, undefined, first.next_cursor, '3');
    expect(next.items).toHaveLength(3);
    expect(next.items.every((row) => !first.items.some((old) => old.customer_id === row.customer_id))).toBe(true);
  });

  it('carries document filters into batch export while excluding pagination', async () => {
    const create = vi.fn().mockResolvedValue({ job_id: 'test-export' });
    const controller = new CustomerController(prisma, { create } as unknown as CustomerExportService);
    await controller.createExport({ id_type: 'hongkong_id', q: '客户', page: 4, limit: 50 }, { headers: {} });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ id_type: 'hongkong_id', q: '客户' }), 'unknown');
    expect(create.mock.calls[0][0]).not.toHaveProperty('page');
    expect(create.mock.calls[0][0]).not.toHaveProperty('limit');
  });
});
