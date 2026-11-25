(() => {
  'use strict';
  const webview = window.chrome?.webview;
  if (window !== window.top || location.origin !== (window.__proctorShellOrigin || 'https://proctor-client.invalid') ||
      location.pathname !== '/index.html' || !webview) return;

  const pending = new Map();
  const listeners = new Map();
  let requestId = 0;
  webview.addEventListener('message', ({ data }) => {
    if (!data || typeof data !== 'object') return;
    if (typeof data.id === 'number') {
      const request = pending.get(data.id);
      if (!request) return;
      pending.delete(data.id);
      if (data.ok) request.resolve(data.value);
      else request.reject(new Error(data.error));
      return;
    }
    if (data.id === undefined) {
      for (const callback of [...(listeners.get(data.channel) || [])]) {
        try { callback(data.value); }
        catch (error) { queueMicrotask(() => { throw error; }); }
      }
    }
  });

  function invoke(channel, ...args) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      pending.set(id, { resolve, reject });
      try { webview.postMessage({ id, channel, args }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }

  function subscribe(channel, callback) {
    const callbacks = listeners.get(channel) || new Set();
    const listener = value => callback(value);
    listeners.set(channel, callbacks);
    callbacks.add(listener);
    return () => callbacks.delete(listener);
  }

  const channels = {
    saveRendererRecovery: 'renderer-recovery:save',
    getRendererRecovery: 'renderer-recovery:get',
    rendererRecoveryComplete: 'renderer-recovery:complete',
    checkClientUpdate: 'client-update:check',
    getClientUpdateStatus: 'client-update:status',
    downloadClientUpdate: 'client-update:download',
    diagnoseServer: 'net:diagnose',
    getDesktopInfo: 'system:getInfo',
    getDesktopSources: 'desktop:getSources',
    testScreenCapture: 'desktop:testScreenCapture',
    startWindows7ScreenCapture: 'desktop:windows7Start',
    stopWindows7ScreenCapture: 'desktop:windows7Stop',
    getMacMediaAccessStatus: 'permissions:getMacMediaAccessStatus',
    getSystemPermissionStatus: 'permissions:getSystemPermissionStatus',
    askMacMediaAccess: 'permissions:askMacMediaAccess',
    openMacPrivacyPane: 'permissions:openMacPrivacyPane',
    openWindowsPrivacyPane: 'permissions:openWindowsPrivacyPane',
    promptMacAccessibility: 'permissions:promptMacAccessibility',
    relaunchAsAdmin: 'app:relaunchAsAdmin',
    quitApp: 'app:quit',
    getSecuritySnapshot: 'security:snapshot',
    getPeripheralSnapshot: 'security:peripherals',
    watchUsbEvents: 'security:watchUsb',
    readUsbEvents: 'security:readUsb',
    acknowledgeUsbEvents: 'security:ackUsb',
    getSecurityCapabilities: 'security:capabilities',
    confirmPeripheralBaseline: 'security:confirmPeripheralBaseline',
    setAllowedHosts: 'browser:setAllowedHosts',
    setContestScope: 'browser:setContestScope',
    installNovaJudgeLogin: 'browser:installNovaJudgeLogin',
    installHydroBrowserLogin: 'browser:installHydroBrowserLogin',
    getNovaJudgeSubmitStatus: 'novajudge-submit:status',
    retryNovaJudgeSubmit: 'novajudge-submit:retry',
    setWindowMode: 'window:mode',
    watchScreenControl: 'screen-control:watch',
    releaseScreenControl: 'screen-control:release',
    isScreenControlDisplaying: 'screen-control:isDisplaying',
    startNetworkDomainMonitor: 'security:startDomainMonitor',
    requestNetworkDomainPermission: 'permissions:requestNetworkDomain',
    stopNetworkDomainMonitor: 'security:stopDomainMonitor',
    resetNetworkDomainObservations: 'security:resetDomains',
    stopRtmpPipes: 'rtmp:stopPipes',
    stopRtmpStreams: 'rtmp:stop',
  };
  const voidMethods = new Set([
    'saveRendererRecovery', 'rendererRecoveryComplete', 'downloadClientUpdate', 'stopWindows7ScreenCapture',
    'quitApp', 'watchUsbEvents', 'acknowledgeUsbEvents', 'setAllowedHosts', 'setContestScope', 'retryNovaJudgeSubmit',
    'setWindowMode', 'watchScreenControl', 'releaseScreenControl', 'stopNetworkDomainMonitor',
    'resetNetworkDomainObservations', 'stopRtmpPipes', 'stopRtmpStreams',
  ]);
  const api = Object.fromEntries(Object.entries(channels).map(([name, channel]) => [
    name, (...args) => {
      const request = invoke(channel, ...args);
      return voidMethods.has(name) ? request.then(() => undefined) : request;
    }
  ]));
  api.jsonRequest = (base, path, options) => invoke('net:json', base, path, options || {});
  api.readWindows7ScreenFrame = async (id, sequence) => {
    const frame = await invoke('desktop:windows7Read', id, sequence);
    return { sequence: frame.sequence, jpeg: Uint8Array.from(atob(frame.jpeg), character => character.charCodeAt(0)) };
  };
  api.createQrDataUrl = async text => window.__proctorQrDataUrl(text);
  api.onClientUpdate = callback => subscribe('client-update:status', callback);
  api.onNovaJudgeSubmitStatus = callback => subscribe('novajudge-submit:status', callback);
  api.onRefreshShortcut = callback => subscribe('browser:refresh-shortcut', () => callback());

  Object.defineProperty(window, 'proctorApi', { value: Object.freeze(api) });
})();
