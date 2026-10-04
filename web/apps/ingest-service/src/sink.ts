import { Pool } from 'pg';
import { ulid } from 'ulid';
import type { CustomerRow } from './types';

const INSERT_SQL = `
INSERT INTO customer
  (customer_id, huji_no, name, gender, birth_date, id_card, phone_masked, address, stat_time,
   province, city, district, occupation, education, marital_status,
   source_file, source_row, ingest_batch, ingest_month)
VALUES
  ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,date_trunc('month', now())::date)
ON CONFLICT (huji_no, ingest_month) WHERE is_deleted = FALSE
DO UPDATE SET
  name           = EXCLUDED.name,
  gender         = EXCLUDED.gender,
  birth_date     = EXCLUDED.birth_date,
  id_card        = EXCLUDED.id_card,
  phone_masked   = EXCLUDED.phone_masked,
  address        = EXCLUDED.address,
  stat_time      = EXCLUDED.stat_time,
  province       = EXCLUDED.province,
  city           = EXCLUDED.city,
  district       = COALESCE(EXCLUDED.district, customer.district),
  occupation     = COALESCE(EXCLUDED.occupation, customer.occupation),
  education      = COALESCE(EXCLUDED.education, customer.education),
  marital_status = COALESCE(EXCLUDED.marital_status, customer.marital_status),
  source_file    = EXCLUDED.source_file,
  source_row     = EXCLUDED.source_row,
  ingest_batch   = EXCLUDED.ingest_batch,
  version        = customer.version + 1,
  updated_at     = NOW();
`;

export class PgSink {
  readonly pool: Pool;
  private buf: CustomerRow[] = [];

  constructor(connString: string, private readonly batchSize = 2000) {
    this.pool = new Pool({ connectionString: connString, max: 4 });
  }

  async push(row: CustomerRow) {
    this.buf.push(row);
    if (this.buf.length >= this.batchSize) await this.flush();
  }

  async flush() {
    if (this.buf.length === 0) return;
    const batch = this.buf;
    this.buf = [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const r of batch) {
        await client.query(INSERT_SQL, [
          ulid(),
          r.huji_no,
          r.name,
          r.gender ?? null,
          r.birth_date ?? null,
          r.id_card ?? null,
          r.phone_masked ?? null,
          r.address ?? null,
          r.stat_time ?? null,
          r.province ?? null,
          r.city ?? null,
          r.district ?? null,
          r.occupation ?? null,
          r.education ?? null,
          r.marital_status ?? null,
          r.source_file,
          r.source_row,
          r.ingest_batch,
        ]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.flush();
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

/**
 * 独立于 PgSink 的 ingest_row_log 写入器，支持三类告警：
 *   - cleaning_error            清洗抛错
 *   - id_card_conflict          批次内身份证相同但 huji_no 不同
 *   - id_card_checksum_invalid  身份证 ISO7064 校验失败
 * 为了避免每行一次网络往返，按 batchSize 攒批 flush；close 时冲洗余量。
 */
export class RowLogSink {
  private buf: RowLogEntry[] = [];

  constructor(private readonly pool: Pool, private readonly batchSize = 500) {}

  async push(entry: RowLogEntry): Promise<void> {
    this.buf.push(entry);
    if (this.buf.length >= this.batchSize) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.buf.length === 0) return;
    const batch = this.buf;
    this.buf = [];
    const values: string[] = [];
    const params: unknown[] = [];
    batch.forEach((e, i) => {
      const base = i * 5;
      values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`);
      params.push(e.job_id, e.file, e.row_no, e.reason, e.raw == null ? null : JSON.stringify(e.raw));
    });
    const sql = `INSERT INTO ingest_row_log (job_id, file, row_no, reason, raw) VALUES ${values.join(',')}`;
    const client = await this.pool.connect();
    try {
      await client.query(sql, params);
    } finally {
      client.release();
    }
  }
}
