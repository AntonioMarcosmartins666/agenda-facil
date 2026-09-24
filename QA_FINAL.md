# Agenda Fácil — QA da migração para Pix

## Alterações

- Removidas as rotas de checkout, portal e webhook Stripe e a dependência SDK.
- O painel cria pedidos Pix avulsos de Essencial (R$ 29) ou Profissional (R$ 59). O pedido fica pendente até que uma pessoa confira o crédito no extrato.
- A migration adiciona RLS para que cada usuário veja somente os seus pedidos, fixa os valores no banco e adiciona confirmação administrativa idempotente.
- Planos confirmados duram 30 dias; o painel e os triggers usam o plano gratuito após a validade.
- As colunas e tabelas históricas Stripe permanecem no banco para preservar dados, mas o app novo não as usa.

## Verificações

- `npm run build`: passou, incluindo TypeScript e build Vite.
- `npm audit --audit-level=low`: zero vulnerabilidades.
- `git diff --check`: passou.
- O usuário aplicou `20260927_pix_manual_billing.sql`; a captura mostrou `Success. No rows returned`.
- Commit `d940427` foi enviado para `main`; a produção respondeu HTTP 200 e serviu bundle com o fluxo Pix e sem o fluxo Stripe.
- `VITE_PIX_KEY` e `VITE_PIX_RECIPIENT` foram configuradas para Production na Vercel; o redeploy foi concluído com status Ready.
- A página inicial e a rota `/agenda/psicologia-da-saraah` respondem HTTP 200. Ainda falta criar um pedido Pix autenticado; a sessão disponível mostrou a tela de login.
- Não foi feita transferência bancária de teste. O pagamento permanece manual e nenhum plano deve ser liberado sem conferir o crédito no extrato.

## Próximos passos de produção

1. Entre no painel com uma conta autorizada e crie um pedido de teste sem efetuar transferência; confirme valores fixos e status `pending`.
2. Após receber um Pix real, confira valor e recebedor no extrato. Consulte pedidos pendentes com:

```sql
SELECT id, business_id, user_id, plan, amount_cents, created_at
FROM public.plan_pix_payments
WHERE status = 'pending'
ORDER BY created_at;
```

3. Confirme apenas o pedido correspondente ao crédito recebido:

```sql
SELECT * FROM public.confirm_plan_pix_payment(
  'ID-DO-PEDIDO'::uuid,
  'REFERENCIA-DO-EXTRATO'
);
```

4. Atualize o status no painel e confira o plano e a validade. Repetir a confirmação não estende a validade novamente.

## Fora deste escopo

- Pix automático por Mercado Pago/Asaas, QR Pix dinâmico, confirmação de comprovantes e e-mails transacionais não estão implementados.
- O sistema não deve ser anunciado como pagamento automático. A liberação depende da conferência manual do recebimento.
