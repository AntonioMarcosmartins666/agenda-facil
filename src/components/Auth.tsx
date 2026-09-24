import { useState, type ChangeEvent, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';

interface AuthProps {
  signup: boolean;
  onDone: () => void | Promise<void>;
}

export default function Auth({ signup, onDone }: AuthProps) {
  const [isSignup, setIsSignup] = useState(signup);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [businessName, setBusinessName] = useState('');
  const [slug, setSlug] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage('');

    try {
      if (isSignup) {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim().toLowerCase(),
          password,
          options: { data: { full_name: name.trim(), business_name: businessName.trim(), business_slug: slug.trim(), whatsapp: whatsapp.trim() } },
        });
        if (error) throw error;
        if (data.session) {
          await onDone();
        } else {
          setMessage('Cadastro realizado. Confira seu e-mail para confirmar a conta e depois faça o login.');
        }
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
        if (error) throw error;
        await onDone();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Ocorreu um erro.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <div className="card auth">
        <div className="mark">✓</div>
        <h1>{isSignup ? 'Crie sua agenda' : 'Entrar no Agenda Fácil'}</h1>
        <p>{isSignup ? 'Comece gratuitamente.' : 'Gerencie seus agendamentos.'}</p>

        <form onSubmit={submit}>
          {isSignup && <>
            <label>Nome<input value={name} onChange={(e: ChangeEvent<HTMLInputElement>) => setName(e.target.value)} required /></label>
            <label>Negócio<input value={businessName} onChange={(e: ChangeEvent<HTMLInputElement>) => setBusinessName(e.target.value)} required /></label>
            <label>Slug público<input value={slug} onChange={(e: ChangeEvent<HTMLInputElement>) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} required /></label>
            <label>WhatsApp<input value={whatsapp} onChange={(e: ChangeEvent<HTMLInputElement>) => setWhatsapp(e.target.value)} /></label>
          </>}
          <label>E-mail<input type="email" value={email} onChange={(e: ChangeEvent<HTMLInputElement>) => setEmail(e.target.value)} required /></label>
          <label>Senha<input type="password" minLength={6} value={password} onChange={(e: ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)} required /></label>
          {message && <div className="notice">{message}</div>}
          <button className="primary wide" disabled={busy}>{busy ? 'Aguarde...' : isSignup ? 'Criar conta' : 'Entrar'}</button>
        </form>

        <button className="link" type="button" onClick={() => { setIsSignup(!isSignup); setMessage(''); }}>
          {isSignup ? 'Já tenho conta' : 'Criar conta'}
        </button>
      </div>
    </div>
  );
}
