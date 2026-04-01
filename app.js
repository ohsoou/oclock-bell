'use strict';

// ── 한국어 시각 맵 ──────────────────────────────────────────────
const HOUR_KO = [
  '자정이에요~', '한시!',   '두시!',   '세시!',
  '네시!',       '다섯시!', '여섯시!', '일곱시!',
  '여덟시!',     '아홉시!', '열시!',   '열한시!',
  '열두시!',     '한시!',   '두시!',   '세시!',
  '네시!',       '다섯시!', '여섯시!', '일곱시!',
  '여덟시!',     '아홉시!', '열시!',   '열한시!',
];

// ── 설정 ─────────────────────────────────────────────────────────
const DEFAULTS = {
  startHour: 8, endHour: 22, alarmOn: false,
  pitch: 1.5, rate: 0.80, volume: 1.0, voiceURI: '',
  statusNotif: false,
};

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('ocb') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings(patch) {
  localStorage.setItem('ocb', JSON.stringify({ ...loadSettings(), ...patch }));
}

// ── DOM ──────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// main
const $clockH      = $('clock-h');
const $clockM      = $('clock-m');
const $clockAmpm   = $('clock-ampm');
const $clockDate   = $('clock-date');
const $startSel    = $('start-hour');
const $endSel      = $('end-hour');
const $toggleBtn   = $('toggle-btn');
const $toggleLabel = $('toggle-label');
const $toggleIcon  = $('toggle-icon');
const $statusLabel = $('status-label');
const $statusDot   = $('status-dot');
const $nextCard    = $('next-card');
const $nextText    = $('next-text');
const $toastWrap   = $('toast');
const $toastMsg    = $('toast-msg');
const $permBanner  = $('perm-banner');
const $permBtn     = $('perm-btn');
const $installTip  = $('install-tip');
const $settingsBtn = $('settings-btn');

// settings page
const $backBtn      = $('back-btn');
const $voiceSel     = $('voice-select');
const $pitchSlider  = $('pitch-slider');
const $rateSlider   = $('rate-slider');
const $volumeSlider = $('volume-slider');
const $pitchValue   = $('pitch-value');
const $rateValue    = $('rate-value');
const $volumeValue  = $('volume-value');
const $testBtn      = $('test-btn');
const $testIcon     = $('test-icon');
const $testLabel    = $('test-label');
const $resetBtn        = $('reset-btn');
const $statusNotifTgl  = $('status-notif-toggle');

// ── Runtime state ────────────────────────────────────────────────
let alarmOn  = false;
let wakeLock = null;
let audioCtx = null;
let worker   = null;

// ── Init ─────────────────────────────────────────────────────────
async function init() {
  const s = loadSettings();

  buildHourOptions($startSel, s.startHour);
  buildHourOptions($endSel,   s.endHour);

  // main listeners
  $startSel.addEventListener('change', onRangeChange);
  $endSel.addEventListener('change',   onRangeChange);
  $toggleBtn.addEventListener('click', onToggle);
  $permBtn.addEventListener('click',   askNotificationPermission);
  $settingsBtn.addEventListener('click', () => showPage('settings'));

  // settings listeners
  $backBtn.addEventListener('click',     () => showPage('main'));
  $pitchSlider.addEventListener('input',  onSliderChange);
  $rateSlider.addEventListener('input',   onSliderChange);
  $volumeSlider.addEventListener('input', onSliderChange);
  $voiceSel.addEventListener('change',    onVoiceChange);
  $testBtn.addEventListener('click',         onTestVoice);
  $resetBtn.addEventListener('click',        onResetTTS);
  $statusNotifTgl.addEventListener('change', onStatusNotifToggle);

  // populate settings page from saved values
  applyTTSToUI(s);
  $statusNotifTgl.checked = s.statusNotif;

  await registerSW();
  checkPermissionBanner();
  checkInstallTip();
  populateVoices();
  startWorkerTimer();

  if (s.alarmOn) {
    alarmOn = true;
    applyToggleUI(true);
    acquireWakeLock();
    startSilentAudio();
    swSchedule();
    // Worker에 알람 복원 — startWorkerTimer 이후 호출되므로 약간 지연
    setTimeout(() => {
      worker?.postMessage({ type: 'SET_ALARM', enabled: true,
        startHour: s.startHour, endHour: s.endHour });
    }, 200);
  }
}

// ── Page navigation ───────────────────────────────────────────────
function showPage(page) {
  document.body.classList.toggle('show-settings', page === 'settings');
}

// ── Hour selects ──────────────────────────────────────────────────
function buildHourOptions(sel, selected) {
  for (let h = 0; h < 24; h++) {
    const ampm  = h < 12 ? '오전' : '오후';
    const label = h === 0   ? '오전 12시'
                : h === 12  ? '오후 12시'
                : `${ampm} ${h > 12 ? h - 12 : h}시`;
    sel.appendChild(Object.assign(document.createElement('option'),
      { value: h, textContent: label, selected: h === selected }));
  }
}

// ── Web Worker timer ──────────────────────────────────────────────
let ntpSynced = false;

function startWorkerTimer() {
  if (typeof Worker !== 'undefined') {
    worker = new Worker('./timer.worker.js');
    worker.onmessage = onWorkerMessage;
    worker.postMessage({ type: 'START' });

    // 1시간마다 NTP 재동기화
    setInterval(() => worker.postMessage({ type: 'RESYNC' }), 60 * 60 * 1000);
  } else {
    // Worker 미지원 폴백: performance.now() 기반 드리프트 보정 틱
    (function fallbackTick() {
      const ms = 1000 - (Date.now() % 1000);
      setTimeout(() => { onTick(Date.now()); fallbackTick(); }, ms);
    })();
  }
}

function onWorkerMessage(e) {
  const { type } = e.data;

  if (type === 'TICK') {
    onTick(e.data.ts);
  }

  if (type === 'ALARM') {
    // Worker가 정시를 직접 감지해서 알림 — 폴링 없이 정밀 발화
    if (alarmOn) fireAlarm(e.data.hour);
  }

  if (type === 'NTP_SYNCED') {
    ntpSynced = true;
    showNtpStatus(`NTP 동기화 완료 (±${Math.round(e.data.rtt / 2)}ms)`);
  }

  if (type === 'NTP_FAILED') {
    showNtpStatus('NTP 실패 — 시스템 시계 사용 중');
  }
}

// ── Tick (UI 전용 — 시계 표시만) ────────────────────────────────
function onTick(ts) {
  renderClock(new Date(ts));
  if (alarmOn) renderNextAlarm();
}

function inRange(h, start, end) {
  return start <= end ? (h >= start && h < end) : (h >= start || h < end);
}

// ── NTP 상태 표시 ─────────────────────────────────────────────────
let ntpStatusTimer = null;
function showNtpStatus(msg) {
  const el = document.getElementById('ntp-status');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(ntpStatusTimer);
  ntpStatusTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

// ── Clock render ──────────────────────────────────────────────────
function renderClock(now) {
  const h = now.getHours(), m = now.getMinutes();
  const isAM = h < 12;
  const disp = h === 0 ? 12 : h > 12 ? h - 12 : h;
  $clockH.textContent    = String(disp).padStart(2, '0');
  $clockM.textContent    = String(m).padStart(2, '0');
  $clockAmpm.textContent = isAM ? '오전' : '오후';
  const days = ['일','월','화','수','목','금','토'];
  $clockDate.textContent =
    `${now.getFullYear()}. ${now.getMonth()+1}. ${now.getDate()}. (${days[now.getDay()]})`;
  document.querySelector('.clock-card').classList.toggle('am', isAM);
}

// ── Alarm fire ────────────────────────────────────────────────────
function fireAlarm(h) {
  speak(HOUR_KO[h]);
  showToast(HOUR_KO[h]);
  animateBell();
  // 정시 후 "다음 알람" 갱신
  setTimeout(updateStatusNotification, 2000);
}

// ── TTS speak ────────────────────────────────────────────────────
function speak(text) {
  if (!window.speechSynthesis) return;
  speechSynthesis.cancel();
  const s = loadSettings();
  const u = new SpeechSynthesisUtterance(text);
  u.lang   = 'ko-KR';
  u.pitch  = s.pitch;
  u.rate   = s.rate;
  u.volume = s.volume;
  if (s.voiceURI) {
    const v = speechSynthesis.getVoices().find(v => v.voiceURI === s.voiceURI);
    if (v) u.voice = v;
  } else {
    const ko = speechSynthesis.getVoices().find(v => v.lang.startsWith('ko'));
    if (ko) u.voice = ko;
  }
  speechSynthesis.speak(u);
}

if (window.speechSynthesis) {
  speechSynthesis.onvoiceschanged = populateVoices;
}

// ── Voice list ────────────────────────────────────────────────────
function populateVoices() {
  const voices   = speechSynthesis.getVoices();
  if (!voices.length) return;

  const saved    = loadSettings().voiceURI;
  const koVoices = voices.filter(v => v.lang.startsWith('ko'));
  const others   = voices.filter(v => !v.lang.startsWith('ko'));

  // clear existing options except first (auto)
  while ($voiceSel.options.length > 1) $voiceSel.remove(1);

  if (koVoices.length) {
    const grp = document.createElement('optgroup');
    grp.label = '한국어';
    koVoices.forEach(v => {
      grp.appendChild(Object.assign(document.createElement('option'), {
        value: v.voiceURI,
        textContent: `${v.name}${v.localService ? '' : ' ☁'}`,
        selected: v.voiceURI === saved,
      }));
    });
    $voiceSel.appendChild(grp);
  }

  if (others.length) {
    const grp = document.createElement('optgroup');
    grp.label = '기타 언어';
    others.forEach(v => {
      grp.appendChild(Object.assign(document.createElement('option'), {
        value: v.voiceURI,
        textContent: `${v.name} (${v.lang})`,
        selected: v.voiceURI === saved,
      }));
    });
    $voiceSel.appendChild(grp);
  }
}

// ── Settings page: sliders ────────────────────────────────────────
function applyTTSToUI(s) {
  $pitchSlider.value  = s.pitch;
  $rateSlider.value   = s.rate;
  $volumeSlider.value = s.volume;
  updateSliderDisplay($pitchSlider,  $pitchValue,  s.pitch);
  updateSliderDisplay($rateSlider,   $rateValue,   s.rate);
  updateSliderDisplay($volumeSlider, $volumeValue, s.volume);
}

function updateSliderDisplay(input, label, val) {
  label.textContent = parseFloat(val).toFixed(1);
  // fill track with purple up to thumb position
  const min = +input.min, max = +input.max;
  const pct = ((val - min) / (max - min)) * 100;
  input.style.background =
    `linear-gradient(to right, var(--purple) ${pct}%, var(--border) ${pct}%)`;
}

function onSliderChange(e) {
  const map = {
    'pitch-slider':  ['pitch',  $pitchValue],
    'rate-slider':   ['rate',   $rateValue],
    'volume-slider': ['volume', $volumeValue],
  };
  const [key, label] = map[e.target.id];
  const val = +e.target.value;
  updateSliderDisplay(e.target, label, val);
  saveSettings({ [key]: val });
}

function onVoiceChange() {
  saveSettings({ voiceURI: $voiceSel.value });
}

function onResetTTS() {
  const d = { pitch: DEFAULTS.pitch, rate: DEFAULTS.rate, volume: DEFAULTS.volume, voiceURI: '' };
  saveSettings(d);
  applyTTSToUI({ ...DEFAULTS });
  $voiceSel.value = '';
}

// ── Test voice ────────────────────────────────────────────────────
function onTestVoice() {
  const h = new Date().getHours();
  speak(HOUR_KO[h]);
  showToast(HOUR_KO[h]);
  animateBell();

  $testBtn.disabled = true;
  $testBtn.classList.add('playing');
  $testIcon.textContent  = '🔊';
  $testLabel.textContent = '재생 중...';

  setTimeout(() => {
    $testBtn.disabled = false;
    $testBtn.classList.remove('playing');
    $testIcon.textContent  = '🔊';
    $testLabel.textContent = '목소리 테스트';
  }, 2500);
}

// ── Toast ─────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(label) {
  $toastMsg.textContent = label;
  $toastWrap.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $toastWrap.classList.remove('show'), 3200);
}

// ── Bell animation ────────────────────────────────────────────────
function animateBell() {
  const el = document.querySelector('.bell-icon');
  if (!el) return;
  el.classList.remove('ring');
  void el.offsetWidth;
  el.classList.add('ring');
}

// ── Toggle ────────────────────────────────────────────────────────
function onToggle() {
  alarmOn = !alarmOn;
  saveSettings({ alarmOn });
  applyToggleUI(alarmOn);

  const { startHour, endHour } = loadSettings();

  if (alarmOn) {
    acquireWakeLock();
    startSilentAudio();
    swSchedule();
    renderNextAlarm();
    // Worker에 알람 활성화 및 범위 전달
    worker?.postMessage({ type: 'SET_ALARM', enabled: true, startHour, endHour });
  } else {
    releaseWakeLock();
    stopSilentAudio();
    swCancel();
    $nextCard.classList.remove('show');
    worker?.postMessage({ type: 'SET_ALARM', enabled: false });
  }
  updateStatusNotification();
}

function applyToggleUI(on) {
  $toggleBtn.classList.toggle('on', on);
  $toggleBtn.classList.toggle('off', !on);
  $toggleLabel.textContent = on ? '알람 끄기' : '알람 켜기';
  $toggleIcon.textContent  = on ? '🔔' : '🔕';
  $statusLabel.textContent = on ? '켜짐' : '꺼짐';
  $statusDot.classList.toggle('active', on);
  document.querySelector('.status-pill').classList.toggle('active', on);
  document.querySelector('.bell-icon').classList.toggle('active', on);
  if (on) $nextCard.classList.add('show');
}

function onRangeChange() {
  const startHour = +$startSel.value, endHour = +$endSel.value;
  saveSettings({ startHour, endHour });
  if (alarmOn) {
    swSchedule();
    renderNextAlarm();
    worker?.postMessage({ type: 'UPDATE_RANGE', startHour, endHour });
  }
  updateStatusNotification();
}

// ── Next alarm ────────────────────────────────────────────────────
function renderNextAlarm() {
  const { startHour, endHour } = loadSettings();
  const now = new Date();
  const h = now.getHours(), m = now.getMinutes();

  for (let d = 1; d <= 24; d++) {
    const nh = (h + d) % 24;
    if (!inRange(nh, startHour, endHour)) continue;
    const rem = d * 60 - m;
    const rh = Math.floor(rem / 60), rm = rem % 60;
    const t = rh > 0 ? `${rh}시간 ${rm > 0 ? rm+'분 ' : ''}후` : `${rm}분 후`;
    $nextText.textContent = `${t} · ${HOUR_KO[nh]}`;
    return;
  }
  $nextText.textContent = '범위 내 알람 없음';
}

// ── Wake Lock ─────────────────────────────────────────────────────
async function acquireWakeLock() {
  if (!navigator.wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
function releaseWakeLock() { wakeLock?.release(); wakeLock = null; }

// ── Silent AudioContext ───────────────────────────────────────────
function startSilentAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const buf = audioCtx.createBuffer(1, audioCtx.sampleRate * 0.1, audioCtx.sampleRate);
    (function loop() {
      if (!audioCtx) return;
      const src = audioCtx.createBufferSource();
      src.buffer = buf;
      src.connect(audioCtx.destination);
      src.onended = () => setTimeout(loop, 10000);
      src.start();
    })();
  } catch {}
}
function stopSilentAudio() { audioCtx?.close(); audioCtx = null; }

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && alarmOn) { acquireWakeLock(); swSchedule(); }
  if (document.visibilityState === 'hidden'  && alarmOn) { swSchedule(); }
});

// ── Service Worker ────────────────────────────────────────────────
function swSchedule() {
  if (!navigator.serviceWorker?.controller) return;
  const { startHour, endHour } = loadSettings();
  const now = Date.now();
  const alarms = [];
  for (let d = 1; d <= 24; d++) {
    const t = new Date(); t.setHours(t.getHours() + d, 0, 0, 0);
    const nh = t.getHours();
    if (!inRange(nh, startHour, endHour)) continue;
    alarms.push({ delay: t.getTime() - now, hour: nh, label: HOUR_KO[nh] });
  }
  navigator.serviceWorker.controller.postMessage({ type: 'SCHEDULE', alarms });
}
function swCancel() {
  navigator.serviceWorker?.controller?.postMessage({ type: 'CANCEL' });
}

// ── 상태 알림 (영구 알림창 표시) ─────────────────────────────────
function onStatusNotifToggle() {
  const enabled = $statusNotifTgl.checked;
  saveSettings({ statusNotif: enabled });

  if (enabled) {
    // 알림 권한 확인 후 표시
    Notification.requestPermission().then(r => {
      if (r === 'granted') {
        $permBanner.classList.add('hidden');
        updateStatusNotification();
      } else {
        // 권한 거부 시 토글 되돌리기
        $statusNotifTgl.checked = false;
        saveSettings({ statusNotif: false });
        $permBanner.classList.remove('hidden');
      }
    });
  } else {
    dismissStatusNotification();
  }
}

function updateStatusNotification() {
  const s = loadSettings();
  if (!s.statusNotif) return;
  if (!navigator.serviceWorker?.controller) return;
  if (Notification.permission !== 'granted') return;

  const { startHour, endHour } = s;
  const startLabel = hourLabel(startHour);
  const endLabel   = hourLabel(endHour);

  // 다음 알람 계산
  let nextText = '';
  if (alarmOn) {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    for (let d = 1; d <= 24; d++) {
      const nh = (h + d) % 24;
      if (!inRange(nh, startHour, endHour)) continue;
      const rem = d * 60 - m;
      const rh = Math.floor(rem / 60), rm = rem % 60;
      const t = rh > 0 ? `${rh}시간 ${rm > 0 ? rm + '분 ' : ''}후` : `${rm}분 후`;
      nextText = ` · 다음: ${HOUR_KO[nh]} (${t})`;
      break;
    }
  }

  navigator.serviceWorker.controller.postMessage({
    type: 'STATUS_NOTIF',
    show: true,
    title: alarmOn ? '🔔 정시 알람 켜짐' : '🔕 정시 알람 꺼짐',
    body:  alarmOn
      ? `${startLabel} ~ ${endLabel}${nextText}`
      : '알람이 꺼져 있어요',
  });
}

function dismissStatusNotification() {
  navigator.serviceWorker?.controller?.postMessage({ type: 'STATUS_NOTIF', show: false });
}

function hourLabel(h) {
  const ampm = h < 12 ? '오전' : '오후';
  const disp = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${ampm} ${disp}시`;
}

async function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  try { await navigator.serviceWorker.register('./sw.js'); } catch {}
}

// ── Notification permission ───────────────────────────────────────
function checkPermissionBanner() {
  if (!('Notification' in window) || Notification.permission === 'granted')
    $permBanner.classList.add('hidden');
  else
    $permBanner.classList.remove('hidden');
}
async function askNotificationPermission() {
  const r = await Notification.requestPermission();
  if (r === 'granted') { $permBanner.classList.add('hidden'); if (alarmOn) swSchedule(); }
}

// ── PWA install tip ───────────────────────────────────────────────
function checkInstallTip() {
  if (window.matchMedia('(display-mode: standalone)').matches)
    $installTip.classList.add('hidden');
}

init();
