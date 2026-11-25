(() => {
  'use strict';
  if (window !== window.top || location.href !== (window.__proctorShellOrigin || 'https://proctor-client.invalid') + '/index.html') return;
  const transport = window.chrome.webview;
  const pending = new Map();
  let id = 0;
  let url = 'about:blank';
  let canGoForward = false;
  let ready = false;
  let placeholder;

  function command(action, ...args) {
    return new Promise((resolve, reject) => {
      const request = ++id;
      pending.set(request, { resolve, reject });
      transport.postMessage({ guest: action, request, args });
    });
  }

  transport.addEventListener('message', ({ data }) => {
    if (data?.guest === 'reply') {
      const request = pending.get(data.request);
      if (!request) return;
      pending.delete(data.request);
      if (data.error) request.reject(new Error(data.error));
      else request.resolve(data.value);
      return;
    }
    if (data?.guest !== 'event' || !placeholder) return;
    if (data.event === 'attached') { ready = true; return; }
    if (data.isMainFrame !== false && (data.event === 'did-navigate' || data.event === 'did-navigate-in-page')) {
      url = data.url;
      canGoForward = data.canGoForward;
    }
    const event = new Event(data.event, { cancelable: true });
    Object.assign(event, { url: data.url, errorCode: data.errorCode, isMainFrame: data.isMainFrame });
    placeholder.dispatchEvent(event);
  });

  // Defer neither discovery nor method installation to DOMContentLoaded:
  // renderer.js is a blocking script and may use the element during parsing.
  function install() {
    const node = document.getElementById('ojView');
    if (!node) return;
    find.disconnect();
    placeholder = node;
    const send = (action, ...args) => { void command(action, ...args).catch(() => {}); };
    Object.defineProperties(node, {
      src: { get: () => url, set: value => send('load', String(value), {}) },
      loadURL: { value: (target, options) => command('load', target, options || {}) },
      getURL: { value: () => url },
      getWebContentsId: { value: () => ready ? 1 : 0 },
      canGoForward: { value: () => canGoForward },
      goForward: { value: () => send('forward') },
      reload: { value: () => send('reload') },
      stop: { value: () => send('stop') },
      setZoomFactor: { value: factor => send('zoom', factor) },
      executeJavaScript: { value: script => command('script', script) },
      focus: { value: () => send('focus') }
    });
    const overlays = [
      '.clientUpdateModal', '.startConfirmModal[open]', '.finishConfirmModal', '.networkWarningModal', '.finishedScreen',
      '.lock', '.novaJudgeWaiting', '.monitorPreview', '.monitorPreviewRestore',
      '.examConnectionStatus', '.desktopVoicePanel', '.mobileReconnectQr',
      '.mobileReconnectQrPopover', '.candidateWarning', '.actionToast'
    ].join(',');
    const rectangle = element => {
      const { x, y, width, height } = element.getBoundingClientRect();
      const scale = window.__proctorShellOrigin ? 1 : window.devicePixelRatio;
      return [x, y, width, height].map(value => Math.round(value * scale));
    };
    let last = '';
    let scheduled = false;
    let rescan = true;
    let covers = [];
    const sizes = new ResizeObserver(layout);
    sizes.observe(node);
    function refreshCovers() {
      const next = [...document.querySelectorAll(overlays)];
      const previouslyTracked = new Set(covers);
      const stillTracked = new Set(next);
      for (const cover of covers) if (!stillTracked.has(cover)) sizes.unobserve(cover);
      for (const cover of next) if (!previouslyTracked.has(cover)) sizes.observe(cover);
      covers = next;
      rescan = false;
    }
    function layout() {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        const guest = rectangle(node);
        let visibleCovers = [];
        if (guest[2] && guest[3]) {
          if (rescan) refreshCovers();
          const [left, top, width, height] = guest;
          visibleCovers = covers.filter(cover => {
            const style = getComputedStyle(cover);
            return style.visibility === 'visible' && Number(style.opacity) > 0;
          }).map(rectangle).filter(([x, y, w, h]) =>
            w && h && x < left + width && x + w > left && y < top + height && y + h > top);
        }
        const geometry = JSON.stringify([guest, visibleCovers]);
        if (geometry !== last) {
          last = geometry;
          transport.postMessage({ guest: 'bounds', args: [guest, visibleCovers] });
        }
      });
    }
    new MutationObserver(changes => {
      let changed = false;
      for (const change of changes) {
        if (change.type === 'childList') {
          // Text updates in clocks and status labels do not change which
          // elements can cover the guest. Their size changes are observed.
          if ([...change.addedNodes, ...change.removedNodes].some(child => child.nodeType === Node.ELEMENT_NODE)) {
            rescan = changed = true;
          }
        } else if (change.target instanceof Element) {
          const target = change.target;
          const wasCover = covers.includes(target);
          if (target.matches(overlays) !== wasCover) rescan = changed = true;
          if (target.contains(node) || covers.some(cover => target.contains(cover))) changed = true;
        }
      }
      if (changed) layout();
    }).observe(document.body, { attributes: true, childList: true, subtree: true });
    function reconnectPopoverChanged(event) {
      if ([event.target, event.relatedTarget].some(node => node instanceof Element && node.closest('.mobileReconnectQr'))) layout();
    }
    // CSS hover and focus change visibility without mutating or resizing the element.
    for (const event of ['pointerover', 'pointerout', 'focusin', 'focusout']) {
      document.addEventListener(event, reconnectPopoverChanged, true);
    }
    window.addEventListener('resize', layout);
    window.addEventListener('scroll', layout, true);
    transport.postMessage({ guest: 'attach', args: [] });
    layout();
  }
  const find = new MutationObserver(install);
  find.observe(document, { childList: true, subtree: true });
  install();
})();
