ALTER TABLE contacts DROP CONSTRAINT contacts_check;
ALTER TABLE contacts ADD COLUMN deleted_at timestamptz;
CREATE TABLE consent_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  consent boolean NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consent_events_contact_idx ON consent_events (contact_id, created_at DESC);
