-- 一期 DDL：客户主表 + 同步任务（按真实 Demo.xlsx 字段）
-- PostgreSQL 15+

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS customer (
  customer_id    CHAR(26)     NOT NULL,  -- ULID
  huji_no        VARCHAR(32)  NOT NULL,
  name           VARCHAR(64)  NOT NULL,
  gender         CHAR(1),
  birth_date     DATE,
  id_card        VARCHAR(32),           -- 脱敏后：前 6 位 + 8 个 * + 后 4 位
  phone_masked   VARCHAR(16),
  address        VARCHAR(256),
  stat_time      TIMESTAMPTZ,
  province       VARCHAR(32),           -- 由身份证前 2 位推导
  city           VARCHAR(64),           -- 由身份证前 4 位推导（有映射表时）
  district       VARCHAR(64),           -- 预留：补全 GB2260 后由身份证前 6 位推导
  occupation     VARCHAR(64),           -- 人工维护位
  education      VARCHAR(32),           -- 人工维护位
  marital_status VARCHAR(16),           -- 人工维护位
  source_file    VARCHAR(256),
  source_row     INT,
  ingest_batch   VARCHAR(64),
  ingest_month   DATE         NOT NULL,
  version        INT          NOT NULL DEFAULT 1,
  is_deleted     BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- PG 分区表要求全局唯一约束必须包含分区键
  PRIMARY KEY (customer_id, ingest_month)
) PARTITION BY RANGE (ingest_month);

-- 示例：当年 12 个月分区（上线前按实际调整）
DO $$
DECLARE m INT;
BEGIN
  FOR m IN 1..12 LOOP
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS customer_p%s PARTITION OF customer
         FOR VALUES FROM (''%s-%s-01'') TO (''%s-%s-01'')',
      lpad(m::text, 2, '0'),
      extract(year from now())::int, lpad(m::text, 2, '0'),
      CASE WHEN m = 12 THEN extract(year from now())::int + 1 ELSE extract(year from now())::int END,
      CASE WHEN m = 12 THEN '01' ELSE lpad((m + 1)::text, 2, '0') END
    );
  END LOOP;
END $$;

-- 业务唯一键：按 (huji_no, ingest_month) 月粒度唯一；软删除行不占用
-- 全局唯一约束必须包含分区键（PG 限制），跨月重复 huji_no 的清算在阶段 3 由业务层保证
CREATE UNIQUE INDEX IF NOT EXISTS uk_customer_huji
  ON customer (huji_no, ingest_month) WHERE is_deleted = FALSE;

-- huji_no 单列普通索引，供跨月检索
CREATE INDEX IF NOT EXISTS idx_customer_huji ON customer (huji_no);

-- 身份证虽允许 huji_no 不同但相同（走告警不阻断），用普通索引供检索
CREATE INDEX IF NOT EXISTS idx_customer_id_card ON customer (id_card);
CREATE INDEX IF NOT EXISTS idx_customer_name_trgm ON customer USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_customer_province ON customer (province);
CREATE INDEX IF NOT EXISTS idx_customer_city     ON customer (city);
CREATE INDEX IF NOT EXISTS idx_customer_address_trgm ON customer USING gin (address gin_trgm_ops);

CREATE TABLE IF NOT EXISTS ingest_job (
  job_id         VARCHAR(64) PRIMARY KEY,
  source_bucket  VARCHAR(128),
  source_prefix  VARCHAR(256),
  status         VARCHAR(16) NOT NULL,
  total_rows     BIGINT      DEFAULT 0,
  success_rows   BIGINT      DEFAULT 0,
  skipped_rows   BIGINT      DEFAULT 0,
  duplicate_rows BIGINT      DEFAULT 0,
  written_rows   BIGINT      DEFAULT 0,
  warnings       BIGINT      DEFAULT 0,
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  error          TEXT
);

CREATE TABLE IF NOT EXISTS ingest_row_log (
  job_id   VARCHAR(64),
  file     VARCHAR(256),
  row_no   INT,
  reason   VARCHAR(64),   -- cleaning_error 原因，或 id_card_conflict / dup_in_batch
  raw      JSONB
);

CREATE INDEX IF NOT EXISTS idx_ingest_row_log_job ON ingest_row_log (job_id);
