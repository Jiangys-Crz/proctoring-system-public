export interface NetworkDomainStatus {
  state: 'idle' | 'ready' | 'limited' | 'unavailable';
  message: string;
  permissionRequired?: boolean;
}

export interface DesktopInfo {
  deviceId: string;
  hostname: string;
  os: string;
  clientVersion: string;
}

export interface ClientUpdateStatus {
  phase: 'checking' | 'current' | 'available' | 'downloading' | 'installing' | 'error';
  required: boolean; currentVersion: string; latestVersion?: string; message: string; notes?: string; percent: number;
  serverOrigin?: string; releaseChannel?: 'public' | 'intranet';
}
export interface NovaJudgeSubmitStatus {
  phase: 'idle' | 'installing' | 'ready' | 'error';
  message: string;
}

export interface SecuritySnapshot {
  activeWindow?: string;
  disallowedProcesses?: string[];
  networkRemotes?: string[];
  networkDomainStatus: NetworkDomainStatus;
  allowedNetworkRemotes: string[];
  peripheralsFingerprint?: string;
  peripheralScanOk: boolean;
  vmSignals?: string[];
}

export interface SecurityCapabilities {
  platform: NodeJS.Platform;
  elevated: boolean;
  elevationStatus?: 'elevated' | 'standard' | 'unavailable';
  processScan: boolean;
  processScanMessage?: string;
  networkScan: boolean;
  networkDomainStatus: NetworkDomainStatus;
  hardwareScan: boolean;
  hardwareScanMessage?: string;
  peripheralsFingerprint?: string;
  vmScan: boolean;
  vmScanMessage?: string;
  vmSignals?: string[];
  activeWindow: boolean;
  activeWindowMessage?: string;
}

export interface SystemPermissionStatus {
  platform: NodeJS.Platform;
  media: null | {
    camera: string;
    microphone: string;
    screen: string;
  };
  accessibility: boolean;
  bundleId?: string;
  appName?: string;
  execPath?: string;
  isPackaged?: boolean;
}

export interface ScreenCaptureProbe {
  ok: boolean;
  sourceCount: number;
  status?: string;
  sources?: Array<{ id: string; name: string; displayId?: string }>;
  reason?: string;
}

export interface ConnectionProbe {
  channel: string;
  ok: boolean;
  statusCode?: number;
  elapsedMs: number;
  message?: string;
}

export interface RtmpStreamRequest {
  mediaBaseUrl: string;
  sessionId: string;
  token: string;
  channels: Array<'DESKTOP_SCREEN' | 'DESKTOP_CAMERA'>;
}

export interface RtmpStreamStatus {
  ok: boolean;
  message: string;
  streams: Array<{ channel: string; url: string; pid?: number; ok: boolean; message?: string; fps?: number }>;
}

export interface RtmpFramePayload {
  sessionId: string;
  channel: 'DESKTOP_SCREEN' | 'DESKTOP_CAMERA';
  buffer: ArrayBuffer;
}

export interface ProctorApi {
  saveRendererRecovery(value: RendererRecoveryState | null): Promise<void>;
  getRendererRecovery(): Promise<RendererRecoveryState | null>;
  rendererRecoveryComplete(): Promise<void>;
  checkClientUpdate(): Promise<ClientUpdateStatus>;
  getClientUpdateStatus(): Promise<ClientUpdateStatus>;
  downloadClientUpdate(): Promise<void>;
  onClientUpdate(callback: (status: ClientUpdateStatus) => void): () => void;
  jsonRequest(baseUrl: string, path: string, options?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<unknown>;
  diagnoseServer(baseUrl: string, path?: string): Promise<ConnectionProbe[]>;
  getDesktopInfo(): Promise<DesktopInfo>;
  getDesktopSources(): Promise<Array<{ id: string; name: string; thumbnail: string }>>;
  testScreenCapture(): Promise<ScreenCaptureProbe>;
  startWindows7ScreenCapture(): Promise<string>;
  readWindows7ScreenFrame(id: string, sequence: number): Promise<{ sequence: number; jpeg: Uint8Array }>;
  stopWindows7ScreenCapture(id: string): Promise<void>;
  createQrDataUrl(text: string): Promise<string>;
  getMacMediaAccessStatus(): Promise<null | { camera: string; microphone: string; screen: string }>;
  getSystemPermissionStatus(): Promise<SystemPermissionStatus>;
  askMacMediaAccess(mediaType: 'camera' | 'microphone'): Promise<boolean>;
  openMacPrivacyPane(pane: 'screen' | 'camera' | 'microphone' | 'accessibility' | 'localNetwork'): Promise<boolean>;
  openWindowsPrivacyPane(pane: 'camera' | 'microphone' | 'network'): Promise<boolean>;
  promptMacAccessibility(): Promise<boolean>;
  relaunchAsAdmin(): Promise<boolean>;
  quitApp(): Promise<void>;
  getSecuritySnapshot(allowedHosts: string[]): Promise<SecuritySnapshot>;
  getPeripheralSnapshot(): Promise<Pick<SecuritySnapshot, 'peripheralsFingerprint' | 'peripheralScanOk'>>;
  getSecurityCapabilities(allowedHosts: string[]): Promise<SecurityCapabilities>;
  watchUsbEvents(sessionId: string): Promise<void>;
  readUsbEvents(sessionId: string): Promise<{ available: boolean; events: Array<{ id: string; action: 'INSERT' | 'REMOVE'; deviceId: string }> }>;
  acknowledgeUsbEvents(sessionId: string, ids: string[]): Promise<void>;
  confirmPeripheralBaseline(): Promise<string>;
  setAllowedHosts(hosts: string[]): Promise<void>;
  setContestScope(baseUrl: string, contestId: string, clientWebUrl?: string, platform?: string, backendOrigin?: string): Promise<void>;
  installNovaJudgeLogin(login: { loginUrl: string; cookie: { name: string; value: string } }): Promise<string>;
  getNovaJudgeSubmitStatus(): Promise<NovaJudgeSubmitStatus>;
  retryNovaJudgeSubmit(): Promise<void>;
  onNovaJudgeSubmitStatus(callback: (status: NovaJudgeSubmitStatus) => void): () => void;
  setWindowMode(mode: 'setup' | 'floating' | 'locked' | 'exit'): Promise<void>;
  watchScreenControl(identity: { baseUrl: string; sessionId: string; token: string }): Promise<void>;
  releaseScreenControl(): Promise<void>;
  isScreenControlDisplaying(): Promise<boolean>;
  startNetworkDomainMonitor(): Promise<NetworkDomainStatus>;
  requestNetworkDomainPermission(): Promise<NetworkDomainStatus>;
  stopNetworkDomainMonitor(): Promise<void>;
  resetNetworkDomainObservations(): Promise<void>;
  stopRtmpPipes(): Promise<void>;
  stopRtmpStreams(): Promise<void>;
  onRefreshShortcut(callback: () => void): () => void;
}

export interface RendererRecoveryState {
  serverUrl: string; sessionServerOrigin: string; sessionToken: string;
  session: { id: string; examId: string; candidateId: string; status: string; [key: string]: unknown };
  exam: { id: string; [key: string]: unknown }; candidate: { id: string; [key: string]: unknown };
  requirements: Record<string, unknown> | null; baselineFingerprint: string;
  pairCode: string; pairPollToken: string;
}
