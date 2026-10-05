-- 数据一致性、持久化任务、审计与分区维护。
-- PostgreSQL 15+；可在已执行 001_init.sql 的环境重复运行。

BEGIN;

ALTER TABLE customer ALTER COLUMN huji_no DROP NOT NULL;
UPDATE customer SET huji_no = NULL WHERE btrim(huji_no) = '';

DROP INDEX IF EXISTS uk_customer_huji;
DROP INDEX IF EXISTS uk_customer_huji_month;

-- 每个导入源行只允许生成一条客户记录。重试或进程恢复时可安全重放。
CREATE TABLE IF NOT EXISTS ingest_row_identity (
  ingest_batch VARCHAR(64)  NOT NULL,
  source_file  VARCHAR(256) NOT NULL,
  source_row   INT          NOT NULL,
  customer_id  CHAR(26)     NOT NULL,
  ingest_month DATE         NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (ingest_batch, source_file, source_row),
  FOREIGN KEY (customer_id, ingest_month)
    REFERENCES customer (customer_id, ingest_month)
    ON DELETE CASCADE
);

INSERT INTO ingest_row_identity (
  ingest_batch, source_file, source_row, customer_id, ingest_month
)
SELECT DISTINCT ON (ingest_batch, source_file, source_row)
       ingest_batch, source_file, source_row, customer_id, ingest_month
  FROM customer
 WHERE ingest_batch IS NOT NULL
   AND source_file IS NOT NULL
   AND source_row IS NOT NULL
 ORDER BY ingest_batch, source_file, source_row, updated_at DESC
ON CONFLICT DO NOTHING;

ALTER TABLE ingest_job
  ADD COLUMN IF NOT EXISTS file_name VARCHAR(256),
  ADD COLUMN IF NOT EXISTS file_path TEXT,
  ADD COLUMN IF NOT EXISTS file_hash CHAR(64),
  ADD COLUMN IF NOT EXISTS checkpoint_row BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS inserted_rows BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS updated_rows BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS warnings_json JSONB,
  ADD COLUMN IF NOT EXISTS report_json JSONB,
  ADD COLUMN IF NOT EXISTS retry_of VARCHAR(64),
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE ingest_job
   SET status = CASE lower(status)
     WHEN 'pending' THEN 'PENDING'
     WHEN 'running' THEN 'RUNNING'
     WHEN 'success' THEN 'SUCCESS'
     WHEN 'succeeded' THEN 'SUCCESS'
     WHEN 'failed' THEN 'FAILED'
     ELSE upper(status)
   END;

CREATE INDEX IF NOT EXISTS idx_ingest_job_created
  ON ingest_job (created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uk_ingest_job_file_hash_success
  ON ingest_job (file_hash)
  WHERE file_hash IS NOT NULL AND status = 'SUCCESS';

CREATE TABLE IF NOT EXISTS export_job (
  job_id       VARCHAR(64) PRIMARY KEY,
  status       VARCHAR(16) NOT NULL,
  filters      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  file_path    TEXT,
  file_name    VARCHAR(256),
  total_rows   BIGINT      NOT NULL DEFAULT 0,
  processed_rows BIGINT    NOT NULL DEFAULT 0,
  groups       INT         NOT NULL DEFAULT 0,
  completed_groups INT     NOT NULL DEFAULT 0,
  requested_by VARCHAR(128),
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_export_job_created
  ON export_job (created_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  audit_id    BIGSERIAL PRIMARY KEY,
  actor       VARCHAR(128) NOT NULL,
  action      VARCHAR(64)  NOT NULL,
  entity_type VARCHAR(64)  NOT NULL,
  entity_id   VARCHAR(128),
  before_data JSONB,
  after_data  JSONB,
  request_id  VARCHAR(128),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_entity
  ON audit_log (entity_type, entity_id, created_at DESC);

-- 按月确保分区存在。旧版 customer_pNN 覆盖同一范围时静默复用，
-- 新建分区统一采用 customer_pYYYY_MM，避免跨年重名。
CREATE OR REPLACE FUNCTION ensure_customer_partitions(months_ahead INT DEFAULT 3)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  offset_month INT;
  month_start DATE;
  month_end DATE;
  partition_name TEXT;
BEGIN
  FOR offset_month IN -1..GREATEST(months_ahead, 0) LOOP
    month_start := date_trunc('month', CURRENT_DATE)
      + make_interval(months => offset_month);
    month_end := month_start + INTERVAL '1 month';
    partition_name := format(
      'customer_p%s_%s',
      extract(year FROM month_start)::INT,
      lpad(extract(month FROM month_start)::INT::TEXT, 2, '0')
    );
    BEGIN
      EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I PARTITION OF customer
           FOR VALUES FROM (%L) TO (%L)',
        partition_name, month_start, month_end
      );
    EXCEPTION
      WHEN invalid_object_definition OR duplicate_table THEN
        NULL;
    END;
  END LOOP;
END;
$$;

SELECT ensure_customer_partitions(3);

COMMIT;
