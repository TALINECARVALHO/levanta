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

webpush.setVapidDetails(
  process.env.VAPID_EMAIL!,
  process.env.VAPID_PUBLIC_KEY!,
  process.env.VAPID_PRIVATE_KEY!,
);

// alarmId -> { subscription, timeoutHandle }
const alarms = new Map<string, ReturnType<typeof setTimeout>>();

function alarmId(subscription: webpush.PushSubscription): string {
  return subscription.endpoint;
}

app.get('/api/ping', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/vapid-public-key', (_req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', async (req, res) => {
  const { subscription, targetTimestamp } = req.body as {
    subscription: webpush.PushSubscription;
    targetTimestamp: number;
  };

  if (!subscription?.endpoint || !targetTimestamp) {
    res.status(400).json({ error: 'subscription e targetTimestamp são obrigatórios' });
    return;
  }

  const id = alarmId(subscription);

  // Cancel any existing alarm for this subscription
  const existing = alarms.get(id);
  if (existing) clearTimeout(existing);

  const delay = targetTimestamp - Date.now();
  if (delay <= 0) {
    res.status(400).json({ error: 'targetTimestamp já passou' });
    return;
  }

  const handle = setTimeout(async () => {
    alarms.delete(id);
    try {
      await webpush.sendNotification(
        subscription,
        JSON.stringify({
          title: '🚨 LEVANTE AGORA! 🚨',
          body: 'Seu tempo esgotou! Hora de se mexer.',
        }),
      );
    } catch (err: any) {
      // 410 Gone = subscription expired/unsubscribed — nothing to do
      if (err.statusCode !== 410) {
        console.error('Erro ao enviar push:', err.message);
      }
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
