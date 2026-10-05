-- Versioned administrative-division master data and customer shadow fields.
-- This migration does not backfill or alter legacy province/city/district values.

BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('customer:region-standardization-migration', 0));

CREATE TABLE IF NOT EXISTS administrative_division_dataset (
  dataset_version VARCHAR(32) PRIMARY KEY,
  effective_date  DATE         NOT NULL,
  fetched_at      TIMESTAMPTZ  NOT NULL,
  source_page     TEXT         NOT NULL,
  source_url      TEXT         NOT NULL,
  source_table    VARCHAR(64)  NOT NULL,
  source_hash     CHAR(64)     NOT NULL,
  province_count  INT          NOT NULL,
  prefecture_count INT         NOT NULL,
  county_count    INT          NOT NULL,
  imported_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CHECK (province_count >= 0 AND prefecture_count >= 0 AND county_count >= 0)
);

CREATE TABLE IF NOT EXISTS administrative_division (
  dataset_version   VARCHAR(32) NOT NULL,
  source_code       VARCHAR(12) NOT NULL,
  code              CHAR(6),
  name              VARCHAR(64) NOT NULL,
  level             VARCHAR(16) NOT NULL,
  division_type     VARCHAR(32) NOT NULL,
  parent_source_code VARCHAR(12),
  parent_code       CHAR(6),
  effective_from    DATE,
  effective_to      DATE,
  is_current        BOOLEAN     NOT NULL DEFAULT TRUE,
  source_url        TEXT        NOT NULL,
  source_hash       CHAR(64)    NOT NULL,
  PRIMARY KEY (dataset_version, source_code),
  UNIQUE (dataset_version, code),
  FOREIGN KEY (dataset_version)
    REFERENCES administrative_division_dataset (dataset_version)
    ON DELETE RESTRICT,
  FOREIGN KEY (dataset_version, parent_source_code)
    REFERENCES administrative_division (dataset_version, source_code)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (level IN ('province', 'prefecture', 'county')),
  CHECK (code IS NULL OR code ~ '^[0-9]{6}$'),
  CHECK (parent_code IS NULL OR parent_code ~ '^[0-9]{6}$')
);

CREATE INDEX IF NOT EXISTS idx_administrative_division_parent
  ON administrative_division (dataset_version, parent_source_code);
CREATE INDEX IF NOT EXISTS idx_administrative_division_name
  ON administrative_division (dataset_version, name, level);

CREATE TABLE IF NOT EXISTS administrative_division_crosswalk (
  crosswalk_id       BIGSERIAL   PRIMARY KEY,
  rule_version       VARCHAR(32) NOT NULL,
  target_dataset_version VARCHAR(32) NOT NULL,
  source_code        CHAR(6)     NOT NULL,
  source_name        VARCHAR(64),
  source_level       VARCHAR(16) NOT NULL,
  source_type        VARCHAR(32),
  target_code        CHAR(6),
  mapping_kind       VARCHAR(32) NOT NULL,
  mapping_scope      VARCHAR(16) NOT NULL,
  auto_apply         BOOLEAN     NOT NULL DEFAULT FALSE,
  confidence         SMALLINT    NOT NULL,
  evidence           TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (target_dataset_version, target_code)
    REFERENCES administrative_division (dataset_version, code)
    DEFERRABLE INITIALLY DEFERRED,
  CHECK (source_code ~ '^[0-9]{6}$'),
  CHECK (target_code IS NULL OR target_code ~ '^[0-9]{6}$'),
  CHECK (source_level IN ('province', 'prefecture', 'county')),
  CHECK (mapping_scope IN ('full', 'parent_only', 'ambiguous')),
  CHECK (confidence BETWEEN 0 AND 100),
  CHECK (NOT auto_apply OR (mapping_scope <> 'ambiguous' AND target_code IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_administrative_division_crosswalk
  ON administrative_division_crosswalk (
    rule_version, source_code, COALESCE(target_code, '000000')
  );

ALTER TABLE customer
  ADD COLUMN IF NOT EXISTS origin_region_code CHAR(6),
  ADD COLUMN IF NOT EXISTS current_province_code CHAR(6),
  ADD COLUMN IF NOT EXISTS current_province_name VARCHAR(64),
  ADD COLUMN IF NOT EXISTS current_prefecture_code CHAR(6),
  ADD COLUMN IF NOT EXISTS current_prefecture_name VARCHAR(64),
  ADD COLUMN IF NOT EXISTS current_county_code CHAR(6),
  ADD COLUMN IF NOT EXISTS current_county_name VARCHAR(64),
  ADD COLUMN IF NOT EXISTS current_division_type VARCHAR(32),
  ADD COLUMN IF NOT EXISTS region_group_code CHAR(6),
  ADD COLUMN IF NOT EXISTS region_group_name VARCHAR(64),
  ADD COLUMN IF NOT EXISTS region_group_type VARCHAR(32),
  ADD COLUMN IF NOT EXISTS region_source VARCHAR(32),
  ADD COLUMN IF NOT EXISTS region_mapping_status VARCHAR(32),
  ADD COLUMN IF NOT EXISTS region_mapping_method VARCHAR(32),
  ADD COLUMN IF NOT EXISTS region_confidence SMALLINT,
  ADD COLUMN IF NOT EXISTS region_dataset_version VARCHAR(32),
  ADD COLUMN IF NOT EXISTS region_rule_version VARCHAR(32),
  ADD COLUMN IF NOT EXISTS region_standardized_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS region_batch_id CHAR(26),
  ADD COLUMN IF NOT EXISTS region_manual_override BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE customer
  DROP CONSTRAINT IF EXISTS customer_region_mapping_status_check,
  ADD CONSTRAINT customer_region_mapping_status_check CHECK (
    region_mapping_status IS NULL OR region_mapping_status IN (
      'current', 'historical_mapped', 'partial',
      'ambiguous', 'unresolved', 'not_applicable'
    )
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS customer_region_mapping_method_check,
  ADD CONSTRAINT customer_region_mapping_method_check CHECK (
    region_mapping_method IS NULL OR region_mapping_method IN (
      'current_code', 'historical_crosswalk', 'exact_name', 'manual', 'none'
    )
  ) NOT VALID,
  DROP CONSTRAINT IF EXISTS customer_region_confidence_check,
  ADD CONSTRAINT customer_region_confidence_check CHECK (
    region_confidence IS NULL OR region_confidence BETWEEN 0 AND 100
  ) NOT VALID;

CREATE INDEX IF NOT EXISTS idx_customer_current_province
  ON customer (current_province_code)
  WHERE is_deleted = FALSE AND current_province_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_current_prefecture
  ON customer (current_prefecture_code)
  WHERE is_deleted = FALSE AND current_prefecture_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_current_county
  ON customer (current_county_code)
  WHERE is_deleted = FALSE AND current_county_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_region_group
  ON customer (region_group_code)
  WHERE is_deleted = FALSE AND region_group_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_customer_region_status
  ON customer (region_mapping_status)
  WHERE is_deleted = FALSE AND region_mapping_status IS NOT NULL;

CREATE TABLE IF NOT EXISTS region_standardization_batch (
  region_batch_id CHAR(26)     PRIMARY KEY,
  dataset_version VARCHAR(32)  NOT NULL,
  rule_version    VARCHAR(32)  NOT NULL,
  source_hash     CHAR(64)     NOT NULL,
  status          VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
  selection       JSONB        NOT NULL DEFAULT '{}'::JSONB,
  total_rows      BIGINT       NOT NULL DEFAULT 0,
  processed_rows  BIGINT       NOT NULL DEFAULT 0,
  current_rows    BIGINT       NOT NULL DEFAULT 0,
  historical_rows BIGINT       NOT NULL DEFAULT 0,
  partial_rows    BIGINT       NOT NULL DEFAULT 0,
  ambiguous_rows  BIGINT       NOT NULL DEFAULT 0,
  unresolved_rows BIGINT       NOT NULL DEFAULT 0,
  not_applicable_rows BIGINT   NOT NULL DEFAULT 0,
  changed_rows    BIGINT       NOT NULL DEFAULT 0,
  worker_id       VARCHAR(128),
  lease_until     TIMESTAMPTZ,
  last_customer_id CHAR(26),
  last_ingest_month DATE,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  error           TEXT,
  requested_by    VARCHAR(128),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  FOREIGN KEY (dataset_version)
    REFERENCES administrative_division_dataset (dataset_version),
  CHECK (status IN (
    'PENDING', 'RUNNING', 'PAUSING', 'PAUSED',
    'SUCCESS', 'FAILED', 'ROLLED_BACK'
  ))
);

CREATE INDEX IF NOT EXISTS idx_region_standardization_batch_status
  ON region_standardization_batch (status, created_at);

CREATE TABLE IF NOT EXISTS region_standardization_staging (
  region_batch_id   CHAR(26) NOT NULL,
  customer_id       CHAR(26) NOT NULL,
  ingest_month      DATE     NOT NULL,
  expected_old_hash CHAR(64) NOT NULL,
  result_hash       CHAR(64) NOT NULL,
  origin_region_code CHAR(6),
  current_province_code CHAR(6),
  current_province_name VARCHAR(64),
  current_prefecture_code CHAR(6),
  current_prefecture_name VARCHAR(64),
  current_county_code CHAR(6),
  current_county_name VARCHAR(64),
  current_division_type VARCHAR(32),
  region_group_code CHAR(6),
  region_group_name VARCHAR(64),
  region_group_type VARCHAR(32),
  region_source     VARCHAR(32) NOT NULL,
  mapping_status    VARCHAR(32) NOT NULL,
  mapping_method    VARCHAR(32) NOT NULL,
  confidence        SMALLINT    NOT NULL,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (region_batch_id, customer_id, ingest_month),
  FOREIGN KEY (region_batch_id)
    REFERENCES region_standardization_batch (region_batch_id)
    ON DELETE CASCADE,
  CHECK (confidence BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_region_staging_status
  ON region_standardization_staging (region_batch_id, mapping_status);

CREATE TABLE IF NOT EXISTS region_standardization_change (
  change_id         BIGSERIAL PRIMARY KEY,
  region_batch_id   CHAR(26) NOT NULL,
  customer_id       CHAR(26) NOT NULL,
  ingest_month      DATE     NOT NULL,
  old_value_hash    CHAR(64) NOT NULL,
  new_value_hash    CHAR(64) NOT NULL,
  old_values        JSONB    NOT NULL,
  new_values        JSONB    NOT NULL,
  mapping_status    VARCHAR(32) NOT NULL,
  changed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rolled_back_at    TIMESTAMPTZ,
  FOREIGN KEY (region_batch_id)
    REFERENCES region_standardization_batch (region_batch_id)
    ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS uk_region_standardization_change_customer
  ON region_standardization_change (region_batch_id, customer_id, ingest_month);

COMMIT;
