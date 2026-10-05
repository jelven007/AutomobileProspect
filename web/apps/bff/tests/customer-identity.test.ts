import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { CustomerController } from '../src/modules/customer.controller';
import { CustomerService } from '../src/modules/customer.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { CustomerExportService } from '../src/modules/customer-export.service';

function setup() {
  const existing = {
    customer_id: 'test-customer',
    id_card: '510223197410137219',
    name: '客户',
    ingest_month: new Date('2026-10-01'),
  };
  const tx = {
    $executeRaw: vi.fn(),
    customer: {
      findFirst: vi.fn().mockResolvedValue(existing),
      create: vi.fn().mockImplementation(async ({ data }) => data),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUniqueOrThrow: vi.fn().mockResolvedValue(existing),
    },
    customerIdentity: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  };
  const transaction = vi.fn().mockImplementation(async (callback) => callback(tx));
  const prisma = { $transaction: transaction } as unknown as PrismaService;
  return {
    tx, transaction,
    controller: new CustomerController(prisma, {} as CustomerExportService),
    service: new CustomerService(prisma),
  };
}

describe('identity admission at API and batch write boundaries', () => {
  it.each(['未知', '12345', '111111111111111', '51022319741013721A'])(
    'rejects %s in create, update and batch import without writing customers',
    async (idCard) => {
      const { controller, service, transaction, tx } = setup();
      const request = { headers: {} };
      for (const operation of [
        controller.create({ name: '客户甲', id_card: idCard }, request),
        controller.update('test-customer', { version: 1, id_card: idCard }, request),
      ]) {
        await expect(operation).rejects.toMatchObject({
          status: 400, response: { message: 'invalid_id_card_format' },
        });
      }
      await expect(service.upsertBatch([
        { name: '客户甲', id_card: idCard }, { name: '客户乙', id_card: idCard },
      ])).rejects.toThrow('invalid_id_card_format');
      expect(transaction).toHaveBeenCalledTimes(1); // update resolves the existing document type
      expect(tx.customer.create).not.toHaveBeenCalled();
      expect(tx.customer.updateMany).not.toHaveBeenCalled();
    },
  );

  it('creates a manual identity with corrected date and canonical key', async () => {
    const { controller, tx } = setup();
    const result = await controller.create({ name: '客户', id_card: '220521740230141' }, { headers: {} });
    expect(result).toMatchObject({ id_card: '220521197402281418', birth_date: '1974-02-28' });
    expect(tx.customerIdentity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ id_card: '220521197402281418' }),
    });
  });

  it('uses the normalized key in both customer updates and identity mappings', async () => {
    const { controller, tx } = setup();
    await controller.update('test-customer', {
      version: 1, id_card: '11010519491231002x',
    }, { headers: {} });
    expect(tx.customer.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ id_card: '11010519491231002X' }),
    }));
    expect(tx.customerIdentity.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ id_card: '11010519491231002X' }),
    });
  });

  it('continues accepting a wrong checksum at the manual API boundary', async () => {
    const { controller } = setup();
    const result = await controller.create({
      name: '客户', id_card: '510223197410137210',
    }, { headers: {} });
    expect(result.id_card).toBe('510223197410137210');
  });
});
