export type Plan = 'free' | 'essential' | 'professional';
export type Status = 'pending' | 'confirmed' | 'cancelled' | 'completed';

export interface Business {
  id: string;
  user_id: string;
  name: string;
  slug: string;
  description: string | null;
  whatsapp: string | null;
  address: string | null;
  active: boolean;
  plan: Plan;
  plan_expires_at: string | null;
  created_at: string;
}

export interface PixPaymentRequest {
  id: string;
  business_id: string;
  plan: Exclude<Plan, 'free'>;
  amount_cents: number;
  status: 'pending' | 'confirmed' | 'rejected';
  created_at: string;
  paid_at: string | null;
  plan_expires_at: string | null;
}

export interface Service {
  id: string;
  business_id: string;
  name: string;
  price: number;
  duration_minutes: number;
  active: boolean;
}

export interface WorkingHour {
  id: string;
  business_id: string;
  weekday: number;
  enabled: boolean;
  start_time: string;
  end_time: string;
  break_start: string | null;
  break_end: string | null;
}

export interface Appointment {
  id: string;
  business_id: string;
  service_id: string;
  client_name: string;
  client_phone: string;
  appointment_date: string;
  status: Status;
  created_at: string;
  service?: Pick<Service, 'name' | 'price' | 'duration_minutes'> | null;
}

export interface PlanLimit {
  label: string;
  price: number;
  services: number;
  appointments: number;
}
