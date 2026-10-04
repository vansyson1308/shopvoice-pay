-- migrate:up
BEGIN;

ALTER TABLE pending_notifications DROP CONSTRAINT IF EXISTS pending_notifications_status_check;
ALTER TABLE pending_notifications
  ADD CONSTRAINT pending_notifications_status_check
  CHECK (status IN ('pending', 'flushed', 'expired', 'failed_terminal'));

ALTER TABLE pending_notifications
  ADD COLUMN IF NOT EXISTS error_code TEXT;

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS error_code TEXT;

COMMIT;

-- migrate:down
BEGIN;

ALTER TABLE jobs
  DROP COLUMN IF EXISTS error_code;

ALTER TABLE pending_notifications
  DROP COLUMN IF EXISTS error_code;

ALTER TABLE pending_notifications DROP CONSTRAINT IF EXISTS pending_notifications_status_check;
ALTER TABLE pending_notifications
  ADD CONSTRAINT pending_notifications_status_check
  CHECK (status IN ('pending', 'flushed', 'expired'));

COMMIT;
