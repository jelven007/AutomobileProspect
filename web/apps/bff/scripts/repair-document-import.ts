/**
 * Repair only v4 rows rejected by resident-ID admission.
 * Dry-run by default. Run with DATABASE_URL and:
 * pnpm exec tsx scripts/repair-document-import.ts --job <v4-job> [--apply]
 *
 * The deterministic repair job + source identities make retries idempotent.
 * Private manifests preserve every source row; before/after snapshots are audited
 * atomically with each batch. Never use the normal whole-file retry for this job.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  CleaningError, cleanRowDetailed, documentKey, isValidIdCardIdentity,
  loadSchema, normalizeIdCardForStorage, streamXlsx,
} from '@leadops/ingest-service';
import type { Prisma } from '@prisma/client';
import { resolveImportLayout, adaptPhoneAddressMappings } from '../src/modules/customer-import.service';
import { CustomerService, type IngestRow } from '../src/modules/customer.service';
import { PrismaService } from '../src/prisma/prisma.service';

interface Candidate {
  row: IngestRow;
  source_rows: number[];
  hash_rows: number[];
  warnings: string[];
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}
function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

async function main(): Promise<void> {
  const oldJobId = arg('--job');
  assert(oldJobId, '--job is required');
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaService();
  await prisma.$connect(); // Preview must not create partitions or modify the database.
  try {
    const oldJob = await prisma.ingestJob.findUniqueOrThrow({ where: { job_id: oldJobId } });
    const oldReport = oldJob.report_json as Record<string, unknown> | null;
    assert.equal(oldReport?.pipeline_version, 4, 'only v4 resident-ID imports can be repaired');
    assert(['SUCCESS', 'SUPERSEDED'].includes(oldJob.status), 'source import must have completed');
    assert(oldJob.file_path && oldJob.file_name && oldJob.file_hash, 'source file metadata missing');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(oldJob.file_path)) hash.update(chunk);
    assert.equal(hash.digest('hex'), oldJob.file_hash, 'source file hash changed');

    const repairId = `repair-doc-v5-${oldJobId}`;
    const output = resolve(arg('--output') ?? join(process.cwd(), '.data', 'repairs', repairId));
    await mkdir(output, { recursive: true, mode: 0o700 });
    const base = loadSchema(resolve(__dirname, '../../ingest-service/configs/ingest-schema.yaml'));
    let layout: ReturnType<typeof resolveImportLayout> | undefined;
    const candidates = new Map<string, Candidate>();
    const stats = {
      pipeline_version: 5, job_id: repairId, retry_of: oldJobId,
      file_name: oldJob.file_name, source_hash: oldJob.file_hash,
      total_scanned: 0, legacy_rejected: 0, accepted_rows: 0,
      hash_rows: 0, hash_unique: 0, unique_customers: 0, duplicate_rows: 0,
      accepted_by_type: {} as Record<string, number>,
      unique_by_type: {} as Record<string, number>,
      remaining_reasons: {} as Record<string, number>,
      warnings_summary: {} as Record<string, number>,
    };

    for await (const { rowNo, values } of streamXlsx(createReadStream(oldJob.file_path), {
      sheetIndex: base.parse.sheet, skipHeaderRows: 0,
    })) {
      if (!layout) layout = resolveImportLayout(base, values);
      if (rowNo <= (layout.hasHeader ? base.parse.skip_header_rows : 0)) continue;
      stats.total_scanned++;
      const schema = adaptPhoneAddressMappings(layout.schema, values);
      assert(!schema.columns.mappings.some((mapping) => mapping.field === 'id_type'), 'v4 type column unexpected');
      const idColumn = schema.columns.mappings.find((mapping) => mapping.field === 'id_card');
      assert(idColumn, 'identity column not found');
      const raw = String(values[idColumn.index - 1] ?? '').trim();
      // This helper deliberately retains v4 semantics: it does NOT strip # or admit organizations.
      if (isValidIdCardIdentity(normalizeIdCardForStorage(raw).value)) continue;
      stats.legacy_rejected++;
      try {
        const cleaned = cleanRowDetailed(values, schema, {
          source_file: oldJob.file_name, source_row: rowNo, ingest_batch: repairId,
        });
        stats.accepted_rows++;
        increment(stats.accepted_by_type, cleaned.row.id_type as string);
        cleaned.warnings.forEach((warning) => increment(stats.warnings_summary, warning));
        const hashFixed = cleaned.warnings.includes('id_card_hash_wrapper_removed');
        if (hashFixed) stats.hash_rows++;
        const key = documentKey(cleaned.row);
        const previous = candidates.get(key);
        candidates.set(key, {
          row: Object.fromEntries(Object.entries(cleaned.row).filter(([, value]) => value != null)) as unknown as IngestRow,
          source_rows: [...(previous?.source_rows ?? []), rowNo],
          hash_rows: [...(previous?.hash_rows ?? []), ...(hashFixed ? [rowNo] : [])],
          warnings: [...new Set([...(previous?.warnings ?? []), ...cleaned.warnings])],
        });
      } catch (error) {
        if (!(error instanceof CleaningError)) throw error;
        let reason = error.reason;
        const plain = raw.normalize('NFKC').toUpperCase().replace(/[\s-]/g, '');
        if (plain === 'NULL') reason = 'literal_NULL';
        else if (/^1[3-9]\d{9}$/.test(plain)) reason = 'mobile_number_in_document_column';
        else if (/^\d{8}$/.test(plain)) reason = 'short_number_requires_document_type';
        else if (reason === 'invalid_id_card_format' && /^[0-9A-Z]{8}[0-9X]$/.test(plain)) reason = 'invalid_organization_or_unsupported_document';
        increment(stats.remaining_reasons, reason);
      }
    }
    assert.equal(stats.total_scanned, Number(oldJob.total_rows), 'source row count differs');
    assert.equal(stats.legacy_rejected, Number(oldJob.skipped_rows), 'v4 rejected row count differs');
    for (const candidate of candidates.values()) {
      increment(stats.unique_by_type, candidate.row.id_type as string);
      if (candidate.hash_rows.length) stats.hash_unique++;
    }
    stats.unique_customers = candidates.size;
    stats.duplicate_rows = stats.accepted_rows - candidates.size;
    const manifest = [...candidates.values()].sort((a, b) => (a.row.source_row ?? 0) - (b.row.source_row ?? 0));
    await writeFile(join(output, 'manifest.ndjson'), manifest.map((item) => JSON.stringify(item)).join('\n') + '\n', { mode: 0o600 });
    await writeFile(join(output, 'preview.json'), JSON.stringify(stats, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ phase: 'preview', ...stats }));
    if (!apply) return;

    assert.equal(await prisma.ingestJob.count({
      where: { status: { in: ['PENDING', 'RUNNING'] }, job_id: { not: repairId } },
    }), 0, 'another import is active');
    const [column] = await prisma.$queryRaw<Array<{ ready: boolean }>>`
      SELECT EXISTS (SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'customer_identity' AND column_name = 'id_type') AS ready`;
    assert(column.ready, 'apply migration 005 before repair');
    const job = await prisma.ingestJob.upsert({
      where: { job_id: repairId },
      create: {
        job_id: repairId, retry_of: oldJobId, source_bucket: 'repair',
        file_name: oldJob.file_name, status: 'RUNNING', started_at: new Date(), report_json: json(stats),
      },
      update: { status: 'RUNNING', error: null, finished_at: null },
    });
    let inserted = Number(job.inserted_rows);
    let updated = Number(job.updated_rows);
    const service = new CustomerService(prisma);
    try {
      for (let start = 0; start < manifest.length; start += 500) {
        const batch = manifest.slice(start, start + 500).map((item) => item.row);
        const result = await service.upsertBatch(batch, {
          jobId: repairId, totalRows: stats.legacy_rejected, successRows: stats.accepted_rows,
          skippedRows: stats.legacy_rejected - stats.accepted_rows, duplicateRows: stats.duplicate_rows,
          insertedBeforeBatch: inserted, updatedBeforeBatch: updated,
          warnings: Object.values(stats.warnings_summary).reduce((a, b) => a + b, 0),
          checkpointRow: Math.min(start + batch.length, manifest.length),
        }, { actor: 'document-repair-v5', jobId: repairId });
        inserted += result.inserted;
        updated += result.updated;
        if (start % 5000 === 0) console.log(JSON.stringify({ phase: 'repair', processed: start + batch.length, inserted, updated }));
      }
      const [verified] = await prisma.$queryRaw<Array<{ linked: bigint }>>`
        SELECT count(*) AS linked FROM ingest_row_identity i
        JOIN customer c ON c.customer_id = i.customer_id AND c.ingest_month = i.ingest_month AND NOT c.is_deleted
        JOIN customer_identity ci ON ci.id_type = c.id_type AND ci.id_card = c.id_card
          AND ci.customer_id = c.customer_id AND ci.ingest_month = c.ingest_month
        WHERE i.ingest_batch = ${repairId}`;
      assert.equal(Number(verified.linked), manifest.length, 'repair identity verification failed');
      assert.equal(inserted + updated, manifest.length, 'repair write count differs');
      const result = { ...stats, inserted_rows: inserted, updated_rows: updated, verified_customers: Number(verified.linked) };
      await prisma.ingestJob.update({
        where: { job_id: repairId },
        data: { status: 'SUCCESS', finished_at: new Date(), report_json: json(result), warnings_json: json(stats.warnings_summary) },
      });
      await writeFile(join(output, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
      console.log(JSON.stringify({ phase: 'complete', ...result }));
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
