/**
 * User-authorized, exact 20-row supplement for file 1 (56).xlsx.
 * Default is read-only preview; --apply writes one audited, idempotent batch.
 * Run from apps/bff with DATABASE_URL: pnpm exec tsx scripts/repair-hongkong-import.ts [--apply]
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  cleanRowDetailed, documentKey, loadSchema, normalizeDocument, streamXlsx,
  type DocumentType,
} from '@leadops/ingest-service';
import type { Prisma } from '@prisma/client';
import { adaptPhoneAddressMappings, resolveImportLayout } from '../src/modules/customer-import.service';
import { CustomerService, type IngestRow } from '../src/modules/customer.service';
import { PrismaService } from '../src/prisma/prisma.service';

const sourceJob = '01M44Z6BH2GZETF86ABJNVPJEX';
const repairId = `repair-hk-v6-${sourceJob}`;
const sourceHash = '3a3733c4b00db0cd61fbc15e84a6ff0abe7d5a6785b48edb22572d41085d84d7';
const hkRows = [35216, 60339, 219367, 301376, 323589, 336248, 396077, 602805, 662365];
const pendingRows = [322889, 363006, 386658, 517548, 567635, 611819, 675224];
const orgRows = [520186, 520187, 644962, 646325];
const organizationNames: Record<string, string> = {
  E83745412: '苏州市吴江区劳动监察大队',
  E83918600: '常熟市环境监察大队',
};
const sourceOrganizationNames: Record<string, string> = {
  E83745412: '吴江市劳动监察大队',
  E83918600: '常熟市环境监察大队',
};
const selected = new Map<number, DocumentType>([
  ...hkRows.map((row): [number, DocumentType] => [row, 'hongkong_id']),
  ...pendingRows.map((row): [number, DocumentType] => [row, 'pending_document']),
  ...orgRows.map((row): [number, DocumentType] => [row, 'organization_code']),
]);
const asJson = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const original = await prisma.ingestJob.findUniqueOrThrow({ where: { job_id: sourceJob } });
    assert(['SUCCESS', 'SUPERSEDED'].includes(original.status));
    assert(original.file_path && original.file_name);
    assert.equal(original.file_hash, sourceHash);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(original.file_path)) hash.update(chunk);
    assert.equal(hash.digest('hex'), sourceHash, 'source file changed');
    const output = resolve('.data', 'repairs', repairId);
    await mkdir(output, { recursive: true, mode: 0o700 });
    const previousAnalysis = await readFile(resolve('.data', 'repairs',
      `repair-doc-v5-${sourceJob}`, 'remaining-analysis', 'rows.ndjson'), 'utf8');
    const evidence = new Map<number, { row: number; raw_values: unknown[]; raw_id: string; group: string }>();
    for (const line of previousAnalysis.trim().split('\n')) {
      const item = JSON.parse(line);
      if (selected.has(item.row)) evidence.set(item.row, item);
    }
    assert.equal(evidence.size, 20);
    const base = loadSchema(resolve(__dirname, '../../ingest-service/configs/ingest-schema.yaml'));
    let layout: ReturnType<typeof resolveImportLayout> | undefined;
    const sources: Array<{
      source_row: number; raw_values: unknown[]; type: DocumentType; decision: string; warnings: string[]; row: IngestRow;
    }> = [];
    const candidates = new Map<string, { row: IngestRow; source_rows: number[] }>();
    let scanned = 0;
    for await (const { rowNo, values } of streamXlsx(createReadStream(original.file_path), {
      sheetIndex: base.parse.sheet, skipHeaderRows: 0,
    })) {
      if (!layout) layout = resolveImportLayout(base, values);
      if (rowNo <= (layout.hasHeader ? base.parse.skip_header_rows : 0)) continue;
      scanned++;
      const type = selected.get(rowNo);
      if (!type) continue;
      const prior = evidence.get(rowNo)!;
      assert.deepEqual(values, prior.raw_values, `source evidence changed at row ${rowNo}`);
      if (type !== 'hongkong_id') {
        assert.equal(prior.group, 'ambiguous_document_type');
        assert.equal(normalizeDocument(prior.raw_id).error, 'ambiguous_document_type');
      } else {
        assert.equal(normalizeDocument(prior.raw_id).type, 'hongkong_id');
      }
      const rowSchema = adaptPhoneAddressMappings(layout.schema, values);
      assert(!rowSchema.columns.mappings.some((mapping) => mapping.field === 'id_type'));
      const typedSchema = {
        ...rowSchema,
        columns: { ...rowSchema.columns, mappings: [...rowSchema.columns.mappings, { index: values.length + 1, field: 'id_type' }] },
      };
      const cleaned = cleanRowDetailed([...values, type], typedSchema, {
        source_file: original.file_name, source_row: rowNo, ingest_batch: repairId,
      });
      assert.equal(cleaned.row.id_type, type);
      const row = Object.fromEntries(Object.entries(cleaned.row).filter(([, value]) => value != null)) as unknown as IngestRow;
      if (type === 'organization_code') assert.equal(row.name, sourceOrganizationNames[row.id_card!]);
      const decision = type === 'hongkong_id' ? 'parenthesized_hk_checksum_verified'
        : type === 'organization_code' ? 'existing_organization_identity_and_known_name_match'
          : 'user_authorized_pending_type_no_reliable_type_evidence';
      sources.push({ source_row: rowNo, raw_values: values, type, decision, warnings: cleaned.warnings, row });
      const key = documentKey(row);
      candidates.set(key, { row, source_rows: [...(candidates.get(key)?.source_rows ?? []), rowNo] });
    }
    assert.equal(scanned, Number(original.total_rows));
    assert.equal(sources.length, 20);
    assert.equal(candidates.size, 18);
    const manifest = [...candidates.values()];
    // Reconfirm organization evidence immediately before write; do not infer from a person's name.
    for (const [id_card, name] of Object.entries(organizationNames)) {
      const identity = await prisma.customerIdentity.findUniqueOrThrow({
        where: { id_type_id_card: { id_type: 'organization_code', id_card } },
      });
      const customer = await prisma.customer.findUniqueOrThrow({
        where: { customer_id_ingest_month: { customer_id: identity.customer_id, ingest_month: identity.ingest_month } },
      });
      assert([name, sourceOrganizationNames[id_card]].includes(customer.name), 'organization evidence changed');
      assert.equal(customer.is_deleted, false);
    }
    const warnings: Record<string, number> = {};
    for (const item of sources) for (const warning of item.warnings) warnings[warning] = (warnings[warning] ?? 0) + 1;
    const stats = {
      pipeline_version: 6, job_id: repairId, retry_of: sourceJob, file_name: original.file_name,
      source_hash: sourceHash, total_scanned: scanned, total_rows: 20, success_rows: 20, skipped_rows: 0,
      duplicate_rows: 2, unique_customers: 18, accepted_by_type: { hongkong_id: 9, pending_document: 7, organization_code: 4 },
      unique_by_type: { hongkong_id: 9, pending_document: 7, organization_code: 2 },
      warnings_summary: warnings, errors: [],
    };
    await writeFile(join(output, 'sources.ndjson'), sources.map((item) => JSON.stringify(item)).join('\n') + '\n', { mode: 0o600 });
    await writeFile(join(output, 'manifest.ndjson'), manifest.map((item) => JSON.stringify(item)).join('\n') + '\n', { mode: 0o600 });
    await writeFile(join(output, 'preview.json'), JSON.stringify(stats, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ phase: 'preview', ...stats }));
    if (!process.argv.includes('--apply')) return;
    assert.equal(await prisma.ingestJob.count({
      where: { status: { in: ['PENDING', 'RUNNING'] }, job_id: { not: repairId } },
    }), 0, 'another import is active');
    assert.equal(await prisma.exportJob.count({ where: { status: { in: ['PENDING', 'RUNNING'] } } }), 0, 'an export is active');
    const constraints = await prisma.$queryRaw<Array<{ conname: string; ready: boolean }>>`
      SELECT conname, convalidated AND position('hongkong_id' in pg_get_constraintdef(oid)) > 0
        AND position('pending_document' in pg_get_constraintdef(oid)) > 0 AS ready
      FROM pg_constraint WHERE conrelid IN ('customer'::regclass, 'customer_identity'::regclass)
        AND conname IN ('customer_id_type_check', 'customer_identity_id_type_check')`;
    assert.equal(constraints.length, 2);
    assert(constraints.every((constraint) => constraint.ready), 'apply and validate migration 006 first');
    const job = await prisma.ingestJob.upsert({
      where: { job_id: repairId },
      create: {
        job_id: repairId, retry_of: sourceJob, source_bucket: 'repair', file_name: original.file_name,
        status: 'RUNNING', started_at: new Date(), report_json: asJson(stats),
      },
      update: { status: 'RUNNING', error: null, finished_at: null },
    });
    try {
      const service = new CustomerService(prisma);
      const rows = manifest.map((item) => item.row);
      const result = await service.upsertBatch(rows, {
        jobId: repairId, totalRows: 20, successRows: 20, skippedRows: 0, duplicateRows: 2,
        insertedBeforeBatch: Number(job.inserted_rows), updatedBeforeBatch: Number(job.updated_rows),
        warnings: Object.values(warnings).reduce((a, b) => a + b, 0), checkpointRow: 20,
      }, { actor: 'document-repair-v6', jobId: repairId });
      const inserted = Number(job.inserted_rows) + result.inserted;
      const updated = Number(job.updated_rows) + result.updated;
      assert.equal(inserted + updated, 18);
      // A replay must not update versions or produce additional repair snapshots.
      assert.deepEqual(await service.upsertBatch(rows, undefined, { actor: 'document-repair-v6', jobId: repairId }), {
        inserted: 0, updated: 0, skipped: 18, conflicts: [],
      });
      for (const item of manifest) {
        const identity = await prisma.customerIdentity.findUniqueOrThrow({
          where: { id_type_id_card: { id_type: item.row.id_type!, id_card: item.row.id_card! } },
        });
        const customer = await prisma.customer.findUniqueOrThrow({
          where: { customer_id_ingest_month: { customer_id: identity.customer_id, ingest_month: identity.ingest_month } },
        });
        assert.equal(customer.is_deleted, false);
        for (const field of ['name', 'id_card', 'id_type', 'source_row', 'source_file', 'ingest_batch'] as const) {
          assert.equal(customer[field], item.row[field], `verification mismatch: ${field}`);
        }
      }
      assert.equal(await prisma.ingestRowIdentity.count({ where: { ingest_batch: repairId } }), 18);
      const audits = await prisma.auditLog.findMany({ where: { entity_id: repairId, action: 'customer.repair_documents' } });
      assert.equal(audits.length, 1);
      assert.equal((audits[0].before_data as unknown[]).length, updated);
      const after = audits[0].after_data as { customers: unknown[] };
      assert.equal(after.customers.length, 18);
      const final = { ...stats, inserted_rows: inserted, updated_rows: updated, verified_customers: 18, replay_skipped: 18, audit_batches: 1 };
      await prisma.ingestJob.update({
        where: { job_id: repairId },
        data: { status: 'SUCCESS', finished_at: new Date(), report_json: asJson(final), warnings_json: asJson(warnings) },
      });
      await writeFile(join(output, 'result.json'), JSON.stringify(final, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ phase: 'complete', ...final }));
    } catch (error) {
      await prisma.ingestJob.update({
        where: { job_id: repairId },
        data: { status: 'FAILED', finished_at: new Date(), error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
