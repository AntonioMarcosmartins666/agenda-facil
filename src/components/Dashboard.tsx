import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { services, hours, appointments, saveBusiness, saveService, deleteService, saveHour, setStatus, LIMITS, requestPixPayment, getPixPaymentRequest, businessesByUser } from '../lib/api';
import { saoPauloDate } from '../lib/time';
import { errorMessage } from '../lib/errors';
import type { Appointment, Business, PixPaymentRequest, Plan, Service, WorkingHour, Status } from '../types';

const days = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const statuses: Status[] = ['pending', 'confirmed', 'completed', 'cancelled'];
export default function Dashboard({
  b,
  onB,
  businesses,
  onSelectBusiness,
}: {
  b: Business;
  onB: (business: Business) => void;
  businesses: Business[];
  onSelectBusiness: () => void;
}) {
  const [tab, setTab] = useState('overview');
  const [serviceList, setServiceList] = useState<Service[]>([]);
  const [workingHours, setWorkingHours] = useState<WorkingHour[]>([]);
  const [appointmentList, setAppointmentList] = useState<Appointment[]>([]);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [billingLoading, setBillingLoading] = useState(false);
  const [pixRequest, setPixRequest] = useState<PixPaymentRequest | null>(null);
  const [, setClock] = useState(0);

  const pixKey = import.meta.env.VITE_PIX_KEY?.trim() ?? '';
  const pixRecipient = import.meta.env.VITE_PIX_RECIPIENT?.trim() ?? '';
  const supportWhatsapp = import.meta.env.VITE_PIX_SUPPORT_WHATSAPP?.replace(/\D/g, '') ?? '';
  const expiresAt = b.plan_expires_at ? new Date(b.plan_expires_at) : null;
  const effectivePlan: Plan = b.plan !== 'free' && (!expiresAt || expiresAt.getTime() <= Date.now()) ? 'free' : b.plan;

  useEffect(() => {
    if (!expiresAt) return;
    let timer = 0;
    const updateAtExpiry = () => {
      const remaining = expiresAt.getTime() - Date.now();
      if (remaining <= 0) setClock(Date.now());
      else timer = window.setTimeout(updateAtExpiry, Math.min(remaining + 50, 2_000_000_000));
    };
    updateAtExpiry();
    return () => window.clearTimeout(timer);
  }, [b.plan_expires_at]);

  const load = async () => {
    setLoading(true);
    try {
      const [loadedServices, loadedHours, loadedAppointments] = await Promise.all([services(b.id), hours(b.id), appointments(b.id)]);
      setServiceList(loadedServices);
      setWorkingHours(loadedHours);
      setAppointmentList(loadedAppointments);
    } catch (error) {
      setMessage(errorMessage(error, 'Erro ao carregar o painel.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [b.id]);

  async function startPix(plan: 'essential' | 'professional') {
    setBillingLoading(true);
    try {
      if (!pixKey || !pixRecipient) throw new Error('O pagamento Pix ainda não foi configurado. Tente novamente mais tarde.');
      const request = await requestPixPayment(b.id, plan);
      setPixRequest(request);
      setMessage('Pedido Pix criado. O plano será liberado após a conferência do pagamento.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível criar o pedido Pix.');
    } finally {
      setBillingLoading(false);
    }
  }

  async function refreshPixStatus() {
    if (!pixRequest) return;
    setBillingLoading(true);
    try {
      const updated = await getPixPaymentRequest(pixRequest.id);
      setPixRequest(updated);
      if (updated.status === 'confirmed') {
        const items = await businessesByUser(b.user_id);
        const business = items.find((item) => item.id === b.id);
        if (business) onB(business);
        setMessage('Pagamento confirmado. Seu plano está ativo.');
      } else {
        setMessage('O pagamento ainda aguarda conferência.');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível consultar o pedido Pix.');
    } finally {
      setBillingLoading(false);
    }
  }

  const limit = LIMITS[effectivePlan];
  const todayCount = useMemo(() => {
    const today = saoPauloDate(new Date());
    return appointmentList.filter((item) => saoPauloDate(new Date(item.appointment_date)) === today).length;
  }, [appointmentList]);

  async function addService() {
    try {
      if (serviceList.length >= limit.services) {
        setMessage(`O plano ${limit.label} permite até ${limit.services} serviços.`);
        return;
      }
      const name = window.prompt('Nome do serviço');
      if (!name?.trim()) return;
      const price = Number(window.prompt('Preço', '29'));
      const duration = Number(window.prompt('Duração em minutos', '60'));
      if (!Number.isFinite(price) || !Number.isFinite(duration) || price < 0 || duration < 5) {
        setMessage('Preço ou duração inválidos.');
        return;
      }
      await saveService({ business_id: b.id, name: name.trim(), price, duration_minutes: duration, active: true });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível salvar o serviço.');
    }
  }

  async function editHour(hour: WorkingHour) {
    const start = window.prompt('Início', hour.start_time.slice(0, 5));
    const end = window.prompt('Fim', hour.end_time.slice(0, 5));
    if (!start || !end) return;
    try {
      await saveHour({ ...hour, start_time: start, end_time: end });
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível salvar o horário.');
    }
  }

  async function updateStatus(id: string, status: Status) {
    try {
      await setStatus(id, status);
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Não foi possível atualizar o status.');
    }
  }

  return (
    <div className="dash">
      <aside>
        <div className="brand"><span className="mark">✓</span>Agenda Fácil</div>
        {[['overview', 'Visão geral'], ['business', 'Meu negócio'], ['services', 'Serviços'], ['hours', 'Horários'], ['appointments', 'Agendamentos'], ['plans', 'Planos']].map(([key, label]) => (
          <button className={tab === key ? 'active' : ''} onClick={() => setTab(key)} key={key}>{label}</button>
        ))}
      </aside>

      <main className="dashmain">
        <header>
          <div><small>PAINEL</small><h1>{b.name}</h1></div>
          <div className="between">
            {businesses.length > 1 && <button className="outline" onClick={onSelectBusiness}>Trocar negócio</button>}
            <a className="outline" href={`/agenda/${b.slug}`} target="_blank" rel="noreferrer">Abrir agenda ↗</a>
          </div>
        </header>

        {message && <div className="notice">{message}</div>}
        {loading ? <section className="panel"><p>Carregando...</p></section> : <>
          {tab === 'overview' && <>
            <div className="stats"><div><small>Hoje</small><b>{todayCount}</b></div><div><small>Serviços</small><b>{serviceList.length}/{limit.services}</b></div><div><small>Plano</small><b>{limit.label}</b></div></div>
            <section className="panel"><h2>Próximos agendamentos</h2>{appointmentList.slice(0, 8).map((item) => <div className="row" key={item.id}><div><b>{item.client_name}</b><small>{item.service?.name ?? 'Serviço'} · {new Date(item.appointment_date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</small></div><span className={`status ${item.status}`}>{item.status}</span></div>)}{!appointmentList.length && <p>Nenhum agendamento ainda.</p>}</section>
          </>}

          {tab === 'business' && <section className="panel form"><h2>Meu negócio</h2><label>Nome<input defaultValue={b.name} onBlur={(e: ChangeEvent<HTMLInputElement>) => void saveBusiness(b.id, { name: e.target.value }).then(onB).catch((error) => setMessage(error.message))} /></label><label>Descrição<textarea defaultValue={b.description ?? ''} onBlur={(e: ChangeEvent<HTMLTextAreaElement>) => void saveBusiness(b.id, { description: e.target.value }).then(onB).catch((error) => setMessage(error.message))} /></label><label>WhatsApp (DDD + número)<input defaultValue={b.whatsapp ?? ''} onBlur={(e: ChangeEvent<HTMLInputElement>) => void saveBusiness(b.id, { whatsapp: e.target.value }).then(onB).catch((error) => setMessage(error.message))} /></label><label>Endereço<input defaultValue={b.address ?? ''} onBlur={(e: ChangeEvent<HTMLInputElement>) => void saveBusiness(b.id, { address: e.target.value }).then(onB).catch((error) => setMessage(error.message))} /></label></section>}

          {tab === 'services' && <section className="panel"><div className="between"><h2>Serviços</h2><button className="primary" onClick={() => void addService()}>+ Novo serviço</button></div>{serviceList.map((service) => <div className="row" key={service.id}><div><b>{service.name}</b><small>R$ {Number(service.price).toFixed(2)} · {service.duration_minutes} min</small></div><div><button className="small" onClick={() => void saveService({ ...service, active: !service.active }).then(load).catch((error) => setMessage(error.message))}>{service.active ? 'Ativo' : 'Inativo'}</button><button className="danger small" onClick={() => { if (window.confirm('Excluir este serviço?')) void deleteService(service.id).then(load).catch((error) => setMessage(error.message)); }}>Excluir</button></div></div>)}</section>}

          {tab === 'hours' && <section className="panel"><h2>Horários</h2>{days.map((day, index) => { const hour = workingHours.find((item) => item.weekday === index); return <div className="row" key={day}><div><b>{day}</b><small>{hour?.enabled ? `${hour.start_time.slice(0, 5)} — ${hour.end_time.slice(0, 5)}` : 'Fechado'}</small></div>{hour && <button className="small" onClick={() => void editHour(hour)}>Editar</button>}</div>; })}</section>}

          {tab === 'appointments' && <section className="panel"><h2>Agendamentos</h2>{appointmentList.map((item) => <div className="row" key={item.id}><div><b>{item.client_name}</b><small>{item.service?.name ?? 'Serviço'} · {new Date(item.appointment_date).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })} · {item.client_phone}</small></div><select value={item.status} onChange={(event: ChangeEvent<HTMLSelectElement>) => void updateStatus(item.id, event.target.value as Status)}>{statuses.map((status) => <option value={status} key={status}>{status}</option>)}</select></div>)}{!appointmentList.length && <p>Nenhum agendamento ainda.</p>}</section>}

          {tab === 'plans' && <section><div className="pricing">{Object.entries(LIMITS).map(([key, plan]) => {
            const isPaidPlan = key === 'essential' || key === 'professional';
            const isCurrentPlan = effectivePlan === key;
            const buttonLabel = key === 'free' ? (isCurrentPlan ? 'Plano atual' : 'Plano gratuito') : isCurrentPlan ? 'Renovar com Pix' : 'Pagar com Pix';
            return <div className="price" key={key}><span>{plan.label}</span><b>{plan.price ? `R$ ${plan.price}/30 dias` : 'Grátis'}</b><p>{plan.services} serviços</p><p>{plan.appointments.toLocaleString('pt-BR')} agendamentos/mês</p><button className="primary" disabled={billingLoading || !isPaidPlan} onClick={() => { if (isPaidPlan) void startPix(key as 'essential' | 'professional'); }}>{buttonLabel}</button></div>;
          })}</div>{expiresAt && effectivePlan !== 'free' && <p>Plano válido até {expiresAt.toLocaleDateString('pt-BR')}.</p>}<p>Pagamento por Pix avulso. A validade de 30 dias começa após a confirmação manual do recebimento.</p>{(!pixKey || !pixRecipient) && <p>O pagamento Pix ainda não está configurado para esta publicação.</p>}</section>}
        </>}
      </main>
      {pixRequest && <div className="pix-overlay"><section className="panel pix-dialog" role="dialog" aria-modal="true" aria-labelledby="pix-title"><button className="pix-close" onClick={() => setPixRequest(null)} aria-label="Fechar">×</button><h2 id="pix-title">Pagamento por Pix</h2><p>Plano {LIMITS[pixRequest.plan].label} · R$ {(pixRequest.amount_cents / 100).toFixed(2).replace('.', ',')} por 30 dias</p><p>Chave Pix: <b>{pixKey}</b></p><p>Recebedor: <b>{pixRecipient}</b></p><button className="outline" onClick={() => void navigator.clipboard.writeText(pixKey).then(() => setMessage('Chave Pix copiada.')).catch(() => setMessage('Não foi possível copiar; selecione a chave e copie manualmente.'))}>Copiar chave Pix</button><p>Após transferir, informe ao suporte o código do pedido para conferência:</p><code className="pix-reference">{pixRequest.id}</code><p>Status: <b>{pixRequest.status === 'confirmed' ? 'Confirmado' : pixRequest.status === 'rejected' ? 'Recusado' : 'Aguardando conferência'}</b></p>{supportWhatsapp && <a className="outline" href={`https://wa.me/${supportWhatsapp}?text=${encodeURIComponent(`Comprovante do pedido Pix ${pixRequest.id}`)}`} target="_blank" rel="noreferrer">Enviar comprovante ao suporte</a>}<button className="primary" disabled={billingLoading} onClick={() => void refreshPixStatus()}>{billingLoading ? 'Consultando…' : 'Atualizar status'}</button><small>O plano só muda depois que o recebimento for conferido. Nunca envie senha ou código de acesso.</small></section></div>}
    </div>
  );
}
