import { supabase } from './supabase';
import type { Appointment, Business, PixPaymentRequest, Plan, Service, Status, WorkingHour } from '../types';

export const LIMITS: Record<Plan, { label: string; price: number; services: number; appointments: number }> = {
  free: { label: 'Grátis', price: 0, services: 3, appointments: 30 },
  essential: { label: 'Essencial', price: 29, services: 10, appointments: 200 },
  professional: { label: 'Profissional', price: 59, services: 50, appointments: 2000 },
};

const BUSINESS_FIELDS = 'id,user_id,name,slug,description,whatsapp,address,active,plan,plan_expires_at,created_at';
const PUBLIC_BUSINESS_FIELDS = 'id,name,slug,description,whatsapp,address,active';
const SERVICE_FIELDS = 'id,business_id,name,price,duration_minutes,active';
const HOUR_FIELDS = 'id,business_id,weekday,enabled,start_time,end_time,break_start,break_end';
const APPOINTMENT_FIELDS = 'id,business_id,service_id,client_name,client_phone,appointment_date,status,created_at,service:services(name,price,duration_minutes)';

function normalizeAppointments(data: unknown): Appointment[] {
  if (!Array.isArray(data)) return [];
  return data.map((value: unknown) => {
    const row = value as Record<string, unknown>;
    const relation = row.service;
    const service = Array.isArray(relation) ? relation[0] ?? null : relation ?? null;
    return { ...row, service } as unknown as Appointment;
  });
}

export async function businessesByUser(uid: string): Promise<Business[]> {
  const { data, error } = await supabase
    .from('businesses')
    .select(BUSINESS_FIELDS)
    .eq('user_id', uid)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Business[];
}

export async function businessBySlug(slug: string): Promise<Business | null> {
  const { data, error } = await supabase.from('businesses').select(PUBLIC_BUSINESS_FIELDS).eq('slug', slug).eq('active', true).maybeSingle();
  if (error) throw error;
  return data as Business | null;
}

export async function services(bid: string, active = false): Promise<Service[]> {
  let query = supabase.from('services').select(SERVICE_FIELDS).eq('business_id', bid).order('name');
  if (active) query = query.eq('active', true);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as Service[];
}

export async function hours(bid: string): Promise<WorkingHour[]> {
  const { data, error } = await supabase.from('working_hours').select(HOUR_FIELDS).eq('business_id', bid).order('weekday');
  if (error) throw error;
  return (data ?? []) as WorkingHour[];
}

export async function appointments(bid: string): Promise<Appointment[]> {
  const { data, error } = await supabase
    .from('appointments')
    .select(APPOINTMENT_FIELDS)
    .eq('business_id', bid)
    .order('appointment_date');
  if (error) throw error;
  return normalizeAppointments(data);
}

export async function createBusiness(uid: string, name: string, slug: string): Promise<Business> {
  const { data, error } = await supabase
    .from('businesses')
    .insert({ user_id: uid, name: name.trim(), slug: slug.trim(), plan: 'free' })
    .select(BUSINESS_FIELDS)
    .single();
  if (error) throw error;
  return data as Business;
}

export async function saveBusiness(id: string, patch: Partial<Business>): Promise<Business> {
  const { data, error } = await supabase.from('businesses').update(patch).eq('id', id).select(BUSINESS_FIELDS).single();
  if (error) throw error;
  return data as Business;
}

export async function saveService(payload: Partial<Service> & Pick<Service, 'business_id' | 'name'>): Promise<Service> {
  const { id, business_id, name, price, duration_minutes, active } = payload;
  const { data, error } = await supabase.from('services').upsert({ id, business_id, name, price, duration_minutes, active }).select(SERVICE_FIELDS).single();
  if (error) throw error;
  return data as Service;
}

export async function deleteService(id: string): Promise<void> {
  const { error } = await supabase.from('services').delete().eq('id', id);
  if (error) throw error;
}

export async function saveHour(payload: Partial<WorkingHour> & Pick<WorkingHour, 'business_id' | 'weekday'>): Promise<WorkingHour> {
  const { id, business_id, weekday, enabled, start_time, end_time, break_start, break_end } = payload;
  const { data, error } = await supabase.from('working_hours').upsert({ id, business_id, weekday, enabled, start_time, end_time, break_start, break_end }, { onConflict: 'business_id,weekday' }).select(HOUR_FIELDS).single();
  if (error) throw error;
  return data as WorkingHour;
}

export async function setStatus(id: string, status: Status): Promise<void> {
  const { error } = await supabase.from('appointments').update({ status }).eq('id', id);
  if (error) throw error;
}

export async function createAppointment(payload: Omit<Appointment, 'id' | 'created_at' | 'status' | 'service'>): Promise<void> {
  // Do not return/select a newly inserted appointment to the anonymous customer: it contains PII.
  const { error } = await supabase.from('appointments').insert(payload);
  if (error) throw error;
}

export async function requestPixPayment(businessId: string, plan: Exclude<Plan, 'free'>): Promise<PixPaymentRequest> {
  const { data, error } = await supabase.rpc('create_plan_pix_request', { p_business_id: businessId, p_plan: plan });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as PixPaymentRequest | null;
  if (!row?.id) throw new Error('Não foi possível criar o pedido Pix.');
  return row;
}

export async function getPixPaymentRequest(id: string): Promise<PixPaymentRequest> {
  const { data, error } = await supabase
    .from('plan_pix_payments')
    .select('id,business_id,plan,amount_cents,status,created_at,paid_at,plan_expires_at')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data as PixPaymentRequest;
}
