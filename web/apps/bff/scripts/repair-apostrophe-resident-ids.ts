/**
 * Repair resident IDs from 1 (22).xlsx that contain an ASCII apostrophe.
 * Preview is read-only. --apply performs identity migration, duplicate merging,
 * invalid-row soft deletion, source-lineage migration, and auditing.
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  CleaningError,
  cleanRowDetailed,
  documentKey,
  loadSchema,
  streamXlsx,
} from '@leadops/ingest-service';
import type { Customer, Prisma } from '@prisma/client';
import { adaptPhoneAddressMappings, resolveImportLayout } from '../src/modules/customer-import.service';
import type { IngestRow } from '../src/modules/customer.service';
import { PrismaService } from '../src/prisma/prisma.service';

const SOURCE_JOB = '01M43ZV6X512NB6J8N8M9W8Q4Y';
const SOURCE_FILE = '1 (22).xlsx';
const SOURCE_HASH = '387d3abb7c26a433e4773071f5472b2bce46d40bad5b3bd55feafac293b7267f';
const REPAIR_ID = `repair-apostrophe-v9-${SOURCE_JOB}`;
const TARGET_COUNT = 7161;
const VALID_COUNT = 7158;
const INVALID_COUNT = 3;
const CONFLICT_COUNT = 312;
const QUOTE_PATTERN = /[\u0027\u2018\u2019\uFF07]/;
const REPARSED_FIELDS = [
  'huji_no', 'name', 'gender', 'birth_date', 'id_type', 'id_card', 'phone_masked',
  'address', 'stat_time', 'province', 'city', 'district', 'occupation', 'education',
  'marital_status', 'source_file', 'source_row',
] as const;

type RepairAction = 'update_in_place' | 'keep_quote' | 'keep_existing';

interface Candidate {
  current: Customer;
  row: IngestRow;
  warnings: string[];
}

interface ValidStageRow {
  action: RepairAction;
  quote_customer_id: string;
  quote_ingest_month: string;
  old_id_card: string;
  survivor_customer_id: string;
  survivor_ingest_month: string;
  loser_customer_id: string | null;
  loser_ingest_month: string | null;
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

interface InvalidStageRow {
  customer_id: string;
  ingest_month: string;
  old_id_card: string;
  source_row: number;
  reason: string;
}

const asJson = (value: unknown): Prisma.InputJsonValue =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

function ownerKey(row: { customer_id: string; ingest_month: Date }): string {
  return `${row.customer_id}:${row.ingest_month.toISOString().slice(0, 10)}`;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function quoteRowWins(quote: Customer, existing: Customer): boolean {
  const createdDiff = quote.created_at.getTime() - existing.created_at.getTime();
  return createdDiff < 0 || (createdDiff === 0 && quote.customer_id < existing.customer_id);
}

function toStage(
  candidate: Candidate,
  existing: Customer | undefined,
): ValidStageRow {
  const { current, row } = candidate;
  assert(current.id_card && QUOTE_PATTERN.test(current.id_card));
  assert(row.id_type === 'resident_id' && row.id_card && !QUOTE_PATTERN.test(row.id_card));
  assert(row.name && row.source_file && row.source_row);
  let action: RepairAction = 'update_in_place';
  let survivor = current;
  let loser: Customer | undefined;
  if (existing) {
    if (quoteRowWins(current, existing)) {
      action = 'keep_quote';
      loser = existing;
    } else {
      action = 'keep_existing';
      survivor = existing;
      loser = current;
    }
  }
  return {
    action,
    quote_customer_id: current.customer_id,
    quote_ingest_month: dateOnly(current.ingest_month),
    old_id_card: current.id_card,
    survivor_customer_id: survivor.customer_id,
    survivor_ingest_month: dateOnly(survivor.ingest_month),
    loser_customer_id: loser?.customer_id ?? null,
    loser_ingest_month: loser ? dateOnly(loser.ingest_month) : null,
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
        where: {
          is_deleted: false,
          id_type: 'resident_id',
          OR: [
            { id_card: { contains: '\u0027' } },
            { id_card: { contains: '\u2018' } },
            { id_card: { contains: '\u2019' } },
            { id_card: { contains: '\uFF07' } },
          ],
        },
      });
      assert.equal(remaining, 0, 'completed repair has remaining quote characters');
      console.log(JSON.stringify({ phase: 'replay', job_id: REPAIR_ID, status: 'SUCCESS', remaining }));
      return;
    }

    const source = await prisma.ingestJob.findUniqueOrThrow({ where: { job_id: SOURCE_JOB } });
    assert.equal(source.file_name, SOURCE_FILE);
    assert.equal(source.file_hash, SOURCE_HASH);
    assert(source.file_path && ['SUCCESS', 'SUPERSEDED'].includes(source.status));
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(source.file_path)) hash.update(chunk);
    assert.equal(hash.digest('hex'), SOURCE_HASH, 'source file changed');

    const current = await prisma.customer.findMany({
      where: {
        is_deleted: false,
        id_type: 'resident_id',
        OR: [
          { id_card: { contains: '\u0027' } },
          { id_card: { contains: '\u2018' } },
          { id_card: { contains: '\u2019' } },
          { id_card: { contains: '\uFF07' } },
        ],
      },
    });
    assert.equal(current.length, TARGET_COUNT, 'unexpected quote-containing resident count');
    assert(current.every((row) =>
      row.source_file === SOURCE_FILE
      && row.ingest_batch === SOURCE_JOB
      && row.source_row != null
      && row.id_card
      && QUOTE_PATTERN.test(row.id_card)));
    const currentBySourceRow = new Map(current.map((row) => [row.source_row as number, row]));
    assert.equal(currentBySourceRow.size, TARGET_COUNT, 'source rows must be unique');

    const base = loadSchema(resolve(__dirname, '../../ingest-service/configs/ingest-schema.yaml'));
    let layout: ReturnType<typeof resolveImportLayout> | undefined;
    const candidates: Candidate[] = [];
    const invalid: InvalidStageRow[] = [];
    const warnings: Record<string, number> = {};
    for await (const { rowNo, values } of streamXlsx(createReadStream(source.file_path), {
      sheetIndex: base.parse.sheet,
      skipHeaderRows: 0,
    })) {
      if (!layout) layout = resolveImportLayout(base, values);
      const old = currentBySourceRow.get(rowNo);
      if (!old) continue;
      try {
        const schema = adaptPhoneAddressMappings(layout.schema, values);
        const cleaned = cleanRowDetailed(values, schema, {
          source_file: SOURCE_FILE,
          source_row: rowNo,
          ingest_batch: REPAIR_ID,
        });
        assert(cleaned.warnings.includes('id_card_quote_removed'), `missing quote warning at row ${rowNo}`);
        if (rowNo === 69456) {
          assert.equal(cleaned.row.id_card, '665965196506216263');
          assert(cleaned.row.address?.startsWith('福建省泉州市晋江市'));
          cleaned.row.province = '福建省';
          cleaned.row.city = '泉州市';
          cleaned.row.district = '晋江市';
          cleaned.warnings.push('region_recovered_from_address');
        }
        for (const warning of cleaned.warnings) warnings[warning] = (warnings[warning] ?? 0) + 1;
        candidates.push({ current: old, row: cleaned.row as IngestRow, warnings: cleaned.warnings });
      } catch (error) {
        if (!(error instanceof CleaningError)) throw error;
        invalid.push({
          customer_id: old.customer_id,
          ingest_month: dateOnly(old.ingest_month),
          old_id_card: old.id_card as string,
          source_row: rowNo,
          reason: error.reason,
        });
      }
    }
    assert.equal(candidates.length, VALID_COUNT, 'valid repaired row count differs');
    assert.equal(invalid.length, INVALID_COUNT, 'invalid repaired row count differs');
    const normalizedIds = candidates.map((candidate) => candidate.row.id_card as string);
    assert.equal(new Set(normalizedIds).size, VALID_COUNT, 'normalized IDs collide within source rows');

    const existingIdentities = await prisma.customerIdentity.findMany({
      where: { id_type: 'resident_id', id_card: { in: normalizedIds } },
    });
    assert.equal(existingIdentities.length, CONFLICT_COUNT, 'normalized conflict count differs');
    const existingCustomers = await prisma.customer.findMany({
      where: {
        OR: existingIdentities.map((identity) => ({
          customer_id: identity.customer_id,
          ingest_month: identity.ingest_month,
        })),
      },
    });
    assert.equal(existingCustomers.length, CONFLICT_COUNT, 'conflict target count differs');
    assert(existingCustomers.every((row) => !row.is_deleted), 'conflict target must be active');
    const existingByOwner = new Map(existingCustomers.map((row) => [ownerKey(row), row]));
    const identityByDocument = new Map(existingIdentities.map((identity) => [
      identity.id_card,
      existingByOwner.get(ownerKey(identity)),
    ]));
    assert([...identityByDocument.values()].every(Boolean), 'conflict identity target missing');

    const stage = candidates.map((candidate) =>
      toStage(candidate, identityByDocument.get(candidate.row.id_card as string)));
    const actionCounts = stage.reduce((counts, row) => {
      counts[row.action] = (counts[row.action] ?? 0) + 1;
      return counts;
    }, {} as Record<RepairAction, number>);
    assert.equal(actionCounts.update_in_place, 6846);
    assert.equal(actionCounts.keep_quote, 208);
    assert.equal(actionCounts.keep_existing, 104);

    const oldIdentities = await prisma.customerIdentity.findMany({
      where: { id_type: 'resident_id', id_card: { in: current.map((row) => row.id_card as string) } },
    });
    assert.equal(oldIdentities.length, TARGET_COUNT, 'old identity mapping count differs');
    const currentOwners = new Set(current.map(ownerKey));
    assert(oldIdentities.every((identity) => currentOwners.has(ownerKey(identity))),
      'old identity mapping owner differs');
    const affectedIds = new Set([
      ...current.map((row) => row.customer_id),
      ...existingCustomers.map((row) => row.customer_id),
    ]);
    const affectedIdentityCount = await prisma.customerIdentity.count({
      where: { customer_id: { in: [...affectedIds] } },
    });
    assert.equal(affectedIdentityCount, TARGET_COUNT + CONFLICT_COUNT,
      'affected customers must each have one identity');

    const changedByField = Object.fromEntries(
      REPARSED_FIELDS.map((field) => [field, 0]),
    ) as Record<string, number>;
    for (const item of stage) {
      if (item.action === 'keep_existing') continue;
      const old = currentBySourceRow.get(item.source_row)!;
      for (const field of REPARSED_FIELDS) {
        const before = old[field];
        const after = item[field];
        const beforeValue = before instanceof Date ? before.toISOString().slice(0, 10) : before ?? null;
        const afterValue = typeof after === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(after)
          ? after
          : after ?? null;
        if (beforeValue !== afterValue) changedByField[field]++;
      }
    }
    const checksumWarnings = warnings.id_card_checksum_invalid ?? 0;
    const stats = {
      pipeline_version: 9,
      job_id: REPAIR_ID,
      retry_of: SOURCE_JOB,
      file_name: SOURCE_FILE,
      source_hash: SOURCE_HASH,
      total_rows: TARGET_COUNT,
      valid_rows: VALID_COUNT,
      invalid_rows: invalid.length,
      duplicate_rows: CONFLICT_COUNT,
      update_in_place: actionCounts.update_in_place,
      duplicate_keep_quote: actionCounts.keep_quote,
      duplicate_keep_existing: actionCounts.keep_existing,
      soft_delete_rows: CONFLICT_COUNT + INVALID_COUNT,
      normalized_identity_count: VALID_COUNT,
      checksum_warnings: checksumWarnings,
      changed_by_field: changedByField,
      warnings_summary: warnings,
      invalid_details: invalid.map(({ source_row, old_id_card, reason }) => ({
        source_row,
        old_id_card,
        reason,
      })),
    };
    const output = resolve('.data', 'repairs', REPAIR_ID);
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(join(output, 'manifest.ndjson'),
      stage.map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
    await writeFile(join(output, 'invalid.ndjson'),
      invalid.map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
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
        file_name: SOURCE_FILE,
        status: 'RUNNING',
        total_rows: TARGET_COUNT,
        success_rows: VALID_COUNT,
        skipped_rows: INVALID_COUNT,
        duplicate_rows: CONFLICT_COUNT,
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
          CREATE TEMP TABLE apostrophe_repair_stage (
            action VARCHAR(32) NOT NULL,
            quote_customer_id CHAR(26) NOT NULL,
            quote_ingest_month DATE NOT NULL,
            old_id_card VARCHAR(32) NOT NULL,
            survivor_customer_id CHAR(26) NOT NULL,
            survivor_ingest_month DATE NOT NULL,
            loser_customer_id CHAR(26),
            loser_ingest_month DATE,
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
          INSERT INTO apostrophe_repair_stage
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
            action VARCHAR(32), quote_customer_id CHAR(26), quote_ingest_month DATE,
            old_id_card VARCHAR(32), survivor_customer_id CHAR(26),
            survivor_ingest_month DATE, loser_customer_id CHAR(26), loser_ingest_month DATE,
            huji_no VARCHAR(32), name VARCHAR(64), gender CHAR(1), birth_date DATE,
            id_type VARCHAR(32), id_card VARCHAR(32), phone_masked VARCHAR(64),
            address VARCHAR(256), stat_time TIMESTAMPTZ, province VARCHAR(32),
            city VARCHAR(64), district VARCHAR(64), occupation VARCHAR(64),
            education VARCHAR(32), marital_status VARCHAR(16), source_file VARCHAR(256),
            source_row INT, ingest_batch VARCHAR(64)
          )
        `, JSON.stringify(stage));
        await tx.$executeRawUnsafe(`
          CREATE TEMP TABLE apostrophe_invalid_stage (
            customer_id CHAR(26) NOT NULL,
            ingest_month DATE NOT NULL,
            old_id_card VARCHAR(32) NOT NULL,
            source_row INT NOT NULL,
            reason VARCHAR(64) NOT NULL
          ) ON COMMIT DROP
        `);
        await tx.$executeRawUnsafe(`
          INSERT INTO apostrophe_invalid_stage
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
            customer_id CHAR(26), ingest_month DATE, old_id_card VARCHAR(32),
            source_row INT, reason VARCHAR(64)
          )
        `, JSON.stringify(invalid));
        await tx.$executeRawUnsafe(`
          LOCK TABLE customer_identity, customer, ingest_row_identity
          IN SHARE ROW EXCLUSIVE MODE
        `);

        const before = await tx.$queryRawUnsafe<Record<string, unknown>[]>(`
          WITH affected AS (
            SELECT quote_customer_id AS customer_id, quote_ingest_month AS ingest_month
              FROM apostrophe_repair_stage
            UNION
            SELECT survivor_customer_id, survivor_ingest_month FROM apostrophe_repair_stage
            UNION
            SELECT loser_customer_id, loser_ingest_month FROM apostrophe_repair_stage
              WHERE loser_customer_id IS NOT NULL
            UNION
            SELECT customer_id, ingest_month FROM apostrophe_invalid_stage
          )
          SELECT c.* FROM affected a
          JOIN customer c ON c.customer_id = a.customer_id AND c.ingest_month = a.ingest_month
          ORDER BY c.customer_id
          FOR UPDATE OF c
        `);
        assert.equal(before.length, TARGET_COUNT + CONFLICT_COUNT, 'affected customer count changed');
        assert(before.every((row) => row.is_deleted === false), 'affected customer is already deleted');
        const quoteTargets = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(`
          SELECT count(*)::bigint AS count FROM (
            SELECT s.quote_customer_id, s.quote_ingest_month, s.old_id_card
              FROM apostrophe_repair_stage s
            UNION ALL
            SELECT i.customer_id, i.ingest_month, i.old_id_card
              FROM apostrophe_invalid_stage i
          ) q
          JOIN customer c ON c.customer_id = q.quote_customer_id
            AND c.ingest_month = q.quote_ingest_month
            AND c.id_card = q.old_id_card AND NOT c.is_deleted
        `);
        assert.equal(Number(quoteTargets[0].count), TARGET_COUNT, 'quote targets changed after preview');
        const conflicts = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(`
          SELECT count(*)::bigint AS count FROM apostrophe_repair_stage s
          JOIN customer_identity ci ON ci.id_type = s.id_type AND ci.id_card = s.id_card
          WHERE s.action <> 'update_in_place'
            AND ci.customer_id <> s.quote_customer_id
        `);
        assert.equal(Number(conflicts[0].count), CONFLICT_COUNT, 'identity conflicts changed after preview');

        const deletedOld = await tx.$executeRawUnsafe(`
          DELETE FROM customer_identity ci USING (
            SELECT quote_customer_id, quote_ingest_month, old_id_card
              FROM apostrophe_repair_stage
            UNION ALL
            SELECT customer_id, ingest_month, old_id_card FROM apostrophe_invalid_stage
          ) q
          WHERE ci.id_type = 'resident_id' AND ci.id_card = q.old_id_card
            AND ci.customer_id = q.quote_customer_id AND ci.ingest_month = q.quote_ingest_month
        `);
        assert.equal(deletedOld, TARGET_COUNT, 'old identity deletion count differs');
        const deletedConflicts = await tx.$executeRawUnsafe(`
          DELETE FROM customer_identity ci USING apostrophe_repair_stage s
          WHERE s.action <> 'update_in_place'
            AND ci.id_type = s.id_type AND ci.id_card = s.id_card
        `);
        assert.equal(deletedConflicts, CONFLICT_COUNT, 'conflict identity deletion count differs');

        await tx.$executeRawUnsafe(`
          UPDATE ingest_row_identity i
             SET customer_id = s.survivor_customer_id,
                 ingest_month = s.survivor_ingest_month
            FROM apostrophe_repair_stage s
           WHERE s.loser_customer_id IS NOT NULL
             AND i.customer_id = s.loser_customer_id
             AND i.ingest_month = s.loser_ingest_month
        `);
        const deletedDuplicates = await tx.$executeRawUnsafe(`
          UPDATE customer c
             SET is_deleted = TRUE, version = c.version + 1, updated_at = NOW()
            FROM apostrophe_repair_stage s
           WHERE s.loser_customer_id IS NOT NULL
             AND c.customer_id = s.loser_customer_id
             AND c.ingest_month = s.loser_ingest_month
             AND NOT c.is_deleted
        `);
        assert.equal(deletedDuplicates, CONFLICT_COUNT, 'duplicate soft-delete count differs');
        const deletedInvalid = await tx.$executeRawUnsafe(`
          UPDATE customer c
             SET is_deleted = TRUE, version = c.version + 1, updated_at = NOW()
            FROM apostrophe_invalid_stage i
           WHERE c.customer_id = i.customer_id AND c.ingest_month = i.ingest_month
             AND NOT c.is_deleted
        `);
        assert.equal(deletedInvalid, INVALID_COUNT, 'invalid soft-delete count differs');

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
          FROM apostrophe_repair_stage s
          WHERE s.action IN ('update_in_place', 'keep_quote')
            AND c.customer_id = s.quote_customer_id
            AND c.ingest_month = s.quote_ingest_month
            AND NOT c.is_deleted AND c.id_card = s.old_id_card
        `);
        assert.equal(updated, actionCounts.update_in_place + actionCounts.keep_quote,
          'reparsed customer update count differs');
        const insertedIdentities = await tx.$executeRawUnsafe(`
          INSERT INTO customer_identity (id_type, id_card, customer_id, ingest_month)
          SELECT id_type, id_card, survivor_customer_id, survivor_ingest_month
            FROM apostrophe_repair_stage
        `);
        assert.equal(insertedIdentities, VALID_COUNT, 'normalized identity insertion count differs');

        const sourceLinks = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(`
          SELECT count(*)::bigint AS count FROM apostrophe_repair_stage s
          JOIN ingest_row_identity i ON i.ingest_batch = $1
            AND i.source_file = s.source_file AND i.source_row = s.source_row
            AND i.customer_id = s.survivor_customer_id
            AND i.ingest_month = s.survivor_ingest_month
        `, SOURCE_JOB);
        assert.equal(Number(sourceLinks[0].count), VALID_COUNT, 'source lineage migration failed');
        const mismatches = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(`
          SELECT count(*)::bigint AS count FROM apostrophe_repair_stage s
          JOIN customer c ON c.customer_id = s.quote_customer_id
            AND c.ingest_month = s.quote_ingest_month
          WHERE s.action IN ('update_in_place', 'keep_quote')
            AND (
              c.is_deleted
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
            )
        `);
        assert.equal(Number(mismatches[0].count), 0, 'reparsed customer field verification failed');
        const linked = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(`
          SELECT count(*)::bigint AS count FROM apostrophe_repair_stage s
          JOIN customer c ON c.customer_id = s.survivor_customer_id
            AND c.ingest_month = s.survivor_ingest_month AND NOT c.is_deleted
          JOIN customer_identity ci ON ci.id_type = s.id_type AND ci.id_card = s.id_card
            AND ci.customer_id = s.survivor_customer_id
            AND ci.ingest_month = s.survivor_ingest_month
        `);
        assert.equal(Number(linked[0].count), VALID_COUNT, 'normalized identity verification failed');
        const remaining = await tx.customer.count({
          where: {
            is_deleted: false,
            id_type: 'resident_id',
            OR: [
              { id_card: { contains: '\u0027' } },
              { id_card: { contains: '\u2018' } },
              { id_card: { contains: '\u2019' } },
              { id_card: { contains: '\uFF07' } },
            ],
          },
        });
        assert.equal(remaining, 0, 'quote-containing resident IDs remain');
        const otherProvince = await tx.$queryRawUnsafe<Array<{ count: bigint }>>(`
          SELECT count(*)::bigint AS count FROM apostrophe_repair_stage s
          JOIN customer c ON c.customer_id = s.survivor_customer_id
            AND c.ingest_month = s.survivor_ingest_month AND NOT c.is_deleted
          WHERE c.province IS NULL OR c.province = '' OR c.province = '其他'
        `);
        assert.equal(Number(otherProvince[0].count), 0, 'repaired survivor still has an unknown province');

        const after = await tx.$queryRawUnsafe<Record<string, unknown>[]>(`
          WITH affected AS (
            SELECT quote_customer_id AS customer_id, quote_ingest_month AS ingest_month
              FROM apostrophe_repair_stage
            UNION
            SELECT survivor_customer_id, survivor_ingest_month FROM apostrophe_repair_stage
            UNION
            SELECT loser_customer_id, loser_ingest_month FROM apostrophe_repair_stage
              WHERE loser_customer_id IS NOT NULL
            UNION
            SELECT customer_id, ingest_month FROM apostrophe_invalid_stage
          )
          SELECT c.* FROM affected a
          JOIN customer c ON c.customer_id = a.customer_id AND c.ingest_month = a.ingest_month
          ORDER BY c.customer_id
        `);
        assert.equal(after.length, TARGET_COUNT + CONFLICT_COUNT);
        await tx.auditLog.create({
          data: {
            actor: 'resident-id-apostrophe-repair-v9',
            action: 'customer.repair_apostrophe_ids',
            entity_type: 'ingest_job',
            entity_id: REPAIR_ID,
            before_data: asJson(before),
            after_data: asJson({ ...stats, customers: after }),
          },
        });
        await tx.ingestJob.update({
          where: { job_id: REPAIR_ID },
          data: {
            status: 'SUCCESS',
            success_rows: VALID_COUNT,
            skipped_rows: INVALID_COUNT,
            duplicate_rows: CONFLICT_COUNT,
            written_rows: actionCounts.update_in_place + actionCounts.keep_quote,
            updated_rows: actionCounts.update_in_place + actionCounts.keep_quote,
            warnings: Object.values(warnings).reduce((sum, count) => sum + count, 0),
            checkpoint_row: TARGET_COUNT,
            warnings_json: asJson(warnings),
            report_json: asJson(stats),
            finished_at: new Date(),
          },
        });
      }, { maxWait: 15_000, timeout: 180_000 });
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
