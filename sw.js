const CACHE = 'oclock-v14';
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
// 페이지에서 받은 alarms 배열로 setTimeout 예약
// SW는 언제든 종료될 수 있으므로, 페이지가 백그라운드로 갈 때마다 재예약
const timers = [];

self.addEventListener('message', e => {
  if (!e.data) return;

  if (e.data.type === 'SCHEDULE') {
    timers.forEach(id => clearTimeout(id));
    timers.length = 0;

    (e.data.alarms || []).forEach(a => {
      if (a.delay > 0 && a.delay < 24 * 60 * 60 * 1000) {
        const id = setTimeout(() => {
          self.registration.showNotification('정시 알람 🔔', {
            body: a.label,
            tag:  `alarm-${a.hour}`,
            renotify: true,
            requireInteraction: false,
          });
        }, a.delay);
        timers.push(id);
      }
    });
  }

  if (e.data.type === 'CANCEL') {
    timers.forEach(id => clearTimeout(id));
    timers.length = 0;
  }

  if (e.data.type === 'STATUS_NOTIF') {
    if (!e.data.show) {
      // 상태 알림 닫기
      self.registration.getNotifications({ tag: 'alarm-status' })
        .then(ns => ns.forEach(n => n.close()));
      return;
    }
    self.registration.showNotification(e.data.title, {
      body:              e.data.body,
      tag:               'alarm-status',   // 같은 tag → 기존 알림 교체
      renotify:          false,            // 교체 시 소리/진동 없음
      silent:            true,
      requireInteraction: false,
      icon:              './icon.svg',
      badge:             './icon.svg',
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
