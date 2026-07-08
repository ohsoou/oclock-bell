// ── 시간 체크 순수 함수 ───────────────────────────────────────────
// worker · app · sw 에서 중복되던 범위 판정/경계 계산을 단일화한다.
// self 전역 공유 패턴 (constants.js 참고).
self.OCBTime = {
  // 시각 h(0~23)가 [start, end) 활성 범위에 드는지. 자정을 걸치는 범위도 지원.
  inRange(h, start, end) {
    return start <= end ? (h >= start && h < end) : (h >= start || h < end);
  },

  // nowMs(보정 시각)에서 다음 알람 경계까지 남은 ms.
  // testMode → 다음 정분(:00초), 일반 → 다음 정시(:00:00).
  msUntilNextBoundary(nowMs, testMode) {
    const n    = new Date(nowMs);
    const next = new Date(n);
    if (testMode) {
      next.setMinutes(n.getMinutes() + 1, 0, 0);
    } else {
      next.setHours(n.getHours() + 1, 0, 0, 0);
    }
    return next.getTime() - n.getTime();
  },
};
