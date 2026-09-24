import { useCallback, useEffect, useState } from 'react';
import { supabase, configured } from './lib/supabase';
import { businessesByUser, createBusiness } from './lib/api';
import type { Business } from './types';
import Auth from './components/Auth';
import Dashboard from './components/Dashboard';
import Booking from './components/Booking';

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function publicSlugFromPath(): string | null {
  const match = window.location.pathname.match(/^\/agenda\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export default function App() {
  const [session, setSession] = useState<any>(null);
  const initialPublicSlug = publicSlugFromPath();
  const [business, setBusiness] = useState<Business | null>(null);
  const [userBusinesses, setUserBusinesses] = useState<Business[]>([]);
  const [view, setView] = useState<'home' | 'auth' | 'businesses' | 'dashboard' | 'booking'>(initialPublicSlug ? 'booking' : 'home');
  const [signup, setSignup] = useState(false);
  const [slug, setSlug] = useState(publicSlugFromPath() ?? '');
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

  const loadBusinesses = useCallback(async (uid: string) => {
    const found = await businessesByUser(uid);
    setUserBusinesses(found);
    if (found.length === 1) {
      setBusiness(found[0]);
      setView('dashboard');
    } else if (found.length > 1) {
      setBusiness(null);
      setView('businesses');
    } else {
      setBusiness(null);
      setView('home');
    }
    return found;
  }, []);

  useEffect(() => {
    let mounted = true;

    const bootstrap = async () => {
      if (!configured) {
        if (mounted) setLoading(false);
        return;
      }

      const { data, error } = await supabase.auth.getSession();
      if (error) {
        if (mounted) setMessage(error.message);
      } else if (mounted) {
        setSession(data.session);
        if (data.session && !publicSlugFromPath()) {
          try {
            await loadBusinesses(data.session.user.id);
          } catch (err) {
            if (mounted) setMessage(err instanceof Error ? err.message : 'Não foi possível carregar o negócio.');
          }
        }
      }

      if (mounted) setLoading(false);
    };

    void bootstrap();

    const { data } = supabase.auth.onAuthStateChange((event: string, nextSession: any) => {
      if (!mounted) return;
      setSession(nextSession);
      if (!nextSession) {
        setBusiness(null);
        setUserBusinesses([]);
        if (!publicSlugFromPath()) setView('home');
        return;
      }
      if (event === 'SIGNED_IN' || event === 'USER_UPDATED') {
        void loadBusinesses(nextSession.user.id).catch((err) => {
          if (mounted) setMessage(err instanceof Error ? err.message : 'Erro ao carregar o negócio.');
        });
      }
    });

    return () => {
      mounted = false;
      data.subscription.unsubscribe();
    };
  }, [loadBusinesses]);

  if (loading) return <div className="center">Carregando Agenda Fácil...</div>;

  if (!configured) {
    return (
      <div className="center">
        <div className="card">
          <h1>Agenda Fácil</h1>
          <p>Configure <b>.env.local</b> com VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY para ativar o backend.</p>
        </div>
      </div>
    );
  }

  if (view === 'booking') {
    return <Booking slug={slug} onBack={() => { window.history.pushState({}, '', '/'); setView('home'); }} />;
  }

  if (view === 'auth') {
    return (
      <Auth
        signup={signup}
        onDone={async () => {
          const { data } = await supabase.auth.getSession();
          if (!data.session) return;

          setSession(data.session);
          let found = await businessesByUser(data.session.user.id);

          if (!found.length) {
            const name = window.prompt('Nome do negócio');
            if (!name?.trim()) return;
            const suggested = slugify(name);
            const publicSlug = window.prompt('Slug público', suggested);
            if (!publicSlug?.trim()) return;
            const created = await createBusiness(data.session.user.id, name, slugify(publicSlug));
            found = [created];
          }

          setUserBusinesses(found);
          if (found.length === 1) {
            setBusiness(found[0]);
            setView('dashboard');
          } else {
            setBusiness(null);
            setView('businesses');
          }
        }}
      />
    );
  }

  if (view === 'businesses') {
    return (
      <div className="center">
        <div className="card auth">
          <div className="mark">✓</div>
          <h1>Escolha uma agenda</h1>
          <p>Selecione o negócio que deseja gerenciar.</p>
          {userBusinesses.map((item) => (
            <button
              className="outline wide"
              key={item.id}
              onClick={() => { setBusiness(item); setView('dashboard'); }}
            >
              {item.name} · /agenda/{item.slug}
            </button>
          ))}
          <button className="link" onClick={async () => { await supabase.auth.signOut(); }}>Sair</button>
        </div>
      </div>
    );
  }

  if (view === 'dashboard' && business) {
    return <Dashboard b={business} onB={setBusiness} businesses={userBusinesses} onSelectBusiness={() => setView('businesses')} />;
  }

  return (
    <div className="landing">
      <header className="top">
        <div className="brand"><span className="mark">✓</span>Agenda Fácil</div>
        {session && business ? (
          <button className="outline" onClick={() => setView('dashboard')}>Meu painel</button>
        ) : (
          <button className="outline" onClick={() => { setSignup(false); setView('auth'); }}>Entrar</button>
        )}
      </header>

      <main>
        <section className="hero">
          <small>AGENDA ONLINE PARA PEQUENOS NEGÓCIOS</small>
          <h1>Sua agenda profissional,<br /><em>sem complicação.</em></h1>
          <p>Organize horários, receba agendamentos online e leve seu cliente direto para o WhatsApp.</p>
          <button className="primary large" onClick={() => { setSignup(true); setView('auth'); }}>Criar minha agenda</button>
          {business && <button className="outline large" onClick={() => { setSlug(business.slug); window.history.pushState({}, '', `/agenda/${business.slug}`); setView('booking'); }}>Ver minha agenda</button>}
        </section>

        <section className="features">
          <div><b>🔗 Link público</b><p>Compartilhe sua agenda.</p></div>
          <div><b>💬 WhatsApp</b><p>Receba o cliente direto no WhatsApp.</p></div>
          <div><b>📅 Organização</b><p>Controle serviços e horários.</p></div>
        </section>

        <section className="pricing">
          <h2>Planos simples</h2>
          {[
            ['Grátis', 'R$ 0', '3 serviços · 30 agendamentos'],
            ['Essencial', 'R$ 29/mês', '10 serviços · 200 agendamentos'],
            ['Profissional', 'R$ 59/mês', '50 serviços · 2.000 agendamentos'],
          ].map(([name, price, details]) => (
            <div className="price" key={name}>
              <span>{name}</span><b>{price}</b><p>{details}</p>
              <button className="primary" onClick={() => { setSignup(true); setView('auth'); }}>Começar</button>
            </div>
          ))}
        </section>

        {message && <div className="notice">{message}</div>}
      </main>
    </div>
  );
}
