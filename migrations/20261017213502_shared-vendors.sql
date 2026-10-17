-- Shared, authoritative vendor backend for Bodega (BODEGA_VENDOR_BACKEND=insforge).
--
-- * Normalized public tables; RLS enabled; anon/authenticated/PUBLIC have no table or function access.
-- * All mutations go through server-only SECURITY INVOKER RPC functions called with the project
--   admin API key (role project_admin). Each RPC call runs in one PostgREST transaction, so every
--   function below is atomic. Row locks / transaction-scoped advisory locks serialize admission.
-- * Functions take one jsonb argument `p` and return jsonb. Expected business failures are returned
--   as {"ok":false,"code":...,"message":...} (nothing has been written at that point); unexpected
--   failures raise and roll the call back.
-- * No plaintext secrets: trial tokens, approval tokens and PostPigeon scoped keys are stored as
--   SHA-256 hashes only. Pooled upstream keys are never stored. External webhook leases are stored
--   only as AES-256-GCM ciphertext sealed by the server (key never reaches the database).
-- * No BEGIN/COMMIT: the migration runner wraps this file in its own transaction.

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

CREATE TABLE public.bodega_vendor_listings (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$'),
  vendor_id text NOT NULL CHECK (vendor_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$'),
  name text NOT NULL CHECK (length(name) <= 16000),
  category text NOT NULL CHECK (length(category) <= 16000),
  one_line text NOT NULL CHECK (length(one_line) <= 16000),
  docs_url text NOT NULL CHECK (length(docs_url) <= 16000),
  quickstart text NOT NULL CHECK (length(quickstart) <= 16000),
  keywords text[] NOT NULL DEFAULT '{}' CHECK (cardinality(keywords) <= 200),
  checks text[] NOT NULL DEFAULT '{}' CHECK (cardinality(checks) <= 200),
  adds_tools text[] NOT NULL DEFAULT '{}' CHECK (cardinality(adds_tools) <= 200),
  price_buy_usd numeric NOT NULL CHECK (price_buy_usd >= 0 AND price_buy_usd < 1000000000),
  price_unit_label text NOT NULL CHECK (length(price_unit_label) <= 1000),
  is_real boolean NOT NULL DEFAULT false,
  sandbox_image text NULL CHECK (length(sandbox_image) <= 1000),
  sandbox_install text[] NULL CHECK (cardinality(sandbox_install) <= 100),
  sandbox_env_hint jsonb NULL CHECK (sandbox_env_hint IS NULL OR (jsonb_typeof(sandbox_env_hint) = 'object' AND pg_column_size(sandbox_env_hint) < 32000)),
  trial_unit text NULL CHECK (trial_unit IN ('api_calls', 'sandbox_minutes', 'runs')),
  trial_per_agent bigint NULL,
  trial_pool_total bigint NULL,
  trial_pool_used bigint NULL,
  trial_expires_after_min double precision NULL,
  trial_max_concurrent bigint NULL,
  search_text text NOT NULL DEFAULT '',
  seq bigint GENERATED ALWAYS AS IDENTITY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bodega_vendor_listings_sandbox_shape CHECK (
    (sandbox_image IS NULL) = (sandbox_install IS NULL) AND (sandbox_image IS NULL) = (sandbox_env_hint IS NULL)),
  CONSTRAINT bodega_vendor_listings_trial_shape CHECK (
    (trial_unit IS NULL AND trial_per_agent IS NULL AND trial_pool_total IS NULL AND trial_pool_used IS NULL
       AND trial_expires_after_min IS NULL AND trial_max_concurrent IS NULL)
    OR (trial_unit IS NOT NULL AND trial_per_agent >= 0 AND trial_pool_total >= 0 AND trial_pool_used >= 0
       AND trial_pool_used <= trial_pool_total AND trial_expires_after_min > 0
       AND trial_expires_after_min < 'Infinity'::double precision AND trial_max_concurrent >= 0))
);
CREATE INDEX bodega_vendor_listings_vendor ON public.bodega_vendor_listings (vendor_id, seq);
CREATE INDEX bodega_vendor_listings_category ON public.bodega_vendor_listings (category, seq);

CREATE TABLE public.bodega_vendor_trials (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  listing_id text NOT NULL REFERENCES public.bodega_vendor_listings (id) ON DELETE RESTRICT,
  session_id text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 200),
  sandbox_id text NULL CHECK (length(sandbox_id) <= 500),
  status text NOT NULL CHECK (status IN ('provisioning', 'active', 'exhausted', 'expired', 'ended')),
  used bigint NOT NULL DEFAULT 0 CHECK (used >= 0),
  limit_amount bigint NOT NULL CHECK (limit_amount > 0),
  unit text NOT NULL CHECK (unit IN ('api_calls', 'sandbox_minutes', 'runs')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  started_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT bodega_vendor_trials_used_le_limit CHECK (used <= limit_amount)
);
CREATE INDEX bodega_vendor_trials_listing_live ON public.bodega_vendor_trials (listing_id, status, expires_at);
CREATE INDEX bodega_vendor_trials_live ON public.bodega_vendor_trials (status, expires_at);
CREATE INDEX bodega_vendor_trials_session ON public.bodega_vendor_trials (session_id, listing_id, started_at);

CREATE TABLE public.bodega_vendor_purchases (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  listing_id text NOT NULL REFERENCES public.bodega_vendor_listings (id) ON DELETE RESTRICT,
  session_id text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 200),
  amount_usd numeric NOT NULL CHECK (amount_usd >= 0 AND amount_usd < 1000000000),
  status text NOT NULL CHECK (status IN ('paid', 'needs_approval', 'declined', 'ready', 'charging', 'pending')),
  receipt_id text NULL CHECK (length(receipt_id) <= 500),
  created_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bodega_vendor_purchases_listing ON public.bodega_vendor_purchases (listing_id, status);
CREATE INDEX bodega_vendor_purchases_session ON public.bodega_vendor_purchases (session_id, created_at);

CREATE TABLE public.bodega_vendor_comparisons (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  check_id text NOT NULL CHECK (length(check_id) <= 200),
  session_id text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 200),
  suggestion text NULL CHECK (length(suggestion) <= 200),
  reason text NOT NULL CHECK (length(reason) <= 16000),
  created_at timestamptz NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bodega_vendor_comparisons_session ON public.bodega_vendor_comparisons (session_id, created_at);

CREATE TABLE public.bodega_vendor_check_results (
  comparison_id text NOT NULL REFERENCES public.bodega_vendor_comparisons (id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal >= 0 AND ordinal < 64),
  listing_id text NOT NULL CHECK (length(listing_id) <= 200),
  trial_id text NOT NULL CHECK (length(trial_id) <= 200),
  ok boolean NOT NULL,
  metrics jsonb NOT NULL CHECK (jsonb_typeof(metrics) = 'object' AND pg_column_size(metrics) < 16000),
  loc integer NOT NULL CHECK (loc >= 0),
  error text NULL CHECK (length(error) <= 16000),
  logs_tail text NOT NULL CHECK (length(logs_tail) <= 16000),
  PRIMARY KEY (comparison_id, ordinal)
);
CREATE INDEX bodega_vendor_check_results_listing ON public.bodega_vendor_check_results (listing_id, ok);

CREATE TABLE public.bodega_vendor_reviews (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 400),
  listing_id text NOT NULL CHECK (length(listing_id) <= 200),
  session_id text NOT NULL CHECK (length(session_id) BETWEEN 1 AND 200),
  verdict text NOT NULL CHECK (verdict IN ('chosen', 'rejected', 'neutral')),
  reason text NOT NULL CHECK (length(reason) <= 16000),
  compared_with text[] NOT NULL DEFAULT '{}' CHECK (cardinality(compared_with) <= 64),
  source text NOT NULL CHECK (source IN ('agent', 'auto')),
  created_at timestamptz NOT NULL,
  payload_digest text NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  seq bigint GENERATED ALWAYS AS IDENTITY,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bodega_vendor_reviews_listing ON public.bodega_vendor_reviews (listing_id, verdict);

CREATE TABLE public.bodega_vendor_approvals (
  purchase_id text PRIMARY KEY REFERENCES public.bodega_vendor_purchases (id) ON DELETE RESTRICT,
  session_id text NOT NULL,
  listing_id text NOT NULL,
  amount_usd numeric NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'declined')),
  expires_at timestamptz NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz NULL,
  CONSTRAINT bodega_vendor_approvals_decided CHECK ((status = 'pending') = (decided_at IS NULL))
);
CREATE INDEX bodega_vendor_approvals_pending ON public.bodega_vendor_approvals (status, expires_at);

-- Durable notification outbox. Never stores approval URLs or tokens: delivery happens inline through
-- the server's injected callback, and this row records the durable delivery status.
CREATE TABLE public.bodega_vendor_notifications (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{8,100}$'),
  kind text NOT NULL CHECK (kind IN ('approval_request')),
  purchase_id text NOT NULL REFERENCES public.bodega_vendor_purchases (id) ON DELETE RESTRICT,
  recipient text NOT NULL CHECK (length(recipient) BETWEEN 1 AND 320 AND recipient !~ '[\r\n]'),
  subject text NOT NULL CHECK (length(subject) <= 300 AND subject !~ '[\r\n]'),
  status text NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'captured')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text NULL CHECK (last_error ~ '^[a-z0-9_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz NULL
);
CREATE INDEX bodega_vendor_notifications_status ON public.bodega_vendor_notifications (status, created_at);
CREATE INDEX bodega_vendor_notifications_created ON public.bodega_vendor_notifications (created_at);
CREATE INDEX bodega_vendor_notifications_purchase ON public.bodega_vendor_notifications (purchase_id);

-- Append-only revocations: once a lease id is revoked it can never be leased again on any replica.
CREATE TABLE public.bodega_vendor_revocations (
  lease_id text PRIMARY KEY CHECK (length(lease_id) BETWEEN 1 AND 200),
  revoked_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.bodega_vendor_leases (
  lease_id text PRIMARY KEY CHECK (length(lease_id) BETWEEN 1 AND 200),
  listing_id text NOT NULL CHECK (length(listing_id) <= 200),
  kind text NOT NULL CHECK (kind IN ('scoped_hmac', 'webhook_sealed')),
  status text NOT NULL CHECK (status IN ('provisioning', 'active', 'revoked')),
  key_hash text NULL UNIQUE CHECK (key_hash ~ '^[0-9a-f]{64}$'),
  sealed_secret text NULL CHECK (sealed_secret ~ '^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$' AND length(sealed_secret) <= 8192),
  claim_id text NULL CHECK (claim_id ~ '^[A-Za-z0-9_-]{16,100}$'),
  claimed_at timestamptz NULL,
  expires_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL,
  CONSTRAINT bodega_vendor_leases_scoped_shape CHECK (kind <> 'scoped_hmac' OR (key_hash IS NOT NULL AND sealed_secret IS NULL)),
  CONSTRAINT bodega_vendor_leases_webhook_shape CHECK (kind <> 'webhook_sealed' OR key_hash IS NULL),
  CONSTRAINT bodega_vendor_leases_active_shape CHECK (status <> 'active' OR (expires_at IS NOT NULL AND (kind = 'scoped_hmac' OR sealed_secret IS NOT NULL))),
  CONSTRAINT bodega_vendor_leases_revoked_shape CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);
CREATE INDEX bodega_vendor_leases_status ON public.bodega_vendor_leases (status, expires_at);

-- ---------------------------------------------------------------------------------------------
-- Integrity guards (defense in depth; RPCs already enforce these)
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public.bodega_vendor__listing_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.vendor_id IS DISTINCT FROM OLD.vendor_id THEN
    RAISE EXCEPTION 'listing id and vendor_id are immutable';
  END IF;
  IF OLD.trial_unit IS NOT NULL AND OLD.trial_pool_used > 0
     AND (NEW.trial_unit IS NULL OR NEW.trial_pool_used < OLD.trial_pool_used) THEN
    RAISE EXCEPTION 'consumed trial pool cannot be reduced or removed';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER bodega_vendor_listings_guard BEFORE UPDATE ON public.bodega_vendor_listings
FOR EACH ROW EXECUTE FUNCTION public.bodega_vendor__listing_guard();

CREATE FUNCTION public.bodega_vendor__trial_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
     OR NEW.limit_amount IS DISTINCT FROM OLD.limit_amount OR NEW.unit IS DISTINCT FROM OLD.unit
     OR NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'trial identity, quota and lifetime are immutable';
  END IF;
  IF NEW.used < OLD.used THEN
    RAISE EXCEPTION 'trial usage is monotonic';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND (OLD.status IN ('ended', 'expired')
     OR (OLD.status = 'exhausted' AND NEW.status NOT IN ('ended', 'expired'))) THEN
    RAISE EXCEPTION 'terminal trial cannot be reactivated';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER bodega_vendor_trials_guard BEFORE UPDATE ON public.bodega_vendor_trials
FOR EACH ROW EXECUTE FUNCTION public.bodega_vendor__trial_guard();

CREATE FUNCTION public.bodega_vendor__purchase_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
     OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.amount_usd IS DISTINCT FROM OLD.amount_usd
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at THEN
    RAISE EXCEPTION 'purchase owner, listing and price are immutable';
  END IF;
  IF OLD.status = 'paid' AND (NEW.status <> 'paid' OR NEW.receipt_id IS DISTINCT FROM OLD.receipt_id) THEN
    RAISE EXCEPTION 'paid purchase is final';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER bodega_vendor_purchases_guard BEFORE UPDATE ON public.bodega_vendor_purchases
FOR EACH ROW EXECUTE FUNCTION public.bodega_vendor__purchase_guard();

CREATE FUNCTION public.bodega_vendor__approval_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.purchase_id IS DISTINCT FROM OLD.purchase_id OR NEW.session_id IS DISTINCT FROM OLD.session_id
     OR NEW.listing_id IS DISTINCT FROM OLD.listing_id OR NEW.amount_usd IS DISTINCT FROM OLD.amount_usd THEN
    RAISE EXCEPTION 'approval purchase binding is immutable';
  END IF;
  IF OLD.status <> 'pending' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'decided approval is final';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER bodega_vendor_approvals_guard BEFORE UPDATE ON public.bodega_vendor_approvals
FOR EACH ROW EXECUTE FUNCTION public.bodega_vendor__approval_guard();

CREATE FUNCTION public.bodega_vendor__lease_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.lease_id IS DISTINCT FROM OLD.lease_id OR NEW.listing_id IS DISTINCT FROM OLD.listing_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR (OLD.key_hash IS NOT NULL AND NEW.key_hash IS DISTINCT FROM OLD.key_hash) THEN
    RAISE EXCEPTION 'lease identity is immutable';
  END IF;
  IF OLD.status = 'revoked' AND NEW.status <> 'revoked' THEN
    RAISE EXCEPTION 'revoked lease cannot be reactivated';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER bodega_vendor_leases_guard BEFORE UPDATE ON public.bodega_vendor_leases
FOR EACH ROW EXECUTE FUNCTION public.bodega_vendor__lease_guard();

CREATE FUNCTION public.bodega_vendor__append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END $$;
CREATE TRIGGER bodega_vendor_revocations_append_only BEFORE UPDATE OR DELETE ON public.bodega_vendor_revocations
FOR EACH ROW EXECUTE FUNCTION public.bodega_vendor__append_only();
CREATE TRIGGER bodega_vendor_comparisons_append_only BEFORE UPDATE OR DELETE ON public.bodega_vendor_comparisons
FOR EACH ROW EXECUTE FUNCTION public.bodega_vendor__append_only();
CREATE TRIGGER bodega_vendor_check_results_append_only BEFORE UPDATE OR DELETE ON public.bodega_vendor_check_results
FOR EACH ROW EXECUTE FUNCTION public.bodega_vendor__append_only();
CREATE TRIGGER bodega_vendor_reviews_append_only BEFORE UPDATE OR DELETE ON public.bodega_vendor_reviews
FOR EACH ROW EXECUTE FUNCTION public.bodega_vendor__append_only();

-- ---------------------------------------------------------------------------------------------
-- Internal helpers
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION public.bodega_vendor__err(p_code text, p_message text) RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('ok', false, 'code', p_code, 'message', p_message)
$$;

CREATE FUNCTION public.bodega_vendor__text_array(p_value jsonb, p_max integer) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v text[];
BEGIN
  IF p_value IS NULL OR jsonb_typeof(p_value) <> 'array' THEN RAISE EXCEPTION 'expected array'; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_value) e WHERE jsonb_typeof(e) <> 'string') THEN
    RAISE EXCEPTION 'expected string array';
  END IF;
  v := ARRAY(SELECT jsonb_array_elements_text(p_value));
  IF cardinality(v) > p_max THEN RAISE EXCEPTION 'array too large'; END IF;
  RETURN v;
END $$;

CREATE FUNCTION public.bodega_vendor__listing_json(l public.bodega_vendor_listings) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', l.id, 'vendor_id', l.vendor_id, 'name', l.name, 'category', l.category, 'one_line', l.one_line,
    'keywords', to_jsonb(l.keywords), 'docs_url', l.docs_url, 'quickstart', l.quickstart,
    'sandbox', CASE WHEN l.sandbox_image IS NULL THEN 'null'::jsonb ELSE jsonb_build_object(
      'image', l.sandbox_image, 'install', to_jsonb(l.sandbox_install), 'env_hint', l.sandbox_env_hint) END,
    'checks', to_jsonb(l.checks),
    'trial', CASE WHEN l.trial_unit IS NULL THEN 'null'::jsonb ELSE jsonb_build_object(
      'unit', l.trial_unit, 'per_agent', l.trial_per_agent, 'pool_total', l.trial_pool_total,
      'pool_used', l.trial_pool_used, 'expires_after_min', l.trial_expires_after_min,
      'max_concurrent', l.trial_max_concurrent) END,
    'price', jsonb_build_object('buy_usd', l.price_buy_usd, 'unit_label', l.price_unit_label),
    'adds_tools', to_jsonb(l.adds_tools), 'real', l.is_real)
$$;

-- Trial token is never returned; callers only ever hold the token they generated.
CREATE FUNCTION public.bodega_vendor__trial_json(t public.bodega_vendor_trials) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('id', t.id, 'listing_id', t.listing_id, 'session_id', t.session_id,
    'sandbox_id', t.sandbox_id, 'status', t.status, 'used', t.used, 'limit', t.limit_amount, 'unit', t.unit,
    'started_at', t.started_at, 'expires_at', t.expires_at)
$$;

CREATE FUNCTION public.bodega_vendor__purchase_json(r public.bodega_vendor_purchases) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('id', r.id, 'listing_id', r.listing_id, 'session_id', r.session_id,
    'amount_usd', r.amount_usd, 'status', r.status, 'receipt_id', r.receipt_id, 'created_at', r.created_at))
$$;

-- ---------------------------------------------------------------------------------------------
-- Catalog RPCs
-- ---------------------------------------------------------------------------------------------

-- p: {listing: Listing (already projected by the server), seed_only: boolean}
CREATE FUNCTION public.bodega_vendor_listing_upsert(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v jsonb := p->'listing';
  v_seed boolean := coalesce((p->>'seed_only')::boolean, false);
  v_id text := v->>'id';
  v_old public.bodega_vendor_listings;
  v_has_trial boolean := jsonb_typeof(v->'trial') = 'object';
  v_has_sandbox boolean := jsonb_typeof(v->'sandbox') = 'object';
  v_used bigint;
  v_keywords text[] := public.bodega_vendor__text_array(v->'keywords', 200);
  v_checks text[] := public.bodega_vendor__text_array(v->'checks', 200);
  v_tools text[] := public.bodega_vendor__text_array(v->'adds_tools', 200);
  v_search text;
  v_attempt integer;
BEGIN
  IF v_id IS NULL THEN RETURN public.bodega_vendor__err('invalid', 'Invalid listing identifiers'); END IF;
  v_search := lower(concat_ws(' ', v->>'name', v->>'category', v->>'one_line', array_to_string(v_keywords, ' ')));
  FOR v_attempt IN 1..2 LOOP
    SELECT * INTO v_old FROM public.bodega_vendor_listings WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.bodega_vendor_listings AS l (id, vendor_id, name, category, one_line, docs_url, quickstart,
        keywords, checks, adds_tools, price_buy_usd, price_unit_label, is_real, sandbox_image, sandbox_install,
        sandbox_env_hint, trial_unit, trial_per_agent, trial_pool_total, trial_pool_used, trial_expires_after_min,
        trial_max_concurrent, search_text)
      VALUES (v_id, v->>'vendor_id', v->>'name', v->>'category', v->>'one_line', v->>'docs_url', v->>'quickstart',
        v_keywords, v_checks, v_tools, (v->'price'->>'buy_usd')::numeric, v->'price'->>'unit_label',
        coalesce((v->>'real')::boolean, false),
        CASE WHEN v_has_sandbox THEN v->'sandbox'->>'image' END,
        CASE WHEN v_has_sandbox THEN public.bodega_vendor__text_array(v->'sandbox'->'install', 100) END,
        CASE WHEN v_has_sandbox THEN v->'sandbox'->'env_hint' END,
        CASE WHEN v_has_trial THEN v->'trial'->>'unit' END,
        CASE WHEN v_has_trial THEN (v->'trial'->>'per_agent')::bigint END,
        CASE WHEN v_has_trial THEN (v->'trial'->>'pool_total')::bigint END,
        CASE WHEN v_has_trial THEN (v->'trial'->>'pool_used')::bigint END,
        CASE WHEN v_has_trial THEN (v->'trial'->>'expires_after_min')::double precision END,
        CASE WHEN v_has_trial THEN (v->'trial'->>'max_concurrent')::bigint END,
        v_search)
      ON CONFLICT (id) DO NOTHING;
      IF FOUND THEN RETURN jsonb_build_object('ok', true, 'inserted', true); END IF;
      CONTINUE; -- lost an insert race; lock the winner's row and fall through to the update path
    END IF;
    IF v_seed THEN RETURN jsonb_build_object('ok', true, 'inserted', false); END IF;
    IF v_old.vendor_id IS DISTINCT FROM v->>'vendor_id' THEN
      RETURN public.bodega_vendor__err('conflict', 'Cannot change listing vendor');
    END IF;
    IF NOT v_has_trial AND coalesce(v_old.trial_pool_used, 0) > 0 THEN
      RETURN public.bodega_vendor__err('conflict', 'Cannot remove a funded trial policy after use');
    END IF;
    -- pool_used is server-maintained: a portal edit can never reset consumed usage.
    v_used := CASE WHEN NOT v_has_trial THEN NULL
                   WHEN v_old.trial_unit IS NOT NULL THEN v_old.trial_pool_used
                   ELSE (v->'trial'->>'pool_used')::bigint END;
    IF v_has_trial AND (v->'trial'->>'pool_total')::bigint < v_used THEN
      RETURN public.bodega_vendor__err('conflict', 'Pool cannot be smaller than consumed usage');
    END IF;
    UPDATE public.bodega_vendor_listings SET
      name = v->>'name', category = v->>'category', one_line = v->>'one_line', docs_url = v->>'docs_url',
      quickstart = v->>'quickstart', keywords = v_keywords, checks = v_checks, adds_tools = v_tools,
      price_buy_usd = (v->'price'->>'buy_usd')::numeric, price_unit_label = v->'price'->>'unit_label',
      is_real = coalesce((v->>'real')::boolean, false),
      sandbox_image = CASE WHEN v_has_sandbox THEN v->'sandbox'->>'image' END,
      sandbox_install = CASE WHEN v_has_sandbox THEN public.bodega_vendor__text_array(v->'sandbox'->'install', 100) END,
      sandbox_env_hint = CASE WHEN v_has_sandbox THEN v->'sandbox'->'env_hint' END,
      trial_unit = CASE WHEN v_has_trial THEN v->'trial'->>'unit' END,
      trial_per_agent = CASE WHEN v_has_trial THEN (v->'trial'->>'per_agent')::bigint END,
      trial_pool_total = CASE WHEN v_has_trial THEN (v->'trial'->>'pool_total')::bigint END,
      trial_pool_used = v_used,
      trial_expires_after_min = CASE WHEN v_has_trial THEN (v->'trial'->>'expires_after_min')::double precision END,
      trial_max_concurrent = CASE WHEN v_has_trial THEN (v->'trial'->>'max_concurrent')::bigint END,
      search_text = v_search
    WHERE id = v_id;
    RETURN jsonb_build_object('ok', true, 'inserted', false);
  END LOOP;
  RAISE EXCEPTION 'listing upsert did not converge';
END $$;

-- p: {id}
CREATE FUNCTION public.bodega_vendor_listing_get(p jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'listing',
    (SELECT public.bodega_vendor__listing_json(l) FROM public.bodega_vendor_listings l WHERE l.id = p->>'id'))
$$;

-- p: {vendor_id, limit}
CREATE FUNCTION public.bodega_vendor_listing_by_vendor(p jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'listings', coalesce(jsonb_agg(x.j ORDER BY x.seq), '[]'::jsonb))
  FROM (SELECT public.bodega_vendor__listing_json(l) AS j, l.seq FROM public.bodega_vendor_listings l
        WHERE l.vendor_id = p->>'vendor_id' ORDER BY l.seq
        LIMIT least(greatest(coalesce((p->>'limit')::integer, 200), 0), 500)) x
$$;

-- p: {words: text[] (lowercase), category: text|null, limit}
CREATE FUNCTION public.bodega_vendor_listing_search(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_words text[] := ARRAY(SELECT lower(w) FROM jsonb_array_elements_text(coalesce(p->'words', '[]'::jsonb)) w
                          WHERE length(w) BETWEEN 1 AND 100 LIMIT 32);
  v_category text := p->>'category';
  v_limit integer := least(greatest(coalesce((p->>'limit')::integer, 5), 0), 100);
BEGIN
  RETURN jsonb_build_object('ok', true, 'listings', coalesce((
    SELECT jsonb_agg(public.bodega_vendor__listing_json(top.l) ORDER BY top.score DESC, (top.l).seq) FROM (
      SELECT s.l, s.score FROM (
        SELECT l, (SELECT count(*) FROM unnest(v_words) w WHERE strpos(l.search_text, w) > 0) AS score
        FROM public.bodega_vendor_listings l
        WHERE v_category IS NULL OR l.category = v_category
      ) s
      WHERE cardinality(v_words) = 0 OR s.score > 0
      ORDER BY s.score DESC, (s.l).seq
      LIMIT v_limit
    ) top), '[]'::jsonb));
END $$;

-- ---------------------------------------------------------------------------------------------
-- Ledger RPCs: trials
-- ---------------------------------------------------------------------------------------------

-- p: {trial: {id, listing_id, session_id, sandbox_id, status, used, limit, unit, token_hash, started_at,
--     expires_at}, max_active: integer|null}
CREATE FUNCTION public.bodega_vendor_trial_create(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v jsonb := p->'trial';
  v_max_active bigint := (p->>'max_active')::bigint;
  v_limit bigint := (v->>'limit')::bigint;
  v_expires timestamptz := (v->>'expires_at')::timestamptz;
  v_listing public.bodega_vendor_listings;
  v_row public.bodega_vendor_trials;
BEGIN
  -- One global admission lock serializes the cross-session/cross-listing counts on every replica.
  PERFORM pg_advisory_xact_lock(hashtextextended('bodega_vendor_trial_admission', 0));
  SELECT * INTO v_listing FROM public.bodega_vendor_listings WHERE id = v->>'listing_id' FOR UPDATE;
  IF NOT FOUND OR v_listing.trial_unit IS NULL OR v_limit IS NULL OR v_limit <= 0
     OR v_limit > v_listing.trial_per_agent OR coalesce((v->>'used')::bigint, -1) <> 0
     OR v->>'unit' IS DISTINCT FROM v_listing.trial_unit OR v_expires IS NULL OR v_expires <= now()
     OR v->>'status' NOT IN ('provisioning', 'active') THEN
    RETURN public.bodega_vendor__err('invalid', 'Invalid trial or policy');
  END IF;
  IF EXISTS (SELECT 1 FROM public.bodega_vendor_trials WHERE id = v->>'id') THEN
    RETURN public.bodega_vendor__err('conflict', 'Duplicate trial id');
  END IF;
  IF EXISTS (SELECT 1 FROM public.bodega_vendor_trials WHERE token_hash = v->>'token_hash') THEN
    RETURN public.bodega_vendor__err('invalid', 'Duplicate trial token');
  END IF;
  IF v_max_active IS NOT NULL AND (SELECT count(*) FROM public.bodega_vendor_trials
      WHERE status IN ('active', 'provisioning') AND expires_at > now()) >= v_max_active THEN
    RETURN public.bodega_vendor__err('limit', 'Global sandbox limit reached');
  END IF;
  IF (SELECT count(*) FROM public.bodega_vendor_trials WHERE listing_id = v_listing.id
      AND status IN ('active', 'provisioning') AND expires_at > now()) >= v_listing.trial_max_concurrent THEN
    RETURN public.bodega_vendor__err('limit', 'Vendor concurrent trial limit reached');
  END IF;
  -- The allowance applies to the whole agent session, including ended trials.
  IF (SELECT coalesce(sum(limit_amount), 0) FROM public.bodega_vendor_trials
      WHERE listing_id = v_listing.id AND session_id = v->>'session_id') + v_limit > v_listing.trial_per_agent THEN
    RETURN public.bodega_vendor__err('limit', 'Session trial allowance already allocated');
  END IF;
  IF v_listing.trial_pool_used >= v_listing.trial_pool_total THEN
    RETURN public.bodega_vendor__err('quota_exceeded', 'Trial or vendor quota exhausted');
  END IF;
  INSERT INTO public.bodega_vendor_trials (id, listing_id, session_id, sandbox_id, status, used, limit_amount, unit,
    token_hash, started_at, expires_at)
  VALUES (v->>'id', v_listing.id, v->>'session_id', v->>'sandbox_id', v->>'status', 0, v_limit, v->>'unit',
    v->>'token_hash', (v->>'started_at')::timestamptz, v_expires)
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('ok', true, 'trial', public.bodega_vendor__trial_json(v_row));
END $$;

-- p: {id} | {token_hash}
CREATE FUNCTION public.bodega_vendor_trial_get(p jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'trial', (SELECT public.bodega_vendor__trial_json(t)
    FROM public.bodega_vendor_trials t
    WHERE (p ? 'id' AND t.id = p->>'id') OR (p ? 'token_hash' AND t.token_hash = p->>'token_hash')
    LIMIT 1))
$$;

-- p: {session_id, limit}
CREATE FUNCTION public.bodega_vendor_trial_list(p jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'trials', coalesce(jsonb_agg(x.j ORDER BY x.started_at, x.id), '[]'::jsonb))
  FROM (SELECT public.bodega_vendor__trial_json(t) AS j, t.started_at, t.id FROM public.bodega_vendor_trials t
        WHERE t.session_id = p->>'session_id' ORDER BY t.started_at DESC, t.id
        LIMIT least(greatest(coalesce((p->>'limit')::integer, 500), 0), 1000)) x
$$;

-- p: {id, patch: {status?, sandbox_id?}, expect: {listing_id?, session_id?, token_hash?, used?, limit?, unit?,
--     started_at?, expires_at?}}
CREATE FUNCTION public.bodega_vendor_trial_update(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_patch jsonb := coalesce(p->'patch', '{}'::jsonb);
  v_expect jsonb := coalesce(p->'expect', '{}'::jsonb);
  v_t public.bodega_vendor_trials;
  v_status text;
  v_field text;
BEGIN
  SELECT * INTO v_t FROM public.bodega_vendor_trials WHERE id = p->>'id' FOR UPDATE;
  IF NOT FOUND THEN RETURN public.bodega_vendor__err('not_found', 'Unknown trial'); END IF;
  FOR v_field IN SELECT jsonb_object_keys(v_expect) LOOP
    IF (CASE v_field
         WHEN 'listing_id' THEN v_t.listing_id IS DISTINCT FROM v_expect->>v_field
         WHEN 'session_id' THEN v_t.session_id IS DISTINCT FROM v_expect->>v_field
         WHEN 'token_hash' THEN v_t.token_hash IS DISTINCT FROM v_expect->>v_field
         WHEN 'used' THEN v_t.used IS DISTINCT FROM (v_expect->>v_field)::bigint
         WHEN 'limit' THEN v_t.limit_amount IS DISTINCT FROM (v_expect->>v_field)::bigint
         WHEN 'unit' THEN v_t.unit IS DISTINCT FROM v_expect->>v_field
         WHEN 'started_at' THEN v_t.started_at IS DISTINCT FROM (v_expect->>v_field)::timestamptz
         WHEN 'expires_at' THEN v_t.expires_at IS DISTINCT FROM (v_expect->>v_field)::timestamptz
         ELSE true END) THEN
      RETURN public.bodega_vendor__err('invalid', 'Trial ' || v_field || ' is immutable; use recordUsage');
    END IF;
  END LOOP;
  v_status := coalesce(v_patch->>'status', v_t.status);
  IF v_status NOT IN ('provisioning', 'active', 'exhausted', 'expired', 'ended') THEN
    RETURN public.bodega_vendor__err('invalid', 'Invalid trial status');
  END IF;
  IF v_status <> v_t.status AND (v_t.status IN ('ended', 'expired')
     OR (v_t.status = 'exhausted' AND v_status NOT IN ('ended', 'expired'))) THEN
    RETURN public.bodega_vendor__err('invalid', 'Terminal trial cannot be reactivated');
  END IF;
  UPDATE public.bodega_vendor_trials SET status = v_status,
    sandbox_id = CASE WHEN v_patch ? 'sandbox_id' THEN v_patch->>'sandbox_id' ELSE sandbox_id END
  WHERE id = v_t.id RETURNING * INTO v_t;
  RETURN jsonb_build_object('ok', true, 'trial', public.bodega_vendor__trial_json(v_t));
END $$;

-- p: {id, amount}. Atomically counts usage against the trial and the vendor's funded pool.
CREATE FUNCTION public.bodega_vendor_trial_usage(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_amount bigint := (p->>'amount')::bigint;
  v_listing_id text;
  v_l public.bodega_vendor_listings;
  v_t public.bodega_vendor_trials;
  v_exhausted boolean;
BEGIN
  IF v_amount IS NULL OR v_amount <= 0 OR v_amount > 9007199254740991 THEN
    RETURN public.bodega_vendor__err('invalid', 'Usage must be a positive integer');
  END IF;
  SELECT listing_id INTO v_listing_id FROM public.bodega_vendor_trials WHERE id = p->>'id';
  IF NOT FOUND THEN RETURN public.bodega_vendor__err('not_found', 'Unknown trial'); END IF;
  -- Lock order everywhere: listing, then trial.
  SELECT * INTO v_l FROM public.bodega_vendor_listings WHERE id = v_listing_id FOR UPDATE;
  SELECT * INTO v_t FROM public.bodega_vendor_trials WHERE id = p->>'id' FOR UPDATE;
  IF v_t.status <> 'active' OR v_t.expires_at <= now() THEN
    RETURN public.bodega_vendor__err('quota_exceeded', 'Trial inactive or expired');
  END IF;
  IF v_l.trial_unit IS NULL OR v_amount > v_t.limit_amount - v_t.used
     OR v_amount > v_l.trial_pool_total - v_l.trial_pool_used THEN
    RETURN public.bodega_vendor__err('quota_exceeded', 'Trial or vendor quota exhausted');
  END IF;
  v_exhausted := v_t.used + v_amount >= v_t.limit_amount OR v_l.trial_pool_used + v_amount >= v_l.trial_pool_total;
  UPDATE public.bodega_vendor_listings SET trial_pool_used = trial_pool_used + v_amount WHERE id = v_l.id;
  UPDATE public.bodega_vendor_trials SET used = used + v_amount,
    status = CASE WHEN v_exhausted THEN 'exhausted' ELSE status END
  WHERE id = v_t.id RETURNING * INTO v_t;
  RETURN jsonb_build_object('ok', true, 'used', v_t.used, 'limit', v_t.limit_amount, 'exhausted', v_exhausted);
END $$;

-- ---------------------------------------------------------------------------------------------
-- Ledger RPCs: purchases, comparisons, reviews, funnel
-- ---------------------------------------------------------------------------------------------

-- p: {purchase: {id, listing_id, session_id, amount_usd, status, receipt_id?, created_at}}. Idempotent.
CREATE FUNCTION public.bodega_vendor_purchase_record(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v jsonb := p->'purchase';
  v_row public.bodega_vendor_purchases;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.bodega_vendor_listings WHERE id = v->>'listing_id') THEN
    RETURN public.bodega_vendor__err('invalid', 'Unknown listing');
  END IF;
  INSERT INTO public.bodega_vendor_purchases (id, listing_id, session_id, amount_usd, status, receipt_id, created_at)
  VALUES (v->>'id', v->>'listing_id', v->>'session_id', (v->>'amount_usd')::numeric, v->>'status',
          v->>'receipt_id', (v->>'created_at')::timestamptz)
  ON CONFLICT (id) DO NOTHING;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'inserted', true); END IF;
  SELECT * INTO v_row FROM public.bodega_vendor_purchases WHERE id = v->>'id';
  IF v_row.listing_id IS DISTINCT FROM v->>'listing_id' OR v_row.session_id IS DISTINCT FROM v->>'session_id'
     OR v_row.amount_usd IS DISTINCT FROM (v->>'amount_usd')::numeric OR v_row.status IS DISTINCT FROM v->>'status'
     OR v_row.receipt_id IS DISTINCT FROM v->>'receipt_id'
     OR v_row.created_at IS DISTINCT FROM (v->>'created_at')::timestamptz THEN
    RETURN public.bodega_vendor__err('conflict', 'Conflicting purchase id');
  END IF;
  RETURN jsonb_build_object('ok', true, 'inserted', false);
END $$;

-- p: {id, patch: {status?, receipt_id?}, expect: {listing_id?, session_id?, amount_usd?, created_at?}}
CREATE FUNCTION public.bodega_vendor_purchase_update(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_patch jsonb := coalesce(p->'patch', '{}'::jsonb);
  v_expect jsonb := coalesce(p->'expect', '{}'::jsonb);
  v_row public.bodega_vendor_purchases;
  v_status text;
  v_receipt text;
  v_field text;
BEGIN
  SELECT * INTO v_row FROM public.bodega_vendor_purchases WHERE id = p->>'id' FOR UPDATE;
  IF NOT FOUND THEN RETURN public.bodega_vendor__err('not_found', 'Unknown purchase'); END IF;
  FOR v_field IN SELECT jsonb_object_keys(v_expect) LOOP
    IF (CASE v_field
         WHEN 'listing_id' THEN v_row.listing_id IS DISTINCT FROM v_expect->>v_field
         WHEN 'session_id' THEN v_row.session_id IS DISTINCT FROM v_expect->>v_field
         WHEN 'amount_usd' THEN v_row.amount_usd IS DISTINCT FROM (v_expect->>v_field)::numeric
         WHEN 'created_at' THEN v_row.created_at IS DISTINCT FROM (v_expect->>v_field)::timestamptz
         ELSE true END) THEN
      RETURN public.bodega_vendor__err('invalid', 'Purchase ' || v_field || ' is immutable');
    END IF;
  END LOOP;
  v_status := coalesce(v_patch->>'status', v_row.status);
  v_receipt := CASE WHEN v_patch ? 'receipt_id' THEN v_patch->>'receipt_id' ELSE v_row.receipt_id END;
  IF v_row.status = 'paid' AND (v_status <> 'paid' OR v_receipt IS DISTINCT FROM v_row.receipt_id) THEN
    RETURN public.bodega_vendor__err('conflict', 'Cannot overwrite paid purchase');
  END IF;
  IF v_status NOT IN ('paid', 'needs_approval', 'declined', 'ready', 'charging', 'pending') THEN
    RETURN public.bodega_vendor__err('invalid', 'Invalid purchase status');
  END IF;
  UPDATE public.bodega_vendor_purchases SET status = v_status, receipt_id = v_receipt
  WHERE id = v_row.id RETURNING * INTO v_row;
  RETURN jsonb_build_object('ok', true, 'purchase', public.bodega_vendor__purchase_json(v_row));
END $$;

-- p: {session_id, limit}
CREATE FUNCTION public.bodega_vendor_purchase_list(p jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'purchases', coalesce(jsonb_agg(x.j ORDER BY x.created_at, x.id), '[]'::jsonb))
  FROM (SELECT public.bodega_vendor__purchase_json(r) AS j, r.created_at, r.id FROM public.bodega_vendor_purchases r
        WHERE r.session_id = p->>'session_id' ORDER BY r.created_at DESC, r.id
        LIMIT least(greatest(coalesce((p->>'limit')::integer, 500), 0), 1000)) x
$$;

-- p: {comparison: {id, check_id, session_id, suggestion, reason, created_at}, results: CheckResult[], digest}
CREATE FUNCTION public.bodega_vendor_comparison_record(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v jsonb := p->'comparison';
  v_digest text;
BEGIN
  IF jsonb_typeof(p->'results') <> 'array' OR jsonb_array_length(p->'results') > 64 THEN
    RETURN public.bodega_vendor__err('invalid', 'Invalid comparison results');
  END IF;
  INSERT INTO public.bodega_vendor_comparisons (id, check_id, session_id, suggestion, reason, created_at, payload_digest)
  VALUES (v->>'id', v->>'check_id', v->>'session_id', v->>'suggestion', v->>'reason',
          (v->>'created_at')::timestamptz, p->>'digest')
  ON CONFLICT (id) DO NOTHING;
  IF NOT FOUND THEN
    SELECT payload_digest INTO v_digest FROM public.bodega_vendor_comparisons WHERE id = v->>'id';
    IF v_digest IS DISTINCT FROM p->>'digest' THEN
      RETURN public.bodega_vendor__err('conflict', 'Conflicting comparison id');
    END IF;
    RETURN jsonb_build_object('ok', true, 'inserted', false);
  END IF;
  INSERT INTO public.bodega_vendor_check_results (comparison_id, ordinal, listing_id, trial_id, ok, metrics, loc, error, logs_tail)
  SELECT v->>'id', (r.ord - 1)::integer, r.e->>'listing_id', r.e->>'trial_id', (r.e->>'ok')::boolean,
         coalesce(r.e->'metrics', '{}'::jsonb), (r.e->>'loc')::integer, r.e->>'error', coalesce(r.e->>'logs_tail', '')
  FROM jsonb_array_elements(p->'results') WITH ORDINALITY AS r(e, ord);
  RETURN jsonb_build_object('ok', true, 'inserted', true);
END $$;

-- p: {review: Review, digest}
CREATE FUNCTION public.bodega_vendor_review_record(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v jsonb := p->'review';
  v_digest text;
BEGIN
  INSERT INTO public.bodega_vendor_reviews (id, listing_id, session_id, verdict, reason, compared_with, source,
    created_at, payload_digest)
  VALUES (v->>'id', v->>'listing_id', v->>'session_id', v->>'verdict', v->>'reason',
    public.bodega_vendor__text_array(v->'compared_with', 64), v->>'source', (v->>'created_at')::timestamptz,
    p->>'digest')
  ON CONFLICT (id) DO NOTHING;
  IF FOUND THEN RETURN jsonb_build_object('ok', true, 'inserted', true); END IF;
  SELECT payload_digest INTO v_digest FROM public.bodega_vendor_reviews WHERE id = v->>'id';
  IF v_digest IS DISTINCT FROM p->>'digest' THEN
    RETURN public.bodega_vendor__err('conflict', 'Conflicting review id');
  END IF;
  RETURN jsonb_build_object('ok', true, 'inserted', false);
END $$;

-- p: {vendor_id}. All aggregation happens here; only per-listing counters leave the database.
CREATE FUNCTION public.bodega_vendor_funnel(p jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
  WITH l AS (
    SELECT id, seq FROM public.bodega_vendor_listings WHERE vendor_id = p->>'vendor_id' ORDER BY seq LIMIT 200
  ), t AS (
    SELECT listing_id, count(*) AS n FROM public.bodega_vendor_trials WHERE listing_id IN (SELECT id FROM l) GROUP BY 1
  ), c AS (
    SELECT listing_id, count(*) AS run, count(*) FILTER (WHERE ok) AS passed
    FROM public.bodega_vendor_check_results WHERE listing_id IN (SELECT id FROM l) GROUP BY 1
  ), r AS (
    SELECT listing_id, count(*) FILTER (WHERE verdict = 'chosen') AS chosen,
           count(*) FILTER (WHERE verdict = 'rejected') AS rejected
    FROM public.bodega_vendor_reviews WHERE listing_id IN (SELECT id FROM l) GROUP BY 1
  ), pur AS (
    SELECT listing_id, count(*) AS n, round(sum(amount_usd), 2) AS revenue
    FROM public.bodega_vendor_purchases WHERE status = 'paid' AND listing_id IN (SELECT id FROM l) GROUP BY 1
  ), reasons AS (
    SELECT listing_id, reason,
           row_number() OVER (PARTITION BY listing_id ORDER BY count(*) DESC, min(seq)) AS rn
    FROM public.bodega_vendor_reviews WHERE listing_id IN (SELECT id FROM l) GROUP BY listing_id, reason
  ), top AS (
    SELECT listing_id, jsonb_agg(reason ORDER BY rn) AS reasons FROM reasons WHERE rn <= 3 GROUP BY 1
  )
  SELECT jsonb_build_object('ok', true, 'funnel', jsonb_build_object('vendor_id', p->>'vendor_id', 'listings',
    coalesce(jsonb_agg(jsonb_build_object(
      'listing_id', l.id, 'trials', coalesce(t.n, 0), 'checks_run', coalesce(c.run, 0),
      'checks_passed', coalesce(c.passed, 0), 'chosen', coalesce(r.chosen, 0), 'rejected', coalesce(r.rejected, 0),
      'purchases', coalesce(pur.n, 0), 'revenue_usd', coalesce(pur.revenue, 0),
      'top_reasons', coalesce(top.reasons, '[]'::jsonb)) ORDER BY l.seq), '[]'::jsonb)))
  FROM l LEFT JOIN t ON t.listing_id = l.id LEFT JOIN c ON c.listing_id = l.id LEFT JOIN r ON r.listing_id = l.id
  LEFT JOIN pur ON pur.listing_id = l.id LEFT JOIN top ON top.listing_id = l.id
$$;

-- ---------------------------------------------------------------------------------------------
-- Approvals and notification outbox RPCs
-- ---------------------------------------------------------------------------------------------

-- p: {purchase: {id, session_id, listing_id, amount_usd}, token_hash, ttl_ms,
--     notification: {id, recipient, subject, status: 'pending'|'captured'}}
CREATE FUNCTION public.bodega_vendor_approval_request(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v jsonb := p->'purchase';
  v_n jsonb := p->'notification';
  v_ttl numeric := (p->>'ttl_ms')::numeric;
  v_purchase public.bodega_vendor_purchases;
  v_existing public.bodega_vendor_approvals;
  v_expires timestamptz;
BEGIN
  IF v_ttl IS NULL OR v_ttl <= 0 OR v_ttl > 604800000 THEN
    RETURN public.bodega_vendor__err('invalid', 'Invalid approval TTL');
  END IF;
  -- Lock order: purchase, then approval.
  SELECT * INTO v_purchase FROM public.bodega_vendor_purchases WHERE id = v->>'id' FOR UPDATE;
  IF NOT FOUND OR v_purchase.session_id IS DISTINCT FROM v->>'session_id'
     OR v_purchase.listing_id IS DISTINCT FROM v->>'listing_id'
     OR v_purchase.amount_usd IS DISTINCT FROM (v->>'amount_usd')::numeric
     OR v_purchase.status <> 'needs_approval' THEN
    RETURN public.bodega_vendor__err('invalid', 'Record purchase before requesting approval');
  END IF;
  SELECT * INTO v_existing FROM public.bodega_vendor_approvals WHERE purchase_id = v_purchase.id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.status <> 'pending' THEN
      RETURN public.bodega_vendor__err('conflict', 'Approval already decided');
    END IF;
    IF v_existing.token_hash IS DISTINCT FROM p->>'token_hash' THEN
      RETURN public.bodega_vendor__err('conflict', 'Shared approval signing secret mismatch');
    END IF;
    RETURN jsonb_build_object('ok', true, 'expires_at', v_existing.expires_at);
  END IF;
  v_expires := now() + make_interval(secs => (v_ttl / 1000)::double precision);
  -- One stable hash and deadline per purchase; replica retries never invalidate the first link.
  INSERT INTO public.bodega_vendor_approvals (purchase_id, session_id, listing_id, amount_usd, token_hash, status, expires_at)
  VALUES (v_purchase.id, v_purchase.session_id, v_purchase.listing_id, v_purchase.amount_usd, p->>'token_hash',
          'pending', v_expires)
  ON CONFLICT (purchase_id) DO UPDATE SET token_hash = excluded.token_hash, expires_at = excluded.expires_at,
    requested_at = now();
  INSERT INTO public.bodega_vendor_notifications (id, kind, purchase_id, recipient, subject, status)
  VALUES (v_n->>'id', 'approval_request', v_purchase.id, v_n->>'recipient', v_n->>'subject', v_n->>'status');
  RETURN jsonb_build_object('ok', true, 'expires_at', v_expires);
END $$;

-- p: {purchase_id}. Read-only.
CREATE FUNCTION public.bodega_vendor_approval_status(p jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_a public.bodega_vendor_approvals;
  v_p public.bodega_vendor_purchases;
BEGIN
  SELECT * INTO v_a FROM public.bodega_vendor_approvals WHERE purchase_id = p->>'purchase_id';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'status', 'pending'); END IF;
  SELECT * INTO v_p FROM public.bodega_vendor_purchases WHERE id = v_a.purchase_id;
  IF NOT FOUND OR v_p.session_id IS DISTINCT FROM v_a.session_id OR v_p.listing_id IS DISTINCT FROM v_a.listing_id
     OR v_p.amount_usd IS DISTINCT FROM v_a.amount_usd OR (v_a.status = 'pending' AND v_a.expires_at <= now()) THEN
    RETURN jsonb_build_object('ok', true, 'status', 'declined');
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', v_a.status);
END $$;

-- p: {token_hash}. Safe for GET: read-only, returns only the purchase binding of a usable link.
CREATE FUNCTION public.bodega_vendor_approval_inspect(p jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'approval', (
    SELECT jsonb_build_object('purchase_id', a.purchase_id, 'session_id', a.session_id, 'listing_id', a.listing_id,
      'amount_usd', a.amount_usd, 'expires_at', a.expires_at, 'status', a.status)
    FROM public.bodega_vendor_approvals a JOIN public.bodega_vendor_purchases r ON r.id = a.purchase_id
    WHERE a.token_hash = p->>'token_hash' AND a.status = 'pending' AND a.expires_at > now()
      AND r.session_id = a.session_id AND r.listing_id = a.listing_id AND r.amount_usd = a.amount_usd
      AND r.status = 'needs_approval'))
$$;

-- p: {token_hash, decision: 'approved'|'declined'}. Atomic one-use decision.
CREATE FUNCTION public.bodega_vendor_approval_decide(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_purchase_id text;
  v_p public.bodega_vendor_purchases;
  v_a public.bodega_vendor_approvals;
BEGIN
  IF p->>'decision' NOT IN ('approved', 'declined') THEN
    RETURN public.bodega_vendor__err('invalid', 'Choose approve or decline');
  END IF;
  SELECT purchase_id INTO v_purchase_id FROM public.bodega_vendor_approvals WHERE token_hash = p->>'token_hash';
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', true, 'decided', false); END IF;
  SELECT * INTO v_p FROM public.bodega_vendor_purchases WHERE id = v_purchase_id FOR UPDATE;
  SELECT * INTO v_a FROM public.bodega_vendor_approvals
  WHERE purchase_id = v_purchase_id AND token_hash = p->>'token_hash' FOR UPDATE;
  IF NOT FOUND OR v_a.status <> 'pending' OR v_a.expires_at <= now() OR v_p.status <> 'needs_approval'
     OR v_p.session_id IS DISTINCT FROM v_a.session_id OR v_p.listing_id IS DISTINCT FROM v_a.listing_id
     OR v_p.amount_usd IS DISTINCT FROM v_a.amount_usd THEN
    RETURN jsonb_build_object('ok', true, 'decided', false);
  END IF;
  UPDATE public.bodega_vendor_approvals SET status = p->>'decision', decided_at = now()
  WHERE purchase_id = v_purchase_id;
  RETURN jsonb_build_object('ok', true, 'decided', true);
END $$;

-- p: {id, status: 'sending'|'sent'|'failed', error?: short machine code}
CREATE FUNCTION public.bodega_vendor_notification_mark(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_status text := p->>'status';
  v_row public.bodega_vendor_notifications;
BEGIN
  SELECT * INTO v_row FROM public.bodega_vendor_notifications WHERE id = p->>'id' FOR UPDATE;
  IF NOT FOUND THEN RETURN public.bodega_vendor__err('not_found', 'Unknown notification'); END IF;
  IF NOT ((v_row.status = 'pending' AND v_status = 'sending')
       OR (v_row.status = 'sending' AND v_status IN ('sent', 'failed'))) THEN
    RETURN public.bodega_vendor__err('conflict', 'Invalid notification transition');
  END IF;
  UPDATE public.bodega_vendor_notifications SET status = v_status, updated_at = now(),
    attempts = attempts + CASE WHEN v_status = 'sending' THEN 1 ELSE 0 END,
    last_error = CASE WHEN v_status = 'failed' THEN coalesce(p->>'error', 'delivery_failed') ELSE NULL END,
    delivered_at = CASE WHEN v_status = 'sent' THEN now() ELSE delivered_at END
  WHERE id = v_row.id;
  RETURN jsonb_build_object('ok', true);
END $$;

-- p: {status?: text, limit}. Admin-safe projection: no tokens or URLs exist in this table.
CREATE FUNCTION public.bodega_vendor_notification_list(p jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('ok', true,
    'counts', (SELECT coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
               FROM (SELECT status, count(*) AS n FROM public.bodega_vendor_notifications GROUP BY status) s),
    'notifications', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'kind', n.kind,
        'purchase_id', n.purchase_id, 'recipient', n.recipient, 'subject', n.subject, 'status', n.status,
        'attempts', n.attempts, 'last_error', n.last_error, 'created_at', n.created_at, 'updated_at', n.updated_at,
        'delivered_at', n.delivered_at) ORDER BY n.created_at DESC, n.id), '[]'::jsonb)
      FROM (SELECT * FROM public.bodega_vendor_notifications x
            WHERE p->>'status' IS NULL OR x.status = p->>'status'
            ORDER BY x.created_at DESC, x.id
            LIMIT least(greatest(coalesce((p->>'limit')::integer, 50), 0), 200)) n))
$$;

-- ---------------------------------------------------------------------------------------------
-- Vault RPCs: shared leases and revocations
-- ---------------------------------------------------------------------------------------------

-- p: {lease_id, listing_id, key_hash, ttl_ms}. Registers (once) the hash of a deterministic scoped key.
CREATE FUNCTION public.bodega_vendor_lease_scoped_issue(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_row public.bodega_vendor_leases;
  v_ttl numeric := (p->>'ttl_ms')::numeric;
BEGIN
  IF v_ttl IS NULL OR v_ttl <= 0 OR v_ttl > 86400000 THEN RETURN public.bodega_vendor__err('invalid', 'Invalid lease TTL'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bodega_vendor_lease:' || (p->>'lease_id'), 0));
  IF EXISTS (SELECT 1 FROM public.bodega_vendor_revocations WHERE lease_id = p->>'lease_id') THEN
    RETURN public.bodega_vendor__err('revoked', 'Lease revoked');
  END IF;
  INSERT INTO public.bodega_vendor_leases (lease_id, listing_id, kind, status, key_hash, expires_at)
  VALUES (p->>'lease_id', p->>'listing_id', 'scoped_hmac', 'active', p->>'key_hash',
          now() + make_interval(secs => (v_ttl / 1000)::double precision))
  ON CONFLICT (lease_id) DO NOTHING;
  SELECT * INTO v_row FROM public.bodega_vendor_leases WHERE lease_id = p->>'lease_id';
  IF v_row.listing_id IS DISTINCT FROM p->>'listing_id' OR v_row.kind <> 'scoped_hmac' OR v_row.status <> 'active'
     OR v_row.expires_at <= now() OR v_row.key_hash IS DISTINCT FROM p->>'key_hash' THEN
    RETURN public.bodega_vendor__err('unavailable', 'Lease unavailable');
  END IF;
  RETURN jsonb_build_object('ok', true, 'expires_at', v_row.expires_at);
END $$;

-- p: {key_hash}. Read-only check used by the simulated PostPigeon API on any replica.
CREATE FUNCTION public.bodega_vendor_scoped_key_check(p jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'authorized', EXISTS (
    SELECT 1 FROM public.bodega_vendor_leases k
    WHERE k.key_hash = p->>'key_hash' AND k.kind = 'scoped_hmac' AND k.status = 'active' AND k.expires_at > now()
      AND NOT EXISTS (SELECT 1 FROM public.bodega_vendor_revocations r WHERE r.lease_id = k.lease_id)))
$$;

-- p: {lease_id}
CREATE FUNCTION public.bodega_vendor_lease_revoked(p jsonb) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('ok', true, 'revoked',
    EXISTS (SELECT 1 FROM public.bodega_vendor_revocations WHERE lease_id = p->>'lease_id'))
$$;

-- p: {lease_id, listing_id, claim_id, stale_ms}. Single-flight provisioning across replicas.
-- Returns state: 'active' (with sealed secret), 'claimed' (caller must provision), 'busy', or an error.
CREATE FUNCTION public.bodega_vendor_lease_claim(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_row public.bodega_vendor_leases;
  v_stale numeric := coalesce((p->>'stale_ms')::numeric, 30000);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bodega_vendor_lease:' || (p->>'lease_id'), 0));
  IF EXISTS (SELECT 1 FROM public.bodega_vendor_revocations WHERE lease_id = p->>'lease_id') THEN
    RETURN public.bodega_vendor__err('revoked', 'Lease revoked');
  END IF;
  SELECT * INTO v_row FROM public.bodega_vendor_leases WHERE lease_id = p->>'lease_id' FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.bodega_vendor_leases (lease_id, listing_id, kind, status, claim_id, claimed_at)
    VALUES (p->>'lease_id', p->>'listing_id', 'webhook_sealed', 'provisioning', p->>'claim_id', now());
    RETURN jsonb_build_object('ok', true, 'state', 'claimed');
  END IF;
  IF v_row.listing_id IS DISTINCT FROM p->>'listing_id' OR v_row.kind <> 'webhook_sealed' OR v_row.status = 'revoked' THEN
    RETURN public.bodega_vendor__err('unavailable', 'Lease unavailable');
  END IF;
  IF v_row.status = 'active' THEN
    IF v_row.expires_at <= now() THEN RETURN public.bodega_vendor__err('unavailable', 'Lease unavailable'); END IF;
    RETURN jsonb_build_object('ok', true, 'state', 'active', 'sealed_secret', v_row.sealed_secret,
                              'expires_at', v_row.expires_at);
  END IF;
  IF v_row.claimed_at > now() - make_interval(secs => (v_stale / 1000)::double precision) THEN
    RETURN jsonb_build_object('ok', true, 'state', 'busy');
  END IF;
  UPDATE public.bodega_vendor_leases SET claim_id = p->>'claim_id', claimed_at = now() WHERE lease_id = v_row.lease_id;
  RETURN jsonb_build_object('ok', true, 'state', 'claimed');
END $$;

-- p: {lease_id, claim_id, sealed_secret, expires_at}
CREATE FUNCTION public.bodega_vendor_lease_complete(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bodega_vendor_lease:' || (p->>'lease_id'), 0));
  IF EXISTS (SELECT 1 FROM public.bodega_vendor_revocations WHERE lease_id = p->>'lease_id') THEN
    RETURN public.bodega_vendor__err('revoked', 'Lease revoked');
  END IF;
  UPDATE public.bodega_vendor_leases SET status = 'active', sealed_secret = p->>'sealed_secret',
    expires_at = (p->>'expires_at')::timestamptz, claim_id = NULL, claimed_at = NULL
  WHERE lease_id = p->>'lease_id' AND status = 'provisioning' AND claim_id = p->>'claim_id'
    AND (p->>'expires_at')::timestamptz > now();
  IF NOT FOUND THEN RETURN public.bodega_vendor__err('unavailable', 'Lease claim lost'); END IF;
  RETURN jsonb_build_object('ok', true);
END $$;

-- p: {lease_id, claim_id}
CREATE FUNCTION public.bodega_vendor_lease_release(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('bodega_vendor_lease:' || (p->>'lease_id'), 0));
  DELETE FROM public.bodega_vendor_leases
  WHERE lease_id = p->>'lease_id' AND status = 'provisioning' AND claim_id = p->>'claim_id';
  RETURN jsonb_build_object('ok', true);
END $$;

-- p: {lease_id}. Revocation is recorded first (blocks every replica), then the lease is marked revoked.
-- Returns the sealed secret (if any) so the server can call the vendor's revoke webhook, then scrub.
CREATE FUNCTION public.bodega_vendor_lease_revoke(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_row public.bodega_vendor_leases;
BEGIN
  IF length(p->>'lease_id') NOT BETWEEN 1 AND 200 THEN RETURN public.bodega_vendor__err('invalid', 'Invalid lease id'); END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('bodega_vendor_lease:' || (p->>'lease_id'), 0));
  INSERT INTO public.bodega_vendor_revocations (lease_id) VALUES (p->>'lease_id') ON CONFLICT (lease_id) DO NOTHING;
  UPDATE public.bodega_vendor_leases SET status = 'revoked', revoked_at = coalesce(revoked_at, now()),
    claim_id = NULL, claimed_at = NULL
  WHERE lease_id = p->>'lease_id' RETURNING * INTO v_row;
  RETURN jsonb_build_object('ok', true, 'kind', v_row.kind, 'listing_id', v_row.listing_id,
                            'sealed_secret', v_row.sealed_secret);
END $$;

-- p: {lease_id}. Drops sealed material after upstream revocation succeeded.
CREATE FUNCTION public.bodega_vendor_lease_scrub(p jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.bodega_vendor_leases SET sealed_secret = NULL WHERE lease_id = p->>'lease_id' AND status = 'revoked';
  RETURN jsonb_build_object('ok', true);
END $$;

-- ---------------------------------------------------------------------------------------------
-- Access control: server-only. RLS on, no anon/authenticated/PUBLIC access, project_admin only.
-- ---------------------------------------------------------------------------------------------

DO $$
DECLARE
  v_table text;
  v_fn regprocedure;
BEGIN
  FOREACH v_table IN ARRAY ARRAY['bodega_vendor_listings', 'bodega_vendor_trials', 'bodega_vendor_purchases',
    'bodega_vendor_comparisons', 'bodega_vendor_check_results', 'bodega_vendor_reviews', 'bodega_vendor_approvals',
    'bodega_vendor_notifications', 'bodega_vendor_revocations', 'bodega_vendor_leases'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', v_table);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO project_admin', v_table);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO project_admin USING (true) WITH CHECK (true)',
                   v_table || '_server_only', v_table);
  END LOOP;
  FOR v_fn IN SELECT p.oid::regprocedure FROM pg_catalog.pg_proc p
              WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE 'bodega\_vendor\_%' LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', v_fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO project_admin', v_fn);
  END LOOP;
END $$;
