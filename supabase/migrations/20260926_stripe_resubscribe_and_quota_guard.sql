-- Allow a verified replacement subscription after the previous one is terminal,
-- and enforce service quotas when an owner moves a service to another business.
BEGIN;

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
    AND (
      stripe_subscription_id IS NULL
      OR stripe_subscription_id = p_subscription_id
      OR subscription_status IN ('canceled', 'incomplete_expired')
    );

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    DELETE FROM public.stripe_webhook_events WHERE event_id = p_event_id;
    RAISE EXCEPTION 'Subscription does not match the business';
  END IF;
  RETURN true;
END;
$$;

DROP TRIGGER IF EXISTS plan_service_limit_guard ON public.services;
CREATE TRIGGER plan_service_limit_guard
  BEFORE INSERT OR UPDATE OF business_id ON public.services
  FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_service_limit();

NOTIFY pgrst, 'reload schema';
COMMIT;
