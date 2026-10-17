-- Shared, server-only Bodega wallet: the cross-instance admission authority.
-- Every mutation runs inside one RPC call (one PostgREST transaction) under row locks.
-- Raw project keys, raw MPP credentials and the signing secret are never stored:
-- only SHA-256 digests and a fingerprint (HMAC of a constant) of the shared secret.
-- Money is integer cents bounded to JavaScript's safe-integer range.

CREATE TABLE public.bodega_wallets (
 session_id text PRIMARY KEY CHECK (length(session_id) BETWEEN 1 AND 256),
 cap_cents bigint NOT NULL CHECK (cap_cents BETWEEN 0 AND 9007199254740991),
 threshold_cents bigint NOT NULL CHECK (threshold_cents >= 0 AND threshold_cents <= cap_cents),
 created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.bodega_wallet_attempts (
 id text PRIMARY KEY CHECK (id ~ '^pur_[0-9a-f-]{36}$'),
 session_id text NOT NULL REFERENCES public.bodega_wallets(session_id),
 listing_id text NOT NULL CHECK (length(listing_id) BETWEEN 1 AND 256),
 request_id text NOT NULL CHECK (request_id ~ '^[a-zA-Z0-9_-]{1,128}$'),
 amount_cents bigint NOT NULL CHECK (amount_cents BETWEEN 50 AND 9007199254740991),
 currency text NOT NULL DEFAULT 'usd' CHECK (currency = 'usd'),
 status text NOT NULL CHECK (status IN ('needs_approval','ready','charging','pending','paid','declined')),
 idempotency_key text NOT NULL UNIQUE CHECK (idempotency_key = 'bodega:' || id),
 payment_intent_id text CHECK (length(payment_intent_id) BETWEEN 4 AND 255),
 approval_url text CHECK (length(approval_url) <= 2048),
 error text CHECK (length(error) <= 1000),
 payment_mode text NOT NULL CHECK (payment_mode ~ '^[a-z0-9-]{1,32}:[a-z0-9-]{1,32}$'),
 credit_limit bigint NOT NULL CHECK (credit_limit BETWEEN 1 AND 9007199254740991),
 credits_used bigint NOT NULL DEFAULT 0 CHECK (credits_used >= 0 AND credits_used <= credit_limit),
 expires_at bigint NOT NULL CHECK (expires_at BETWEEN 0 AND 9007199254740991),
 created_at bigint NOT NULL CHECK (created_at BETWEEN 0 AND 9007199254740991),
 lease_until bigint NOT NULL DEFAULT 0 CHECK (lease_until BETWEEN 0 AND 9007199254740991),
 key_hash text CHECK (key_hash ~ '^[0-9a-f]{64}$'),
 UNIQUE (session_id, listing_id, request_id),
 CHECK (status <> 'paid' OR (key_hash IS NOT NULL AND (
   (payment_mode LIKE 'mock:%' AND payment_intent_id ~ '^mock_[A-Za-z0-9]{1,255}$') OR
   (payment_mode LIKE 'stripe:%' AND payment_intent_id ~ '^pi_[A-Za-z0-9_]{1,255}$'))))
);
CREATE UNIQUE INDEX bodega_wallet_attempts_receipt_once
 ON public.bodega_wallet_attempts(payment_intent_id) WHERE payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX bodega_wallet_attempts_key_once
 ON public.bodega_wallet_attempts(key_hash) WHERE key_hash IS NOT NULL;
CREATE INDEX bodega_wallet_attempts_session
 ON public.bodega_wallet_attempts(session_id, created_at, id);

CREATE TABLE public.bodega_wallet_events (
 event_id text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 255),
 processed_at bigint NOT NULL
);
CREATE TABLE public.bodega_wallet_mpp_credentials (
 purchase_id text PRIMARY KEY REFERENCES public.bodega_wallet_attempts(id),
 credential_hash text NOT NULL CHECK (credential_hash ~ '^[0-9a-f]{64}$')
);
CREATE TABLE public.bodega_wallet_fulfilled (
 purchase_id text PRIMARY KEY REFERENCES public.bodega_wallet_attempts(id),
 fulfilled_at bigint NOT NULL
);
-- Singleton fingerprint of BODEGA_PROJECT_KEY_SECRET: every node must sign project keys identically.
CREATE TABLE public.bodega_wallet_signing_key (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bodega_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bodega_wallet_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bodega_wallet_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bodega_wallet_mpp_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bodega_wallet_fulfilled ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bodega_wallet_signing_key ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bodega_wallets, public.bodega_wallet_attempts, public.bodega_wallet_events,
 public.bodega_wallet_mpp_credentials, public.bodega_wallet_fulfilled, public.bodega_wallet_signing_key
 FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.bodega_wallets, public.bodega_wallet_attempts,
 public.bodega_wallet_events, public.bodega_wallet_mpp_credentials, public.bodega_wallet_fulfilled,
 public.bodega_wallet_signing_key TO project_admin;

-- Database clock (epoch milliseconds) is authoritative for leases/expiry across nodes.
CREATE FUNCTION public.bodega_wallet_now_ms() RETURNS bigint
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint $$;

CREATE FUNCTION public.bodega_wallet_register_key(p_fingerprint text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
 IF p_fingerprint IS NULL OR p_fingerprint !~ '^[0-9a-f]{64}$' THEN RETURN false; END IF;
 INSERT INTO public.bodega_wallet_signing_key(singleton, fingerprint) VALUES (true, p_fingerprint)
  ON CONFLICT (singleton) DO NOTHING;
 RETURN (SELECT k.fingerprint = p_fingerprint FROM public.bodega_wallet_signing_key k WHERE k.singleton);
END $$;

-- Reconnect never resets or replenishes an existing wallet; returns the stored policy.
CREATE FUNCTION public.bodega_wallet_ensure_session(p_session_id text, p_cap_cents bigint, p_threshold_cents bigint)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE w public.bodega_wallets;
BEGIN
 IF p_session_id IS NULL OR length(p_session_id) NOT BETWEEN 1 AND 256
  OR p_cap_cents IS NULL OR p_cap_cents NOT BETWEEN 0 AND 9007199254740991
  OR p_threshold_cents IS NULL OR p_threshold_cents < 0 OR p_threshold_cents > p_cap_cents THEN
  RETURN jsonb_build_object('error', 'INVALID_POLICY');
 END IF;
 INSERT INTO public.bodega_wallets(session_id, cap_cents, threshold_cents)
  VALUES (p_session_id, p_cap_cents, p_threshold_cents) ON CONFLICT (session_id) DO NOTHING;
 SELECT * INTO w FROM public.bodega_wallets WHERE session_id = p_session_id;
 RETURN jsonb_build_object('cap_cents', w.cap_cents, 'threshold_cents', w.threshold_cents);
END $$;

CREATE FUNCTION public.bodega_wallet_get(p_id text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT to_jsonb(a) FROM public.bodega_wallet_attempts a WHERE a.id = p_id $$;

CREATE FUNCTION public.bodega_wallet_by_payment(p_payment_id text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT to_jsonb(a) FROM public.bodega_wallet_attempts a WHERE a.payment_intent_id = p_payment_id $$;

CREATE FUNCTION public.bodega_wallet_list(p_session_id text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$
 SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY a.created_at, a.id), '[]'::jsonb)
 FROM public.bodega_wallet_attempts a WHERE a.session_id = p_session_id
$$;

CREATE FUNCTION public.bodega_wallet_view(p_session_id text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE w public.bodega_wallets; spent bigint; held bigint;
BEGIN
 SELECT * INTO w FROM public.bodega_wallets WHERE session_id = p_session_id;
 IF NOT FOUND THEN RETURN jsonb_build_object('error', 'NO_WALLET'); END IF;
 SELECT COALESCE(sum(amount_cents) FILTER (WHERE status = 'paid'), 0)::bigint,
        COALESCE(sum(amount_cents) FILTER (WHERE status NOT IN ('paid','declined')), 0)::bigint
  INTO spent, held FROM public.bodega_wallet_attempts WHERE session_id = p_session_id;
 RETURN jsonb_build_object(
  'session_id', w.session_id, 'cap_cents', w.cap_cents, 'threshold_cents', w.threshold_cents,
  'spent_cents', spent, 'reserved_cents', held, 'remaining_cents', w.cap_cents - spent - held,
  'purchases', public.bodega_wallet_list(p_session_id));
END $$;

-- Budget admission: the wallet row lock serializes every reservation for a session.
CREATE FUNCTION public.bodega_wallet_reserve(p_session_id text, p_listing_id text, p_amount_cents bigint,
 p_request_id text, p_credit_limit bigint, p_payment_mode text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
 w public.bodega_wallets; prior public.bodega_wallet_attempts; created public.bodega_wallet_attempts;
 used bigint; now_ms bigint := public.bodega_wallet_now_ms(); new_id text;
BEGIN
 IF p_amount_cents IS NULL OR p_amount_cents NOT BETWEEN 50 AND 9007199254740991
  OR p_credit_limit IS NULL OR p_credit_limit NOT BETWEEN 1 AND 9007199254740991
  OR p_request_id IS NULL OR p_request_id !~ '^[a-zA-Z0-9_-]{1,128}$'
  OR p_listing_id IS NULL OR length(p_listing_id) NOT BETWEEN 1 AND 256
  OR p_payment_mode IS NULL OR p_payment_mode !~ '^[a-z0-9-]{1,32}:[a-z0-9-]{1,32}$' THEN
  RETURN jsonb_build_object('error', 'INVALID_PURCHASE');
 END IF;
 SELECT * INTO w FROM public.bodega_wallets WHERE session_id = p_session_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('error', 'NO_WALLET'); END IF;
 SELECT * INTO prior FROM public.bodega_wallet_attempts
  WHERE session_id = p_session_id AND listing_id = p_listing_id AND request_id = p_request_id;
 IF FOUND THEN
  IF prior.amount_cents <> p_amount_cents OR prior.payment_mode <> p_payment_mode THEN
   RETURN jsonb_build_object('error', 'IDEMPOTENCY_CONFLICT');
  END IF;
  RETURN jsonb_build_object('attempt', to_jsonb(prior));
 END IF;
 SELECT COALESCE(sum(amount_cents), 0)::bigint INTO used FROM public.bodega_wallet_attempts
  WHERE session_id = p_session_id AND status <> 'declined';
 IF w.cap_cents - used < p_amount_cents THEN
  RETURN jsonb_build_object('error', 'BUDGET_EXCEEDED');
 END IF;
 new_id := 'pur_' || gen_random_uuid()::text;
 INSERT INTO public.bodega_wallet_attempts(id, session_id, listing_id, request_id, amount_cents, status,
  idempotency_key, credit_limit, expires_at, created_at, payment_mode)
 VALUES (new_id, p_session_id, p_listing_id, p_request_id, p_amount_cents,
  CASE WHEN p_amount_cents > w.threshold_cents THEN 'needs_approval' ELSE 'ready' END,
  'bodega:' || new_id, p_credit_limit, now_ms + 30::bigint * 86400000, now_ms, p_payment_mode)
 RETURNING * INTO created;
 RETURN jsonb_build_object('attempt', to_jsonb(created));
END $$;

-- First approval link wins so concurrent nodes converge on one human request.
CREATE FUNCTION public.bodega_wallet_set_approval(p_id text, p_url text) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$
 UPDATE public.bodega_wallet_attempts AS t SET approval_url = COALESCE(t.approval_url, p_url)
 WHERE t.id = p_id AND t.status = 'needs_approval' AND length(p_url) <= 2048
 RETURNING to_jsonb(t)
$$;

CREATE FUNCTION public.bodega_wallet_approve(p_id text) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$
 UPDATE public.bodega_wallet_attempts AS t SET status = 'ready'
 WHERE t.id = p_id AND t.status = 'needs_approval'
 RETURNING to_jsonb(t)
$$;

CREATE FUNCTION public.bodega_wallet_decline(p_id text, p_reason text) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$
 UPDATE public.bodega_wallet_attempts AS t SET status = 'declined', error = left(p_reason, 1000), lease_until = 0
 WHERE t.id = p_id AND t.status IN ('ready','needs_approval')
 RETURNING to_jsonb(t)
$$;

-- One charging lease at a time; an expired lease (crashed node) can be re-claimed to inspect/replay.
CREATE FUNCTION public.bodega_wallet_claim(p_id text, p_lease_ms bigint) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE now_ms bigint := public.bodega_wallet_now_ms();
BEGIN
 IF p_lease_ms IS NULL OR p_lease_ms NOT BETWEEN 1000 AND 600000 THEN RETURN false; END IF;
 UPDATE public.bodega_wallet_attempts SET status = 'charging', lease_until = now_ms + p_lease_ms
 WHERE id = p_id AND status IN ('ready','pending','charging') AND lease_until <= now_ms;
 RETURN FOUND;
END $$;

-- Settles an attempt. Paid is terminal; ambiguous outcomes stay held as pending.
CREATE FUNCTION public.bodega_wallet_finish(p_id text, p_status text, p_payment_id text, p_error text, p_key_hash text)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE a public.bodega_wallet_attempts; done public.bodega_wallet_attempts;
BEGIN
 IF p_status IS NULL OR p_status NOT IN ('paid','pending','declined') THEN
  RETURN jsonb_build_object('error', 'INVALID_STATUS');
 END IF;
 SELECT * INTO a FROM public.bodega_wallet_attempts WHERE id = p_id FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('error', 'NO_PURCHASE'); END IF;
 IF a.status = 'paid' THEN RETURN jsonb_build_object('attempt', to_jsonb(a)); END IF;
 IF a.status = 'needs_approval' THEN RETURN jsonb_build_object('error', 'APPROVAL_REQUIRED'); END IF;
 IF p_status = 'paid' AND (p_payment_id IS NULL OR p_key_hash IS NULL OR p_key_hash !~ '^[0-9a-f]{64}$'
  OR NOT ((a.payment_mode LIKE 'mock:%' AND p_payment_id ~ '^mock_[A-Za-z0-9]{1,255}$')
       OR (a.payment_mode LIKE 'stripe:%' AND p_payment_id ~ '^pi_[A-Za-z0-9_]{1,255}$'))) THEN
  RETURN jsonb_build_object('error', 'NO_RECEIPT');
 END IF;
 IF p_payment_id IS NOT NULL AND (length(p_payment_id) NOT BETWEEN 4 AND 255
  OR (a.payment_intent_id IS NOT NULL AND a.payment_intent_id <> p_payment_id)
  OR EXISTS (SELECT 1 FROM public.bodega_wallet_attempts o WHERE o.payment_intent_id = p_payment_id AND o.id <> p_id)) THEN
  RETURN jsonb_build_object('error', 'RECEIPT_CONFLICT');
 END IF;
 BEGIN
  UPDATE public.bodega_wallet_attempts SET status = p_status,
   payment_intent_id = COALESCE(p_payment_id, payment_intent_id), error = left(p_error, 1000), lease_until = 0,
   key_hash = CASE WHEN p_status = 'paid' THEN p_key_hash ELSE NULL END
  WHERE id = p_id RETURNING * INTO done;
 EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('error', 'RECEIPT_CONFLICT');
 END;
 RETURN jsonb_build_object('attempt', to_jsonb(done));
END $$;

CREATE FUNCTION public.bodega_wallet_resolve_key(p_key_hash text) RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$
 SELECT to_jsonb(a) FROM public.bodega_wallet_attempts a
 WHERE a.key_hash = p_key_hash AND a.status = 'paid' AND a.expires_at > public.bodega_wallet_now_ms()
$$;

CREATE FUNCTION public.bodega_wallet_consume(p_id text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
 UPDATE public.bodega_wallet_attempts SET credits_used = credits_used + 1
 WHERE id = p_id AND status = 'paid' AND credits_used < credit_limit AND expires_at > public.bodega_wallet_now_ms();
 RETURN FOUND;
END $$;

-- First credential digest binds the purchase; later calls succeed only with the same credential.
CREATE FUNCTION public.bodega_wallet_bind_mpp_credential(p_id text, p_credential_hash text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
 IF p_credential_hash IS NULL OR p_credential_hash !~ '^[0-9a-f]{64}$'
  OR NOT EXISTS (SELECT 1 FROM public.bodega_wallet_attempts WHERE id = p_id) THEN
  RETURN false;
 END IF;
 INSERT INTO public.bodega_wallet_mpp_credentials(purchase_id, credential_hash)
  VALUES (p_id, p_credential_hash) ON CONFLICT (purchase_id) DO NOTHING;
 RETURN (SELECT c.credential_hash = p_credential_hash FROM public.bodega_wallet_mpp_credentials c WHERE c.purchase_id = p_id);
END $$;

CREATE FUNCTION public.bodega_wallet_has_event(p_event_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM public.bodega_wallet_events WHERE event_id = p_event_id) $$;

CREATE FUNCTION public.bodega_wallet_mark_event(p_event_id text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
 INSERT INTO public.bodega_wallet_events(event_id, processed_at)
  VALUES (p_event_id, public.bodega_wallet_now_ms()) ON CONFLICT (event_id) DO NOTHING;
 RETURN FOUND;
END $$;

CREATE FUNCTION public.bodega_wallet_is_fulfilled(p_id text) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM public.bodega_wallet_fulfilled WHERE purchase_id = p_id) $$;

CREATE FUNCTION public.bodega_wallet_mark_fulfilled(p_id text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp
AS $$
BEGIN
 INSERT INTO public.bodega_wallet_fulfilled(purchase_id, fulfilled_at)
  SELECT a.id, public.bodega_wallet_now_ms() FROM public.bodega_wallet_attempts a
  WHERE a.id = p_id AND a.status = 'paid'
 ON CONFLICT (purchase_id) DO NOTHING;
 RETURN FOUND;
END $$;

REVOKE ALL ON FUNCTION
 public.bodega_wallet_now_ms(),
 public.bodega_wallet_register_key(text),
 public.bodega_wallet_ensure_session(text, bigint, bigint),
 public.bodega_wallet_get(text),
 public.bodega_wallet_by_payment(text),
 public.bodega_wallet_list(text),
 public.bodega_wallet_view(text),
 public.bodega_wallet_reserve(text, text, bigint, text, bigint, text),
 public.bodega_wallet_set_approval(text, text),
 public.bodega_wallet_approve(text),
 public.bodega_wallet_decline(text, text),
 public.bodega_wallet_claim(text, bigint),
 public.bodega_wallet_finish(text, text, text, text, text),
 public.bodega_wallet_resolve_key(text),
 public.bodega_wallet_consume(text),
 public.bodega_wallet_bind_mpp_credential(text, text),
 public.bodega_wallet_has_event(text),
 public.bodega_wallet_mark_event(text),
 public.bodega_wallet_is_fulfilled(text),
 public.bodega_wallet_mark_fulfilled(text)
 FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
 public.bodega_wallet_now_ms(),
 public.bodega_wallet_register_key(text),
 public.bodega_wallet_ensure_session(text, bigint, bigint),
 public.bodega_wallet_get(text),
 public.bodega_wallet_by_payment(text),
 public.bodega_wallet_list(text),
 public.bodega_wallet_view(text),
 public.bodega_wallet_reserve(text, text, bigint, text, bigint, text),
 public.bodega_wallet_set_approval(text, text),
 public.bodega_wallet_approve(text),
 public.bodega_wallet_decline(text, text),
 public.bodega_wallet_claim(text, bigint),
 public.bodega_wallet_finish(text, text, text, text, text),
 public.bodega_wallet_resolve_key(text),
 public.bodega_wallet_consume(text),
 public.bodega_wallet_bind_mpp_credential(text, text),
 public.bodega_wallet_has_event(text),
 public.bodega_wallet_mark_event(text),
 public.bodega_wallet_is_fulfilled(text),
 public.bodega_wallet_mark_fulfilled(text)
 TO project_admin;
