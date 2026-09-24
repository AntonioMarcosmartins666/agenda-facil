-- Cobrança manual por Pix com ativação somente após conferência no extrato.
-- Não apaga campos ou eventos antigos do Stripe para preservar histórico.
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'plan_type'
  ) THEN
    CREATE TYPE public.plan_type AS ENUM ('free', 'essential', 'professional');
  ELSIF (
    SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
    FROM pg_catalog.pg_enum e
    JOIN pg_catalog.pg_type t ON t.oid = e.enumtypid
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public' AND t.typname = 'plan_type'
  ) IS DISTINCT FROM ARRAY['free', 'essential', 'professional']::text[] THEN
    RAISE EXCEPTION 'public.plan_type must contain exactly free, essential, professional';
  END IF;
END
$$;

ALTER TABLE public.businesses
  ADD COLUMN IF NOT EXISTS plan_expires_at timestamptz;

-- Transição: negócios pagos existentes ganham uma data de validade explícita.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'businesses'
      AND column_name = 'subscription_expires_at'
  ) THEN
    EXECUTE $sql$
      UPDATE public.businesses
      SET plan_expires_at = COALESCE(subscription_expires_at, now() + interval '30 days')
      WHERE plan <> 'free' AND plan_expires_at IS NULL
    $sql$;
  ELSE
    UPDATE public.businesses
    SET plan_expires_at = now() + interval '30 days'
    WHERE plan <> 'free' AND plan_expires_at IS NULL;
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.plan_pix_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan public.plan_type NOT NULL CHECK (plan IN ('essential', 'professional')),
  amount_cents integer GENERATED ALWAYS AS (
    CASE plan WHEN 'essential' THEN 2900 WHEN 'professional' THEN 5900 END
  ) STORED,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  plan_expires_at timestamptz,
  payment_reference text
);

CREATE INDEX IF NOT EXISTS plan_pix_payments_owner_created_idx
  ON public.plan_pix_payments (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS plan_pix_payments_pending_idx
  ON public.plan_pix_payments (created_at) WHERE status = 'pending';

ALTER TABLE public.plan_pix_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.plan_pix_payments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.plan_pix_payments TO authenticated;
DROP POLICY IF EXISTS pix_payment_owner_read ON public.plan_pix_payments;
CREATE POLICY pix_payment_owner_read ON public.plan_pix_payments
  FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.create_plan_pix_request(p_business_id uuid, p_plan text)
RETURNS TABLE (id uuid, business_id uuid, plan public.plan_type, amount_cents integer,
               status text, created_at timestamptz, paid_at timestamptz, plan_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_plan public.plan_type;
  v_pending public.plan_pix_payments%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_plan IS NULL OR p_plan NOT IN ('essential', 'professional') THEN RAISE EXCEPTION 'Invalid plan'; END IF;

  PERFORM 1 FROM public.businesses b
  WHERE b.id = p_business_id AND b.user_id = v_user_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Business not found or not owned by user'; END IF;

  SELECT * INTO v_pending FROM public.plan_pix_payments p
  WHERE p.business_id = p_business_id AND p.user_id = v_user_id AND p.status = 'pending'
  ORDER BY p.created_at DESC LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    IF v_pending.plan <> p_plan::public.plan_type THEN
      RAISE EXCEPTION 'Existe um pedido Pix pendente para este negócio';
    END IF;
    RETURN QUERY SELECT v_pending.id, v_pending.business_id, v_pending.plan, v_pending.amount_cents,
                        v_pending.status, v_pending.created_at, v_pending.paid_at, v_pending.plan_expires_at;
    RETURN;
  END IF;

  v_plan := p_plan::public.plan_type;
  RETURN QUERY
  INSERT INTO public.plan_pix_payments (business_id, user_id, plan)
  VALUES (p_business_id, v_user_id, v_plan)
  RETURNING plan_pix_payments.id, plan_pix_payments.business_id, plan_pix_payments.plan,
            plan_pix_payments.amount_cents, plan_pix_payments.status, plan_pix_payments.created_at,
            plan_pix_payments.paid_at, plan_pix_payments.plan_expires_at;
END;
$$;
REVOKE ALL ON FUNCTION public.create_plan_pix_request(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_plan_pix_request(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.confirm_plan_pix_payment(p_payment_id uuid, p_payment_reference text DEFAULT NULL)
RETURNS TABLE (business_id uuid, plan public.plan_type, plan_expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_payment public.plan_pix_payments%ROWTYPE;
  v_expiry timestamptz;
BEGIN
  SELECT pp.* INTO v_payment FROM public.plan_pix_payments pp WHERE pp.id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Pix request not found'; END IF;

  IF v_payment.status = 'confirmed' THEN
    RETURN QUERY SELECT v_payment.business_id, v_payment.plan, v_payment.plan_expires_at;
    RETURN;
  END IF;
  IF v_payment.status <> 'pending' THEN RAISE EXCEPTION 'Pix request is not pending'; END IF;

  UPDATE public.businesses b
  SET plan = v_payment.plan,
      plan_expires_at = GREATEST(COALESCE(b.plan_expires_at, now()), now()) + interval '30 days'
  WHERE b.id = v_payment.business_id
  RETURNING b.plan_expires_at INTO v_expiry;
  IF NOT FOUND THEN RAISE EXCEPTION 'Business for Pix request not found'; END IF;

  UPDATE public.plan_pix_payments
  SET status = 'confirmed', paid_at = now(), plan_expires_at = v_expiry,
      payment_reference = NULLIF(btrim(p_payment_reference), '')
  WHERE plan_pix_payments.id = p_payment_id;

  RETURN QUERY SELECT v_payment.business_id, v_payment.plan, v_expiry;
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_plan_pix_payment(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.confirm_plan_pix_payment(uuid, text) TO service_role;

-- Quota enforcement uses the effective plan. Null/expired dates cannot retain paid limits.
CREATE OR REPLACE FUNCTION public.enforce_plan_service_limit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_plan public.plan_type;
  v_limit integer;
  v_count integer;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(NEW.business_id::text));
  SELECT CASE WHEN b.plan <> 'free' AND b.plan_expires_at > pg_catalog.now()
              THEN b.plan ELSE 'free'::public.plan_type END
    INTO v_plan FROM public.businesses b WHERE b.id = NEW.business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Negócio inválido'; END IF;
  v_limit := CASE v_plan WHEN 'free' THEN 3 WHEN 'essential' THEN 10 WHEN 'professional' THEN 50 END;
  SELECT count(*) INTO v_count FROM public.services s
    WHERE s.business_id = NEW.business_id AND s.id IS DISTINCT FROM NEW.id;
  IF v_count >= v_limit THEN RAISE EXCEPTION 'Limite de serviços do plano atingido'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_plan_appointment_limit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_plan public.plan_type;
  v_limit integer;
  v_count integer;
  v_month_start timestamptz;
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(NEW.business_id::text));
  SELECT CASE WHEN b.plan <> 'free' AND b.plan_expires_at > pg_catalog.now()
              THEN b.plan ELSE 'free'::public.plan_type END
    INTO v_plan FROM public.businesses b WHERE b.id = NEW.business_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Negócio inválido'; END IF;
  v_limit := CASE v_plan WHEN 'free' THEN 30 WHEN 'essential' THEN 200 WHEN 'professional' THEN 2000 END;
  v_month_start := pg_catalog.date_trunc('month', COALESCE(NEW.created_at, pg_catalog.now()) AT TIME ZONE 'America/Sao_Paulo')
    AT TIME ZONE 'America/Sao_Paulo';
  SELECT count(*) INTO v_count FROM public.appointments a
    WHERE a.business_id = NEW.business_id AND a.created_at >= v_month_start
      AND a.created_at < v_month_start + interval '1 month';
  IF v_count >= v_limit THEN RAISE EXCEPTION 'Limite mensal de agendamentos do plano atingido'; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS plan_service_limit_guard ON public.services;
CREATE TRIGGER plan_service_limit_guard
  BEFORE INSERT ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_service_limit();

DROP TRIGGER IF EXISTS plan_appointment_limit_guard ON public.appointments;
CREATE TRIGGER plan_appointment_limit_guard
  BEFORE INSERT ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_appointment_limit();

REVOKE ALL ON FUNCTION public.enforce_plan_service_limit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_plan_appointment_limit() FROM PUBLIC, anon, authenticated;
GRANT SELECT (plan_expires_at) ON TABLE public.businesses TO authenticated;

NOTIFY pgrst, 'reload schema';
COMMIT;
