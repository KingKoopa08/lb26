CREATE TABLE web_analytics_events (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  event_type text NOT NULL CHECK (event_type IN ('page_view','conversion')),
  event_name text,
  visitor_id text NOT NULL,
  session_id text NOT NULL,
  page_path text NOT NULL,
  page_title text,
  referrer text,
  source text NOT NULL DEFAULT 'Direct',
  medium text,
  campaign text,
  term text,
  content text,
  device_type text,
  browser text,
  operating_system text,
  country_code text,
  region text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX web_analytics_occurred_at_idx ON web_analytics_events (occurred_at DESC);
CREATE INDEX web_analytics_session_idx ON web_analytics_events (session_id, occurred_at);
CREATE INDEX web_analytics_page_idx ON web_analytics_events (page_path, occurred_at DESC);
CREATE INDEX web_analytics_source_idx ON web_analytics_events (source, occurred_at DESC);

