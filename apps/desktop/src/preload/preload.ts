import { contextBridge, ipcRenderer } from 'electron';
import QRCode from 'qrcode';
import type { ProctorApi } from '../shared/types';

const api: ProctorApi = {
  saveRendererRecovery: value => ipcRenderer.invoke('renderer-recovery:save', value),
  getRendererRecovery: () => ipcRenderer.invoke('renderer-recovery:get'),
  rendererRecoveryComplete: () => ipcRenderer.invoke('renderer-recovery:complete'),
  checkClientUpdate: () => ipcRenderer.invoke('client-update:check'),
  getClientUpdateStatus: () => ipcRenderer.invoke('client-update:status'),
  downloadClientUpdate: () => ipcRenderer.invoke('client-update:download'),
  onClientUpdate: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, status: import('../shared/types').ClientUpdateStatus) => callback(status);
    ipcRenderer.on('client-update:status', listener);
    return () => ipcRenderer.removeListener('client-update:status', listener);
  },
  jsonRequest: (baseUrl: string, requestPath: string, options?: { method?: string; body?: unknown; headers?: Record<string, string> }) =>
    ipcRenderer.invoke('net:json', baseUrl, requestPath, options || {}),
  diagnoseServer: (baseUrl: string, requestPath?: string) => ipcRenderer.invoke('net:diagnose', baseUrl, requestPath),
  getDesktopInfo: () => ipcRenderer.invoke('system:getInfo'),
  getDesktopSources: () => ipcRenderer.invoke('desktop:getSources'),
  testScreenCapture: () => ipcRenderer.invoke('desktop:testScreenCapture'),
  startWindows7ScreenCapture: () => ipcRenderer.invoke('desktop:windows7Start'),
  readWindows7ScreenFrame: (id, sequence) => ipcRenderer.invoke('desktop:windows7Read', id, sequence),
  stopWindows7ScreenCapture: id => ipcRenderer.invoke('desktop:windows7Stop', id),
  createQrDataUrl: (text: string) => QRCode.toDataURL(text, { margin: 4, width: 360, errorCorrectionLevel: 'M' }),
  getMacMediaAccessStatus: () => ipcRenderer.invoke('permissions:getMacMediaAccessStatus'),
  getSystemPermissionStatus: () => ipcRenderer.invoke('permissions:getSystemPermissionStatus'),
  askMacMediaAccess: (mediaType: 'camera' | 'microphone') => ipcRenderer.invoke('permissions:askMacMediaAccess', mediaType),
  openMacPrivacyPane: (pane: 'screen' | 'camera' | 'microphone' | 'accessibility' | 'localNetwork') => ipcRenderer.invoke('permissions:openMacPrivacyPane', pane),
  openWindowsPrivacyPane: (pane: 'camera' | 'microphone' | 'network') => ipcRenderer.invoke('permissions:openWindowsPrivacyPane', pane),
  promptMacAccessibility: () => ipcRenderer.invoke('permissions:promptMacAccessibility'),
  relaunchAsAdmin: () => ipcRenderer.invoke('app:relaunchAsAdmin'),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  getSecuritySnapshot: (allowedHosts: string[]) => ipcRenderer.invoke('security:snapshot', allowedHosts),
  getPeripheralSnapshot: () => ipcRenderer.invoke('security:peripherals'),
  watchUsbEvents: sessionId => ipcRenderer.invoke('security:watchUsb', sessionId),
  readUsbEvents: sessionId => ipcRenderer.invoke('security:readUsb', sessionId),
  acknowledgeUsbEvents: (sessionId, ids) => ipcRenderer.invoke('security:ackUsb', sessionId, ids),
  getSecurityCapabilities: (allowedHosts: string[]) => ipcRenderer.invoke('security:capabilities', allowedHosts),
  confirmPeripheralBaseline: () => ipcRenderer.invoke('security:confirmPeripheralBaseline'),
  setAllowedHosts: (hosts: string[]) => ipcRenderer.invoke('browser:setAllowedHosts', hosts),
  setContestScope: (baseUrl: string, contestId: string, clientWebUrl?: string, platform?: string, backendOrigin?: string) => ipcRenderer.invoke('browser:setContestScope', baseUrl, contestId, clientWebUrl, platform, backendOrigin),
  installNovaJudgeLogin: (login: unknown) => ipcRenderer.invoke('browser:installNovaJudgeLogin', login),
  getNovaJudgeSubmitStatus: () => ipcRenderer.invoke('novajudge-submit:status'),
  retryNovaJudgeSubmit: () => ipcRenderer.invoke('novajudge-submit:retry'),
  onNovaJudgeSubmitStatus: callback => {
    const listener = (_event: Electron.IpcRendererEvent, status: import('../shared/types').NovaJudgeSubmitStatus) => callback(status);
    ipcRenderer.on('novajudge-submit:status', listener);
    return () => ipcRenderer.removeListener('novajudge-submit:status', listener);
  },
  setWindowMode: (mode: 'setup' | 'floating' | 'locked') => ipcRenderer.invoke('window:mode', mode),
  watchScreenControl: (identity) => ipcRenderer.invoke('screen-control:watch', identity),
  releaseScreenControl: () => ipcRenderer.invoke('screen-control:release'),
  isScreenControlDisplaying: () => ipcRenderer.invoke('screen-control:isDisplaying'),
  startNetworkDomainMonitor: () => ipcRenderer.invoke('security:startDomainMonitor'),
  requestNetworkDomainPermission: () => ipcRenderer.invoke('permissions:requestNetworkDomain'),
  stopNetworkDomainMonitor: () => ipcRenderer.invoke('security:stopDomainMonitor'),
  resetNetworkDomainObservations: () => ipcRenderer.invoke('security:resetDomains'),
  stopRtmpPipes: () => ipcRenderer.invoke('rtmp:stopPipes'),
  stopRtmpStreams: () => ipcRenderer.invoke('rtmp:stop'),
  onRefreshShortcut: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('browser:refresh-shortcut', listener);
    return () => ipcRenderer.removeListener('browser:refresh-shortcut', listener);
  }
};

if (process.isMainFrame) contextBridge.exposeInMainWorld('proctorApi', api);
