-- InsForge/Postgres seam: NOT applied automatically or verified remotely.
-- Apply only to an explicitly selected development project using trusted SQL tooling.
CREATE TABLE IF NOT EXISTS public.bodega_vendor_records (
  kind text NOT NULL,
  id text NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (kind, id),
  CHECK (kind IN ('listing','trial','purchase','comparison','review','approval','lease','revocation','postpigeon_key'))
);
ALTER TABLE public.bodega_vendor_records ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bodega_vendor_records FROM PUBLIC;

-- One transaction. A successful last unit may return exhausted=true.
-- A denial raises and leaves trial usage and vendor pool unchanged.
CREATE OR REPLACE FUNCTION public.bodega_reserve_trial_usage(p_trial_id text, p_amount integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE t jsonb; l jsonb; used_count integer; limit_count integer; pool_count integer; pool_limit integer; exhausted boolean;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Usage must be positive'; END IF;
  SELECT data INTO t FROM bodega_vendor_records WHERE kind='trial' AND id=p_trial_id FOR UPDATE;
  IF t IS NULL THEN RAISE EXCEPTION 'Unknown trial'; END IF;
  SELECT data INTO l FROM bodega_vendor_records WHERE kind='listing' AND id=t->>'listing_id' FOR UPDATE;
  IF t->>'status' <> 'active' OR (t->>'expires_at')::timestamptz <= clock_timestamp() OR l->'trial' IS NULL OR l->'trial' = 'null'::jsonb THEN
    RAISE EXCEPTION 'QUOTA_EXCEEDED';
  END IF;
  used_count := (t->>'used')::integer; limit_count := (t->>'limit')::integer;
  pool_count := (l->'trial'->>'pool_used')::integer; pool_limit := (l->'trial'->>'pool_total')::integer;
  IF p_amount > limit_count-used_count OR p_amount > pool_limit-pool_count THEN RAISE EXCEPTION 'QUOTA_EXCEEDED'; END IF;
  used_count := used_count+p_amount; pool_count := pool_count+p_amount;
  exhausted := used_count >= limit_count OR pool_count >= pool_limit;
  t := jsonb_set(t, '{used}', to_jsonb(used_count));
  IF exhausted THEN t := jsonb_set(t, '{status}', '"exhausted"'::jsonb); END IF;
  l := jsonb_set(l, '{trial,pool_used}', to_jsonb(pool_count));
  UPDATE bodega_vendor_records SET data=t WHERE kind='trial' AND id=p_trial_id;
  UPDATE bodega_vendor_records SET data=l WHERE kind='listing' AND id=t->>'listing_id';
  RETURN jsonb_build_object('used',used_count,'limit',limit_count,'exhausted',exhausted);
END $$;
REVOKE ALL ON FUNCTION public.bodega_reserve_trial_usage(text, integer) FROM PUBLIC;
-- Grant narrowly to the selected server role, never browser roles.
