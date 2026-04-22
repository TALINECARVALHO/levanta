import 'dotenv/config';
import express from 'express';
import webpush from 'web-push';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Allow requests from the Vite dev server
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

if (!process.env.VAPID_EMAIL || !process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  console.error('[Push] ERRO: Variáveis VAPID não configuradas!');
} else {
  console.log('[Push] VAPID configurado para:', process.env.VAPID_EMAIL);
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY,
  );
}

// alarmId -> { subscription, timeoutHandle }
const alarms = new Map<string, ReturnType<typeof setTimeout>>();

function alarmId(subscription: webpush.PushSubscription): string {
  return subscription.endpoint;
}

app.get('/api/ping', (_req, res) => {
  res.json({ ok: true });
});

// Quick test: POST {subscription} → push arrives in 5 seconds
app.post('/api/push/test', async (req, res) => {
  const { subscription } = req.body as { subscription: webpush.PushSubscription };
  if (!subscription?.endpoint) { res.status(400).json({ error: 'subscription obrigatória' }); return; }
  res.json({ ok: true, message: 'Push de teste em 5 segundos' });
  setTimeout(async () => {
    try {
      await webpush.sendNotification(subscription, JSON.stringify({
        title: '✅ Teste OK!',
        body: 'Push de servidor funcionando.',
      }));
      console.log('[Push] Teste enviado com sucesso');
    } catch (err: any) {
      console.error('[Push] Falha no teste:', err.statusCode, err.message);
    }
  }, 5000);
});

app.get('/api/vapid-public-key', (_req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', async (req, res) => {
  const { subscription, targetTimestamp } = req.body as {
    subscription: webpush.PushSubscription;
    targetTimestamp: number;
  };

  console.log('[Push] Recebido agendamento — endpoint:', subscription?.endpoint?.slice(0, 60));

  if (!subscription?.endpoint || !targetTimestamp) {
    res.status(400).json({ error: 'subscription e targetTimestamp são obrigatórios' });
    return;
  }

  const id = alarmId(subscription);
  const existing = alarms.get(id);
  if (existing) clearTimeout(existing);

  const delay = targetTimestamp - Date.now();
  if (delay <= 0) {
    res.status(400).json({ error: 'targetTimestamp já passou' });
    return;
  }

  console.log(`[Push] Alarme agendado para ${new Date(targetTimestamp).toISOString()} (delay: ${Math.round(delay / 1000)}s)`);

  const handle = setTimeout(async () => {
    alarms.delete(id);
    console.log('[Push] Disparando notificação...');
    try {
      await webpush.sendNotification(
        subscription,
        JSON.stringify({
          title: '🚨 LEVANTE AGORA! 🚨',
          body: 'Seu tempo esgotou! Hora de se mexer.',
        }),
      );
      console.log('[Push] Notificação enviada com sucesso');
    } catch (err: any) {
      console.error('[Push] Erro ao enviar:', err.statusCode, err.message, err.body);
    }
  }, delay);

  alarms.set(id, handle);
  res.json({ ok: true, firesAt: new Date(targetTimestamp).toISOString() });
});

app.post('/api/push/cancel', (req, res) => {
  const { subscription } = req.body as { subscription: webpush.PushSubscription };
  if (!subscription?.endpoint) {
    res.status(400).json({ error: 'subscription é obrigatória' });
    return;
  }
  const id = alarmId(subscription);
  const handle = alarms.get(id);
  if (handle) {
    clearTimeout(handle);
    alarms.delete(id);
  }
  res.json({ ok: true });
});

// Serve built frontend in production
const distDir = path.join(__dirname, 'dist');
app.use(express.static(distDir));
app.get('*', (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'));
});

const PORT = Number(process.env.PORT ?? 3001);
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});
