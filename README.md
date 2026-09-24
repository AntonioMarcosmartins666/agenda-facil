# Agenda Fácil — QA Final v1.1.0

Projeto React + TypeScript + Vite + Supabase, revisado para uma execução mais previsível em desenvolvimento e para build de produção.

## 1. Instalar

No terminal, dentro da pasta do projeto:

```bash
npm.cmd install
```

## 2. Configurar Supabase

Copie `.env.example` para `.env.local` e informe:

```env
VITE_SUPABASE_URL=https://SEU-PROJETO.supabase.co
VITE_SUPABASE_ANON_KEY=SUA_CHAVE_PUBLICA
```

Em um projeto Supabase novo, execute `supabase/schema.sql`. Para o banco já existente de produção, aplique as migrations em `supabase/migrations/` na ordem do nome do arquivo; não reexecute o schema inicial sobre dados existentes sem revisar o conteúdo.

Antes de considerar a produção endurecida, execute `20260924_booking_security_and_concurrency.sql` no SQL Editor após a migration de compatibilidade. Ela limita colunas acessíveis publicamente e valida conflitos de horário no banco.

## 3. Validar

```bash
npm.cmd run typecheck
npm.cmd run build
```

## 4. Executar

```bash
npm.cmd run dev
```

Abra o endereço informado pelo Vite, normalmente `http://localhost:5173/`.

## 5. Rotas principais

- `/` — landing page
- `/agenda/<slug>` — agenda pública
- `/painel` — o painel é aberto pelo fluxo de autenticação

## QA

Veja `QA_FINAL.md` para o relatório da revisão.

### Pagamento manual por Pix

Esta versão usa pedido Pix avulso, sem SDK, chave secreta de gateway ou webhook de cartão. O cliente cria um pedido no painel, transfere o valor para a chave Pix configurada e informa o código do pedido ao suporte. Uma pessoa confere o crédito no extrato e só então confirma o pedido no Supabase. O plano vale por 30 dias após a confirmação; o banco aplica os limites do plano gratuito quando expira.

1. Aplique `supabase/migrations/20260927_pix_manual_billing.sql` no SQL Editor do Supabase. Ela cria pedidos com valores fixos (Essencial R$ 29; Profissional R$ 59), impede o cliente de alterar status/valor e acrescenta validade ao plano.
2. Configure na Vercel para Production as variáveis `VITE_PIX_KEY` e `VITE_PIX_RECIPIENT`. Opcionalmente configure `VITE_PIX_SUPPORT_WHATSAPP` com DDI + DDD + número, apenas dígitos.
3. Faça redeploy para incorporar a chave e o nome do recebedor no frontend. A chave Pix será visível ao pagador; não coloque segredos em variáveis `VITE_`.
4. Consulte pedidos pendentes no Supabase com `SELECT id, business_id, user_id, plan, amount_cents, created_at FROM public.plan_pix_payments WHERE status = 'pending' ORDER BY created_at;`.
5. Depois de conferir o recebedor, valor e crédito no extrato, confirme somente aquele pedido: `SELECT * FROM public.confirm_plan_pix_payment('ID-DO-PEDIDO'::uuid, 'REFERENCIA-DO-EXTRATO');`. A função é idempotente; repeti-la não estende os 30 dias novamente. Para recusar, altere o status para `rejected` pelo SQL Editor.

A confirmação é manual. O sistema não lê comprovantes nem verifica o banco automaticamente. Não libere um plano com base apenas numa captura de tela. As tabelas/campos históricos do Stripe permanecem para preservar dados, mas as rotas e a dependência SDK foram removidas do aplicativo.

### E-mails

Esta versão ainda não envia e-mails de agendamento nem notificações de assinatura. O agendamento coleta telefone, e não há formulário de recuperação de senha. Mensagens de autenticação do Supabase (cadastro/recuperação) precisam de SMTP customizado em **Supabase → Authentication → SMTP Settings**; definir credenciais de e-mail na Vercel, sem código remetente, não ativa essas mensagens.
