-- How events reach us: the platform calls our URL (webhook), or we hold a long connection to it (websocket).
ALTER TABLE channels ADD COLUMN mode text NOT NULL DEFAULT 'webhook' CHECK (mode IN ('webhook', 'websocket'));
