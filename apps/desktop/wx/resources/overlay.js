(() => {
  'use strict';
  if (window !== window.top || location.href !== (window.__proctorShellOrigin || 'https://proctor-client.invalid') + '/screen-control.html') return;
  const transport = window.chrome.webview;
  Object.defineProperty(window, 'screenControlDisplay', {
    value: Object.freeze({
      subscribe(callback) {
        transport.addEventListener('message', ({ data }) => {
          if (data?.channel === 'screen-control:display') callback(data.value);
        });
        transport.postMessage({ channel: 'screen-control:ready', args: [] });
      }
    })
  });
})();
