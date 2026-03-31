// Web Worker — 메인 스레드와 분리된 타이머
// 브라우저의 탭 스로틀링 영향을 훨씬 덜 받음

let intervalId = null;

self.onmessage = (e) => {
  if (e.data.type === 'START') {
    if (intervalId) clearInterval(intervalId);
    intervalId = setInterval(() => {
      self.postMessage({ type: 'TICK', ts: Date.now() });
    }, 500); // 500ms 폴링 → 정시 놓칠 확률 0에 가깝게
  }
  if (e.data.type === 'STOP') {
    if (intervalId) clearInterval(intervalId);
    intervalId = null;
  }
};
