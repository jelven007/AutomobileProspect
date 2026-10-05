-- Apply after 005. Only expands admitted types; no identity/index rebuild or data rewrite.
-- Commit NOT VALID checks first so the table scan does not hold ACCESS EXCLUSIVE locks.
SET lock_timeout = '10s';
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('customer:document-identity-migration', 0));
ALTER TABLE customer DROP CONSTRAINT IF EXISTS customer_id_type_check;
ALTER TABLE customer ADD CONSTRAINT customer_id_type_check CHECK (id_type IN (
  'resident_id', 'organization_code', 'credit_code', 'passport_cn',
  'hk_macao_permit', 'mainland_permit', 'taiwan_permit', 'hongkong_id', 'pending_document'
)) NOT VALID;
ALTER TABLE customer_identity DROP CONSTRAINT IF EXISTS customer_identity_id_type_check;
ALTER TABLE customer_identity ADD CONSTRAINT customer_identity_id_type_check CHECK (id_type IN (
  'resident_id', 'organization_code', 'credit_code', 'passport_cn',
  'hk_macao_permit', 'mainland_permit', 'taiwan_permit', 'hongkong_id', 'pending_document'
)) NOT VALID;
COMMIT;
ALTER TABLE customer VALIDATE CONSTRAINT customer_id_type_check;
ALTER TABLE customer_identity VALIDATE CONSTRAINT customer_identity_id_type_check;
RESET lock_timeout;
