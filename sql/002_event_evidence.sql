-- Event-level merged classification evidence and publisher list (needed to
-- recompute transmission when new reports join an existing event).
ALTER TABLE events ADD COLUMN IF NOT EXISTS classification jsonb;
ALTER TABLE events ADD COLUMN IF NOT EXISTS publishers text[] NOT NULL DEFAULT '{}';
ALTER TABLE events ADD COLUMN IF NOT EXISTS linked_release_id bigint;
INSERT INTO schema_migrations (version) VALUES ('002_event_evidence') ON CONFLICT DO NOTHING;
