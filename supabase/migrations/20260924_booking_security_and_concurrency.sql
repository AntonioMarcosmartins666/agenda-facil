-- Least-privilege PostgREST access and atomic booking validation.
-- Run after 20260923_business_compatibility.sql.
BEGIN;

-- Remove broad grants that may have been added while troubleshooting RLS.
REVOKE ALL PRIVILEGES ON TABLE public.businesses, public.services,
  public.working_hours, public.appointments FROM PUBLIC, anon, authenticated;

-- Public agenda needs only customer-safe business fields.
GRANT SELECT (id, name, slug, description, whatsapp, address, active)
  ON TABLE public.businesses TO anon;
GRANT SELECT (id, user_id, name, slug, description, whatsapp, address,
  active, plan, created_at)
  ON TABLE public.businesses TO authenticated;
GRANT INSERT (user_id, name, slug, plan) ON TABLE public.businesses TO authenticated;
GRANT UPDATE (name, description, whatsapp, address) ON TABLE public.businesses TO authenticated;

-- Services and working hours are public scheduling data; owner writes remain RLS-protected.
GRANT SELECT (id, business_id, name, price, duration_minutes, active)
  ON TABLE public.services TO anon, authenticated;
GRANT INSERT (id, business_id, name, price, duration_minutes, active)
  ON TABLE public.services TO authenticated;
GRANT UPDATE (id, business_id, name, price, duration_minutes, active)
  ON TABLE public.services TO authenticated;
GRANT DELETE ON TABLE public.services TO authenticated;

GRANT SELECT (id, business_id, weekday, enabled, start_time, end_time, break_start, break_end)
  ON TABLE public.working_hours TO anon, authenticated;
GRANT INSERT (id, business_id, weekday, enabled, start_time, end_time, break_start, break_end)
  ON TABLE public.working_hours TO authenticated;
GRANT UPDATE (id, business_id, weekday, enabled, start_time, end_time, break_start, break_end)
  ON TABLE public.working_hours TO authenticated;

-- Anonymous customers can create a booking but cannot read appointment PII.
GRANT INSERT (business_id, service_id, client_name, client_phone, appointment_date)
  ON TABLE public.appointments TO anon, authenticated;
GRANT SELECT (id, business_id, service_id, client_name, client_phone,
  appointment_date, status, created_at) ON TABLE public.appointments TO authenticated;
GRANT UPDATE (status) ON TABLE public.appointments TO authenticated;

-- Serialize inserts by business/day so concurrent requests cannot both claim a slot.
CREATE OR REPLACE FUNCTION public.validate_appointment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_duration integer;
  v_local_start timestamp;
  v_local_end timestamp;
  v_hours record;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.business_id IS NOT DISTINCT FROM OLD.business_id
     AND NEW.service_id IS NOT DISTINCT FROM OLD.service_id
     AND NEW.appointment_date IS NOT DISTINCT FROM OLD.appointment_date THEN
    RETURN NEW;
  END IF;

  SELECT s.duration_minutes INTO v_duration
  FROM public.services AS s
  JOIN public.businesses AS b ON b.id = s.business_id AND b.active = true
  WHERE s.id = NEW.service_id AND s.business_id = NEW.business_id AND s.active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Serviço inválido ou indisponível';
  END IF;

  IF NEW.appointment_date <= pg_catalog.now() THEN
    RAISE EXCEPTION 'Data no passado';
  END IF;

  v_local_start := NEW.appointment_date AT TIME ZONE 'America/Sao_Paulo';
  v_local_end := v_local_start + pg_catalog.make_interval(mins => v_duration);

  SELECT h.enabled, h.start_time, h.end_time, h.break_start, h.break_end
    INTO v_hours
  FROM public.working_hours AS h
  WHERE h.business_id = NEW.business_id
    AND h.weekday = EXTRACT(DOW FROM v_local_start)::integer;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Agenda fechada nessa data';
  END IF;
  IF v_hours.enabled IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Agenda fechada nessa data';
  END IF;
  IF v_local_start::time < v_hours.start_time OR v_local_end::time > v_hours.end_time THEN
    RAISE EXCEPTION 'Horário fora do expediente';
  END IF;
  IF v_hours.break_start IS NOT NULL AND v_hours.break_end IS NOT NULL
     AND v_local_start::time < v_hours.break_end
     AND v_local_end::time > v_hours.break_start THEN
    RAISE EXCEPTION 'Horário dentro do intervalo';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(NEW.business_id::text),
    pg_catalog.hashtext(v_local_start::date::text)
  );

  IF EXISTS (
    SELECT 1
    FROM public.appointments AS a
    JOIN public.services AS existing_service ON existing_service.id = a.service_id
    WHERE a.business_id = NEW.business_id
      AND a.status <> 'cancelled'
      AND a.id IS DISTINCT FROM NEW.id
      AND a.appointment_date < NEW.appointment_date + pg_catalog.make_interval(mins => v_duration)
      AND a.appointment_date + pg_catalog.make_interval(mins => existing_service.duration_minutes)
          > NEW.appointment_date
  ) THEN
    RAISE EXCEPTION 'Horário já ocupado';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointment_validation ON public.appointments;
CREATE TRIGGER appointment_validation
  BEFORE INSERT OR UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.validate_appointment();

NOTIFY pgrst, 'reload schema';
COMMIT;
