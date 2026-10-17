-- Bodega customer identities and agent credentials (server-only).
-- Raw agent bearer tokens never reach the database: only SHA-256 hex digests are stored.
-- Accessed exclusively through the RPC functions below with the server admin API key.
-- No custom schemas, no transaction statements (the migration runner wraps this file).

CREATE TABLE public.bodega_customers (
  id text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{2,63}$'),
  email text NOT NULL CHECK (
    char_length(email) <= 254
    AND email ~ '^[^[:space:]@<>"'',;]{1,64}@[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$'
  ),
  cap_cents bigint NOT NULL CHECK (cap_cents BETWEEN 0 AND 10000000),
  threshold_cents bigint NOT NULL CHECK (threshold_cents >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bodega_customers_threshold_within_cap CHECK (threshold_cents <= cap_cents)
);

CREATE TABLE public.bodega_agent_credentials (
  id text PRIMARY KEY CHECK (id ~ '^agt_[a-f0-9]{24}$'),
  customer_id text NOT NULL REFERENCES public.bodega_customers(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  last_used_at timestamptz,
  CONSTRAINT bodega_agent_credentials_expiry CHECK (
    expires_at > created_at AND expires_at <= created_at + interval '366 days'
  )
);
CREATE INDEX bodega_agent_credentials_customer
  ON public.bodega_agent_credentials(customer_id);

-- Immutability guards (RLS cannot compare OLD/NEW).
CREATE OR REPLACE FUNCTION public.bodega_customers_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'customer id and created_at are immutable' USING ERRCODE = '22023';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
CREATE TRIGGER bodega_customers_guard
  BEFORE UPDATE ON public.bodega_customers
  FOR EACH ROW EXECUTE FUNCTION public.bodega_customers_guard();

CREATE OR REPLACE FUNCTION public.bodega_agent_credentials_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'agent credential binding is immutable' USING ERRCODE = '22023';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'revoked credentials cannot be restored' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER bodega_agent_credentials_guard
  BEFORE UPDATE ON public.bodega_agent_credentials
  FOR EACH ROW EXECUTE FUNCTION public.bodega_agent_credentials_guard();

-- Deny-by-default for browser/user roles: RLS on, no policies, no grants.
ALTER TABLE public.bodega_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bodega_agent_credentials ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bodega_customers, public.bodega_agent_credentials FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.bodega_customers, public.bodega_agent_credentials TO project_admin;

-- Safe projection helpers: never include token_hash.
CREATE OR REPLACE FUNCTION public.bodega_customer_json(c public.bodega_customers)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'id', c.id, 'email', c.email, 'cap_cents', c.cap_cents,
    'threshold_cents', c.threshold_cents, 'active', c.active, 'created_at', c.created_at
  );
$$;

CREATE OR REPLACE FUNCTION public.bodega_create_customer(
  p_id text, p_email text, p_cap_cents bigint, p_threshold_cents bigint,
  p_credential_id text, p_token_hash text, p_expires_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  created public.bodega_customers;
BEGIN
  INSERT INTO public.bodega_customers(id, email, cap_cents, threshold_cents)
  VALUES (p_id, p_email, p_cap_cents, p_threshold_cents)
  RETURNING * INTO created;
  INSERT INTO public.bodega_agent_credentials(id, customer_id, token_hash, expires_at)
  VALUES (p_credential_id, p_id, p_token_hash, p_expires_at);
  RETURN public.bodega_customer_json(created);
END;
$$;

CREATE OR REPLACE FUNCTION public.bodega_get_customer(p_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT public.bodega_customer_json(c) FROM public.bodega_customers c WHERE c.id = p_id;
$$;

CREATE OR REPLACE FUNCTION public.bodega_list_customers()
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(
    public.bodega_customer_json(c) || jsonb_build_object('credentials', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', k.id, 'customer_id', k.customer_id, 'created_at', k.created_at,
        'expires_at', k.expires_at, 'revoked_at', k.revoked_at, 'last_used_at', k.last_used_at
      ) ORDER BY k.created_at, k.id), '[]'::jsonb)
      FROM public.bodega_agent_credentials k WHERE k.customer_id = c.id
    )) ORDER BY c.created_at, c.id), '[]'::jsonb)
  FROM public.bodega_customers c;
$$;

CREATE OR REPLACE FUNCTION public.bodega_set_customer_active(p_id text, p_active boolean)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  updated public.bodega_customers;
BEGIN
  UPDATE public.bodega_customers SET active = p_active WHERE id = p_id RETURNING * INTO updated;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN public.bodega_customer_json(updated);
END;
$$;

CREATE OR REPLACE FUNCTION public.bodega_add_agent_credential(
  p_customer_id text, p_credential_id text, p_token_hash text,
  p_expires_at timestamptz, p_revoke_existing boolean
)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM public.bodega_customers WHERE id = p_customer_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  IF p_revoke_existing THEN
    UPDATE public.bodega_agent_credentials SET revoked_at = now()
    WHERE customer_id = p_customer_id AND revoked_at IS NULL;
  END IF;
  INSERT INTO public.bodega_agent_credentials(id, customer_id, token_hash, expires_at)
  VALUES (p_credential_id, p_customer_id, p_token_hash, p_expires_at);
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.bodega_revoke_agent_credential(p_credential_id text)
RETURNS boolean
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
  UPDATE public.bodega_agent_credentials SET revoked_at = now()
  WHERE id = p_credential_id AND revoked_at IS NULL;
  RETURN FOUND;
END;
$$;

-- Returns {customer, credential_id} only for an active customer with an unrevoked,
-- unexpired credential; last_used_at is throttled to one write per minute.
CREATE OR REPLACE FUNCTION public.bodega_authenticate_agent(p_token_hash text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  cred public.bodega_agent_credentials;
  cust public.bodega_customers;
BEGIN
  SELECT k.* INTO cred FROM public.bodega_agent_credentials k
  WHERE k.token_hash = p_token_hash AND k.revoked_at IS NULL AND k.expires_at > now();
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT c.* INTO cust FROM public.bodega_customers c
  WHERE c.id = cred.customer_id AND c.active;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF cred.last_used_at IS NULL OR cred.last_used_at < now() - interval '1 minute' THEN
    UPDATE public.bodega_agent_credentials SET last_used_at = now() WHERE id = cred.id;
  END IF;
  RETURN jsonb_build_object('customer', public.bodega_customer_json(cust), 'credential_id', cred.id);
END;
$$;

REVOKE ALL ON FUNCTION
  public.bodega_customers_guard(),
  public.bodega_agent_credentials_guard(),
  public.bodega_customer_json(public.bodega_customers),
  public.bodega_create_customer(text, text, bigint, bigint, text, text, timestamptz),
  public.bodega_get_customer(text),
  public.bodega_list_customers(),
  public.bodega_set_customer_active(text, boolean),
  public.bodega_add_agent_credential(text, text, text, timestamptz, boolean),
  public.bodega_revoke_agent_credential(text),
  public.bodega_authenticate_agent(text)
FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.bodega_customer_json(public.bodega_customers),
  public.bodega_create_customer(text, text, bigint, bigint, text, text, timestamptz),
  public.bodega_get_customer(text),
  public.bodega_list_customers(),
  public.bodega_set_customer_active(text, boolean),
  public.bodega_add_agent_credential(text, text, text, timestamptz, boolean),
  public.bodega_revoke_agent_credential(text),
  public.bodega_authenticate_agent(text)
TO project_admin;
