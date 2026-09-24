-- Stripe recurring billing: keep entitlement changes server-only and webhook-idempotent.
-- Apply once in Supabase SQL Editor after reviewing the project-specific schema.
BEGIN;

-- The production schema may not have installed the application's plan enum yet.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_type AS t
    JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'plan_type'
  ) THEN
    CREATE TYPE public.plan_type AS ENUM ('free', 'essential', 'professional');
  ELSIF (
    SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
    FROM pg_catalog.pg_enum AS e
    JOIN pg_catalog.pg_type AS t ON t.oid = e.enumtypid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'plan_type'
  ) IS DISTINCT FROM ARRAY['free', 'essential', 'professional']::text[] THEN
    RAISE EXCEPTION 'public.plan_type must contain exactly free, essential, professional';
  END IF;
END
$$;

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS stripe_customer_id text,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS subscription_status text,
  ADD COLUMN IF NOT EXISTS subscription_expires_at timestamptz;

-- Normalize any legacy enum/text status column so webhook updates have one stable contract.
ALTER TABLE public.businesses
  ALTER COLUMN subscription_status TYPE text USING subscription_status::text;

CREATE UNIQUE INDEX IF NOT EXISTS businesses_stripe_subscription_id_uidx
  ON public.businesses (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS appointments_business_created_at_idx
  ON public.appointments (business_id, created_at);

GRANT SELECT (subscription_status) ON TABLE public.businesses TO authenticated;

CREATE TABLE IF NOT EXISTS public.stripe_webhook_events (
  event_id text PRIMARY KEY,
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  processed_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.stripe_webhook_events FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.stripe_webhook_events TO service_role;

CREATE OR REPLACE FUNCTION public.apply_stripe_subscription_event(
  p_event_id text,
  p_business_id uuid,
  p_subscription_id text,
  p_customer_id text,
  p_plan text,
  p_status text,
  p_period_end timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_plan public.plan_type;
  v_updated integer;
BEGIN
  IF p_event_id IS NULL OR p_business_id IS NULL OR p_subscription_id IS NULL
     OR p_customer_id IS NULL OR p_plan NOT IN ('essential', 'professional') THEN
    RAISE EXCEPTION 'Invalid Stripe event payload';
  END IF;
  IF p_status NOT IN ('active', 'trialing', 'past_due', 'canceled', 'unpaid', 'incomplete_expired', 'incomplete', 'paused') THEN
    RAISE EXCEPTION 'Unsupported Stripe subscription status';
  END IF;

  v_plan := CASE WHEN p_status IN ('active', 'trialing', 'past_due')
    THEN p_plan::public.plan_type ELSE 'free'::public.plan_type END;

  INSERT INTO public.stripe_webhook_events (event_id, business_id)
  VALUES (p_event_id, p_business_id)
  ON CONFLICT (event_id) DO NOTHING;
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  UPDATE public.businesses
  SET stripe_customer_id = p_customer_id,
      stripe_subscription_id = p_subscription_id,
      subscription_status = p_status,
      subscription_expires_at = p_period_end,
      plan = v_plan
  WHERE id = p_business_id
    AND (stripe_subscription_id IS NULL OR stripe_subscription_id = p_subscription_id);

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    DELETE FROM public.stripe_webhook_events WHERE event_id = p_event_id;
    RAISE EXCEPTION 'Subscription does not match the business';
  END IF;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_stripe_subscription_event(text, uuid, text, text, text, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_stripe_subscription_event(text, uuid, text, text, text, text, timestamptz)
  TO service_role;

-- Enforce service and booking quotas in PostgreSQL as well as in the UI.
CREATE OR REPLACE FUNCTION public.enforce_plan_service_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_plan public.plan_type;
  v_limit integer;
  v_count integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(NEW.business_id::text));
  SELECT b.plan INTO v_plan FROM public.businesses AS b WHERE b.id = NEW.business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Negócio inválido'; END IF;
  v_limit := CASE v_plan WHEN 'free' THEN 3 WHEN 'essential' THEN 10 WHEN 'professional' THEN 50 END;
  SELECT count(*) INTO v_count FROM public.services AS s
    WHERE s.business_id = NEW.business_id AND s.id IS DISTINCT FROM NEW.id;
  IF v_count >= v_limit THEN RAISE EXCEPTION 'Limite de serviços do plano atingido'; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS plan_service_limit_guard ON public.services;
CREATE TRIGGER plan_service_limit_guard
  BEFORE INSERT ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_service_limit();

CREATE OR REPLACE FUNCTION public.enforce_plan_appointment_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_plan public.plan_type;
  v_limit integer;
  v_count integer;
  v_month_start timestamptz;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(NEW.business_id::text));
  SELECT b.plan INTO v_plan FROM public.businesses AS b WHERE b.id = NEW.business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Negócio inválido'; END IF;
  v_limit := CASE v_plan WHEN 'free' THEN 30 WHEN 'essential' THEN 200 WHEN 'professional' THEN 2000 END;
  v_month_start := date_trunc('month', COALESCE(NEW.created_at, pg_catalog.now()) AT TIME ZONE 'America/Sao_Paulo')
    AT TIME ZONE 'America/Sao_Paulo';
  SELECT count(*) INTO v_count FROM public.appointments AS a
    WHERE a.business_id = NEW.business_id
      AND a.created_at >= v_month_start
      AND a.created_at < v_month_start + interval '1 month';
  IF v_count >= v_limit THEN RAISE EXCEPTION 'Limite mensal de agendamentos do plano atingido'; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS plan_appointment_limit_guard ON public.appointments;
CREATE TRIGGER plan_appointment_limit_guard
  BEFORE INSERT ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_appointment_limit();

REVOKE ALL ON FUNCTION public.enforce_plan_service_limit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_plan_appointment_limit() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
