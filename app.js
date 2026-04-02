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
  statusNotif: false, testMode: false,
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
const $clockAmpm   = $('clock-ampm'); // null이면 무시
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
const $testModeTgl     = $('test-mode-toggle');

// ── Runtime state ────────────────────────────────────────────────
let alarmOn  = false;
let testMode = false;
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
  $testModeTgl.addEventListener('change',    onTestModeToggle);

  // populate settings page from saved values
  applyTTSToUI(s);
  $statusNotifTgl.checked = s.statusNotif;
  testMode = s.testMode;
  $testModeTgl.checked = s.testMode;

  await registerSW();
  checkPermissionBanner();
  checkInstallTip();
  populateVoices();
  initGeolocation();
  startWorkerTimer();

  // 홈 가이드 — 첫 방문 시 표시
  setTimeout(() => startGuide('home'), 600);

  if (s.alarmOn) {
    alarmOn = true;
    applyToggleUI(true);
    acquireWakeLock();
    startSilentAudio();
    swSchedule();
    // Worker에 알람 복원 — startWorkerTimer 이후 호출되므로 약간 지연
    setTimeout(() => {
      worker?.postMessage({ type: 'SET_ALARM', enabled: true,
        startHour: s.startHour, endHour: s.endHour, testMode });
    }, 200);
  }
}

// ── Page navigation ───────────────────────────────────────────────
function showPage(page) {
  document.body.classList.toggle('show-settings', page === 'settings');
  // 설정 페이지 가이드 — 전환 애니메이션 끝난 뒤 표시
  if (page === 'settings') {
    setTimeout(() => startGuide('settings'), 420);
  }
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

// ── 일출/일몰 계산 (NOAA 간략 알고리즘 — 오프라인, 외부 API 불필요) ──
// 참고: https://en.wikipedia.org/wiki/Sunrise_equation
const _d2r = Math.PI / 180;
const _sinD = d => Math.sin(d * _d2r);
const _cosD = d => Math.cos(d * _d2r);
const _asinD = x => Math.asin(x) / _d2r;
const _acosD = x => Math.acos(x) / _d2r;

function calcSunTimes(lat, lng, date) {
  // Julian date
  const JD = date.getTime() / 86400000 + 2440587.5;
  // Mean solar noon
  const n      = Math.round(JD - 2451545.0 + 0.0008 - lng / 360);
  const Jstar  = n - lng / 360;
  // Solar mean anomaly (degrees)
  const M      = ((357.5291 + 0.98560028 * Jstar) % 360 + 360) % 360;
  // Equation of the center
  const C      = 1.9148 * _sinD(M) + 0.0200 * _sinD(2 * M) + 0.0003 * _sinD(3 * M);
  // Ecliptic longitude
  const lambda = ((M + C + 180 + 102.9372) % 360 + 360) % 360;
  // Solar transit (Julian date)
  const Jtr    = 2451545.0 + Jstar + 0.0053 * _sinD(M) - 0.0069 * _sinD(2 * lambda);
  // Declination
  const sinDec = _sinD(lambda) * _sinD(23.4397);
  const cosDec = Math.cos(_asinD(sinDec) * _d2r);
  // Hour angle (−0.833° accounts for atmospheric refraction + solar disc)
  const cosOmega = (_sinD(-0.833) - _sinD(lat) * sinDec) / (_cosD(lat) * cosDec);

  if (cosOmega < -1) return null; // 극야 — 해 없음 (항상 밤)
  if (cosOmega >  1) return null; // 백야 — 해 짐 없음 (항상 낮)

  const omega  = _acosD(cosOmega);
  const toDate = jd => new Date((jd - 2440587.5) * 86400000);
  return {
    sunrise: toDate(Jtr - omega / 360),
    sunset:  toDate(Jtr + omega / 360),
  };
}

// ── 위치 기반 주간/야간 판별 ─────────────────────────────────────
let sunTimes = null;      // { sunrise: Date, sunset: Date }
let sunTimesDate = '';    // 마지막 계산 날짜 (YYYY-MM-DD)
let geoCoords = null;     // { lat, lng }

function isDaytime(now) {
  // 위치를 아직 모르면 오전 6시~오후 8시를 낮으로 간주 (임시)
  if (!sunTimes) return now.getHours() >= 6 && now.getHours() < 20;
  return now >= sunTimes.sunrise && now < sunTimes.sunset;
}

function refreshSunTimes(now) {
  if (!geoCoords) return;
  const dateKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
  if (dateKey === sunTimesDate) return; // 오늘 이미 계산함
  sunTimesDate = dateKey;
  sunTimes = calcSunTimes(geoCoords.lat, geoCoords.lng, now);
}

async function initGeolocation() {
  // localStorage에 캐시된 좌표 먼저 사용
  try {
    const cached = JSON.parse(localStorage.getItem('ocb_geo') || 'null');
    if (cached) { geoCoords = cached; refreshSunTimes(new Date()); }
  } catch {}

  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    pos => {
      geoCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      localStorage.setItem('ocb_geo', JSON.stringify(geoCoords));
      sunTimesDate = ''; // 재계산 강제
      refreshSunTimes(new Date());
    },
    () => { /* 권한 거부 — 임시 로직 유지 */ },
    { timeout: 8000, maximumAge: 6 * 60 * 60 * 1000 } // 6시간 캐시
  );
}

// ── Clock render ──────────────────────────────────────────────────
function renderClock(now) {
  const h = now.getHours(), m = now.getMinutes();
  const disp = h === 0 ? 12 : h > 12 ? h - 12 : h;
  $clockH.textContent    = String(disp).padStart(2, '0');
  $clockM.textContent    = String(m).padStart(2, '0');
  if ($clockAmpm) $clockAmpm.textContent = h < 12 ? '오전' : '오후';
  const days = ['일','월','화','수','목','금','토'];
  $clockDate.textContent =
    `${now.getFullYear()}. ${now.getMonth()+1}. ${now.getDate()}. (${days[now.getDay()]})`;

  // 날짜 바뀌면 일출/일몰 재계산
  refreshSunTimes(now);
  // 실제 햇빛 기준 낮/밤 전환
  document.querySelector('.clock-card').classList.toggle('am', isDaytime(now));
}

// ── Alarm fire ────────────────────────────────────────────────────
function fireAlarm(h) {
  speak(HOUR_KO[h]);
  showToast(HOUR_KO[h]);
  animateBell();
  navigator.vibrate?.(300);  // 진동 모드일 때 한 번 진동
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
    worker?.postMessage({ type: 'SET_ALARM', enabled: true, startHour, endHour, testMode });
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
  const h = now.getHours();

  if (testMode) {
    if (!inRange(h, startHour, endHour)) {
      $nextText.textContent = '범위 내 알람 없음';
      return;
    }
    const sec = 60 - now.getSeconds();
    $nextText.textContent = `[테스트] ${sec}초 후 · ${HOUR_KO[h]}`;
    return;
  }

  const m = now.getMinutes();
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
  const base = Date.now();
  const alarms = [];
  const slots  = testMode ? 24 : 24;      // 24 entries either way
  for (let d = 1; d <= slots; d++) {
    const t = new Date();
    if (testMode) t.setMinutes(t.getMinutes() + d, 0, 0);
    else          t.setHours(t.getHours() + d, 0, 0, 0);
    const nh = t.getHours();
    if (!inRange(nh, startHour, endHour)) continue;
    alarms.push({ delay: t.getTime() - base, hour: nh, label: HOUR_KO[nh] });
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

function onTestModeToggle() {
  testMode = $testModeTgl.checked;
  saveSettings({ testMode });
  worker?.postMessage({ type: 'TEST_MODE', enabled: testMode });
  if (alarmOn) {
    swSchedule();
    renderNextAlarm();
  }
  showToast(testMode ? '테스트 모드 켜짐 (1분 간격)' : '테스트 모드 꺼짐');
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

// ══════════════════════════════════════════════════════════════
// GUIDE SYSTEM
// ══════════════════════════════════════════════════════════════

const GUIDE_STEPS = {
  home: [
    {
      target:  '.clock-card',
      tag:     '시계',
      title:   '낮/밤 테마 자동 전환',
      desc:    '위치 정보를 기반으로 실제 일출·일몰 시간에 맞춰 밝은 낮 테마와 어두운 밤 테마로 자동 전환돼요.',
    },
    {
      target:  '.range-row',
      tag:     '알람 범위',
      title:   '알람 시간 범위 설정',
      desc:    '시작 시간과 종료 시간을 설정하면, 그 범위 안의 정시에만 알람이 울려요.',
    },
    {
      target:  '#toggle-btn',
      tag:     '알람',
      title:   '알람 켜기 / 끄기',
      desc:    '버튼을 탭하면 알람이 켜져요. 켜진 상태에서 매 정시마다 한국어로 시각을 알려줘요.',
    },
    {
      target:  '#settings-btn',
      tag:     '설정',
      title:   'TTS & 알림 설정',
      desc:    '목소리·음높이·속도·음량을 조절하고, 알림창에 알람 상태를 표시할 수 있어요.',
    },
  ],
  settings: [
    {
      target:  '.card:has(#status-notif-toggle)',
      tag:     '알림',
      title:   '상태 알림 표시',
      desc:    '켜두면 알림창에 알람 켜짐/꺼짐 상태와 다음 알람 시각이 항상 표시돼요.',
    },
    {
      target:  '#voice-select',
      tag:     '목소리',
      title:   '목소리 선택',
      desc:    '디바이스에 설치된 한국어 음성 중 원하는 목소리를 고를 수 있어요.',
    },
    {
      target:  '.card:has(#pitch-slider)',
      tag:     '음성 조절',
      title:   '음높이 · 속도 · 음량',
      desc:    '슬라이더로 음높이(Pitch), 말하기 속도(Rate), 음량(Volume)을 자유롭게 조절하세요.',
    },
    {
      target:  '#test-btn',
      tag:     '테스트',
      title:   '목소리 테스트',
      desc:    '버튼을 탭하면 현재 설정으로 즉시 발화해요. 알람을 켜기 전에 미리 확인해보세요.',
    },
  ],
};

const $guideOverlay  = document.getElementById('guide-overlay');
const $guideSpot     = document.getElementById('guide-spotlight');
const $guideTip      = document.getElementById('guide-tooltip');
const $guideStepBadge= document.getElementById('guide-step-badge');
const $guideTag      = document.getElementById('guide-tag');
const $guideTitle    = document.getElementById('guide-title');
const $guideDesc     = document.getElementById('guide-desc');
const $guidePrev     = document.getElementById('guide-prev');
const $guideNext     = document.getElementById('guide-next');
const $guideNever    = document.getElementById('guide-never');

let guideContext = null;  // 'home' | 'settings'
let guideStep    = 0;

function shouldShowGuide(ctx) {
  return !localStorage.getItem(`ocb_guide_${ctx}`);
}

function startGuide(ctx) {
  if (!shouldShowGuide(ctx)) return;
  guideContext = ctx;
  guideStep    = 0;
  $guideNever.checked = false;
  $guideOverlay.classList.add('active');
  renderGuideStep();
}

function renderGuideStep() {
  const steps = GUIDE_STEPS[guideContext];
  const step  = steps[guideStep];
  const total = steps.length;

  // content
  $guideStepBadge.textContent = `${guideStep + 1} / ${total}`;
  $guideTag.textContent       = step.tag;
  $guideTitle.textContent     = step.title;
  $guideDesc.textContent      = step.desc;
  $guidePrev.disabled         = guideStep === 0;
  $guideNext.textContent      = guideStep === total - 1 ? '시작하기 🎉' : '다음';

  // find target element (may be in the currently visible view)
  const targetEl = document.querySelector(step.target);
  if (!targetEl) { advanceGuide(1); return; }  // skip if not in DOM

  positionGuide(targetEl);
}

function positionGuide(el) {
  const GAP    = 8;
  const MARGIN = 16;
  const r      = el.getBoundingClientRect();
  const vw     = window.innerWidth;
  const vh     = window.innerHeight;

  // ── 스포트라이트 ───────────────────────────────────────────────
  $guideSpot.style.top    = `${r.top    - GAP}px`;
  $guideSpot.style.left   = `${r.left   - GAP}px`;
  $guideSpot.style.width  = `${r.width  + GAP * 2}px`;
  $guideSpot.style.height = `${r.height + GAP * 2}px`;

  // ── 툴팁 가로 위치: 항상 화면 중앙 정렬 ─────────────────────────
  const tipW = Math.min(300, vw - MARGIN * 2);
  const left = (vw - tipW) / 2;
  $guideTip.style.width = `${tipW}px`;
  $guideTip.style.left  = `${left}px`;

  // ── 툴팁 세로 위치: 아래 공간 우선 → 위 → 화면 중앙 ────────────
  const BELOW_GAP = r.bottom + GAP + 12;
  const tipH = 220; // 예상 높이 (충분한 여유)

  $guideTip.classList.remove('arrow-top', 'arrow-bottom', 'arrow-none');

  let top;
  if (BELOW_GAP + tipH < vh - MARGIN) {
    top = BELOW_GAP;
    $guideTip.classList.add('arrow-top');
  } else if (r.top - GAP - 12 - tipH > MARGIN) {
    top = r.top - GAP - 12 - tipH;
    $guideTip.classList.add('arrow-bottom');
  } else {
    top = Math.max(MARGIN, (vh - tipH) / 2);
    $guideTip.classList.add('arrow-none');
  }
  $guideTip.style.top = `${top}px`;

  // ── 화살표: 타겟 중심 X에 맞춰 동적 계산 ───────────────────────
  // 타겟 중심 X → 툴팁 기준 상대 위치로 변환
  const targetCenterX = r.left + r.width / 2;
  const arrowLeft = Math.max(16, Math.min(targetCenterX - left - 6, tipW - 28));
  $guideTip.style.setProperty('--arrow-left', `${arrowLeft}px`);

  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function advanceGuide(dir) {
  const steps = GUIDE_STEPS[guideContext];
  guideStep += dir;
  if (guideStep < 0) guideStep = 0;
  if (guideStep >= steps.length) {
    closeGuide();
    return;
  }
  renderGuideStep();
}

function closeGuide() {
  if ($guideNever.checked) {
    localStorage.setItem(`ocb_guide_${guideContext}`, '1');
  }
  $guideOverlay.classList.remove('active');
  guideContext = null;
}

$guidePrev.addEventListener('click', () => advanceGuide(-1));
$guideNext.addEventListener('click', () => advanceGuide(1));

// close on backdrop tap (outside spotlight/tooltip)
$guideOverlay.addEventListener('click', e => {
  if (e.target === $guideOverlay) closeGuide();
});

// recalculate position on resize
window.addEventListener('resize', () => {
  if (!guideContext) return;
  const step = GUIDE_STEPS[guideContext][guideStep];
  const el   = document.querySelector(step.target);
  if (el) positionGuide(el);
});

init();
