-- Server-only catalog and audit mirror. Wallet admission remains local and atomic.
CREATE TABLE public.bodega_catalog (
 id text PRIMARY KEY,
 vendor_id text NOT NULL,
 category text NOT NULL,
 listing jsonb NOT NULL CHECK (pg_column_size(listing) < 64000),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.bodega_events (
 kind text NOT NULL CHECK (kind IN ('trial','purchase','review','comparison')),
 id text NOT NULL,
 session_id text NOT NULL,
 payload jsonb NOT NULL CHECK (pg_column_size(payload) < 64000),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(kind,id)
);
CREATE INDEX bodega_events_session ON public.bodega_events(session_id,updated_at);
ALTER TABLE public.bodega_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bodega_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bodega_catalog, public.bodega_events FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,UPDATE ON public.bodega_catalog,public.bodega_events TO project_admin;
