CREATE TABLE public.bodega_sellers (
  vendor_id text PRIMARY KEY CHECK (vendor_id ~ '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,100}$'),
  account_id text NOT NULL UNIQUE CHECK (account_id ~ '^acct_[a-zA-Z0-9]+$' AND account_id <> 'acct_1URdmN2M1S84n0j8'),
  created_at bigint NOT NULL CHECK (created_at > 0)
);
CREATE TABLE public.bodega_settlements (
  purchase_id text PRIMARY KEY,
  order_hash text NOT NULL CHECK (order_hash ~ '^[a-f0-9]{64}$'),
  account_id text NOT NULL REFERENCES public.bodega_sellers(account_id),
  fee_cents integer NOT NULL DEFAULT 0 CHECK (fee_cents = 0)
);
ALTER TABLE public.bodega_sellers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bodega_settlements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bodega_sellers, public.bodega_settlements FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.bodega_sellers, public.bodega_settlements TO project_admin;

CREATE FUNCTION public.bodega_connect(p_op text, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE s public.bodega_sellers; t public.bodega_settlements;
BEGIN
  IF p_op = 'save_seller' THEN
    INSERT INTO public.bodega_sellers(vendor_id,account_id,created_at)
    VALUES (p_payload->>'vendorId',p_payload->>'accountId',(p_payload->>'createdAt')::bigint)
    ON CONFLICT (vendor_id) DO NOTHING;
  END IF;
  IF p_op IN ('seller','save_seller') THEN
    SELECT * INTO s FROM public.bodega_sellers WHERE vendor_id=p_payload->>'vendorId';
    IF s.vendor_id IS NULL THEN RETURN NULL; END IF;
    IF p_op='save_seller' AND s.account_id <> p_payload->>'accountId' THEN RAISE EXCEPTION 'Seller destination is immutable'; END IF;
    RETURN jsonb_build_object('vendorId',s.vendor_id,'accountId',s.account_id,'createdAt',s.created_at);
  END IF;
  IF p_op = 'freeze' THEN
    INSERT INTO public.bodega_settlements(purchase_id,order_hash,account_id,fee_cents)
    VALUES (p_payload->>'purchaseId',p_payload->>'orderHash',p_payload->>'accountId',(p_payload->>'feeCents')::integer)
    ON CONFLICT (purchase_id) DO NOTHING;
  END IF;
  IF p_op IN ('settlement','freeze') THEN
    SELECT * INTO t FROM public.bodega_settlements WHERE purchase_id=p_payload->>'purchaseId';
    IF t.purchase_id IS NULL THEN RETURN NULL; END IF;
    IF p_op='freeze' AND (t.order_hash <> p_payload->>'orderHash' OR t.account_id <> p_payload->>'accountId' OR t.fee_cents <> (p_payload->>'feeCents')::integer) THEN RAISE EXCEPTION 'Settlement is immutable'; END IF;
    RETURN jsonb_build_object('purchaseId',t.purchase_id,'orderHash',t.order_hash,'accountId',t.account_id,'feeCents',t.fee_cents);
  END IF;
  RAISE EXCEPTION 'Unsupported Connect operation';
END;
$$;
REVOKE ALL ON FUNCTION public.bodega_connect(text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bodega_connect(text,jsonb) TO project_admin;
