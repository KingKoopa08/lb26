CREATE TABLE contacts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  first_name text NOT NULL,
  last_name text NOT NULL DEFAULT '',
  email text,
  phone text,
  address_line1 text,
  address_line2 text,
  city text,
  state text NOT NULL DEFAULT 'LA',
  postal_code text,
  preferred_contact text CHECK (preferred_contact IN ('email','phone','text',NULL)),
  consent boolean NOT NULL DEFAULT false,
  consent_at timestamptz,
  owner_user_id bigint REFERENCES admin_users(id) ON DELETE SET NULL,
  next_follow_up_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);
CREATE UNIQUE INDEX contacts_email_unique ON contacts (lower(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX contacts_phone_unique ON contacts (phone) WHERE phone IS NOT NULL;
CREATE INDEX contacts_name_idx ON contacts (lower(last_name), lower(first_name));
CREATE INDEX contacts_postal_code_idx ON contacts (postal_code);

CREATE TABLE crm_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  request_type text NOT NULL CHECK (request_type IN ('volunteer','yard_sign','house_party','host_event','rsvp','general')),
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','scheduled','completed','declined','duplicate','spam')),
  source text NOT NULL DEFAULT 'website',
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  owner_user_id bigint REFERENCES admin_users(id) ON DELETE SET NULL,
  next_follow_up_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX crm_requests_queue_idx ON crm_requests (status, created_at DESC);
CREATE INDEX crm_requests_contact_idx ON crm_requests (contact_id, created_at DESC);
CREATE INDEX crm_requests_type_idx ON crm_requests (request_type, created_at DESC);

CREATE TABLE contact_notes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  author_user_id bigint REFERENCES admin_users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX contact_notes_contact_idx ON contact_notes (contact_id, created_at DESC);

CREATE TABLE tags (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  color text NOT NULL DEFAULT '#7A1FB8',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX tags_name_unique ON tags (lower(name));
CREATE TABLE contact_tags (
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id bigint NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, tag_id)
);

CREATE TABLE events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title text NOT NULL,
  event_type text NOT NULL DEFAULT 'campaign',
  description text NOT NULL DEFAULT '',
  starts_at timestamptz NOT NULL,
  ends_at timestamptz,
  timezone text NOT NULL DEFAULT 'America/Chicago',
  venue text,
  address text,
  city text,
  state text NOT NULL DEFAULT 'LA',
  postal_code text,
  capacity integer CHECK (capacity IS NULL OR capacity > 0),
  waitlist_enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','canceled','completed','archived')),
  organizer text,
  contact_email text,
  accessibility_notes text,
  internal_notes text,
  created_by bigint REFERENCES admin_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX events_public_idx ON events (status, starts_at);

CREATE TABLE event_rsvps (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id bigint NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  contact_id bigint NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  guest_count integer NOT NULL DEFAULT 1 CHECK (guest_count BETWEEN 1 AND 20),
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','waitlisted','canceled','checked_in')),
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, contact_id)
);
CREATE INDEX event_rsvps_event_idx ON event_rsvps (event_id, status);

CREATE TABLE follow_up_tasks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  contact_id bigint REFERENCES contacts(id) ON DELETE CASCADE,
  event_id bigint REFERENCES events(id) ON DELETE CASCADE,
  owner_user_id bigint REFERENCES admin_users(id) ON DELETE SET NULL,
  title text NOT NULL,
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (contact_id IS NOT NULL OR event_id IS NOT NULL)
);
CREATE INDEX follow_up_tasks_queue_idx ON follow_up_tasks (completed_at, due_at);
