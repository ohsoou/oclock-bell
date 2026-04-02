const CACHE = 'oclock-v20';
const ASSETS = ['./', './index.html', './style.css', './app.js',
                './timer.worker.js', './manifest.json', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks =>
      Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(r => r || fetch(e.request)));
});

// ── 백그라운드 알람 스케줄 ─────────────────────────────────────
// TimestampTrigger 지원 여부에 따라 두 가지 전략 사용:
//   ① TimestampTrigger (Chrome Android) — SW가 종료돼도 OS가 알림 발생
//   ② setTimeout 폴백                  — SW가 살아있는 동안만 작동
const hasTrigger = typeof TimestampTrigger !== 'undefined';
const timers = [];   // ② 폴백용 타이머 ID 목록
const RETRY_LIMIT = 2;

// 예약된 트리거 알람 태그 접두사
const TRIGGER_PREFIX = 'scheduled-alarm-';

async function cancelTriggerAlarms() {
  try {
    const ns = await self.registration.getNotifications({ includeTriggered: true });
    ns.filter(n => n.tag?.startsWith(TRIGGER_PREFIX)).forEach(n => n.close());
  } catch { /* includeTriggered 미지원 환경 — 무시 */ }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function showNotificationWithRetry(title, options, attempt = 0) {
  try {
    await self.registration.showNotification(title, options);
  } catch (err) {
    if (attempt >= RETRY_LIMIT) throw err;
    await wait(600 * (attempt + 1));
    return showNotificationWithRetry(title, options, attempt + 1);
  }
}

self.addEventListener('message', e => {
  if (!e.data) return;

  if (e.data.type === 'SCHEDULE') {
    // ── 기존 예약 전부 취소 ──────────────────────────────────────
    timers.forEach(id => clearTimeout(id));
    timers.length = 0;

    const alarms = (e.data.alarms || []).filter(
      a => a.delay > 0 && a.delay < 24 * 60 * 60 * 1000
    );

    if (hasTrigger) {
      // ① TimestampTrigger: OS가 직접 관리 → 앱 종료 후에도 동작
      cancelTriggerAlarms().then(() => {
        alarms.forEach(a => {
          showNotificationWithRetry('정시 알람 🔔', {
            body:               a.label,
            tag:                a.tag || `${TRIGGER_PREFIX}${a.hour}`,
            showTrigger:        new TimestampTrigger(Date.now() + a.delay),
            renotify:           true,
            requireInteraction: false,
            icon:               './icon.svg',
            badge:              './icon.svg',
          });
        });
      });
    } else {
      // ② 폴백: SW 내 setTimeout (SW가 살아있는 동안만 작동)
      alarms.forEach(a => {
        const id = setTimeout(() => {
          showNotificationWithRetry('정시 알람 🔔', {
            body:               a.label,
            tag:                a.tag || `${TRIGGER_PREFIX}${a.hour}`,
            renotify:           true,
            requireInteraction: false,
          });
        }, a.delay);
        timers.push(id);
      });
    }
  }

  if (e.data.type === 'CANCEL') {
    timers.forEach(id => clearTimeout(id));
    timers.length = 0;
    if (hasTrigger) cancelTriggerAlarms();
  }

  if (e.data.type === 'STATUS_NOTIF') {
    if (!e.data.show) {
      self.registration.getNotifications({ tag: 'alarm-status' })
        .then(ns => ns.forEach(n => n.close()));
      return;
    }
    showNotificationWithRetry(e.data.title, {
      body:               e.data.body,
      tag:                'alarm-status',
      renotify:           false,
      silent:             true,
      requireInteraction: false,
      icon:               './icon.svg',
      badge:              './icon.svg',
    });
  }
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => list.length ? list[0].focus() : clients.openWindow('./'))
  );
});
