/**
 * Reparse the exact resident-ID rows from 1 (53).xlsx whose stored number contains U+2018.
 * Default is a read-only preview; --apply migrates the identity keys and updates all source fields
 * in one audited transaction.
 *
 * Run from apps/bff with DATABASE_URL:
 * pnpm exec tsx scripts/repair-left-quote-resident-ids.ts [--apply]
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  cleanRowDetailed,
  documentKey,
  loadSchema,
  streamXlsx,
} from '@leadops/ingest-service';
import type { Prisma } from '@prisma/client';
import { adaptPhoneAddressMappings, resolveImportLayout } from '../src/modules/customer-import.service';
import type { IngestRow } from '../src/modules/customer.service';
import { PrismaService } from '../src/prisma/prisma.service';

const SOURCE_JOB = '01M44XA9WHJEQFGE76S4CP2BK3';
const SOURCE_HASH = '595dc109186a87d05f7a46191df23ee62a7b6208d3ca7b3e188ff7e0a464d0bf';
const REPAIR_ID = `repair-left-quote-v8-${SOURCE_JOB}`;
const TARGET_COUNT = 839;
const LEFT_QUOTE = '\u2018';
const FIELDS = [
  'huji_no', 'name', 'gender', 'birth_date', 'id_type', 'id_card', 'phone_masked',
  'address', 'stat_time', 'province', 'city', 'district', 'occupation', 'education',
  'marital_status', 'source_file', 'source_row',
] as const;

interface CurrentRow {
  customer_id: string;
  ingest_month: Date;
  huji_no: string | null;
  name: string;
  gender: string | null;
  birth_date: Date | null;
  id_type: string;
  id_card: string | null;
  phone_masked: string | null;
  address: string | null;
  stat_time: Date | null;
  province: string | null;
  city: string | null;
  district: string | null;
  occupation: string | null;
  education: string | null;
  marital_status: string | null;
  source_file: string | null;
  source_row: number | null;
  ingest_batch: string | null;
}

interface RepairRow {
  customer_id: string;
  ingest_month: string;
  old_id_card: string;
  huji_no: string | null;
  name: string;
  gender: string | null;
  birth_date: string | null;
  id_type: string;
  id_card: string;
  phone_masked: string | null;
  address: string | null;
  stat_time: string | null;
  province: string | null;
  city: string | null;
  district: string | null;
  occupation: string | null;
  education: string | null;
  marital_status: string | null;
  source_file: string;
  source_row: number;
  ingest_batch: string;
}

const asJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

function comparable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return `${value}T00:00:00.000Z`;
  }
  return value ?? null;
}

function toRepairRow(current: CurrentRow, row: IngestRow): RepairRow {
  assert(current.id_card && current.id_card.includes(LEFT_QUOTE));
  assert(row.id_type === 'resident_id' && row.id_card && !row.id_card.includes(LEFT_QUOTE));
  assert(row.name && row.source_file && row.source_row);
  return {
    customer_id: current.customer_id,
    ingest_month: current.ingest_month.toISOString().slice(0, 10),
    old_id_card: current.id_card,
    huji_no: row.huji_no ?? null,
    name: row.name,
    gender: row.gender ?? null,
    birth_date: row.birth_date ?? null,
    id_type: row.id_type,
    id_card: row.id_card,
    phone_masked: row.phone_masked ?? null,
    address: row.address ?? null,
    stat_time: row.stat_time ?? null,
    province: row.province ?? null,
    city: row.city ?? null,
    district: row.district ?? null,
    occupation: row.occupation ?? null,
    education: row.education ?? null,
    marital_status: row.marital_status ?? null,
    source_file: row.source_file,
    source_row: row.source_row,
    ingest_batch: REPAIR_ID,
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const completed = await prisma.ingestJob.findUnique({ where: { job_id: REPAIR_ID } });
    if (completed?.status === 'SUCCESS') {
      const remaining = await prisma.customer.count({
        where: { is_deleted: false, id_type: 'resident_id', id_card: { contains: LEFT_QUOTE } },
      });
      assert.equal(remaining, 0, 'completed repair has remaining left-quote IDs');
      console.log(JSON.stringify({ phase: 'replay', job_id: REPAIR_ID, status: 'SUCCESS', remaining }));
      return;
    }

    const source = await prisma.ingestJob.findUniqueOrThrow({ where: { job_id: SOURCE_JOB } });
    assert.equal(source.file_name, '1 (53).xlsx');
    assert.equal(source.file_hash, SOURCE_HASH);
    assert(source.file_path && ['SUCCESS', 'SUPERSEDED'].includes(source.status));
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(source.file_path)) hash.update(chunk);
    assert.equal(hash.digest('hex'), SOURCE_HASH, 'source file changed');

    const current = await prisma.customer.findMany({
      where: { is_deleted: false, id_type: 'resident_id', id_card: { contains: LEFT_QUOTE } },
    }) as CurrentRow[];
    assert.equal(current.length, TARGET_COUNT, 'unexpected left-quote resident count');
    assert(current.every((row) =>
      row.source_file === source.file_name
      && row.ingest_batch === SOURCE_JOB
      && row.source_row != null
      && row.id_card?.includes(LEFT_QUOTE)));
    const currentBySourceRow = new Map(current.map((row) => [row.source_row as number, row]));
    assert.equal(currentBySourceRow.size, TARGET_COUNT, 'source rows must be unique');

    const base = loadSchema(resolve(__dirname, '../../ingest-service/configs/ingest-schema.yaml'));
    let layout: ReturnType<typeof resolveImportLayout> | undefined;
    const repairRows: RepairRow[] = [];
    const warnings: Record<string, number> = {};
    for await (const { rowNo, values } of streamXlsx(createReadStream(source.file_path), {
      sheetIndex: base.parse.sheet,
      skipHeaderRows: 0,
    })) {
      if (!layout) layout = resolveImportLayout(base, values);
      const old = currentBySourceRow.get(rowNo);
      if (!old) continue;
      const schema = adaptPhoneAddressMappings(layout.schema, values);
      const cleaned = cleanRowDetailed(values, schema, {
        source_file: source.file_name,
        source_row: rowNo,
        ingest_batch: REPAIR_ID,
      });
      assert(cleaned.warnings.includes('id_card_left_quote_removed'), `missing quote warning at row ${rowNo}`);
      for (const warning of cleaned.warnings) warnings[warning] = (warnings[warning] ?? 0) + 1;
      repairRows.push(toRepairRow(old, cleaned.row as IngestRow));
    }
    repairRows.sort((a, b) => a.source_row - b.source_row);
    assert.equal(repairRows.length, TARGET_COUNT, 'not all source rows were reparsed');
    assert.equal(new Set(repairRows.map((row) => documentKey(row))).size, TARGET_COUNT, 'normalized IDs collide');

    const newIdentities = await prisma.customerIdentity.findMany({
      where: { id_type: 'resident_id', id_card: { in: repairRows.map((row) => row.id_card) } },
    });
    assert.equal(newIdentities.length, 0, 'normalized identity already belongs to a customer');
    const oldIdentities = await prisma.customerIdentity.findMany({
      where: { id_type: 'resident_id', id_card: { in: repairRows.map((row) => row.old_id_card) } },
    });
    assert.equal(oldIdentities.length, TARGET_COUNT, 'old identity mapping count differs');
    const ownerKeys = new Set(current.map((row) =>
      `${row.customer_id}:${row.ingest_month.toISOString().slice(0, 10)}`));
    assert(oldIdentities.every((identity) =>
      ownerKeys.has(`${identity.customer_id}:${identity.ingest_month.toISOString().slice(0, 10)}`)),
    'old identity mapping owner differs');

    const changedByField = Object.fromEntries(FIELDS.map((field) => [field, 0])) as Record<string, number>;
    const addressChanges: Array<{ source_row: number; before: string | null; after: string | null }> = [];
    for (const row of repairRows) {
      const old = currentBySourceRow.get(row.source_row)!;
      for (const field of FIELDS) {
        if (comparable(old[field]) !== comparable(row[field])) changedByField[field]++;
      }
      if (old.address !== row.address) {
        addressChanges.push({ source_row: row.source_row, before: old.address, after: row.address });
      }
    }
    const stats = {
      pipeline_version: 8,
      job_id: REPAIR_ID,
      retry_of: SOURCE_JOB,
      file_name: source.file_name,
      source_hash: SOURCE_HASH,
      total_rows: TARGET_COUNT,
      success_rows: TARGET_COUNT,
      skipped_rows: 0,
      duplicate_rows: 0,
      inserted_rows: 0,
      updated_rows: TARGET_COUNT,
      changed_by_field: changedByField,
      warnings_summary: warnings,
      address_changes: addressChanges,
    };
    const output = resolve('.data', 'repairs', REPAIR_ID);
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(join(output, 'manifest.ndjson'),
      repairRows.map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    await writeFile(join(output, 'preview.json'), JSON.stringify(stats, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ phase: 'preview', ...stats }));
    if (!apply) return;

    assert.equal(await prisma.ingestJob.count({
      where: { status: { in: ['PENDING', 'RUNNING'] }, job_id: { not: REPAIR_ID } },
    }), 0, 'another import is active');
    assert.equal(await prisma.exportJob.count({
      where: { status: { in: ['PENDING', 'RUNNING'] } },
    }), 0, 'an export is active');
    await prisma.ingestJob.upsert({
      where: { job_id: REPAIR_ID },
      create: {
        job_id: REPAIR_ID,
        retry_of: SOURCE_JOB,
        source_bucket: 'repair',
        file_name: source.file_name,
        status: 'RUNNING',
        total_rows: TARGET_COUNT,
        success_rows: TARGET_COUNT,
        started_at: new Date(),
        report_json: asJson(stats),
      },
      update: {
        status: 'RUNNING',
        file_hash: null,
        error: null,
        finished_at: null,
        report_json: asJson(stats),
      },
    });

    try {
      await prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`
          CREATE TEMP TABLE left_quote_repair_stage (
            customer_id CHAR(26) NOT NULL,
            ingest_month DATE NOT NULL,
            old_id_card VARCHAR(32) NOT NULL,
            huji_no VARCHAR(32),
            name VARCHAR(64) NOT NULL,
            gender CHAR(1),
            birth_date DATE,
            id_type VARCHAR(32) NOT NULL,
            id_card VARCHAR(32) NOT NULL,
            phone_masked VARCHAR(64),
            address VARCHAR(256),
            stat_time TIMESTAMPTZ,
            province VARCHAR(32),
            city VARCHAR(64),
            district VARCHAR(64),
            occupation VARCHAR(64),
            education VARCHAR(32),
            marital_status VARCHAR(16),
            source_file VARCHAR(256) NOT NULL,
            source_row INT NOT NULL,
            ingest_batch VARCHAR(64) NOT NULL
          ) ON COMMIT DROP
        `);
        await tx.$executeRawUnsafe(`
          INSERT INTO left_quote_repair_stage
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
            customer_id CHAR(26), ingest_month DATE, old_id_card VARCHAR(32),
            huji_no VARCHAR(32), name VARCHAR(64), gender CHAR(1), birth_date DATE,
            id_type VARCHAR(32), id_card VARCHAR(32), phone_masked VARCHAR(64),
            address VARCHAR(256), stat_time TIMESTAMPTZ, province VARCHAR(32),
            city VARCHAR(64), district VARCHAR(64), occupation VARCHAR(64),
            education VARCHAR(32), marital_status VARCHAR(16), source_file VARCHAR(256),
            source_row INT, ingest_batch VARCHAR(64)
          )
        `, JSON.stringify(repairRows));
        const lockKeys = repairRows.flatMap((row) => [
          `document:resident_id:${row.old_id_card}`,
          `document:resident_id:${row.id_card}`,
        ]).sort();
        await tx.$executeRawUnsafe(`
          WITH keys AS MATERIALIZED (
            SELECT value AS key FROM jsonb_array_elements_text($1::jsonb) ORDER BY value
          )
          SELECT pg_advisory_xact_lock(hashtextextended(key, 0)) FROM keys ORDER BY key
        `, JSON.stringify(lockKeys));

        const before = await tx.$queryRawUnsafe<Record<string, unknown>[]>(`
          SELECT c.* FROM left_quote_repair_stage s
          JOIN customer c ON c.customer_id = s.customer_id AND c.ingest_month = s.ingest_month
          WHERE NOT c.is_deleted AND c.id_type = 'resident_id' AND c.id_card = s.old_id_card
          ORDER BY s.source_row
          FOR UPDATE OF c
        `);
        assert.equal(before.length, TARGET_COUNT, 'target rows changed after preview');
        const conflict = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(`
          SELECT count(*)::bigint AS count FROM left_quote_repair_stage s
          JOIN customer_identity ci ON ci.id_type = s.id_type AND ci.id_card = s.id_card
          WHERE ci.customer_id <> s.customer_id OR ci.ingest_month <> s.ingest_month
        `);
        assert.equal(Number(conflict[0].count), 0, 'normalized identity conflict appeared');

        const deletedIdentities = await tx.$executeRawUnsafe(`
          DELETE FROM customer_identity ci USING left_quote_repair_stage s
          WHERE ci.id_type = 'resident_id' AND ci.id_card = s.old_id_card
            AND ci.customer_id = s.customer_id AND ci.ingest_month = s.ingest_month
        `);
        assert.equal(deletedIdentities, TARGET_COUNT, 'old identity migration count differs');
        const updated = await tx.$executeRawUnsafe(`
          UPDATE customer c SET
            huji_no = s.huji_no, name = s.name, gender = s.gender,
            birth_date = s.birth_date, id_type = s.id_type, id_card = s.id_card,
            phone_masked = s.phone_masked, address = s.address, stat_time = s.stat_time,
            province = s.province, city = s.city, district = s.district,
            occupation = s.occupation, education = s.education,
            marital_status = s.marital_status, source_file = s.source_file,
            source_row = s.source_row, ingest_batch = s.ingest_batch,
            version = c.version + 1, updated_at = NOW()
          FROM left_quote_repair_stage s
          WHERE c.customer_id = s.customer_id AND c.ingest_month = s.ingest_month
            AND NOT c.is_deleted AND c.id_type = 'resident_id' AND c.id_card = s.old_id_card
        `);
        assert.equal(updated, TARGET_COUNT, 'customer update count differs');
        const insertedIdentities = await tx.$executeRawUnsafe(`
          INSERT INTO customer_identity (id_type, id_card, customer_id, ingest_month)
          SELECT id_type, id_card, customer_id, ingest_month FROM left_quote_repair_stage
        `);
        assert.equal(insertedIdentities, TARGET_COUNT, 'new identity migration count differs');

        const mismatches = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(`
          SELECT count(*)::bigint AS count FROM left_quote_repair_stage s
          JOIN customer c ON c.customer_id = s.customer_id AND c.ingest_month = s.ingest_month
          JOIN customer_identity ci ON ci.id_type = s.id_type AND ci.id_card = s.id_card
            AND ci.customer_id = s.customer_id AND ci.ingest_month = s.ingest_month
          WHERE c.is_deleted
             OR c.huji_no IS DISTINCT FROM s.huji_no OR c.name IS DISTINCT FROM s.name
             OR c.gender IS DISTINCT FROM s.gender OR c.birth_date IS DISTINCT FROM s.birth_date
             OR c.id_type IS DISTINCT FROM s.id_type OR c.id_card IS DISTINCT FROM s.id_card
             OR c.phone_masked IS DISTINCT FROM s.phone_masked OR c.address IS DISTINCT FROM s.address
             OR c.stat_time IS DISTINCT FROM s.stat_time OR c.province IS DISTINCT FROM s.province
             OR c.city IS DISTINCT FROM s.city OR c.district IS DISTINCT FROM s.district
             OR c.occupation IS DISTINCT FROM s.occupation OR c.education IS DISTINCT FROM s.education
             OR c.marital_status IS DISTINCT FROM s.marital_status
             OR c.source_file IS DISTINCT FROM s.source_file OR c.source_row IS DISTINCT FROM s.source_row
             OR c.ingest_batch IS DISTINCT FROM s.ingest_batch
        `);
        assert.equal(Number(mismatches[0].count), 0, 'post-update field verification failed');
        const after = await tx.$queryRawUnsafe<Record<string, unknown>[]>(`
          SELECT c.* FROM left_quote_repair_stage s
          JOIN customer c ON c.customer_id = s.customer_id AND c.ingest_month = s.ingest_month
          ORDER BY s.source_row
        `);
        assert.equal(after.length, TARGET_COUNT);
        await tx.auditLog.create({
          data: {
            actor: 'resident-id-left-quote-repair-v8',
            action: 'customer.repair_left_quote_ids',
            entity_type: 'ingest_job',
            entity_id: REPAIR_ID,
            before_data: asJson(before),
            after_data: asJson({ updated: TARGET_COUNT, customers: after }),
          },
        });
        await tx.ingestJob.update({
          where: { job_id: REPAIR_ID },
          data: {
            status: 'SUCCESS',
            written_rows: TARGET_COUNT,
            updated_rows: TARGET_COUNT,
            warnings: Object.values(warnings).reduce((sum, count) => sum + count, 0),
            checkpoint_row: TARGET_COUNT,
            warnings_json: asJson(warnings),
            report_json: asJson(stats),
            finished_at: new Date(),
          },
        });
      }, { maxWait: 15_000, timeout: 120_000 });
    } catch (error) {
      await prisma.ingestJob.update({
        where: { job_id: REPAIR_ID },
        data: {
          status: 'FAILED',
          error: error instanceof Error ? error.message : String(error),
          finished_at: new Date(),
        },
      });
      throw error;
    }

    await writeFile(join(output, 'result.json'), JSON.stringify(stats, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ phase: 'complete', ...stats }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: Error) => {
  console.error(error);
  process.exitCode = 1;
});
