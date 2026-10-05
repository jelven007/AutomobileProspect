-- 身份证作为客户全局唯一键；编码编号仅保留为普通展示字段。
-- 可重复执行；已有数据保留每个身份证最早入库的一条有效记录。

BEGIN;

-- Never reapply the legacy dedupe after multi-document identities have been enabled.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'customer' AND column_name = 'id_type'
  ) THEN
    RAISE EXCEPTION 'document_identity_already_enabled: apply incremental migrations only';
  END IF;
END $$;

SELECT pg_advisory_xact_lock(hashtextextended('customer:id-card-identity-migration', 0));

UPDATE customer
   SET id_card = upper(btrim(id_card)),
       updated_at = NOW()
 WHERE id_card IS NOT NULL
   AND id_card <> upper(btrim(id_card));

UPDATE customer
   SET is_deleted = TRUE,
       version = version + 1,
       updated_at = NOW()
 WHERE is_deleted = FALSE
   AND NULLIF(btrim(id_card), '') IS NULL;

WITH ranked AS (
  SELECT customer_id,
         ingest_month,
         row_number() OVER (
           PARTITION BY id_card
           ORDER BY created_at ASC, customer_id ASC
         ) AS rn
    FROM customer
   WHERE is_deleted = FALSE
     AND id_card IS NOT NULL
)
UPDATE customer AS c
   SET is_deleted = TRUE,
       version = version + 1,
       updated_at = NOW()
  FROM ranked AS r
 WHERE c.customer_id = r.customer_id
   AND c.ingest_month = r.ingest_month
   AND r.rn > 1;

DROP INDEX IF EXISTS uk_customer_huji;
DROP INDEX IF EXISTS uk_customer_huji_month;

CREATE UNIQUE INDEX IF NOT EXISTS uk_customer_id_card_month
  ON customer (id_card, ingest_month)
  WHERE id_card IS NOT NULL AND is_deleted = FALSE;

DROP TABLE IF EXISTS customer_identity;

CREATE TABLE customer_identity (
  id_card      VARCHAR(32) PRIMARY KEY,
  customer_id  CHAR(26)    NOT NULL,
  ingest_month DATE        NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (customer_id, ingest_month)
    REFERENCES customer (customer_id, ingest_month)
    ON DELETE CASCADE
);

INSERT INTO customer_identity (id_card, customer_id, ingest_month)
SELECT id_card, customer_id, ingest_month
  FROM customer
 WHERE id_card IS NOT NULL
   AND is_deleted = FALSE;

CREATE INDEX idx_customer_identity_customer
  ON customer_identity (customer_id, ingest_month);

COMMIT;
