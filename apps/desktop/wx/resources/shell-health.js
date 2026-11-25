(() => {
  'use strict';
  const transport = window.chrome?.webview;
  if (window !== window.top || location.href !== 'https://proctor-client.invalid/index.html' || !transport) return;
  let finished = false;
  function report(shellStatus, reason) {
    if (finished) return;
    finished = true;
    transport.postMessage({ shellStatus, reason });
  }
  // Report only a category and local script position. Errors may contain
  // candidate data or URL credentials and must not be copied into startup logs.
  window.addEventListener('error', event => {
    if (finished) return;
    const name = event.target?.localName;
    if (name === 'script' || name === 'link') report('failed', 'resource-' + name);
    else if (event.target === window) report('failed', 'script-execution:' + (event.lineno || 0) + ':' + (event.colno || 0));
  }, true);
  document.addEventListener('DOMContentLoaded', () => {
    if (!window.proctorApi) return report('failed', 'native-bridge');
    if (typeof document.getElementById('ojView')?.loadURL !== 'function') return report('failed', 'contest-bridge');
    if (window.__proctorRendererReady !== true) return report('failed', 'renderer-incomplete');
    if (!document.getElementById('setupPanel')) return report('failed', 'interface-document');
    report('ready', '');
  }, { once: true });
})();
