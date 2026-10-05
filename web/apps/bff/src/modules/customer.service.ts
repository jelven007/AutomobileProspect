import { Inject, Injectable } from '@nestjs/common';
import { ulid } from 'ulid';
import type { Customer } from '@leadops/types';
import type { Prisma } from '@prisma/client';
import { documentKey, normalizeDocument } from '@leadops/ingest-service';
import { PrismaService } from '../prisma/prisma.service';

export interface IngestRow extends Partial<Customer> {
  name: string;
}

export interface IdentityConflict {
  huji_no: string;
  against: string;
  reason: 'id_card_conflict';
}

export interface UpsertBatchResult {
  inserted: number;
  updated: number;
  skipped: number;
  conflicts: IdentityConflict[];
}

export interface IngestProgress {
  jobId: string;
  totalRows: number;
  successRows: number;
  skippedRows: number;
  duplicateRows: number;
  insertedBeforeBatch: number;
  updatedBeforeBatch: number;
  warnings: number;
  checkpointRow: number;
}

interface StagedIngestRow {
  row_order: number;
  customer_id: string;
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
  source_file: string | null;
  source_row: number | null;
  ingest_batch: string | null;
  ingest_month: string;
}

interface CountResult {
  count: bigint | number;
}

const CREATE_STAGE_SQL = `
CREATE TEMP TABLE customer_ingest_stage (
  row_order INT PRIMARY KEY,
  customer_id CHAR(26) NOT NULL,
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
  source_file VARCHAR(256),
  source_row INT,
  ingest_batch VARCHAR(64),
  ingest_month DATE NOT NULL
) ON COMMIT DROP
`;

const LOAD_STAGE_SQL = `
INSERT INTO customer_ingest_stage
SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS x(
    row_order INT,
    customer_id CHAR(26),
    huji_no VARCHAR(32),
    name VARCHAR(64),
    gender CHAR(1),
    birth_date DATE,
    id_type VARCHAR(32),
    id_card VARCHAR(32),
    phone_masked VARCHAR(64),
    address VARCHAR(256),
    stat_time TIMESTAMPTZ,
    province VARCHAR(32),
    city VARCHAR(64),
    district VARCHAR(64),
    occupation VARCHAR(64),
    education VARCHAR(32),
    marital_status VARCHAR(16),
    source_file VARCHAR(256),
    source_row INT,
    ingest_batch VARCHAR(64),
    ingest_month DATE
  )
`;

const LOCK_KEYS_SQL = `
WITH keys AS MATERIALIZED (
  SELECT value AS key
    FROM jsonb_array_elements_text($1::jsonb)
   ORDER BY value
)
SELECT pg_advisory_xact_lock(hashtextextended(key, 0))
  FROM keys
 ORDER BY key
`;

const REMOVE_REPLAYED_ROWS_SQL = `
WITH removed AS (
  DELETE FROM customer_ingest_stage AS s
   USING ingest_row_identity AS i
   WHERE i.ingest_batch = s.ingest_batch
     AND i.source_file = s.source_file
     AND i.source_row = s.source_row
  RETURNING 1
)
SELECT count(*)::bigint AS count FROM removed
`;

const EXPECTED_UPDATES_SQL = `
SELECT count(*)::bigint AS count
  FROM customer_ingest_stage AS s
  JOIN customer_identity AS ci ON ci.id_type = s.id_type AND ci.id_card = s.id_card
`;

const UPDATE_EXISTING_SQL = `
UPDATE customer AS c
   SET huji_no = COALESCE(s.huji_no, c.huji_no),
       name = s.name,
       gender = COALESCE(s.gender, c.gender),
       birth_date = COALESCE(s.birth_date, c.birth_date),
       phone_masked = COALESCE(s.phone_masked, c.phone_masked),
       address = COALESCE(s.address, c.address),
       stat_time = COALESCE(s.stat_time, c.stat_time),
       province = COALESCE(s.province, c.province),
       city = COALESCE(s.city, c.city),
       district = COALESCE(s.district, c.district),
       occupation = COALESCE(s.occupation, c.occupation),
       education = COALESCE(s.education, c.education),
       marital_status = COALESCE(s.marital_status, c.marital_status),
       source_file = COALESCE(s.source_file, c.source_file),
       source_row = COALESCE(s.source_row, c.source_row),
       ingest_batch = COALESCE(s.ingest_batch, c.ingest_batch),
       version = c.version + 1,
       updated_at = NOW()
  FROM customer_ingest_stage AS s
  JOIN customer_identity AS ci ON ci.id_type = s.id_type AND ci.id_card = s.id_card
 WHERE c.customer_id = ci.customer_id
   AND c.ingest_month = ci.ingest_month
   AND c.is_deleted = FALSE
`;

const INSERT_NEW_SQL = `
INSERT INTO customer (
  customer_id, huji_no, name, gender, birth_date, id_type, id_card, phone_masked,
  address, stat_time, province, city, district, occupation, education,
  marital_status, source_file, source_row, ingest_batch, ingest_month
)
SELECT s.customer_id, s.huji_no, s.name, s.gender, s.birth_date, s.id_type, s.id_card,
       s.phone_masked, s.address, s.stat_time, s.province, s.city, s.district,
       s.occupation, s.education, s.marital_status, s.source_file, s.source_row,
       s.ingest_batch, s.ingest_month
  FROM customer_ingest_stage AS s
  LEFT JOIN customer_identity AS ci ON ci.id_type = s.id_type AND ci.id_card = s.id_card
 WHERE ci.id_card IS NULL
`;

const INSERT_CUSTOMER_IDENTITIES_SQL = `
INSERT INTO customer_identity (id_type, id_card, customer_id, ingest_month)
SELECT s.id_type, s.id_card, s.customer_id, s.ingest_month
  FROM customer_ingest_stage AS s
  LEFT JOIN customer_identity AS ci ON ci.id_type = s.id_type AND ci.id_card = s.id_card
 WHERE ci.id_card IS NULL
`;

const INSERT_SOURCE_IDENTITIES_SQL = `
INSERT INTO ingest_row_identity (
  ingest_batch, source_file, source_row, customer_id, ingest_month
)
SELECT s.ingest_batch,
       s.source_file,
       s.source_row,
       COALESCE(ci.customer_id, s.customer_id),
       COALESCE(ci.ingest_month, s.ingest_month)
  FROM customer_ingest_stage AS s
  LEFT JOIN customer_identity AS ci ON ci.id_type = s.id_type AND ci.id_card = s.id_card
 WHERE s.ingest_batch IS NOT NULL
   AND s.source_file IS NOT NULL
   AND s.source_row IS NOT NULL
`;

export function toCustomer(row: Record<string, unknown>): Customer {
  const birth = row.birth_date as Date | null | undefined;
  const stat = row.stat_time as Date | null | undefined;
  const created = row.created_at as Date | null | undefined;
  const updated = row.updated_at as Date | null | undefined;
  return {
    customer_id: row.customer_id as string,
    huji_no: (row.huji_no as string | null) ?? undefined,
    name: row.name as string,
    gender: (row.gender as 'M' | 'F' | 'U' | null) ?? undefined,
    birth_date: birth ? birth.toISOString().slice(0, 10) : undefined,
    id_type: (row.id_type as string | undefined) ?? 'resident_id',
    id_card: (row.id_card as string | null) ?? undefined,
    phone_masked: (row.phone_masked as string | null) ?? undefined,
    address: (row.address as string | null) ?? undefined,
    stat_time: stat ? stat.toISOString() : undefined,
    province: (row.province as string | null) ?? undefined,
    city: (row.city as string | null) ?? undefined,
    district: (row.district as string | null) ?? undefined,
    occupation: (row.occupation as string | null) ?? undefined,
    education: (row.education as string | null) ?? undefined,
    marital_status: (row.marital_status as string | null) ?? undefined,
    source_file: (row.source_file as string | null) ?? undefined,
    source_row: (row.source_row as number | null) ?? undefined,
    ingest_batch: (row.ingest_batch as string | null) ?? undefined,
    version: (row.version as number) ?? 1,
    is_deleted: (row.is_deleted as boolean) ?? false,
    created_at: created ? created.toISOString() : new Date().toISOString(),
    updated_at: updated ? updated.toISOString() : new Date().toISOString(),
  };
}

export function deriveIngestMonth(_statIso?: string | null): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function sourceLockKey(row: StagedIngestRow): string | null {
  if (!row.ingest_batch || !row.source_file || row.source_row == null) return null;
  return `source:${JSON.stringify([row.ingest_batch, row.source_file, row.source_row])}`;
}

function prepareRows(rows: IngestRow[]): StagedIngestRow[] {
  const byIdCard = new Map<string, { row: IngestRow; index: number }>();
  rows.forEach((row, index) => {
    const document = normalizeDocument(row.id_card, row.id_type);
    if (document.error) throw new Error(document.error);
    const normalized = { ...row, id_type: document.type, id_card: document.value };
    byIdCard.set(documentKey(normalized), { row: normalized, index });
  });

  const ingestMonth = deriveIngestMonth().toISOString().slice(0, 10);
  return [...byIdCard.values()]
    .sort((left, right) => left.index - right.index)
    .map(({ row, index }) => ({
      row_order: index,
      customer_id: ulid(),
      huji_no: optionalString(row.huji_no),
      name: row.name,
      gender: optionalString(row.gender),
      birth_date: optionalString(row.birth_date),
      id_type: row.id_type as string,
      id_card: optionalString(row.id_card) as string,
      phone_masked: optionalString(row.phone_masked),
      address: optionalString(row.address),
      stat_time: optionalString(row.stat_time),
      province: optionalString(row.province),
      city: optionalString(row.city),
      district: optionalString(row.district),
      occupation: optionalString(row.occupation),
      education: optionalString(row.education),
      marital_status: optionalString(row.marital_status),
      source_file: optionalString(row.source_file),
      source_row: row.source_row ?? null,
      ingest_batch: optionalString(row.ingest_batch),
      ingest_month: ingestMonth,
    }));
}

function countOf(rows: CountResult[]): number {
  return Number(rows[0]?.count ?? 0);
}

@Injectable()
export class CustomerService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async upsertFromIngest(row: IngestRow): Promise<'insert' | 'update'> {
    const result = await this.upsertBatch([row]);
    return result.inserted === 1 ? 'insert' : 'update';
  }

  /** 证件类型 + 号码是唯一合并依据；编码编号仅作为普通字段保存。 */
  async upsertBatch(
    rows: IngestRow[],
    progress?: IngestProgress,
    repairAudit?: { actor: string; jobId: string },
  ): Promise<UpsertBatchResult> {
    if (rows.length === 0) {
      return { inserted: 0, updated: 0, skipped: 0, conflicts: [] };
    }
    const stagedRows = prepareRows(rows);
    const lockKeys = [...new Set(stagedRows.flatMap((row) => {
      const keys = [`document:${documentKey(row)}`];
      const source = sourceLockKey(row);
      if (source) keys.push(source);
      return keys;
    }))].sort();

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(LOCK_KEYS_SQL, JSON.stringify(lockKeys));
      await tx.$executeRawUnsafe(CREATE_STAGE_SQL);
      await tx.$executeRawUnsafe(LOAD_STAGE_SQL, JSON.stringify(stagedRows));

      const skipped = countOf(
        await tx.$queryRawUnsafe<CountResult[]>(REMOVE_REPLAYED_ROWS_SQL),
      );
      const expectedUpdates = countOf(
        await tx.$queryRawUnsafe<CountResult[]>(EXPECTED_UPDATES_SQL),
      );
      // Repair snapshots and writes share the same identity locks and transaction.
      const snapshotSql = `
        SELECT c.* FROM customer_ingest_stage s
        JOIN customer_identity ci ON ci.id_type = s.id_type AND ci.id_card = s.id_card
        JOIN customer c ON c.customer_id = ci.customer_id AND c.ingest_month = ci.ingest_month
      `;
      const before = repairAudit
        ? await tx.$queryRawUnsafe<Record<string, unknown>[]>(snapshotSql)
        : [];
      const updated = await tx.$executeRawUnsafe(UPDATE_EXISTING_SQL);
      if (updated !== expectedUpdates) {
        throw new Error('customer_identity_target_missing');
      }
      const inserted = await tx.$executeRawUnsafe(INSERT_NEW_SQL);
      await tx.$executeRawUnsafe(INSERT_CUSTOMER_IDENTITIES_SQL);
      await tx.$executeRawUnsafe(INSERT_SOURCE_IDENTITIES_SQL);

      const remaining = stagedRows.length - skipped;
      if (inserted + updated !== remaining) {
        throw new Error(`ingest_batch_write_mismatch:${remaining}:${inserted + updated}`);
      }
      if (repairAudit && remaining > 0) {
        const after = await tx.$queryRawUnsafe<Record<string, unknown>[]>(snapshotSql);
        await tx.auditLog.create({
          data: {
            actor: repairAudit.actor,
            action: 'customer.repair_documents',
            entity_type: 'ingest_job',
            entity_id: repairAudit.jobId,
            before_data: JSON.parse(JSON.stringify(before)) as Prisma.InputJsonValue,
            after_data: JSON.parse(JSON.stringify({ inserted, updated, customers: after })) as Prisma.InputJsonValue,
          },
        });
      }

      if (progress) {
        await tx.ingestJob.update({
          where: { job_id: progress.jobId },
          data: {
            status: 'RUNNING',
            total_rows: progress.totalRows,
            success_rows: progress.successRows,
            skipped_rows: progress.skippedRows,
            duplicate_rows: progress.duplicateRows,
            inserted_rows: progress.insertedBeforeBatch + inserted,
            updated_rows: progress.updatedBeforeBatch + updated,
            written_rows: progress.insertedBeforeBatch + progress.updatedBeforeBatch + inserted + updated,
            warnings: progress.warnings,
            checkpoint_row: progress.checkpointRow,
            updated_at: new Date(),
          },
        });
      }

      return { inserted, updated, skipped, conflicts: [] };
    }, { maxWait: 15_000, timeout: 120_000 });
  }
}
