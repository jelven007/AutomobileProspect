import { Pool } from 'pg';
import { ulid } from 'ulid';
import type { CustomerRow } from './types';
import { documentKey, normalizeDocument } from './document';

export interface SinkStats {
  inserted: number;
  updated: number;
  skipped: number;
  duplicateRows: number;
  conflictWarnings: number;
}

interface StagedRow extends Omit<CustomerRow, 'huji_no'> {
  customer_id: string;
  huji_no: string | null;
  ingest_month: string;
}

const CREATE_STAGE_SQL = `
CREATE TEMP TABLE ingest_stage (
  customer_id VARCHAR(26) NOT NULL,
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
INSERT INTO ingest_stage
SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS x(
    customer_id VARCHAR(26),
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
       source_file = s.source_file,
       source_row = s.source_row,
       ingest_batch = s.ingest_batch,
       version = c.version + 1,
       updated_at = NOW()
  FROM ingest_stage AS s
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
  FROM ingest_stage AS s
  LEFT JOIN customer_identity AS ci ON ci.id_type = s.id_type AND ci.id_card = s.id_card
 WHERE ci.id_card IS NULL
`;

export class PgSink {
  readonly pool: Pool;
  private readonly buf: CustomerRow[] = [];
  readonly stats: SinkStats = {
    inserted: 0,
    updated: 0,
    skipped: 0,
    duplicateRows: 0,
    conflictWarnings: 0,
  };

  constructor(connString: string, private readonly batchSize = 2000) {
    this.pool = new Pool({ connectionString: connString, max: 4 });
  }

  async push(row: CustomerRow): Promise<void> {
    const document = normalizeDocument(row.id_card, row.id_type);
    if (document.error) throw new Error(document.error);
    this.buf.push({ ...row, id_type: document.type, id_card: document.value });
    if (this.buf.length >= this.batchSize) await this.flush();
  }

  async flush(): Promise<SinkStats> {
    if (this.buf.length === 0) return { ...this.stats };
    const pending = this.buf.slice();
    const byIdCard = new Map<string, CustomerRow>();
    for (const row of pending) {
      const key = documentKey(row);
      if (byIdCard.has(key)) this.stats.duplicateRows += 1;
      byIdCard.set(key, row);
    }
    const ingestMonth = new Date().toISOString().slice(0, 7) + '-01';
    const rows: StagedRow[] = [...byIdCard.values()].map((row) => ({
      ...row,
      customer_id: ulid(),
      huji_no: row.huji_no?.trim() || null,
      ingest_month: ingestMonth,
    }));
    const lockKeys = [...new Set(rows.flatMap((row) => {
      const keys = [`document:${documentKey(row)}`];
      if (row.ingest_batch && row.source_file && row.source_row != null) {
        keys.push(`source:${JSON.stringify([row.ingest_batch, row.source_file, row.source_row])}`);
      }
      return keys;
    }))].sort();

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `WITH keys AS MATERIALIZED (
           SELECT unnest($1::text[]) AS key ORDER BY 1
         )
         SELECT pg_advisory_xact_lock(hashtextextended(key, 0)) FROM keys`,
        [lockKeys],
      );
      await client.query(CREATE_STAGE_SQL);
      await client.query(LOAD_STAGE_SQL, [JSON.stringify(rows)]);
      const skipped = await client.query(`
        WITH removed AS (
          DELETE FROM ingest_stage AS s
           USING ingest_row_identity AS i
           WHERE i.ingest_batch = s.ingest_batch
             AND i.source_file = s.source_file
             AND i.source_row = s.source_row
          RETURNING 1
        )
        SELECT count(*)::int AS count FROM removed
      `);
      const updated = await client.query(UPDATE_EXISTING_SQL);
      const inserted = await client.query(INSERT_NEW_SQL);
      await client.query(`
        INSERT INTO customer_identity (id_type, id_card, customer_id, ingest_month)
        SELECT s.id_type, s.id_card, s.customer_id, s.ingest_month
          FROM ingest_stage AS s
          LEFT JOIN customer_identity AS ci ON ci.id_type = s.id_type AND ci.id_card = s.id_card
         WHERE ci.id_card IS NULL
        ON CONFLICT (id_type, id_card) DO NOTHING
      `);
      await client.query(`
        INSERT INTO ingest_row_identity (
          ingest_batch, source_file, source_row, customer_id, ingest_month
        )
        SELECT s.ingest_batch,
               s.source_file,
               s.source_row,
               COALESCE(ci.customer_id, s.customer_id),
               COALESCE(ci.ingest_month, s.ingest_month)
          FROM ingest_stage AS s
          LEFT JOIN customer_identity AS ci ON ci.id_type = s.id_type AND ci.id_card = s.id_card
         WHERE s.ingest_batch IS NOT NULL
           AND s.source_file IS NOT NULL
           AND s.source_row IS NOT NULL
        ON CONFLICT DO NOTHING
      `);
      await client.query('COMMIT');

      this.stats.skipped += Number(skipped.rows[0]?.count ?? 0);
      this.stats.updated += updated.rowCount ?? 0;
      this.stats.inserted += inserted.rowCount ?? 0;
      this.buf.splice(0, pending.length);
      return { ...this.stats };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.flush();
    await this.pool.end();
  }

  async abort(): Promise<void> {
    await this.pool.end();
  }
}

export interface RowLogEntry {
  job_id: string;
  file: string;
  row_no: number;
  reason: string;
  raw?: unknown;
}

export class RowLogSink {
  private readonly buf: RowLogEntry[] = [];

  constructor(private readonly pool: Pool, private readonly batchSize = 500) {}

  async push(entry: RowLogEntry): Promise<void> {
    this.buf.push(entry);
    if (this.buf.length >= this.batchSize) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.buf.length === 0) return;
    const batch = this.buf.slice();
    const values: string[] = [];
    const params: unknown[] = [];
    batch.forEach((entry, index) => {
      const base = index * 5;
      values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`);
      params.push(
        entry.job_id,
        entry.file,
        entry.row_no,
        entry.reason,
        entry.raw == null ? null : JSON.stringify(entry.raw),
      );
    });
    const sql = `INSERT INTO ingest_row_log (job_id, file, row_no, reason, raw) VALUES ${values.join(',')}`;
    const client = await this.pool.connect();
    try {
      await client.query(sql, params);
      this.buf.splice(0, batch.length);
    } finally {
      client.release();
    }
  }
}
