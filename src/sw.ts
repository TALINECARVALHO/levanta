/// <reference lib="WebWorker" />

import { precacheAndRoute } from 'workbox-precaching';

declare const self: ServiceWorkerGlobalScope;

// Precache app shell — manifest injected by vite-plugin-pwa at build time
// @ts-ignore
precacheAndRoute(self.__WB_MANIFEST);

let alarmTimeout: ReturnType<typeof setTimeout> | null = null;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data;
  if (!data) return;

  if (data.type === 'SET_ALARM') {
    if (alarmTimeout !== null) clearTimeout(alarmTimeout);

    const delay = (data.targetTimestamp as number) - Date.now();
    if (delay <= 0) return;

    alarmTimeout = setTimeout(async () => {
      alarmTimeout = null;

      // Notification fires even with screen locked on Android
      await self.registration.showNotification('🚨 LEVANTE AGORA! 🚨', {
        body: 'Seu tempo esgotou! Hora de se mexer.',
        icon: '/icon.svg',
        tag: 'levanta-alarm',
        requireInteraction: true,
        // @ts-ignore — vibrate is valid in service worker notifications
        vibrate: [300, 100, 300, 100, 300],
      } as NotificationOptions);

      // Tell open clients to play audio (app handles sound)
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        (client as WindowClient).postMessage({ type: 'ALARM_FIRED' });
      }
    }, delay);
  }

  if (data.type === 'CANCEL_ALARM') {
    if (alarmTimeout !== null) {
      clearTimeout(alarmTimeout);
      alarmTimeout = null;
    }
  }
});

// Push event: server sent the notification (fires even on locked screen via FCM/APNs)
self.addEventListener('push', (event: PushEvent) => {
  let title = '🚨 LEVANTE AGORA! 🚨';
  let body = 'Seu tempo esgotou! Hora de se mexer.';

  try {
    const data = event.data?.json();
    if (data?.title) title = data.title;
    if (data?.body) body = data.body;
  } catch {}

  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, {
        body,
        icon: '/icon.svg',
        tag: 'levanta-alarm',
        requireInteraction: true,
        // @ts-ignore
        vibrate: [300, 100, 300, 100, 300],
      } as NotificationOptions);

      // Tell open clients to play audio
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        (client as WindowClient).postMessage({ type: 'ALARM_FIRED' });
      }
    })()
  );
});

self.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        const open = clients[0] as WindowClient | undefined;
        if (open) return open.focus();
        return self.clients.openWindow('/');
      })
  );
});
