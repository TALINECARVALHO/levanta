import React, { useState, useEffect } from 'react';
import { 
  Timer, ChevronUp, ChevronDown, Play, 
  Volume2, BellRing, History, Pause, Square, CheckCircle2, AlarmClockOff, AlarmClock
} from 'lucide-react';

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? '';

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// Fetch VAPID key at runtime so it works regardless of build-time env vars
let _vapidKey: string | null = null;
async function getVapidKey(): Promise<string | null> {
  if (_vapidKey) return _vapidKey;
  // Prefer build-time key if available
  const buildKey = import.meta.env.VITE_VAPID_PUBLIC_KEY;
  if (buildKey) { _vapidKey = buildKey; return _vapidKey; }
  try {
    const res = await fetch(`${SERVER_URL}/api/vapid-public-key`);
    const data = await res.json();
    _vapidKey = data.key ?? null;
  } catch (e) {
    console.error('[Push] Falha ao buscar chave VAPID:', e);
  }
  return _vapidKey;
}

async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!('PushManager' in window) || !navigator.serviceWorker) return null;
  const vapidKey = await getVapidKey();
  if (!vapidKey) { console.error('[Push] Chave VAPID não disponível'); return null; }
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) return existing;
    return await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidKey),
    });
  } catch (e) {
    console.error('[Push] Falha ao criar subscricão:', e);
    return null;
  }
}

async function serverScheduleAlarm(subscription: PushSubscription, targetTimestamp: number) {
  const res = await fetch(`${SERVER_URL}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription, targetTimestamp }),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error('[Push] Servidor recusou agendamento:', res.status, text);
  } else {
    const data = await res.json();
    console.log('[Push] Alarme agendado no servidor:', data.firesAt);
  }
}

async function serverCancelAlarm(subscription: PushSubscription) {
  await fetch(`${SERVER_URL}/api/push/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription }),
  }).catch(() => {});
}

// SW-local fallback (used when server push is unavailable)
function swSendAlarm(targetTimestamp: number) {
  navigator.serviceWorker?.ready.then((reg) => {
    reg.active?.postMessage({ type: 'SET_ALARM', targetTimestamp });
  });
}

function swCancelAlarm() {
  navigator.serviceWorker?.ready.then((reg) => {
    reg.active?.postMessage({ type: 'CANCEL_ALARM' });
  });
}

// Keeps the Render free-tier server awake while timer is running
function startKeepAlive(): () => void {
  const id = setInterval(() => {
    fetch(`${SERVER_URL}/api/ping`).catch(() => {});
  }, 10 * 60 * 1000);
  return () => clearInterval(id);
}

// Try server push first; SW-local setTimeout always runs as fallback
async function scheduleAlarm(targetTimestamp: number) {
  swSendAlarm(targetTimestamp);
  try {
    const sub = await getPushSubscription();
    if (sub) {
      await serverScheduleAlarm(sub, targetTimestamp);
    } else {
      console.warn('[Push] Sem subscricão, usando apenas fallback SW local');
    }
  } catch (e) {
    console.error('[Push] Erro ao agendar no servidor:', e);
  }
}

async function cancelAlarm() {
  swCancelAlarm();
  try {
    const sub = await navigator.serviceWorker?.ready
      .then((r) => r.pushManager.getSubscription())
      .catch(() => null);
    if (sub) await serverCancelAlarm(sub);
  } catch {}
}

export default function App() {
  const [view, setView] = useState<'setup' | 'active'>('setup');

  // Timer Setup State
  const [setupHours, setSetupHours] = useState(0);
  const [setupMinutes, setSetupMinutes] = useState(25);

  // Active Timer State
  const [timeLeft, setTimeLeft] = useState(setupHours * 3600 + setupMinutes * 60);
  const [isActive, setIsActive] = useState(false);
  const [isFlashing, setIsFlashing] = useState(false);
  const [nextAlarmTime, setNextAlarmTime] = useState("");

  // Use a ref to hold the HTML5 Audio object for mobile reliability
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const stopKeepAliveRef = React.useRef<(() => void) | null>(null);

  useEffect(() => {
    // Initialize audio object once
    audioRef.current = new Audio("https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3");
    audioRef.current.volume = 1.0;
  }, []);

  // Listen for ALARM_FIRED from service worker (plays audio when screen was locked)
  useEffect(() => {
    if (!navigator.serviceWorker) return;
    const handler = (event: MessageEvent) => {
      if (event.data?.type === 'ALARM_FIRED') {
        // Use refs to avoid stale closures
        if (soundEnabledRef.current && audioRef.current) {
          audioRef.current.currentTime = 0;
          audioRef.current.play().catch(() => {});
        }
        setIsFlashing(true);
        setTimeout(() => setIsFlashing(false), 5000);
      }
    };
    navigator.serviceWorker.addEventListener('message', handler);
    return () => navigator.serviceWorker.removeEventListener('message', handler);
  }, []);

  // Sound logic
  const playNotificationSound = () => {
    if (!soundEnabled || !audioRef.current) return;
    try {
      audioRef.current.currentTime = 0;
      audioRef.current.play().catch(e => console.error("Erro ao tocar som:", e));
    } catch (e) {
      console.error("Erro geral no som:", e);
    }
  };


  // Computed display values
  const displayHours = Math.floor(timeLeft / 3600);
  const displayMinutes = Math.floor((timeLeft % 3600) / 60);
  const displaySeconds = timeLeft % 60;

  // Toggle states
  const [soundEnabled, setSoundEnabled] = useState(true);
  const soundEnabledRef = React.useRef(soundEnabled);
  useEffect(() => { soundEnabledRef.current = soundEnabled; }, [soundEnabled]);
  const [remindersEnabled, setRemindersEnabled] = useState(false);

  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    let lastTick = Date.now();

    if (isActive && timeLeft > 0) {
      interval = setInterval(() => {
        const now = Date.now();
        const delta = Math.floor((now - lastTick) / 1000);
        if (delta >= 1) {
          setTimeLeft(prev => Math.max(0, prev - delta));
          lastTick = now;
        }
      }, 500);
    } else if (timeLeft === 0 && isActive) {
      // Cancel any pending alarm (avoid duplicate notification when screen was on)
      cancelAlarm();

      // Play sound + flash (visible state)
      playNotificationSound();
      setIsFlashing(true);
      setTimeout(() => setIsFlashing(false), 5000);

      // Schedule next cycle alarm (server push + SW fallback)
      const durationMs = (setupHours * 3600 + setupMinutes * 60) * 1000;
      const nextTarget = Date.now() + durationMs;
      scheduleAlarm(nextTarget);

      // Update next alarm display
      const future = new Date(nextTarget);
      setNextAlarmTime(future.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

      // Restart timer
      setTimeLeft(setupHours * 3600 + setupMinutes * 60);
      lastTick = Date.now();
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isActive, timeLeft]);

  const handleStart = async () => {
    // Request Notification Permission (must be from user gesture on mobile)
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }

    // Unlock HTML5 Audio for mobile (requires user gesture)
    if (audioRef.current) {
      audioRef.current.play().then(() => {
        audioRef.current?.pause();
        if (audioRef.current) audioRef.current.currentTime = 0;
      }).catch(e => console.error("Falha ao desbloquear áudio:", e));
    }

    // Request Wake Lock to prevent screen sleep
    if ('wakeLock' in navigator) {
      try {
        await (navigator as any).wakeLock.request('screen');
      } catch (err) {}
    }

    // Schedule alarm via server push (+ SW fallback)
    const durationMs = (setupHours * 3600 + setupMinutes * 60) * 1000;
    const targetTimestamp = Date.now() + durationMs;
    scheduleAlarm(targetTimestamp);

    const future = new Date(targetTimestamp);
    setNextAlarmTime(future.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));

    setTimeLeft(setupHours * 3600 + setupMinutes * 60);
    setIsActive(true);
    setView('active');
    stopKeepAliveRef.current = startKeepAlive();
  };

  const handlePause = () => {
    const willBePaused = isActive;
    setIsActive(!isActive);
    if (willBePaused) {
      cancelAlarm();
    } else {
      scheduleAlarm(Date.now() + timeLeft * 1000);
    }
  };

  const handleStop = () => {
    cancelAlarm();
    stopKeepAliveRef.current?.();
    stopKeepAliveRef.current = null;
    setIsActive(false);
    setIsFlashing(false);
    setView('setup');
  };

  const incrementTime = (type: 'hours' | 'minutes') => {
    if (type === 'hours') {
      setSetupHours(prev => Math.min(prev + 1, 12));
    } else {
      setSetupMinutes(prev => (prev + 5 >= 60 ? 0 : prev + 5));
    }
  };

  const decrementTime = (type: 'hours' | 'minutes') => {
    if (type === 'hours') {
      setSetupHours(prev => Math.max(prev - 1, 0));
    } else {
      setSetupMinutes(prev => (prev - 5 < 0 ? 55 : prev - 5));
    }
  };

  const formatZero = (num: number) => num.toString().padStart(2, '0');

  const handleHoursChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value.replace(/\D/g, '')) || 0;
    setSetupHours(Math.min(Math.max(val, 0), 23));
  };

  const handleMinutesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value.replace(/\D/g, '')) || 0;
    setSetupMinutes(Math.min(Math.max(val, 0), 59));
  };

  // Background and Layout depending on view
  return (
    <div className={`relative min-h-screen transition-colors duration-500 ${isFlashing ? 'bg-primary animate-pulse' : 'bg-background'} text-on-background font-inter selection:bg-primary-fixed selection:text-on-primary-fixed pb-24`}>
      
      {/* Background Image for Active View */}
      {view === 'active' && (
        <div className="fixed inset-0 w-full h-full -z-10 opacity-30 pointer-events-none">
          <img 
            src="https://lh3.googleusercontent.com/aida-public/AB6AXuCqhJCp9jePqGhrff6CPPop3fjuOqkXbV15ugoOFKDl7r1CBy0K10zTXrvIsvF7XyZFqLBGFVuxaf2hQhSDNrnDWC-JP15hO1PSYkeavX-XpHuHsWJsq_VBhKSyqSM13Y-DevG9yY63QRYD8a5_JQXMYgrr0UTJ4itYJp6GozraDCI_nmOUVoKuu6nRfhEK6EvsHSWxBTC5mmW_5NxGe6skzKpSkdBcWG8rtDTY6D3x6jjpAyA0LBNaPNiHiGowIKrnm1kQpRKVF65E" 
            alt="Zen background" 
            className="w-full h-full object-cover grayscale brightness-110" 
          />
        </div>
      )}

      {/* Top Header */}
      <header className="fixed top-0 w-full z-50 bg-background/80 backdrop-blur-md border-b border-outline-variant/20 shadow-sm">
        <div className="flex justify-between items-center h-14 px-6 max-w-[600px] mx-auto w-full">
          <div className="flex flex-row items-center cursor-pointer" onClick={() => setView('setup')}>
            <button className="flex items-center justify-center w-10 h-10 rounded-full transition-colors hover:bg-surface-dim active:scale-95 transition-transform duration-150">
              <Timer className="w-5 h-5 text-primary" strokeWidth={2.5} />
            </button>
            <h1 className="text-lg font-bold tracking-tight text-primary font-manrope -ml-1">Stand-Up</h1>
          </div>
          <div className="flex items-center gap-1">
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-[600px] mx-auto px-6 pt-24 min-h-screen flex flex-col">
        {view === 'setup' ? (
          /* SETUP VIEW */
          <div className="flex flex-col items-center w-full">

            {/* Setup Text */}
            <div className="text-center mb-10 w-full">
              <span className="text-[length:var(--text-label-caps)] font-inter text-outline uppercase tracking-[0.05em] font-semibold mb-2 block">
                Sessão de Foco
              </span>
              <h2 className="text-[length:var(--text-headline-lg)] font-manrope text-primary font-bold leading-tight">
                Prepare-se para Levantar
              </h2>
              <p className="text-[length:var(--text-body-md)] font-inter text-on-surface-variant mt-2">
                Otimize sua postura e produtividade.
              </p>
            </div>

            {/* Timer Picker Container */}
            <div className="w-full bg-surface-container-low rounded-2xl p-6 shadow-sm mb-8">
              <div className="flex flex-col items-center">
                <span className="text-[length:var(--text-label-sm)] font-inter text-outline font-medium mb-4 uppercase">Duração</span>
                
                <div className="flex items-center justify-center gap-6">
                  {/* Hours */}
                  <div className="flex flex-col items-center w-28">
                    <button onClick={() => incrementTime('hours')} className="p-2 text-primary/40 hover:text-primary transition-colors active:scale-95">
                      <ChevronUp className="w-8 h-8" strokeWidth={3} />
                    </button>
                    <input 
                      type="text"
                      inputMode="numeric"
                      value={formatZero(setupHours)}
                      onChange={handleHoursChange}
                      className="w-full text-center bg-transparent border-none outline-none text-[length:var(--text-display-timer)] font-manrope text-primary font-light -tracking-[0.02em] py-4 focus:ring-0 appearance-none overflow-visible"
                    />
                    <button onClick={() => decrementTime('hours')} className="p-2 text-primary/40 hover:text-primary transition-colors active:scale-95">
                      <ChevronDown className="w-8 h-8" strokeWidth={3} />
                    </button>
                  </div>

                  <span className="text-[length:var(--text-display-timer)] font-manrope text-primary font-light -mt-4">:</span>

                  {/* Minutes */}
                  <div className="flex flex-col items-center w-28">
                    <button onClick={() => incrementTime('minutes')} className="p-2 text-primary/40 hover:text-primary transition-colors active:scale-95">
                      <ChevronUp className="w-8 h-8" strokeWidth={3} />
                    </button>
                    <input 
                      type="text"
                      inputMode="numeric"
                      value={formatZero(setupMinutes)}
                      onChange={handleMinutesChange}
                      className="w-full text-center bg-transparent border-none outline-none text-[length:var(--text-display-timer)] font-manrope text-primary font-light -tracking-[0.02em] py-4 focus:ring-0 appearance-none overflow-visible"
                    />
                    <button onClick={() => decrementTime('minutes')} className="p-2 text-primary/40 hover:text-primary transition-colors active:scale-95">
                      <ChevronDown className="w-8 h-8" strokeWidth={3} />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Start Button */}
            <button 
              onClick={handleStart}
              className="w-full h-14 mb-8 bg-primary text-on-primary rounded-full text-[length:var(--text-headline-md)] font-manrope font-semibold shadow-md active:scale-[0.98] transition-transform flex items-center justify-center gap-2 hover:brightness-110"
            >
              <Play className="w-6 h-6 fill-on-primary" />
              Iniciar Sessão
            </button>


            {/* Toggles */}
            <div className="w-full space-y-3 pb-8">
              <div className="flex items-center justify-between p-4 bg-white/50 border border-outline-variant/30 rounded-2xl">
                <div className="flex items-center gap-3">
                  <Volume2 className="w-5 h-5 text-primary" />
                  <span className="text-[length:var(--text-body-md)] font-inter font-medium text-on-surface">Som da Sessão</span>
                </div>
                <button 
                  onClick={() => setSoundEnabled(!soundEnabled)}
                  className={`w-12 h-6 rounded-full relative flex items-center px-1 transition-colors duration-200 ${soundEnabled ? 'bg-primary' : 'bg-surface-variant'}`}
                >
                  <div className={`w-4 h-4 bg-white rounded-full transition-transform duration-200 shadow-sm ${soundEnabled ? 'translate-x-6' : 'translate-x-0'}`} />
                </button>
              </div>

              <div className="flex items-center justify-between p-4 bg-white/50 border border-outline-variant/30 rounded-2xl">
                <div className="flex items-center gap-3">
                  <BellRing className="w-5 h-5 text-primary" />
                  <span className="text-[length:var(--text-body-md)] font-inter font-medium text-on-surface">Lembretes Inteligentes</span>
                </div>
                <button
                  onClick={() => setRemindersEnabled(!remindersEnabled)}
                  className={`w-12 h-6 rounded-full relative flex items-center px-1 transition-colors duration-200 ${remindersEnabled ? 'bg-primary' : 'bg-surface-variant'}`}
                >
                  <div className={`w-4 h-4 bg-white rounded-full transition-transform duration-200 shadow-sm ${remindersEnabled ? 'translate-x-6' : 'translate-x-0'}`} />
                </button>
              </div>

              {/* Debug: test push notification */}
              <button
                onClick={async () => {
                  const sub = await getPushSubscription();
                  if (!sub) { alert('Sem subscricão push. Verifique a permissão de notificações.'); return; }
                  const res = await fetch(`${SERVER_URL}/api/push/test`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ subscription: sub }),
                  });
                  const data = await res.json();
                  alert(res.ok ? 'Notificação de teste enviada! Aguarde 5 segundos.' : `Erro: ${data.error}`);
                }}
                className="w-full p-3 border border-dashed border-primary/40 rounded-2xl text-[length:var(--text-body-sm)] font-inter text-primary/70 hover:bg-primary/5 active:scale-98 transition-all"
              >
                Testar notificação push (debug)
              </button>
            </div>
          </div>
        ) : (
          /* ACTIVE TIMER VIEW */
          <div className="flex flex-col items-center w-full">
            {/* Main Timer Section */}
            <div className="flex flex-col items-center justify-center py-6 text-center w-full relative">
              <div className="relative w-[280px] h-[280px] md:w-[320px] md:h-[320px] flex items-center justify-center mb-8">
                {/* SVG Progress Ring */}
                <svg className="absolute inset-0 w-full h-full -rotate-90 pointer-events-none" viewBox="0 0 100 100">
                  <circle className="text-surface-container-high" cx="50" cy="50" fill="transparent" r="46" stroke="currentColor" strokeWidth="2" />
                  {/* Active Path calculation */}
                  <circle 
                    className="text-tertiary-container transition-all duration-1000 ease-linear" 
                    cx="50" cy="50" fill="transparent" r="46" stroke="currentColor" 
                    strokeDasharray="289" 
                    strokeDashoffset={289 - (289 * (timeLeft / (setupHours * 3600 + setupMinutes * 60)) || 0)} 
                    strokeLinecap="round" strokeWidth="2" 
                  />
                </svg>
                <div className="z-10 flex flex-col items-center">
                  <span className="text-[length:var(--text-display-timer)] font-manrope text-on-surface font-light leading-none -tracking-[0.02em]">
                    {displayHours > 0 ? `${formatZero(displayHours)}:${formatZero(displayMinutes)}` : `${formatZero(displayMinutes)}:${formatZero(displaySeconds)}`}
                  </span>
                  <p className="text-[length:var(--text-label-caps)] font-inter text-on-surface-variant uppercase font-semibold tracking-widest mt-4">
                    Tempo até a pausa
                  </p>
                </div>
              </div>

              {/* Next alarm indicator */}
              <div className="flex items-center gap-2 bg-surface-container-lowest border border-outline-variant/30 px-5 py-2.5 rounded-full shadow-sm mb-10">
                <AlarmClock className="w-5 h-5 text-on-surface-variant" />
                <span className="text-[length:var(--text-label-sm)] font-inter text-on-surface-variant font-medium">
                  Próximo Alarme às {nextAlarmTime}
                </span>
              </div>

              {/* Action Buttons */}
              <div className="flex gap-4 w-full justify-center px-4">
                <button 
                  onClick={handlePause}
                  className="flex-1 max-w-[150px] bg-secondary-container text-primary h-14 rounded-full text-[length:var(--text-body-md)] font-inter font-semibold flex items-center justify-center gap-2 transition-all hover:brightness-95 active:scale-95"
                >
                  <Pause className={`w-5 h-5 ${!isActive ? 'fill-primary' : ''}`} />
                  {isActive ? 'Pausar' : 'Retomar'}
                </button>
                <button 
                  onClick={handleStop}
                  className="flex-1 max-w-[150px] bg-primary text-on-primary h-14 rounded-full text-[length:var(--text-body-md)] font-inter font-semibold flex items-center justify-center gap-2 shadow-md transition-all hover:brightness-110 active:scale-95"
                >
                   <Square className="w-4 h-4 fill-on-primary" />
                   Parar
                </button>
              </div>
            </div>


          </div>
        )}
      </main>

    </div>
  );
}
