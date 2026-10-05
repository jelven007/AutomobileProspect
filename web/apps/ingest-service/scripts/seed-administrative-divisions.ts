#!/usr/bin/env tsx
import { Pool } from 'pg';
import {
  loadAdministrativeDivisionDataset,
  REGION_RULE_VERSION,
} from '../src/administrative-division';

async function main(): Promise<void> {
  const connectionString = process.env.PG_URL ?? process.env.DATABASE_URL;
  if (!connectionString) throw new Error('PG_URL_or_DATABASE_URL_required');
  const dataset = loadAdministrativeDivisionDataset();
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('administrative-division:seed', 0))`,
    );
    const existing = await client.query<{ source_hash: string }>(
      `SELECT source_hash
         FROM administrative_division_dataset
        WHERE dataset_version = $1`,
      [dataset.metadata.dataset_version],
    );
    if (existing.rows[0] && existing.rows[0].source_hash.trim() !== dataset.metadata.source_hash) {
      throw new Error(`dataset_version_hash_conflict:${dataset.metadata.dataset_version}`);
    }

    await client.query(
      `INSERT INTO administrative_division_dataset (
         dataset_version, effective_date, fetched_at, source_page, source_url,
         source_table, source_hash, province_count, prefecture_count, county_count
       ) VALUES ($1, $2::date, $3::timestamptz, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (dataset_version) DO UPDATE SET
         fetched_at = EXCLUDED.fetched_at,
         source_page = EXCLUDED.source_page,
         source_url = EXCLUDED.source_url,
         source_table = EXCLUDED.source_table,
         province_count = EXCLUDED.province_count,
         prefecture_count = EXCLUDED.prefecture_count,
         county_count = EXCLUDED.county_count`,
      [
        dataset.metadata.dataset_version,
        dataset.metadata.effective_date,
        dataset.metadata.fetched_at,
        dataset.metadata.source_page,
        dataset.metadata.source_url,
        dataset.metadata.source_table,
        dataset.metadata.source_hash,
        dataset.metadata.counts.province,
        dataset.metadata.counts.prefecture,
        dataset.metadata.counts.county,
      ],
    );

    for (let offset = 0; offset < dataset.divisions.length; offset += 500) {
      const rows = dataset.divisions.slice(offset, offset + 500).map((division) => ({
        ...division,
        source_url: dataset.metadata.source_url,
        source_hash: dataset.metadata.source_hash,
      }));
      await client.query(
        `INSERT INTO administrative_division (
           dataset_version, source_code, code, name, level, division_type,
           parent_source_code, parent_code, is_current, source_url, source_hash
         )
         SELECT dataset_version, source_code, code, name, level, division_type,
                parent_source_code, parent_code, TRUE, source_url, source_hash
           FROM jsonb_to_recordset($1::jsonb) AS item(
             dataset_version VARCHAR(32), source_code VARCHAR(12), code CHAR(6),
             name VARCHAR(64), level VARCHAR(16), division_type VARCHAR(32),
             parent_source_code VARCHAR(12), parent_code CHAR(6),
             source_url TEXT, source_hash CHAR(64)
           )
         ON CONFLICT (dataset_version, source_code) DO UPDATE SET
           code = EXCLUDED.code,
           name = EXCLUDED.name,
           level = EXCLUDED.level,
           division_type = EXCLUDED.division_type,
           parent_source_code = EXCLUDED.parent_source_code,
           parent_code = EXCLUDED.parent_code,
           is_current = TRUE,
           source_url = EXCLUDED.source_url,
           source_hash = EXCLUDED.source_hash`,
        [JSON.stringify(rows)],
      );
    }

    await client.query(`DELETE FROM administrative_division_crosswalk WHERE rule_version = $1`, [
      REGION_RULE_VERSION,
    ]);
    if (dataset.crosswalk.length) {
      const rows = dataset.crosswalk.map((entry) => ({
        ...entry,
        source_names: entry.source_names ?? [entry.source_name],
        source_parent_codes: entry.source_parent_codes ?? [],
        candidate_target_codes: entry.candidate_target_codes ?? [],
        rule_version: REGION_RULE_VERSION,
        target_dataset_version: dataset.metadata.dataset_version,
      }));
      await client.query(
        `INSERT INTO administrative_division_crosswalk (
           rule_version, target_dataset_version, source_code, source_name, source_names,
           source_level, source_type, source_parent_codes, source_first_year, source_last_year,
           target_code, candidate_target_codes, mapping_kind, mapping_scope,
           auto_apply, confidence, mapping_reason, evidence
         )
         SELECT rule_version, target_dataset_version, source_code, source_name, source_names,
                source_level, source_type, source_parent_codes, source_first_year, source_last_year,
                target_code, candidate_target_codes, mapping_kind, mapping_scope,
                auto_apply, confidence, mapping_reason, evidence
           FROM jsonb_to_recordset($1::jsonb) AS item(
             rule_version VARCHAR(32), target_dataset_version VARCHAR(32),
             source_code CHAR(6), source_name VARCHAR(64), source_names JSONB,
             source_level VARCHAR(16), source_type VARCHAR(32), source_parent_codes JSONB,
             source_first_year SMALLINT, source_last_year SMALLINT, target_code CHAR(6),
             candidate_target_codes JSONB, mapping_kind VARCHAR(32), mapping_scope VARCHAR(16),
             auto_apply BOOLEAN, confidence SMALLINT, mapping_reason VARCHAR(64), evidence TEXT
           )`,
        [JSON.stringify(rows)],
      );
    }
    await client.query('COMMIT');
    process.stdout.write(
      `${JSON.stringify({
        dataset_version: dataset.metadata.dataset_version,
        divisions: dataset.divisions.length,
        crosswalk: dataset.crosswalk.length,
      })}\n`,
    );
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
