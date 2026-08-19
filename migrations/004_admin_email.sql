CREATE TABLE email_conversations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject text NOT NULL DEFAULT '(no subject)',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','archived','spam')),
  unread boolean NOT NULL DEFAULT true,
  needs_follow_up boolean NOT NULL DEFAULT true,
  contact_id bigint REFERENCES contacts(id) ON DELETE SET NULL,
  assigned_user_id bigint REFERENCES admin_users(id) ON DELETE SET NULL,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_conversations_queue_idx ON email_conversations (status, unread DESC, last_message_at DESC);
CREATE INDEX email_conversations_contact_idx ON email_conversations (contact_id, last_message_at DESC);

CREATE TABLE email_messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id bigint NOT NULL REFERENCES email_conversations(id) ON DELETE CASCADE,
  direction text NOT NULL CHECK (direction IN ('inbound','outbound','draft')),
  resend_email_id text,
  internet_message_id text,
  in_reply_to text,
  from_address text NOT NULL,
  to_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  bcc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject text NOT NULL DEFAULT '(no subject)',
  text_body text NOT NULL DEFAULT '',
  html_body text,
  delivery_status text NOT NULL DEFAULT 'received' CHECK (delivery_status IN ('draft','queued','sent','delivered','delivery_delayed','bounced','complained','failed','received')),
  error_message text,
  sent_by_user_id bigint REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE UNIQUE INDEX email_messages_resend_unique ON email_messages (resend_email_id) WHERE resend_email_id IS NOT NULL;
CREATE INDEX email_messages_conversation_idx ON email_messages (conversation_id, created_at);
CREATE INDEX email_messages_internet_id_idx ON email_messages (internet_message_id) WHERE internet_message_id IS NOT NULL;

CREATE TABLE email_attachments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id bigint NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  resend_attachment_id text,
  filename text NOT NULL,
  content_type text NOT NULL DEFAULT 'application/octet-stream',
  size_bytes bigint,
  content_disposition text,
  content_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE email_internal_notes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id bigint NOT NULL REFERENCES email_conversations(id) ON DELETE CASCADE,
  author_user_id bigint REFERENCES admin_users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX email_notes_conversation_idx ON email_internal_notes (conversation_id, created_at);

CREATE TABLE email_webhook_events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  resend_email_id text,
  payload jsonb NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
