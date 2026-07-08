// ── Timer Worker ──────────────────────────────────────────────────
// 전략:
//  1. NTP API로 서버 시간 가져와 시계 오프셋(ntpOffset) 계산
//  2. performance.now()를 기준으로 경과 시간 추적 (드리프트 없음)
//  3. 보정된 시간 = Date.now() + ntpOffset
//  4. setInterval 폴링 대신 2단계(coarse→fine) 자기보정 setTimeout으로
//     다음 정시를 정밀 예약 — 긴 타이머의 스로틀/드리프트 영향을 줄인다
//  5. UI 업데이트용 1초 틱은 별도로 유지
importScripts('./constants.js', './time-utils.js');

// NTP 동기화 서버 목록 (순서대로 시도)
const NTP_APIS = [
  'https://worldtimeapi.org/api/ip',
  'https://timeapi.io/api/time/current/zone?timeZone=Asia%2FSeoul',
];

let ntpOffset    = 0;      // ms — 시스템 시계 보정값
let ntpSynced    = false;
let alarmEnabled = false;
let startHour    = OCB.DEFAULT_START_HOUR;
let endHour      = OCB.DEFAULT_END_HOUR;
let testMode     = false;  // true → 1분 간격 (테스트용)
let alarmTimer   = null;
let tickTimer    = null;

// ── NTP 동기화 ────────────────────────────────────────────────────
async function syncNTP() {
  for (const url of NTP_APIS) {
    try {
      const t0  = performance.now();
      const res = await fetch(url, { cache: 'no-store' });
      const t1  = performance.now();
      const rtt = t1 - t0;

      const data      = await res.json();
      // worldtimeapi: data.unixtime (seconds), timeapi: data.dateTime (ISO string)
      const serverMs  = data.unixtime
        ? data.unixtime * 1000
        : new Date(data.dateTime).getTime();

      // 응답 도착 시점 기준으로 서버 시간 추정 (RTT 절반 보정)
      const estimated = serverMs + rtt / 2;
      ntpOffset       = estimated - Date.now();
      ntpSynced       = true;

      self.postMessage({ type: 'NTP_SYNCED', offset: ntpOffset, rtt: Math.round(rtt) });
      return;
    } catch { /* 다음 서버 시도 */ }
  }
  // 모든 서버 실패 — 시스템 시계 그대로 사용
  self.postMessage({ type: 'NTP_FAILED' });
}

// ── 보정된 현재 시간 ─────────────────────────────────────────────
function now() {
  return Date.now() + ntpOffset;
}

// ── 알람 2단계 자기보정 스케줄링 ────────────────────────────────
// coarse: 경계 GUARD_MS 전까지만 대기 후 남은 시간을 재계산 (긴 타이머
//         스로틀·드리프트 영향을 GUARD 구간으로 한정)
// fine:   경계 직전 보정 시각을 다시 읽어 짧게 정밀 대기 → 발화
function scheduleNextAlarm() {
  if (alarmTimer) clearTimeout(alarmTimer);
  if (!alarmEnabled) return;
  armBoundaryTimer();
}

function armBoundaryTimer() {
  const remaining = OCBTime.msUntilNextBoundary(now(), testMode);
  if (remaining > OCB.BOUNDARY_GUARD_MS) {
    alarmTimer = setTimeout(armBoundaryTimer, remaining - OCB.BOUNDARY_GUARD_MS);
  } else {
    alarmTimer = setTimeout(fireBoundary, remaining);
  }
}

function fireBoundary() {
  const h = new Date(now()).getHours();
  if (OCBTime.inRange(h, startHour, endHour)) {
    self.postMessage({ type: 'ALARM', hour: h, ts: now() });
  }
  scheduleNextAlarm(); // 다음 정시 재예약
}

// ── 1초 UI 틱 ────────────────────────────────────────────────────
// performance.now() 기반 드리프트 보정 루프
// 매 tick 후 다음 정확한 1초 경계까지의 지연을 재계산
function scheduleTick() {
  const n       = new Date(now());
  const msToNext = OCB.MS_PER_SECOND - n.getMilliseconds();
  tickTimer = setTimeout(() => {
    self.postMessage({ type: 'TICK', ts: now() });
    scheduleTick();
  }, msToNext);
}

// ── 메시지 처리 ──────────────────────────────────────────────────
self.onmessage = async (e) => {
  const { type } = e.data;

  if (type === 'START') {
    // 즉시 틱 시작 (NTP 동기화 전에도 시계 표시)
    scheduleTick();
    // NTP 동기화 후 알람 스케줄
    await syncNTP();
    scheduleNextAlarm();
  }

  if (type === 'SET_ALARM') {
    alarmEnabled = e.data.enabled;
    startHour    = e.data.startHour ?? startHour;
    endHour      = e.data.endHour   ?? endHour;
    testMode     = e.data.testMode  ?? testMode;
    scheduleNextAlarm();
  }

  if (type === 'TEST_MODE') {
    testMode = e.data.enabled;
    if (alarmEnabled) scheduleNextAlarm();
  }

  if (type === 'UPDATE_RANGE') {
    startHour = e.data.startHour;
    endHour   = e.data.endHour;
    // 알람이 켜져 있으면 재스케줄
    if (alarmEnabled) scheduleNextAlarm();
  }

  if (type === 'STOP') {
    clearTimeout(alarmTimer);
    clearTimeout(tickTimer);
    alarmTimer = null;
    tickTimer  = null;
    alarmEnabled = false;
  }

  // 주기적 NTP 재동기화 (1시간마다)
  if (type === 'RESYNC') {
    await syncNTP();
    if (alarmEnabled) scheduleNextAlarm();
  }
};
