import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from 'react';
import { businessBySlug, services, hours, createAppointment } from '../lib/api';
import { saoPauloDateTime } from '../lib/time';
import { errorMessage } from '../lib/errors';
import type { Business, Service, WorkingHour } from '../types';

const todayIso = () => saoPauloDateTime().date;

export default function Booking({ slug, onBack }: { slug: string; onBack: () => void }) {
  const [business, setBusiness] = useState<Business | null>(null);
  const [serviceList, setServiceList] = useState<Service[]>([]);
  const [workingHours, setWorkingHours] = useState<WorkingHour[]>([]);
  const [serviceId, setServiceId] = useState('');
  const [date, setDate] = useState(todayIso());
  const [time, setTime] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const found = await businessBySlug(slug);
        if (!found) throw new Error('Agenda não encontrada.');
        const [loadedServices, loadedHours] = await Promise.all([services(found.id, true), hours(found.id)]);
        if (!mounted) return;
        setBusiness(found);
        setServiceList(loadedServices);
        setWorkingHours(loadedHours);
      } catch (error) {
        if (mounted) setMessage(error instanceof Error ? error.message : 'Erro ao carregar a agenda.');
      } finally {
        if (mounted) setLoading(false);
      }
    };
    void load();
    return () => { mounted = false; };
  }, [slug]);

  const selectedService = serviceList.find((service) => service.id === serviceId);

  const slots = useMemo(() => {
    if (!selectedService) return [];
    const weekday = new Date(`${date}T12:00:00`).getDay();
    const hour = workingHours.find((item) => item.weekday === weekday);
    if (!hour?.enabled) return [];

    const toMinutes = (value: string) => {
      const [h, m] = value.slice(0, 5).split(':').map(Number);
      return h * 60 + m;
    };

    const start = toMinutes(hour.start_time);
    const end = toMinutes(hour.end_time);
    const breakStart = hour.break_start ? toMinutes(hour.break_start) : null;
    const breakEnd = hour.break_end ? toMinutes(hour.break_end) : null;
    const result: string[] = [];
    const now = saoPauloDateTime();

    for (let minute = start; minute + selectedService.duration_minutes <= end; minute += 30) {
      const finishes = minute + selectedService.duration_minutes;
      const crossesBreak = breakStart !== null && breakEnd !== null && minute < breakEnd && finishes > breakStart;
      if (crossesBreak) continue;
      const slot = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
      if (date > now.date || (date === now.date && slot > now.time)) result.push(slot);
    }

    return result;
  }, [selectedService, date, workingHours]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!business || !selectedService || !time || submitting) return;

    const now = saoPauloDateTime();
    if (date < now.date || (date === now.date && time <= now.time)) {
      setMessage('Esse horário já passou. Escolha um horário futuro.');
      setTime('');
      return;
    }

    const configuredDigits = (business.whatsapp ?? '').replace(/\D/g, '');
    const localPhone = /^55\d{10,11}$/.test(configuredDigits)
      ? configuredDigits.slice(2)
      : configuredDigits;
    if (!/^\d{10,11}$/.test(localPhone)) {
      setMessage('O WhatsApp do negócio está incompleto. Avise o responsável para atualizar o número com DDD e telefone.');
      return;
    }

    try {
      setSubmitting(true);
      setMessage('');
      await createAppointment({
        business_id: business.id,
        service_id: selectedService.id,
        client_name: name.trim(),
        client_phone: phone.trim(),
        appointment_date: `${date}T${time}:00-03:00`,
      });

      setMessage('Agendamento criado! Abrindo WhatsApp...');
      const text = `Olá! Novo agendamento.\nCliente: ${name.trim()}\nServiço: ${selectedService.name}\nData: ${date.split('-').reverse().join('/')} às ${time}`;
      window.location.href = `https://wa.me/55${localPhone}?text=${encodeURIComponent(text)}`;
    } catch (error) {
      setMessage(errorMessage(error, 'Não foi possível agendar.'));
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) return <div className="center"><div className="card"><h2>Carregando...</h2></div></div>;
  if (!business) return <div className="center"><div className="card"><h2>Agenda indisponível</h2><p>{message}</p><button className="outline" onClick={onBack}>Voltar</button></div></div>;

  return (
    <div className="public">
      <button className="back" onClick={onBack}>← Voltar</button>
      <div className="card booking">
        <div className="mark">AF</div>
        <h1>{business.name}</h1>
        <p>{business.description || 'Escolha um serviço e horário.'}</p>

        <form onSubmit={submit}>
          <label>Serviço
            <select value={serviceId} onChange={(event: ChangeEvent<HTMLSelectElement>) => { setServiceId(event.target.value); setTime(''); }} required>
              <option value="">Selecione</option>
              {serviceList.map((service) => <option key={service.id} value={service.id}>{service.name} — R$ {Number(service.price).toFixed(2)}</option>)}
            </select>
          </label>
          <label>Data<input type="date" min={todayIso()} value={date} onChange={(event: ChangeEvent<HTMLInputElement>) => { setDate(event.target.value); setTime(''); }} required /></label>
          <div><b>Horários</b><div className="slots">{slots.map((slot) => <button type="button" className={slot === time ? 'slot chosen' : 'slot'} onClick={() => setTime(slot)} key={slot}>{slot}</button>)}</div></div>
          {!slots.length && selectedService && <p className="muted">Não há horários configurados para esta data.</p>}
          <label>Seu nome<input value={name} onChange={(event: ChangeEvent<HTMLInputElement>) => setName(event.target.value)} required /></label>
          <label>Seu WhatsApp<input value={phone} onChange={(event: ChangeEvent<HTMLInputElement>) => setPhone(event.target.value)} required /></label>
          {message && <div className="notice">{message}</div>}
          <button className="primary wide" disabled={!time || submitting}>{submitting ? 'Salvando...' : 'Confirmar agendamento'}</button>
        </form>
      </div>
    </div>
  );
}
