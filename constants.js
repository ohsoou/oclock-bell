// ── 시간 체크 도메인 상수 ─────────────────────────────────────────
// window(<script>) · Web Worker(importScripts) · Service Worker(importScripts)
// 세 컨텍스트 모두 self 로 접근한다. version.js 와 동일한 전역 공유 패턴.
//
// ⚠️ 안드로이드 래퍼(AlarmDefaults.kt)의 기본값과 동일하게 유지할 것.
self.OCB = Object.freeze({
  DEFAULT_START_HOUR: 8,           // 알람 활성 시작 시각 (08:00)
  DEFAULT_END_HOUR:   22,          // 알람 활성 종료 시각 (22:00, 미포함)

  HOURS_PER_DAY:      24,
  MS_PER_SECOND:      1000,
  MS_PER_MINUTE:      60 * 1000,

  NTP_RESYNC_MS:      60 * 60 * 1000,        // NTP 재동기화 주기 (1시간)
  MAX_ALARM_DELAY_MS: 24 * 60 * 60 * 1000,   // SW 예약 허용 최대 지연 (24시간)
  SCHEDULE_SLOT_COUNT: 24,                   // SW 사전예약 슬롯 수

  BOUNDARY_GUARD_MS:  2000,        // 2단계 타이머: 정밀 구간 진입 임계 (경계 2초 전)
  VIBRATE_MS:         300,         // 알람 발화 시 진동 길이
});
