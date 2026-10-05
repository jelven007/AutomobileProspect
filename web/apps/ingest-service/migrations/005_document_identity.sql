-- Existing databases: apply ONLY this incremental migration after 004.
-- Stop writers during migration/deployment. No customer data is deleted or reclassified.
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('customer:document-identity-migration', 0));
LOCK TABLE customer, customer_identity IN ACCESS EXCLUSIVE MODE;

ALTER TABLE customer ADD COLUMN IF NOT EXISTS id_type VARCHAR(32) NOT NULL DEFAULT 'resident_id';
ALTER TABLE customer_identity ADD COLUMN IF NOT EXISTS id_type VARCHAR(32) NOT NULL DEFAULT 'resident_id';

ALTER TABLE customer_identity DROP CONSTRAINT IF EXISTS customer_identity_pkey;
ALTER TABLE customer_identity ADD PRIMARY KEY (id_type, id_card);

CREATE UNIQUE INDEX IF NOT EXISTS uk_customer_document_month
  ON customer (id_type, id_card, ingest_month)
  WHERE id_card IS NOT NULL AND is_deleted = FALSE;
DROP INDEX IF EXISTS uk_customer_id_card_month;

ALTER TABLE customer DROP CONSTRAINT IF EXISTS customer_id_type_check;
ALTER TABLE customer ADD CONSTRAINT customer_id_type_check CHECK (id_type IN (
  'resident_id', 'organization_code', 'credit_code', 'passport_cn',
  'hk_macao_permit', 'mainland_permit', 'taiwan_permit'
));
ALTER TABLE customer_identity DROP CONSTRAINT IF EXISTS customer_identity_id_type_check;
ALTER TABLE customer_identity ADD CONSTRAINT customer_identity_id_type_check CHECK (id_type IN (
  'resident_id', 'organization_code', 'credit_code', 'passport_cn',
  'hk_macao_permit', 'mainland_permit', 'taiwan_permit'
));
COMMIT;
