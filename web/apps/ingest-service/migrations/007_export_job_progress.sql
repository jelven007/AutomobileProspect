-- Add durable progress tracking for asynchronous customer exports.
ALTER TABLE export_job
  ADD COLUMN IF NOT EXISTS processed_rows BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completed_groups INT NOT NULL DEFAULT 0;

UPDATE export_job
   SET processed_rows = total_rows,
       completed_groups = groups
 WHERE status = 'SUCCESS'
   AND (processed_rows <> total_rows OR completed_groups <> groups);
