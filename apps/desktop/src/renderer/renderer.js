const $ = (id) => document.getElementById(id);

const state = {
  clientUpdate: { phase: 'checking', required: true },
  serverUrl: window.PROCTOR_DEFAULT_SERVER_URL || 'http://localhost:4031',
  desktopInfo: null,
  pairCode: '',
  pairPollToken: '',
  pairPollContext: null,
  sessionServerOrigin: '',
  sessionRevoked: false,
  sessionToken: '',
  session: null,
  loginRequest: null,
  exam: null,
  candidate: null,
  requirements: null,
  cameraStream: null,
  screenStream: null,
  baselineFingerprint: '',
  heartbeatTimer: 0,
  pairTimer: 0,
  clockTimer: 0,
  uploadFlushTimer: 0,
  uploadFlushBusy: false,
  uploadFallback: new Map(),
  uploadRetryAt: new Map(),
  recordingSaves: new Set(),
  recordingBuffers: new Map(),
  mediaStateTimer: 0,
  mediaStateRequestId: 0,
  mobileReconnectPairCode: '',
  mobileReconnectPairExpiresAt: 0,
  mobileReconnectQrGenerating: false,
  mobileReconnectQrContext: null,
  liveFrameTimer: 0,
  reconnectTimer: 0,
  reconnectAttempts: 0,
  connectionStatusTimer: 0,
  networkOfflineSince: 0,
  heartbeatBusy: false,
  pairPollBusy: false,
  testDisconnecting: false,
  monitoringStarting: false,
  monitoringSessionId: '',
  monitoringGeneration: 0,
  capturePending: {},
  heartbeatSnapshot: null,
  heartbeatSnapshotRequest: null,
  heartbeatSnapshotSchedule: null,
  heartbeatSnapshotFreshness: null,
  peripheralSnapshot: null,
  peripheralSnapshotRequest: null,
  peripheralSnapshotSchedule: null,
  securityAlertObservation: null,
  alertFlushRequest: null,
  captureRecoveryTimer: 0,
  captureRecoveryBusy: false,
  captureRecoveryRetries: 0,
  screenCaptureProbe: null,
  networkAccessProbe: null,
  serverCheckRequestId: 0,
  systemReady: false,
  allPermissionsGranted: false,
  credentialMaterials: false,
  mediaReady: false,
  loginStepReached: false,
  loginMethod: 'qr',
  liveFrameBusy: {},
  mediaRecorders: [],
  whipPublishers: new Map(),
  whipReconnectTimers: new Map(),
  whipStartingChannels: new Set(),
  whipAttempts: new Map(),
  rtmpStreaming: false,
  rtmpStreamingChannels: new Set(),
  rtmpStreamingSessionId: '',
  rtmpFps: {},
  rtmpWriteFailures: {},
  contestPageLoading: false,
  contestPageLoaded: false,
  contestPageRetryAt: 0,
  ojLoginRetryId: '',
  contestLoadGeneration: 0,
  finishedScreenVisible: false,
  browserZoomFactor: 1,
  monitorPreviewHidden: false,
  monitorPreviewRestoreSide: 'right',
  monitorPreviewRestoreDragged: false,
};

window.proctorDesktopMicrophone = window.createProctorMicrophoneCapture?.({
  onReady: () => {
    if (!state.session || state.finishedScreenVisible) return;
    const changed = window.proctorDesktopMicrophone.attach(state.screenStream);
    if (changed && !state.monitoringStarting) {
      const sessionId = state.session.id, generation = state.monitoringGeneration;
      for (const recorder of state.mediaRecorders.filter(item => item.channel === 'DESKTOP_SCREEN')) trackRecordingSave(recorder.stop());
      state.mediaRecorders = state.mediaRecorders.filter(item => item.channel !== 'DESKTOP_SCREEN');
      void stopWhipChannel('DESKTOP_SCREEN').then(() => {
        if (!state.finishedScreenVisible && state.session?.id === sessionId && state.monitoringGeneration === generation) { startSegmentRecorders(); void startRtmpStreams(); }
      });
    }
  },
  onUnavailable: message => { if (state.session && !state.finishedScreenVisible) warnCandidate(`电脑麦克风：${message}。请检查麦克风连接和系统权限。`, 'desktop-microphone'); }
});
window.proctorDesktopVoice = window.createProctorDesktopVoice?.({
  context: () => state.session?.id && state.session.status !== 'FINISHED' && state.sessionToken && !state.finishedScreenVisible && !state.requirements?.isPublicTest
    ? { sessionId: state.session.id, serverUrl: state.serverUrl, token: state.sessionToken } : null,
  request: (body, context) => window.proctorApi.jsonRequest(context.serverUrl, '/api/client/voice/calls', {
    method: 'POST', body, headers: { 'x-proctor-session-token': context.token }
  }),
  getMicrophone: () => window.proctorDesktopMicrophone.clone()
});
let lastPairError = '';
const lastAlertReports = new Map();
const pendingAlertReports = new Map();
const alertRequests = new Set();
const evidenceFlushTimers = new Set();
const lastWarningAt = new Map();
const ALERT_COOLDOWN_MS = 5 * 60_000;
const examNoticeInbox = window.createProctorNoticeInbox({
  read: identity => api(`/api/client/qa?sessionId=${encodeURIComponent(identity.sessionId)}`),
  acknowledge: (identity, id) => api('/api/client/qa', { method: 'POST', body: JSON.stringify({ action: 'ack-announcement', sessionId: identity.sessionId, announcementId: id }) }),
  render: ({ current, confirming, error }) => {
    $('examNoticeModal').classList.toggle('hidden', !current);
    $('examNoticeTitle').textContent = current?.candidateId ? '发给你的公告' : '考试公告';
    $('examNoticeContent').textContent = current?.content || '';
    $('examNoticeError').textContent = error;
    $('examNoticeConfirm').disabled = confirming;
    $('examNoticeConfirm').textContent = confirming ? '确认中…' : '确认已读';
  }
});
let warningTimer = 0;
let permissionRequestTarget = '';
let permissionRefreshOnFocus = false;
let permissionFocusTimer = 0;
let lastPermissionTarget = '';

const captureProfile = {
  nativeWindows7: false,
  width: 1920,
  height: 1080,
  frameRate: 30,
  cameraWidth: 1280,
  cameraHeight: 720,
  cameraFrameRate: 20,
  screenLiveBitrate: 3_000_000,
  cameraLiveBitrate: 450_000,
  recordingFrameRate: 20,
  screenBitrate: 3_000_000,
  cameraBitrate: 600_000,
  audioBitrate: 32_000,
  liveFrameWidth: 1920,
  liveFrameQuality: 0.85
};

function configureCaptureProfile(os) {
  captureProfile.nativeWindows7 = /^win32 6\.1(?:\.|\s|$)/.test(os || '');
  if (!/^win32 6\.1(?:\.|\s|$)/.test(os || '')) return;
  // Windows 7 runs the Chromium encoders in software. Keep readable source
  // resolution while reducing redundant full-frame copies and encoding work.
  captureProfile.frameRate = 15;
  captureProfile.cameraFrameRate = 15;
  captureProfile.recordingFrameRate = 10;
}

async function saveRendererRecovery() {
  if (!window.proctorApi.saveRendererRecovery) return;
  if (!state.session || state.session.status === 'FINISHED' || state.sessionRevoked || !state.sessionToken) {
    await window.proctorApi.saveRendererRecovery(null);
    return;
  }
  await window.proctorApi.saveRendererRecovery({
    serverUrl: state.serverUrl, sessionServerOrigin: state.sessionServerOrigin, sessionToken: state.sessionToken,
    session: state.session, candidate: state.candidate, exam: state.exam, requirements: state.requirements,
    baselineFingerprint: state.baselineFingerprint, pairCode: state.pairCode, pairPollToken: state.pairPollToken
  });
}

async function restoreRendererRecovery(saved) {
  Object.assign(state, saved);
  if (window.PROCTOR_RELEASE_CHANNEL === 'unified') window.PROCTOR_PUBLIC_API_URL = state.serverUrl;
  setOnly('waitingPanel');
  $('waitingHint').textContent = '正在恢复考试，请稍等…';
  $('app').inert = true;
  const contestOrigin = contestWebsiteOrigin();
  const hosts = [new URL(state.serverUrl).hostname, new URL(state.exam.platformBaseUrl).hostname];
  if (contestOrigin) hosts.push(new URL(contestOrigin).hostname);
  await window.proctorApi.setAllowedHosts(hosts);
  await window.proctorApi.setContestScope(state.exam.platformBaseUrl, state.exam.platformContestId, contestOrigin, state.exam.platform, state.serverUrl);
  // Revalidate the original token and current session before reopening the
  // contest. The server retains the start time, lock state and exam deadline.
  await sendHeartbeat();
  if (!state.finishedScreenVisible) {
    await startSubmittedMonitoring(state.session, state.requirements);
    if (!state.finishedScreenVisible) {
      await ensureScreenCapture();
      if (state.requirements?.requireFrontCamera) await ensureCameraCapture();
      startSegmentRecorders();
      void startRtmpStreams();
    }
  }
  if (!state.finishedScreenVisible) {
    if (['APPROVED', 'IN_EXAM', 'LOCKED'].includes(state.session.status) || state.session.startedAt) await enterApproved();
    else if (state.pairCode && state.pairPollToken) state.pairTimer = window.setInterval(pollPair, 2500);
  }
  $('app').inert = false;
  await window.proctorApi.rendererRecoveryComplete?.();
}

function apiUrl(path) {
  return `${state.serverUrl.replace(/\/$/, '')}${path}`;
}

function clientAuthHeaders(serverUrl = state.serverUrl) {
  return state.sessionToken && state.sessionServerOrigin === new URL(serverUrl).origin
    ? { 'x-proctor-session-token': state.sessionToken } : {};
}

async function handleRevokedClientSession() {
  if (state.sessionRevoked) return;
  state.sessionRevoked = true;
  await resetWaitingLogin('电脑和第二机位连接均已失效，请重新登录。');
}

function watchScreenControl(session = state.session) {
  if (!session?.id || !state.sessionToken || state.sessionServerOrigin !== new URL(state.serverUrl).origin) return;
  // Independent main-process polling also covers pending review, the time
  // before the exam starts, the finished page, and renderer refreshes.
  void window.proctorApi.watchScreenControl({
    baseUrl: state.serverUrl, sessionId: session.id, token: state.sessionToken
  }).catch((error) => console.warn('[screen-control]', errorMessage(error)));
}

function normalizeServerUrl(value) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('请填写监考服务器地址');
  const parsed = new URL(trimmed);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('服务器地址必须以 http:// 或 https:// 开头');
  return parsed.toString().replace(/\/$/, '');
}

const showToast = window.createProctorToast($('actionToast'));

function friendlyNetworkError(error) {
  return window.proctorUserMessage(error);
}

function showError(error, fallback) {
  console.error('[client]', error);
  showToast(window.proctorUserMessage(error, fallback));
}

function shouldFallbackToRendererFetch(error) {
  const message = errorMessage(error);
  return [
    'ERR_ADDRESS_UNREACHABLE',
    'ERR_NETWORK_ACCESS_DENIED',
    'ERR_CONNECTION_TIMED_OUT',
    'ERR_CONNECTION_RESET',
    'ERR_CONNECTION_CLOSED',
    'ERR_INTERNET_DISCONNECTED',
    'ERR_NAME_NOT_RESOLVED'
  ].some((code) => message.includes(code));
}

async function fetchJsonFromRenderer(path, options = {}) {
  const serverUrl = options.serverUrl || state.serverUrl;
  const usesSession = path !== '/api/health';
  const token = state.sessionToken, sessionId = state.session?.id;
  const response = await fetch(`${serverUrl.replace(/\/$/, '')}${path}`, {
    redirect: 'error', credentials: 'omit',
    method: options.method || 'GET',
    body: options.body,
    signal: options.signal,
    headers: {
      ...(options.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      'x-proctor-client': 'desktop',
      ...(usesSession ? clientAuthHeaders(serverUrl) : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json();
  if (new URL(serverUrl).origin !== new URL(state.serverUrl).origin || (usesSession && (sessionId !== state.session?.id || token !== state.sessionToken))) throw new Error('服务器或会话已切换，请重试');
  if (body?.code === 'CLIENT_SESSION_REVOKED') {
    if (usesSession && token === state.sessionToken) await handleRevokedClientSession();
    throw new Error('会话已注销，请重新登录');
  }
  if (!response.ok || !body.ok) throw new Error(body.message || '请求失败');
  return body.data;
}

async function diagnoseFromRenderer(path = '/api/health', serverUrl = state.serverUrl) {
  const startedAt = Date.now();
  try {
    await fetchJsonFromRenderer(path, { serverUrl });
    return { channel: 'renderer-fetch', ok: true, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return {
      channel: 'renderer-fetch',
      ok: false,
      elapsedMs: Date.now() - startedAt,
      message: errorMessage(error)
    };
  }
}

async function probeServerAccess(path = '/api/health', serverUrl = state.serverUrl) {
  const mainProbes = await window.proctorApi.diagnoseServer(serverUrl, path).catch((error) => [
    { channel: 'main-diagnose', ok: false, elapsedMs: 0, message: errorMessage(error) }
  ]);
  const rendererProbe = await diagnoseFromRenderer(path, serverUrl);
  return [...mainProbes, rendererProbe];
}

function formatConnectionProbe(probe) {
  const mark = probe.ok ? '可用' : '失败';
  const detail = probe.ok ? `${probe.elapsedMs}ms` : `${probe.elapsedMs}ms，${probe.message || '未知错误'}`;
  return `${probe.channel}: ${mark} (${detail})`;
}

async function buildConnectionDiagnostics(serverUrl = state.serverUrl) {
  const probes = await probeServerAccess('/api/health', serverUrl);
  if (serverUrl === state.serverUrl) state.networkAccessProbe = probes;
  return probes.map(formatConnectionProbe).join('；');
}

async function allowCurrentServerHost() {
  const host = new URL(state.serverUrl).hostname;
  if (host) await window.proctorApi.setAllowedHosts([host]);
}

function currentServerHosts() {
  const addresses = [state.serverUrl, contestWebsiteOrigin(), mobileWebsiteOrigin(), state.exam?.platformBaseUrl];
  // Each backend has independent student and media domains.
  if (state.serverUrl.replace(/\/+$/, '') === 'https://proctoring.example.test') {
    addresses.push('https://proctorstream.example.test', 'https://proctorrtc.example.test');
  }
  if (state.serverUrl.replace(/\/+$/, '') === 'https://proctoring.example.org') {
    addresses.push('https://proctorstream.example.org', 'https://proctorrtc.example.org');
  }
  return [...new Set(addresses.filter(Boolean).flatMap((value) => {
    try { return [new URL(value).hostname]; } catch { return []; }
  }))];
}

function contestWebsiteOrigin() {
  const configured = String(window.PROCTOR_CLIENT_WEB_URL || '').trim().replace(/\/$/, '');
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      return '';
    }
  }
  try {
    const parsed = new URL(state.serverUrl);
    if (parsed.origin === 'https://proctoring.example.test') return 'https://proctorstu.example.test';
    if (parsed.origin === 'https://proctoring.example.org') return 'https://proctorstu.example.org';
    // The backend and candidate website use 4031/4032. Keep older configured
    // development addresses working when a deployment has not migrated yet.
    if (parsed.port === '4031') parsed.port = '4032';
    else if (parsed.port === '3310') parsed.port = '3320';
    else if (parsed.port === '3100') parsed.port = '3200';
    return parsed.origin;
  } catch {
    return '';
  }
}

function mobileWebsiteOrigin() {
  const configured = String(window.PROCTOR_MOBILE_WEB_URL || '').trim().replace(/\/$/, '');
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      return '';
    }
  }
  return contestWebsiteOrigin();
}

function mobileApiBase() {
  const mobile = new URL(mobileWebsiteOrigin());
  const configured = String(window.PROCTOR_PUBLIC_API_URL || state.serverUrl).trim();
  const backend = new URL(configured);
  if (!['http:', 'https:'].includes(backend.protocol)) {
    throw new Error('请配置手机可访问的监考后台地址');
  }
  if (mobile.protocol === 'https:' && backend.protocol !== 'https:') {
    throw new Error('手机 HTTPS 页面需要 HTTPS 后台地址，请检查公开 API 地址配置');
  }
  const isLoopback = (host) => host === 'localhost' || host === '[::1]' || /^127\./.test(host);
  if (isLoopback(backend.hostname) && !isLoopback(mobile.hostname)) {
    backend.hostname = mobile.hostname;
  }
  return backend.toString().replace(/\/+$/, '');
}

function mobileWebsiteUrl() {
  const origin = mobileWebsiteOrigin();
  if (!origin) return '';
  return new URL(origin === new URL(state.serverUrl).origin ? '/candidate' : '/', origin).toString();
}

function mediaRtmpBase() {
  const configured = String(window.PROCTOR_MEDIA_RTMP_BASE || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const server = new URL(state.serverUrl);
  return `rtmp://${server.hostname}:1935`;
}

function isNovaJudgeExam() { return state.exam?.platform === 'NOVAJUDGE'; }

function showNovaJudgeLogin(phase) {
  $('novaJudgeWaiting').classList.toggle('hidden', phase === 'ready');
  $('novaJudgeCountdown').classList.toggle('hidden', phase !== 'waiting');
  $('novaJudgeLoading').classList.toggle('hidden', phase !== 'loading');
  $('novaJudgeRetryBtn').classList.toggle('hidden', phase !== 'failed');
  $('ojView').classList.toggle('hidden', phase === 'waiting' || phase === 'failed');
  document.body.classList.toggle('novaJudgeConnecting', phase === 'loading' || phase === 'failed');
  updateLocalPreviews();
}

function contestWebsiteUrl() {
  if (isNovaJudgeExam()) return new URL(`/contest/${state.exam.platformContestId}`, state.exam.platformBaseUrl).toString();
  const origin = contestWebsiteOrigin();
  if (!origin || !state.session?.id || !state.sessionToken) return '';
  const url = new URL('/contest', origin);
  url.searchParams.set('apiBase', state.serverUrl);
  url.searchParams.set('sessionId', state.session.id);
  // 会话令牌放在 URL fragment 中，避免被网页服务器日志和 Referer 记录。
  url.hash = new URLSearchParams({ sessionToken: state.sessionToken }).toString();
  return url.toString();
}

function browserNavigationAllowed(url) {
  if (!state.exam) return true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'about:' || parsed.protocol === 'data:' || parsed.protocol === 'blob:') return true;
    if (isNovaJudgeExam()) {
      const origin = new URL(state.exam.platformBaseUrl).origin;
      const prefix = `/contest/${state.exam.platformContestId}`;
      return parsed.origin === origin && (parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`));
    }
    const candidateOrigin = contestWebsiteOrigin();
    if (candidateOrigin && parsed.origin === candidateOrigin) {
      return parsed.pathname === '/contest' || parsed.pathname.startsWith('/contest/');
    }
    return false;
  } catch {
    return false;
  }
}

async function api(path, options = {}) {
  const serverUrl = state.serverUrl, token = state.sessionToken, sessionId = state.session?.id;
  const usesSession = path !== '/api/health';
  const headers = {
    ...(usesSession ? clientAuthHeaders() : {}),
    ...(options.headers || {})
  };
  if (!(options.body instanceof FormData)) {
    try {
      const result = await window.proctorApi.jsonRequest(serverUrl, path, {
        method: options.method || 'GET',
        body: options.body ? JSON.parse(options.body) : undefined,
        headers
      });
      if (serverUrl !== state.serverUrl || (usesSession && (sessionId !== state.session?.id || token !== state.sessionToken))) throw new Error('服务器或会话已切换，请重试');
      return result;
    } catch (error) {
      if (errorMessage(error).includes('[CLIENT_SESSION_REVOKED]')) {
        if (usesSession && serverUrl === state.serverUrl && token === state.sessionToken) await handleRevokedClientSession();
        throw error;
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes((options.method || 'GET').toUpperCase()) || !shouldFallbackToRendererFetch(error)) throw error;
      if (serverUrl !== state.serverUrl || (usesSession && (sessionId !== state.session?.id || token !== state.sessionToken))) throw new Error('服务器或会话已切换，请重试');
      return fetchJsonFromRenderer(path, { ...options, serverUrl });
    }
  }
  return fetchJsonFromRenderer(path, options);
}

function openUploadDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('cwnupaa-proctor-offline', 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('uploads')) {
        db.createObjectStore('uploads', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('alerts')) db.createObjectStore('alerts', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('离线队列打开失败'));
  });
}

async function withUploadStore(mode, callback, storeName = 'uploads') {
  const db = await openUploadDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      const request = callback(store);
      // Request success precedes the durable IndexedDB transaction commit.
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error || new Error('离线录像保存事务已取消'));
      transaction.onerror = () => reject(transaction.error || new Error('离线录像保存失败'));
      request.onerror = () => reject(request.error || new Error('离线队列读写失败'));
    });
  } finally {
    db.close();
  }
}

async function queueUpload(blob, filename, fields, sessionToken = state.sessionToken, serverUrl = state.serverUrl) {
  const item = {
    id: fields.uploadId || window.proctorUploadId(), blob, filename, fields, sessionToken, serverUrl, createdAt: Date.now()
  };
  // Retain an in-memory copy if disk quota/IndexedDB fails, and keep retrying.
  state.uploadFallback.set(item.id, item);
  try {
    await withUploadStore('readwrite', (store) => store.put(item));
    state.uploadFallback.delete(item.id);
  } catch (error) {
    warnCandidate('录像暂未能保存到本地磁盘，正在重试上传；请勿退出客户端，并联系监考老师。', 'recording-storage');
    console.error('[recording-storage]', error);
  }
  ensureUploadFlushTimer();
}

async function deleteQueuedUpload(id) {
  await withUploadStore('readwrite', (store) => store.delete(id));
}

async function listQueuedUploads() {
  return withUploadStore('readonly', (store) => store.getAll());
}

async function uploadBlob(blob, filename, fields, sessionToken = state.sessionToken, serverUrl = state.serverUrl) {
  const form = new FormData();
  form.append('file', blob, filename);
  Object.entries(fields).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') form.append(key, String(value));
  });
  const abort = new AbortController();
  const timeout = window.setTimeout(() => abort.abort(), 60_000);
  try {
    return await fetchJsonFromRenderer('/api/client/upload', {
      method: 'POST', serverUrl, body: form, signal: abort.signal,
      headers: { 'x-proctor-session-token': sessionToken || '' }
    });
  } finally {
    window.clearTimeout(timeout);
  }
}

async function uploadLiveFrameBlob(blob, channel) {
  if (!state.session?.id) return;
  const form = new FormData();
  form.append('file', blob, `live-${channel}.jpg`);
  form.append('sessionId', state.session.id);
  form.append('channel', channel);
  form.append('capturedAt', new Date().toISOString());
  await api('/api/client/live-frame', { method: 'POST', body: form });
}

function captureVideoElementFrame(video, maxWidth = 960, quality = 0.68) {
  return new Promise((resolve, reject) => {
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      reject(new Error('视频画面尚未就绪'));
      return;
    }
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) {
      reject(new Error('无法创建画布'));
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('实时帧编码失败'));
    }, 'image/jpeg', quality);
  });
}

async function uploadLiveFrame(channel, videoId) {
  if (!state.session?.id || state.session.status === 'FINISHED' || state.liveFrameBusy[channel]) return;
  state.liveFrameBusy[channel] = true;
  try {
    const blob = await captureVideoElementFrame($(videoId), channel === 'DESKTOP_SCREEN' ? captureProfile.liveFrameWidth : captureProfile.cameraWidth, channel === 'DESKTOP_SCREEN' ? captureProfile.liveFrameQuality : 0.62);
    await uploadLiveFrameBlob(blob, channel);
  } catch (error) {
    console.warn('实时预览帧上传失败', channel, errorMessage(error));
    // Live frames are best-effort; evidence clips and heartbeats still report failures.
  } finally {
    state.liveFrameBusy[channel] = false;
  }
}

function uploadLiveFrames() {
  // RTMP/HLS is the real-time transport. Live frames are no longer used for monitoring.
}

async function flushUploadQueue() {
  if (state.uploadFlushBusy) return;
  state.uploadFlushBusy = true;
  try {
    const disk = await listQueuedUploads().catch(() => []);
    const diskIds = new Set(disk.map((item) => item.id));
    const queued = [...new Map([...disk, ...state.uploadFallback.values()].map((item) => [item.id, item])).values()];
    for (const item of queued) {
      // Never send a saved session token to a different configured server.
      if (item.serverUrl && item.serverUrl !== state.serverUrl) continue;
      if (!item.serverUrl && item.fields?.sessionId !== state.session?.id) continue;
      if ((state.uploadRetryAt.get(item.id) || 0) > Date.now()) continue;
      try {
        if (state.uploadFallback.has(item.id)) {
          await withUploadStore('readwrite', (store) => store.put(item)).then(() => {
            diskIds.add(item.id);
            state.uploadFallback.delete(item.id);
          }).catch(() => {});
        }
        const token = item.fields?.sessionId === state.session?.id ? state.sessionToken : item.sessionToken;
        await uploadBlob(item.blob, item.filename, item.fields || {}, token, item.serverUrl || state.serverUrl);
        state.uploadFallback.delete(item.id);
        if (diskIds.has(item.id)) await deleteQueuedUpload(item.id);
        state.uploadRetryAt.delete(item.id);
      } catch (error) {
        const message = errorMessage(error);
        state.uploadRetryAt.set(item.id, Date.now() + (/补传窗口已关闭|令牌无效|考试已结束|客户端会话不存在/.test(message) ? 60_000 : 10_000));
        // An expired token is not permission to destroy unuploaded evidence.
        warnCandidate('仍有录像片段未上传成功，客户端会继续重试；请勿退出客户端。', 'recording-upload');
        if (!/补传窗口已关闭|令牌无效|考试已结束|客户端会话不存在/.test(message)) break;
      }
    }
  } finally {
    state.uploadFlushBusy = false;
  }
}

function ensureUploadFlushTimer() {
  if (!state.uploadFlushTimer) state.uploadFlushTimer = window.setInterval(() => {
    void flushUploadQueue();
    void flushPendingAlerts();
  }, 10000);
}

async function checkServerConnection() {
  const serverUrl = state.serverUrl;
  const requestId = ++state.serverCheckRequestId;
  const current = () => serverUrl === state.serverUrl && requestId === state.serverCheckRequestId;
  const box = $('serverStatusText').parentElement;
  box.classList.remove('ok', 'bad');
  $('serverStatusText').textContent = `连接检测中：${state.serverUrl}`;
  try {
    await allowCurrentServerHost();
    if (!current()) return false;
    await api('/api/health');
    if (!current()) return false;
    state.networkAccessProbe = [{ channel: 'client-request', ok: true, elapsedMs: 0 }];
  } catch (error) {
    if (!current()) return false;
    state.networkAccessProbe = null;
    await buildConnectionDiagnostics(serverUrl).catch(() => null);
    if (!current()) return false;
    if (!networkAccessOk()) {
      box.classList.add('bad');
      $('serverStatusText').textContent = '连接失败';
      showError(error);
      setCheck('serverCheck', false, `本地网络：未授权或不可达；${friendlyNetworkError(error)}`);
      return false;
    }
  }
  box.classList.remove('bad');
  box.classList.add('ok');
  $('serverStatusText').textContent = `已连接：${serverUrl}`;
  setCheck('serverCheck', true, '本地网络：已授权，监考服务器可访问');
  ensureUploadFlushTimer();
  void flushUploadQueue();
  void flushPendingAlerts();
  return true;
}

async function saveServerUrlFromInput() {
  try {
    const nextServer = normalizeServerUrl($('serverUrlInput').value);
    if (new URL(nextServer).origin !== new URL(state.serverUrl).origin) {
      await resetWaitingLogin('服务器已更换，请重新登录。');
    }
    state.serverUrl = nextServer;
    localStorage.setItem('proctorServerUrl', state.serverUrl);
    await checkServerConnection();
    await refreshPermissionStatus('服务器地址已保存。').catch(() => null);
  } catch (error) {
    const box = $('serverStatusText').parentElement;
    box.classList.remove('ok');
    box.classList.add('bad');
    $('serverStatusText').textContent = '连接失败';
    showError(error);
  }
}

function setOnly(id) {
  if (id !== 'examPanel' && id !== 'waitingPanel') { examNoticeInbox.clear(); $('appealModal').classList.add('hidden'); }
  ['setupPanel', 'loginPanel', 'waitingPanel', 'examPanel', 'finishedPanel'].forEach((item) => $(item).classList.toggle('hidden', item !== id));
  document.body.classList.toggle('novaJudgeMode', id === 'examPanel' && isNovaJudgeExam());
  if (id !== 'examPanel' || !isNovaJudgeExam()) document.body.classList.remove('novaJudgeConnecting');
  document.body.classList.toggle('examMode', id === 'examPanel' || id === 'finishedPanel');
  updateLocalPreviews();
}

function setCheck(id, ok, text) {
  const el = $(id);
  if (id === 'serverCheck') {
    el.textContent = text;
    el.classList.toggle('ok', ok === true);
    el.classList.toggle('bad', ok === false);
    return;
  }
  const label = id === 'screenCheck' ? '屏幕检测' : id === 'cameraCheck' ? '摄像头采集检测' : '系统检查';
  if (id === 'systemCheck') {
    ok = state.allPermissionsGranted;
  }
  el.textContent = `${label}：${ok === true ? '已通过' : '未通过'}`;
  el.classList.toggle('ok', ok === true);
  el.classList.toggle('bad', ok !== true);
}

function updateSetupButtons() {
  $('permissionBtn').disabled = !(state.allPermissionsGranted && state.systemReady);
  $('pairBtn').disabled = state.clientUpdate.required || !(state.allPermissionsGranted && state.systemReady && state.mediaReady && state.desktopInfo);
  const steps = [
    { id: 'permissionStatusBtn', complete: state.allPermissionsGranted && state.systemReady, current: !(state.allPermissionsGranted && state.systemReady) },
    { id: 'permissionBtn', complete: state.mediaReady, current: state.allPermissionsGranted && state.systemReady && !state.mediaReady },
    { id: 'pairBtn', complete: state.loginStepReached, current: state.mediaReady && !state.loginStepReached }
  ];
  for (const step of steps) {
    const button = $(step.id);
    button.classList.toggle('step-complete', step.complete);
    button.classList.toggle('step-current', step.current);
    if (step.current) button.setAttribute('aria-current', 'step'); else button.removeAttribute('aria-current');
  }
}

function selectLoginMethod(method) {
  state.loginMethod = method;
  $('qrLoginBtn').classList.toggle('login-selected', method === 'qr');
  $('credentialLoginBtn').classList.toggle('login-selected', method === 'credentials');
  $('qrLoginBtn').setAttribute('aria-pressed', String(method === 'qr'));
  $('credentialLoginBtn').setAttribute('aria-pressed', String(method === 'credentials'));
  $('qrLoginContent').classList.toggle('hidden', method !== 'qr');
  $('credentialForm').classList.toggle('hidden', method !== 'credentials');
}

function renderClientUpdate(status) {
  if (status.serverOrigin && !state.session) {
    const origin = new URL(status.serverOrigin).origin;
    if (origin !== new URL(state.serverUrl).origin) {
      clearInterval(state.pairTimer); state.pairTimer = 0;
      state.sessionToken = ''; state.sessionServerOrigin = '';
      state.pairCode = ''; state.pairPollToken = ''; state.pairPollContext = null; state.pairPollBusy = false;
      state.loginRequest = null; state.candidate = null; state.exam = null; state.requirements = null;
      state.mobileReconnectPairCode = ''; state.mobileReconnectPairExpiresAt = 0;
      state.mobileReconnectQrContext = null; state.mobileReconnectQrGenerating = false;
      state.loginStepReached = false; state.networkAccessProbe = null;
      state.serverUrl = origin;
      localStorage.removeItem('proctorServerUrl');
      setOnly('setupPanel');
      setCheck('serverCheck', false, '后台已切换，请重新检测连接');
      void checkServerConnection().catch(() => {});
    }
    if (window.PROCTOR_RELEASE_CHANNEL === 'unified') window.PROCTOR_PUBLIC_API_URL = origin;
  }
  state.clientUpdate = status;
  $('clientVersionStatus').textContent = `${status.releaseChannel ? (status.releaseChannel === 'intranet' ? '已选择内网后台 · ' : '已选择公网后台 · ') : ''}${status.message}`;
  const visible = status.required && !state.session;
  $('clientUpdateModal').classList.toggle('hidden', !visible);
  $('app').inert = visible;
  if (visible && !$('clientUpdateModal').contains(document.activeElement)) $('clientUpdateExit').focus();
  $('clientUpdateTitle').textContent = status.phase === 'available' ? '请更新监考客户端' : status.phase === 'error' ? '客户端需要完成版本检查' : status.phase === 'checking' ? '正在检查最新版本' : '正在更新客户端';
  $('clientUpdateMessage').textContent = status.message;
  $('clientUpdateVersions').textContent = `当前版本 v${status.currentVersion || '-'}${status.latestVersion ? ` · 最新版本 v${status.latestVersion}` : ''}${status.serverOrigin ? `\n连接后台：${status.serverOrigin}` : ''}`;
  $('clientUpdateNotes').textContent = status.notes || '';
  $('clientUpdateProgress').classList.toggle('hidden', !['downloading', 'installing'].includes(status.phase));
  $('clientUpdateProgress').value = status.percent || 0;
  $('clientUpdateProgressText').textContent = status.phase === 'downloading' ? `${Math.floor(status.percent || 0)}%` : '';
  $('clientUpdateDownload').classList.toggle('hidden', status.phase !== 'available');
  $('clientUpdateRetry').classList.toggle('hidden', status.phase !== 'error');
  updateSetupButtons();
}

function renderNovaJudgeSubmit(status) {
  $('submitCliStatus').classList.toggle('hidden', status.phase === 'idle');
  $('submitCliStatus').classList.toggle('failed', status.phase === 'error');
  $('submitCliMessage').textContent = status.message;
  $('submitCliRetry').classList.toggle('hidden', status.phase !== 'error');
}
async function ensureLatestClient(retry = false) {
  try { renderClientUpdate(await (retry ? window.proctorApi.checkClientUpdate() : window.proctorApi.getClientUpdateStatus())); }
  catch (error) { renderClientUpdate({ phase: 'error', required: true, message: errorMessage(error), currentVersion: state.desktopInfo?.clientVersion, percent: 0 }); }
  return !state.clientUpdate.required;
}

function warnCandidate(message, key = message) {
  const now = Date.now();
  const lastAt = lastWarningAt.get(key) || 0;
  if (now - lastAt < ALERT_COOLDOWN_MS) return;
  lastWarningAt.set(key, now);
  const box = $('candidateWarning');
  box.textContent = message;
  box.classList.remove('hidden');
  clearTimeout(warningTimer);
  warningTimer = window.setTimeout(() => box.classList.add('hidden'), 8000);
}

async function reportAlert(type, severity, message, withEvidence = false, observation = {}) {
  if (state.requirements?.isPublicTest) return false;
  if (!state.session || state.session.status === 'FINISHED' || state.finishedScreenVisible) return false;
  const sessionId = state.session.id;
  const cooldownKey = `${state.serverUrl}:${sessionId}:${type}${observation.key ? `:${observation.key}` : ''}`;
  const now = Date.now();
  const lastAt = lastAlertReports.get(cooldownKey) || 0;
  if (!observation.transition && now - lastAt < ALERT_COOLDOWN_MS) return false;
  // Confirmed recovery followed by a new incident must survive the ordinary
  // cooldown and must not overwrite an earlier incident still queued offline.
  const eventId = window.proctorUploadId();
  const key = observation.transition ? `${cooldownKey}:${eventId}` : cooldownKey;
  if (alertRequests.has(key)) return false;
  let pending = pendingAlertReports.get(key);
  if (!pending) {
    pending = {
      id: key, cooldownKey, serverUrl: state.serverUrl, sessionToken: state.sessionToken,
      payload: { sessionId, type, severity, message, eventId, occurredAt: new Date(now).toISOString() }
    };
    pendingAlertReports.set(key, pending);
    markRecordingEvent({ id: pending.payload.eventId, occurredAt: pending.payload.occurredAt, channel: window.proctorEvidenceChannel(type, { message }) });
    if (withEvidence) captureEvidenceNow();
    await withUploadStore('readwrite', (store) => store.put(pending), 'alerts').catch(() => {});
  }
  ensureUploadFlushTimer();
  return sendPendingAlert(pending);
}

async function sendPendingAlert(pending) {
  const key = pending.id;
  if (pending.serverUrl !== state.serverUrl || alertRequests.has(key)) return false;
  alertRequests.add(key);
  const abort = new AbortController();
  const timeout = window.setTimeout(() => abort.abort(), 30_000);
  try {
    await fetchJsonFromRenderer('/api/client/alerts', {
      method: 'POST',
      serverUrl: pending.serverUrl,
      signal: abort.signal,
      headers: { 'x-proctor-session-token': pending.payload.sessionId === state.session?.id ? state.sessionToken : pending.sessionToken },
      body: JSON.stringify(pending.payload)
    });
    const cooldownKey = pending.cooldownKey || key;
    lastAlertReports.set(cooldownKey, Math.max(lastAlertReports.get(cooldownKey) || 0, new Date(pending.payload.occurredAt).getTime()));
    pendingAlertReports.delete(key);
    await withUploadStore('readwrite', (store) => store.delete(key), 'alerts').catch(() => {});
    return true;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeout);
    alertRequests.delete(key);
  }
}

async function flushPendingAlerts() {
  if (state.alertFlushRequest) return state.alertFlushRequest;
  const request = (async () => {
    const saved = await withUploadStore('readonly', (store) => store.getAll(), 'alerts').catch(() => []);
    for (const item of saved) if (!pendingAlertReports.has(item.id)) pendingAlertReports.set(item.id, item);
    const pending = [...pendingAlertReports.values()].filter(item => item.serverUrl === state.serverUrl);
    let next = 0;
    // Reconnecting a whole room must not release every persisted alert in one
    // request burst. Parallel flush callers share these same three workers.
    await Promise.all(Array.from({ length: Math.min(3, pending.length) }, async () => {
      while (next < pending.length) await sendPendingAlert(pending[next++]);
    }));
  })();
  state.alertFlushRequest = request;
  try { await request; }
  finally { if (state.alertFlushRequest === request) state.alertFlushRequest = null; }
}

function captureEvidenceNow() {
  flushRecorders();
  void flushUploadQueue();
  const sessionId = state.session?.id;
  const timer = window.setTimeout(() => {
    evidenceFlushTimers.delete(timer);
    if (state.session?.id === sessionId) {
      flushRecorders();
      void flushUploadQueue();
    }
  }, 20000);
  evidenceFlushTimers.add(timer);
}

async function runWithButtonBusy(buttonId, busyText, task) {
  const button = $(buttonId);
  const originalText = button.textContent;
  const wasDisabled = button.disabled;
  button.textContent = busyText;
  button.disabled = true;
  button.classList.add('loading');
  try {
    return await task();
  } catch (error) {
    showActionError(buttonId, error);
    console.error(error);
    return null;
  } finally {
    button.textContent = originalText;
    button.disabled = wasDisabled;
    button.classList.remove('loading');
    updateSetupButtons();
  }
}

function showActionError(buttonId, error) {
  $('loginStatus').textContent = '';
  showError(error, buttonId === 'credentialSubmitBtn' || buttonId === 'qrLoginBtn'
    ? '登录未完成，请稍后重试或联系监考老师'
    : '操作未完成，请稍后重试');
}

function statusLabel(status) {
  const labels = {
    'not-determined': '未决定',
    granted: '已授权',
    denied: '已拒绝',
    restricted: '受限制',
    unknown: '未知'
  };
  return labels[status] || status || '未知';
}

function screenCaptureLive() {
  return !!state.screenStream?.getVideoTracks().some((track) => track.readyState === 'live');
}

function cameraCaptureLive() {
  return !!state.cameraStream?.getVideoTracks().some((track) => track.readyState === 'live');
}

function screenSourceUsable() {
  return state.screenCaptureProbe?.ok === true;
}

function screenAuthorized(permissions) {
  if (permissions?.platform === 'darwin') return permissions?.media?.screen === 'granted';
  return permissions?.media?.screen === 'granted' || screenCaptureLive() || screenSourceUsable();
}

function cameraAuthorized(permissions) {
  return permissions?.media?.camera === 'granted' || cameraCaptureLive();
}

function accessibilityAuthorized(permissions, capabilities) {
  return permissions?.accessibility !== false || !!capabilities?.activeWindow;
}

function screenPermissionDetail(permissions) {
  if (screenCaptureLive()) return '已授权，屏幕采集中';
  if (permissions?.platform === 'darwin' && permissions.media?.screen !== 'granted') return '未开启屏幕录制权限，否则只能看到监考客户端窗口';
  if (state.screenCaptureProbe?.ok) {
    const raw = permissions?.media?.screen ? `系统状态：${statusLabel(permissions.media.screen)}` : '';
    const detail = state.screenCaptureProbe.verifiedFrame ? '已获取屏幕画面，提交登录请求后开始推流' : '已发现桌面源，检测时会试取屏幕画面';
    return [detail, raw].filter(Boolean).join('，');
  }
  if (state.screenCaptureProbe?.reason) return `实测失败：${state.screenCaptureProbe.reason}`;
  return permissions?.media ? statusLabel(permissions.media.screen) : '通过屏幕采集实测确认';
}

function networkAccessOk() {
  return !!state.networkAccessProbe?.some((probe) => probe.ok);
}

function networkAccessDetail() {
  if (!state.networkAccessProbe) return '访问监考服务器时会触发系统本地网络授权';
  if (networkAccessOk()) return `服务器可访问：${state.serverUrl}`;
  return state.networkAccessProbe.map(formatConnectionProbe).join('；');
}

function setPermissionHint(message) {
  const hint = $('macPermissionHint');
  hint.textContent = message || '';
  hint.classList.toggle('hidden', !message);
}

function permissionRuntimeDetail(permissions) {
  if (permissions?.platform !== 'darwin') return '';
  return [
    permissions.appName ? `当前应用：${permissions.appName}` : '',
    permissions.bundleId ? `标识：${permissions.bundleId}` : '',
    permissions.isPackaged === false ? '当前为开发运行身份，请给 Electron/终端或打包后的 App 对应授权。' : '',
    permissions.execPath ? `路径：${permissions.execPath}` : ''
  ]
    .filter(Boolean)
    .join(' ');
}

function stopStream(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

function setPreviewStatus(id, text) {
  const target = $(id);
  if (target) target.textContent = text;
}

function setPreviewStream(videoId, stream) {
  const video = $(videoId);
  if (!video || video.srcObject === stream) return;
  video.srcObject = stream || null;
}

function updateLocalPreviews() {
  const policy = window.proctorCapturePolicy(state.session, state.requirements, {
    screen: screenCaptureLive(), camera: cameraCaptureLive()
  });
  setPreviewStream('screenPreview', policy.previewScreen ? state.screenStream : null);
  setPreviewStream('cameraPreview', policy.previewCamera ? state.cameraStream : null);
  $('screenPreviewTile').classList.toggle('hidden', !policy.previewScreen);
  $('cameraPreviewTile').classList.toggle('hidden', !policy.previewCamera);
  const hasPreview = policy.previewScreen || policy.previewCamera;
  const novaWaiting = isNovaJudgeExam() && !$('novaJudgeWaiting').classList.contains('hidden');
  $('monitorPreview').classList.toggle('hidden', !hasPreview || state.monitorPreviewHidden || novaWaiting);
  $('monitorPreviewRestore').classList.toggle('hidden', !hasPreview || !state.monitorPreviewHidden || novaWaiting);
  $('monitorPreview').classList.toggle('single', policy.previewScreen !== policy.previewCamera);
  setPreviewStatus('screenPreviewStatus', screenCaptureLive() ? '实时采集中' : '未采集');
  setPreviewStatus('cameraPreviewStatus', cameraCaptureLive() ? '实时采集中' : '未采集');
}

function placeMonitorPreviewRestore(rect) {
  const restore = $('monitorPreviewRestore');
  const side = rect.left + rect.width / 2 < window.innerWidth / 2 ? 'left' : 'right';
  state.monitorPreviewRestoreSide = side;
  restore.classList.toggle('left', side === 'left');
  restore.classList.toggle('right', side === 'right');
  restore.querySelector('b').textContent = side === 'left' ? '›' : '‹';
  const savedTop = Number(localStorage.getItem('monitorPreviewRestoreTop'));
  const centerY = Number.isFinite(savedTop) && savedTop > 0 ? savedTop : rect.top + rect.height / 2;
  restore.style.top = `${clamp(centerY, 48, window.innerHeight - 48)}px`;
}

function hideMonitorPreview() {
  const preview = $('monitorPreview');
  if (preview.classList.contains('hidden')) return;
  placeMonitorPreviewRestore(preview.getBoundingClientRect());
  state.monitorPreviewHidden = true;
  updateLocalPreviews();
}

function restoreMonitorPreview() {
  state.monitorPreviewHidden = false;
  updateLocalPreviews();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function monitorPreviewPosition() {
  try {
    return JSON.parse(localStorage.getItem('monitorPreviewPosition') || 'null');
  } catch {
    return null;
  }
}

function placeMonitorPreview(left, top) {
  const preview = $('monitorPreview');
  if (!preview) return;
  const rect = preview.getBoundingClientRect();
  const nextLeft = clamp(left, 0, Math.max(0, window.innerWidth - rect.width));
  const nextTop = clamp(top, 0, Math.max(0, window.innerHeight - rect.height));
  preview.style.left = `${nextLeft}px`;
  preview.style.top = `${nextTop}px`;
  preview.style.right = 'auto';
  preview.style.bottom = 'auto';
  localStorage.setItem('monitorPreviewPosition', JSON.stringify({ left: nextLeft, top: nextTop }));
}

function enableMonitorPreviewDrag() {
  const preview = $('monitorPreview');
  if (!preview) return;

  const saved = monitorPreviewPosition();
  if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
    requestAnimationFrame(() => placeMonitorPreview(saved.left, saved.top));
  }

  let dragging = false;
  let offsetX = 0;
  let offsetY = 0;

  preview.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    if (event.target.closest('button')) return;
    const rect = preview.getBoundingClientRect();
    dragging = true;
    offsetX = event.clientX - rect.left;
    offsetY = event.clientY - rect.top;
    preview.classList.add('dragging');
    preview.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  preview.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    placeMonitorPreview(event.clientX - offsetX, event.clientY - offsetY);
  });

  const stopDragging = (event) => {
    if (!dragging) return;
    dragging = false;
    preview.classList.remove('dragging');
    preview.releasePointerCapture?.(event.pointerId);
  };
  preview.addEventListener('pointerup', stopDragging);
  preview.addEventListener('pointercancel', stopDragging);

  window.addEventListener('resize', () => {
    if (state.monitorPreviewHidden) {
      const savedPosition = monitorPreviewPosition();
      const width = preview.offsetWidth || 220;
      const height = preview.offsetHeight || 250;
      placeMonitorPreviewRestore({ left: savedPosition?.left ?? window.innerWidth - width - 14, top: savedPosition?.top ?? window.innerHeight - height - 14, width, height });
      return;
    }
    const rect = preview.getBoundingClientRect();
    placeMonitorPreview(rect.left, rect.top);
  });
}

function enableMonitorPreviewRestoreDrag() {
  const restore = $('monitorPreviewRestore');
  if (!restore) return;
  let dragging = false;
  let moved = false;
  let pointerStartY = 0;
  let centerOffsetY = 0;

  restore.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const rect = restore.getBoundingClientRect();
    dragging = true;
    moved = false;
    pointerStartY = event.clientY;
    centerOffsetY = event.clientY - (rect.top + rect.height / 2);
    restore.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  restore.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    if (Math.abs(event.clientY - pointerStartY) > 3) moved = true;
    if (!moved) return;
    const centerY = clamp(event.clientY - centerOffsetY, 48, window.innerHeight - 48);
    restore.style.top = `${centerY}px`;
    localStorage.setItem('monitorPreviewRestoreTop', String(centerY));
  });

  const stopDragging = (event) => {
    if (!dragging) return;
    dragging = false;
    state.monitorPreviewRestoreDragged = moved;
    restore.releasePointerCapture?.(event.pointerId);
  };
  restore.addEventListener('pointerup', stopDragging);
  restore.addEventListener('pointercancel', (event) => {
    moved = false;
    stopDragging(event);
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error || '未知错误');
}

async function tryScreenCapture(label, createStream) {
  try {
    const stream = await createStream();
    if (!stream?.getVideoTracks?.().length) throw new Error('未获得视频轨道');
    return stream;
  } catch (error) {
    throw new Error(`${label}失败：${errorMessage(error)}`);
  }
}

async function captureElectronScreenWithSource(source) {
  // Chromium 108 (Electron 22) SelectResultFromCandidates uses explicit max
  // width/height as its preferred capture size, with ANY_WITHIN_LIMIT for
  // desktop sources. Omitting min avoids upscaling small screens, not 640p.
  // https://chromium.googlesource.com/chromium/src/+/108.0.5359.215/third_party/blink/renderer/modules/mediastream/media_stream_constraints_util_video_content.cc
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: source.id,
        minFrameRate: captureProfile.frameRate,
        maxFrameRate: captureProfile.frameRate,
        maxWidth: captureProfile.width,
        maxHeight: captureProfile.height
      }
    }
  });
}

async function captureElectronScreenWithoutSource() {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'screen',
        minFrameRate: captureProfile.frameRate,
        maxFrameRate: captureProfile.frameRate,
        maxWidth: captureProfile.width,
        maxHeight: captureProfile.height
      }
    }
  });
}

async function captureElectronScreen() {
  const sources = await window.proctorApi.getDesktopSources();
  const screenSources = sources.filter((item) => item.id?.startsWith('screen:'));
  const candidates = screenSources;
  if (!candidates.length) throw new Error('未发现可采集的屏幕源');
  const errors = [];
  for (const source of candidates) {
    try {
      return await tryScreenCapture(`直连屏幕源 ${source.name || source.id}`, () => captureElectronScreenWithSource(source));
    } catch (error) {
      errors.push(errorMessage(error));
    }
  }
  try {
    return await tryScreenCapture('无指定源直连屏幕', captureElectronScreenWithoutSource);
  } catch (error) {
    errors.push(errorMessage(error));
  }
  throw new Error(errors.join('；'));
}

function captureSystemScreenBasic() {
  return navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: captureProfile.frameRate, max: captureProfile.frameRate },
      width: { ideal: captureProfile.width, max: captureProfile.width },
      height: { ideal: captureProfile.height, max: captureProfile.height }
    },
    audio: false
  });
}

function captureSystemScreenLowRate() {
  return navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: { ideal: captureProfile.frameRate, max: captureProfile.frameRate },
      width: { ideal: captureProfile.width, max: captureProfile.width },
      height: { ideal: captureProfile.height, max: captureProfile.height }
    },
    audio: false
  });
}

async function captureScreen() {
  if (captureProfile.nativeWindows7) {
    return tryScreenCapture('Windows 7 完整桌面采集', () => window.proctorCaptureWindows7Screen(window.proctorApi));
  }
  const errors = [];
  try {
    return await captureElectronScreen();
  } catch (error) {
    errors.push(errorMessage(error));
  }

  try {
    return await tryScreenCapture('系统屏幕共享基础模式', captureSystemScreenBasic);
  } catch (error) {
    errors.push(errorMessage(error));
  }

  try {
    return await tryScreenCapture('系统屏幕共享兜底模式', captureSystemScreenLowRate);
  } catch (error) {
    errors.push(errorMessage(error));
  }

  throw new Error(errors.join('；'));
}

function waitForVideoFrame(stream) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timer);
      video.pause();
      video.srcObject = null;
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error || '屏幕视频画面读取失败')));
    };
    const timer = window.setTimeout(() => fail(new Error('屏幕视频画面读取超时')), 5000);

    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.onloadeddata = finish;
    video.onerror = () => fail(new Error('屏幕视频画面读取失败'));
    video.onloadedmetadata = () => {
      const played = video.play();
      if (played?.then) {
        played
          .then(() => {
            if (typeof video.requestVideoFrameCallback === 'function') {
              video.requestVideoFrameCallback(() => finish());
            } else if (video.videoWidth || video.videoHeight) {
              finish();
            }
          })
          .catch(fail);
      } else if (video.videoWidth || video.videoHeight) {
        finish();
      }
    };
  });
}

async function probeScreenCaptureFrame() {
  let stream = null;
  try {
    stream = await captureScreen();
    await waitForVideoFrame(stream);
    return {
      ...(state.screenCaptureProbe || {}),
      ok: true,
      verifiedFrame: true,
      reason: undefined
    };
  } catch (error) {
    return {
      ...(state.screenCaptureProbe || {}),
      ok: false,
      verifiedFrame: false,
      reason: errorMessage(error)
    };
  } finally {
    stopStream(stream);
  }
}

function attachScreenTrackWatchers() {
  const stream = state.screenStream;
  stream?.getVideoTracks().forEach((track) => {
    // Preserve small code/editor text, including replacement capture tracks.
    try { track.contentHint = 'text'; } catch {}
    track.addEventListener('ended', () => {
      if (state.screenStream !== stream || state.finishedScreenVisible) return;
      setCheck('screenCheck', false, '屏幕采集：已停止');
      updateLocalPreviews();
      if (!state.session) return;
      void reportAlert('SCREEN_CAPTURE_LOST', 5, '电脑屏幕采集被停止', true);
      scheduleWindowModeCaptureRecovery(1200);
    });
    track.addEventListener('mute', () => {
      if (state.screenStream === stream && state.session && !state.finishedScreenVisible) scheduleWindowModeCaptureRecovery(1500);
    });
  });
}

function scheduleWindowModeCaptureRecovery(delay = 1200) {
  window.clearTimeout(state.captureRecoveryTimer);
  if (!state.session?.id || state.session.status === 'FINISHED' || state.finishedScreenVisible) return;
  const generation = state.monitoringGeneration;
  const sessionId = state.session.id;
  state.captureRecoveryTimer = window.setTimeout(async () => {
    state.captureRecoveryTimer = 0;
    if (generation !== state.monitoringGeneration || state.session?.id !== sessionId || state.finishedScreenVisible) return;
    if (state.captureRecoveryBusy) { scheduleWindowModeCaptureRecovery(1000); return; }
    const recovered = await recoverWindowModeCapture(generation, sessionId);
    if (!recovered && state.captureRecoveryRetries < 2 && generation === state.monitoringGeneration && state.session?.id === sessionId) {
      state.captureRecoveryRetries += 1;
      scheduleWindowModeCaptureRecovery(3000);
    }
  }, delay);
}

async function recoverWindowModeCapture(generation, sessionId) {
  state.captureRecoveryBusy = true;
  let replacement = null;
  try {
    // Fullscreen/kiosk transitions can leave a track "live" but stop its
    // frames. Acquire and verify a replacement while the old stream keeps
    // recording and publishing, then replace only the screen track; the camera stays live.
    replacement = await captureScreen();
    await waitForVideoFrame(replacement);
    if (generation !== state.monitoringGeneration || state.session?.id !== sessionId || state.finishedScreenVisible) return false;
    const previous = state.screenStream;
    state.screenStream = replacement;
    replacement = null;
    attachScreenTrackWatchers();
    updateLocalPreviews();
    startSegmentRecorders();
    const publisher = state.whipPublishers.get('DESKTOP_SCREEN');
    const sender = publisher?.peer.getSenders().find((item) => item.track?.kind === 'video');
    if (publisher && sender && publisher.peer.connectionState === 'connected') {
      try {
        await sender.replaceTrack(state.screenStream.getVideoTracks()[0]);
        publisher.stream = state.screenStream;
      } catch (error) {
        console.warn('[capture-recovery:replace-track]', errorMessage(error));
        await stopWhipChannel('DESKTOP_SCREEN');
      }
    } else {
      await stopWhipChannel('DESKTOP_SCREEN');
    }
    stopStream(previous);
    state.captureRecoveryRetries = 0;
    return true;
  } catch (error) {
    console.warn('[capture-recovery]', errorMessage(error));
    return false;
  } finally {
    stopStream(replacement);
    state.captureRecoveryBusy = false;
    if (generation === state.monitoringGeneration && state.session?.id === sessionId && !state.finishedScreenVisible) void startRtmpStreams();
  }
}

async function ensureScreenCapture() {
  return ensureCaptureOnce('screen', acquireScreenCapture);
}

function ensureCaptureOnce(channel, acquire) {
  const generation = state.monitoringGeneration;
  if (state.capturePending[channel]?.generation === generation) return state.capturePending[channel].promise;
  const pending = { generation, promise: null };
  pending.promise = acquire(generation).finally(() => {
    if (state.capturePending[channel] === pending) delete state.capturePending[channel];
  });
  state.capturePending[channel] = pending;
  return pending.promise;
}

async function acquireScreenCapture(generation) {
  if (screenCaptureLive()) return true;
  const permissions = await window.proctorApi.getSystemPermissionStatus().catch(() => null);
  if (generation !== state.monitoringGeneration || state.finishedScreenVisible) return false;
  if (permissions?.platform === 'darwin' && permissions.media?.screen !== 'granted') {
    await window.proctorApi.openMacPrivacyPane('screen').catch(() => false);
    setCheck('screenCheck', false, '屏幕检测：需要开启屏幕录制权限，否则只能看到监考客户端窗口');
    return false;
  }
  stopStream(state.screenStream);
  state.screenStream = null;
  updateLocalPreviews();
  try {
    const stream = await captureScreen();
    if (generation !== state.monitoringGeneration || state.finishedScreenVisible) { stopStream(stream); return false; }
    state.screenStream = stream;
    window.proctorDesktopMicrophone?.attach?.(stream);
    updateLocalPreviews();
    attachScreenTrackWatchers();
    setCheck('screenCheck', true, '屏幕采集：1080p/30fps 正常');
    return true;
  } catch (error) {
    if (generation !== state.monitoringGeneration || state.finishedScreenVisible) return false;
    setCheck('screenCheck', false, '屏幕检测：未获取画面');
    showError(error, '屏幕画面获取失败，请检查屏幕录制权限后重试');
    if (state.session) {
      await reportAlert('SCREEN_CAPTURE_LOST', 5, `电脑屏幕采集启动失败：${errorMessage(error)}`, true);
    }
    return false;
  }
}

async function ensureCameraCapture() {
  return ensureCaptureOnce('camera', acquireCameraCapture);
}

async function acquireCameraCapture(generation) {
  if (cameraCaptureLive()) return true;
  stopStream(state.cameraStream);
  state.cameraStream = null;
  updateLocalPreviews();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: captureProfile.cameraWidth, max: captureProfile.cameraWidth },
        height: { ideal: captureProfile.cameraHeight, max: captureProfile.cameraHeight },
        frameRate: { ideal: captureProfile.cameraFrameRate, max: captureProfile.cameraFrameRate }
      },
      audio: false
    });
    if (generation !== state.monitoringGeneration || state.finishedScreenVisible) { stopStream(stream); return false; }
    state.cameraStream = stream;
    updateLocalPreviews();
    setCheck('cameraCheck', true, '摄像头采集：1080p/30fps 正常');
    return true;
  } catch (error) {
    if (generation !== state.monitoringGeneration || state.finishedScreenVisible) return false;
    updateLocalPreviews();
    setCheck('cameraCheck', false, '摄像头采集：未获取画面');
    showError(error, '摄像头画面获取失败，请检查摄像头后重试');
    return false;
  }
}

function setActionVisibility(platform, permissions, capabilities) {
  [
    'networkPermissionBtn',
    'screenPermissionBtn',
    'cameraPermissionBtn',
    'microphonePermissionBtn',
    'accessibilityPermissionBtn',
    'adminRelaunchBtn'
  ].forEach((id) => $(id).classList.add('hidden'));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderCapabilityPanel(permissions, capabilities) {
  const rows = window.proctorPermissionRows(permissions, capabilities, {
    network: networkAccessOk(), screen: screenCaptureLive() || screenAuthorized(permissions),
    camera: cameraAuthorized(permissions), microphone: permissions?.media?.microphone === 'granted'
  });
  state.allPermissionsGranted = rows.every((row) => row.granted);
  setCheck('systemCheck', state.allPermissionsGranted, '');
  if (!state.allPermissionsGranted) state.systemReady = false;
  $('capabilityPanel').innerHTML = rows.map((row) => {
    const busy = permissionRequestTarget === row.key;
    return `<div class="capability ${row.granted ? 'ok' : 'bad'}${busy ? ' loading' : ''}" role="button" tabindex="0" aria-disabled="${Boolean(permissionRequestTarget)}" aria-busy="${busy}" data-permission="${escapeHtml(row.key)}"><strong>${escapeHtml(row.title)}</strong><span>${escapeHtml(row.label)}</span>${row.detail ? `<small>${escapeHtml(row.detail)}</small>` : ''}</div>`;
  }).join('');
  updateSetupButtons();
}

async function requestLocalNetworkPermission() {
  setCheck('serverCheck', null, '本地网络：正在请求访问监考服务器');
  const connected = await checkServerConnection();
  if (connected) return true;
  const permissions = await window.proctorApi.getSystemPermissionStatus().catch(() => null);
  if (permissions?.platform === 'darwin') {
    setPermissionHint('本地网络不可达。如果浏览器可访问服务器，请在系统设置 > 隐私与安全性 > 本地网络 中允许程序设计算法协会监考客户端，然后完全退出并重新打开客户端。');
    await window.proctorApi.openMacPrivacyPane('localNetwork').catch(() => false);
  }
  if (permissions?.platform === 'win32') {
    setPermissionHint('监考服务器不可达。请检查当前网络、防火墙和代理设置，并确认允许程序设计算法协会监考客户端访问局域网。');
    await window.proctorApi.openWindowsPrivacyPane('network').catch(() => false);
  }
  return false;
}

async function requestCameraPermission(permissions) {
  if (!permissions?.media || cameraAuthorized(permissions)) return true;
  setCheck('cameraCheck', null, '摄像头采集：正在申请摄像头权限');
  if (permissions.platform === 'darwin') {
    const granted = await window.proctorApi.askMacMediaAccess('camera').catch(() => false);
    if (!granted) await window.proctorApi.openMacPrivacyPane('camera').catch(() => false);
  }
  if (permissions.platform === 'win32') {
    await window.proctorApi.openWindowsPrivacyPane('camera').catch(() => false);
  }
  return false;
}

async function requestMicrophonePermission(permissions) {
  if (!permissions?.media || permissions.media.microphone === 'granted') return true;
  setPermissionHint('正在申请麦克风权限。考试录制和语音对话需要麦克风访问权限。');
  if (permissions.platform === 'darwin') {
    const granted = await window.proctorApi.askMacMediaAccess('microphone').catch(() => false);
    if (!granted) await window.proctorApi.openMacPrivacyPane('microphone').catch(() => false);
  }
  if (permissions.platform === 'win32') {
    await window.proctorApi.openWindowsPrivacyPane('microphone').catch(() => false);
  }
  return false;
}

async function requestScreenPermission(permissions) {
  state.screenCaptureProbe = await window.proctorApi.testScreenCapture().catch((error) => ({
    ok: false,
    sourceCount: 0,
    reason: errorMessage(error)
  }));
  if (screenAuthorized(permissions)) return true;
  setCheck('screenCheck', false, '屏幕检测：未获取画面');
  if (permissions?.platform === 'darwin') {
    setPermissionHint('正在打开屏幕录制权限设置。授权后请完全退出并重新打开客户端，再重新检测。');
    await window.proctorApi.openMacPrivacyPane('screen').catch(() => false);
  }
  return false;
}

async function requestAccessibilityPermission(permissions, capabilities) {
  if (accessibilityAuthorized(permissions, capabilities)) return true;
  setPermissionHint('正在申请辅助功能权限，用于识别切屏和活动窗口。授权后请完全退出并重新打开客户端。');
  const prompted = await window.proctorApi.promptMacAccessibility().catch(() => false);
  if (!prompted) await window.proctorApi.openMacPrivacyPane('accessibility').catch(() => false);
  return false;
}

async function requestRequiredPermissionsSequentially() {
  const networkOk = await requestLocalNetworkPermission();
  let permissions = await window.proctorApi.getSystemPermissionStatus();

  await requestCameraPermission(permissions);
  permissions = await window.proctorApi.getSystemPermissionStatus();
  await requestMicrophonePermission(permissions);
  permissions = await window.proctorApi.getSystemPermissionStatus();
  await requestScreenPermission(permissions);
  permissions = await window.proctorApi.getSystemPermissionStatus();
  const refreshed = await refreshPermissionStatus(networkOk ? '已逐项申请并检测权限。' : '本地网络仍不可达，请授权后重新检测。');
  permissions = refreshed.permissions;
  const capabilities = refreshed.capabilities;

  if (permissions.platform === 'darwin') {
    await requestAccessibilityPermission(permissions, capabilities);
  }
  if (permissions.platform === 'win32' && capabilities?.elevationStatus === 'unavailable') {
    $('adminRelaunchBtn').classList.add('hidden');
    setPermissionHint('管理员权限检测失败，请重新安装完整客户端，并检查安全软件是否隔离了权限检测组件。');
  } else if (permissions.platform === 'win32' && capabilities && !capabilities.elevated) {
    $('adminRelaunchBtn').classList.remove('hidden');
    setPermissionHint('请关闭软件，右键点击客户端图标，选择“以管理员身份运行”后重新打开。');
  }

  return refreshed;
}

async function refreshPermissionStatus(extraMessage = '') {
  const serverUrl = state.serverUrl;
  let host = '';
  try {
    host = new URL(state.serverUrl).hostname;
  } catch {
    host = '';
  }
  const [permissions, scannedCapabilities, networkProbes, screenProbe, domainStatus] = await Promise.all([
    window.proctorApi.getSystemPermissionStatus(),
    window.proctorApi.getSecurityCapabilities(host ? [host] : []).catch(() => null),
    probeServerAccess('/api/health', serverUrl).catch((error) => [
      { channel: 'local-network', ok: false, elapsedMs: 0, message: errorMessage(error) }
    ]),
    window.proctorApi.testScreenCapture().catch(error => ({ ok: false, sourceCount: 0, reason: errorMessage(error) })),
    window.proctorApi.startNetworkDomainMonitor().catch(error => ({ state: 'unavailable', message: errorMessage(error) }))
  ]);
  const capabilities = scannedCapabilities && { ...scannedCapabilities,
    networkDomainStatus: domainStatus, networkScan: ['ready', 'limited'].includes(domainStatus.state) };
  if (serverUrl === state.serverUrl) state.networkAccessProbe = networkProbes;
  setCheck(
    'serverCheck',
    networkAccessOk(),
    networkAccessOk()
      ? '本地网络：已授权，监考服务器可访问'
      : `本地网络：未授权或不可达；${networkAccessDetail()}`
  );
  state.screenCaptureProbe = screenProbe;

  setActionVisibility(permissions.platform, permissions, capabilities);
  renderCapabilityPanel(permissions, capabilities);
  setPermissionHint(extraMessage);

  return { permissions, capabilities };
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function displayName(candidate) {
  return candidate.teamName || candidate.name || candidate.examNumber;
}

function candidateInfo(candidate, roomName, memberName) {
  const name = candidate.name || memberName || candidate.teamName || '-';
  const teamFields = candidate.teamName ? `
    <span><small>队伍名称</small><b>${escapeHtml(candidate.teamName)}</b></span>
    <span><small>队伍成员</small><b title="${escapeHtml(candidate.teamMembers || '-')}">${escapeHtml(candidate.teamMembers || '-')}</b></span>
  ` : '';
  return `
    <span><small>考号</small><b>${escapeHtml(candidate.examNumber || '-')}</b></span>
    <span><small>姓名</small><b>${escapeHtml(name)}</b></span>
    <span><small>考室</small><b>${escapeHtml(roomName || '-')}</b></span>
    <span><small>座位号</small><b>${escapeHtml(candidate.seatNo || '-')}</b></span>
    ${teamFields}
  `;
}

async function detectSystemPermissions() {
  state.systemReady = false;
  state.mediaReady = false;
  updateSetupButtons();
  setCheck('systemCheck', null, '系统检查：正在检测权限');
  setCheck('screenCheck', null, '屏幕检测：等待系统权限完成');
  setCheck('cameraCheck', null, '摄像头采集：等待系统权限完成');
  const status = await refreshPermissionStatus();
  const { permissions, capabilities } = status;

  if (!state.allPermissionsGranted) {
    setCheck('systemCheck', false, '系统检查：请先点击未授权的权限完成授权');
    return false;
  }

  if (permissions.platform === 'win32' && capabilities && !capabilities.elevated) {
    setCheck('systemCheck', false, capabilities.elevationStatus === 'unavailable'
      ? '系统检查：管理员权限检测失败，请重新安装完整客户端并检查安全软件'
      : '系统检查：请关闭软件，并使用“以管理员身份运行”重新启动');
    renderCapabilityPanel(permissions, capabilities);
    return false;
  }

  if (permissions.platform === 'darwin' && !accessibilityAuthorized(permissions, capabilities)) {
    setCheck('systemCheck', false, '系统检查：需要辅助功能权限');
    renderCapabilityPanel(permissions, capabilities);
    return false;
  }

  if (!networkAccessOk()) {
    setCheck('systemCheck', false, `系统检查：监考服务器不可达；${networkAccessDetail()}`);
    renderCapabilityPanel(permissions, capabilities);
    return false;
  }

  try {
    state.desktopInfo = await window.proctorApi.getDesktopInfo();
    configureCaptureProfile(state.desktopInfo.os);
    // These results already came from the successful capability probes. Full
    // allowlist/signature scans run in monitoring, not as an unused second pass.
    if (!capabilities?.peripheralsFingerprint || !Array.isArray(capabilities.vmSignals)) throw new Error('设备检测结果不完整');
    state.baselineFingerprint = capabilities.peripheralsFingerprint;
    if (capabilities.vmSignals.length) {
      showToast('检测到虚拟机环境，请使用符合考试要求的电脑或联系监考老师');
      setCheck('systemCheck', false, `系统检查：疑似虚拟机 ${capabilities.vmSignals.join('、')}`);
      renderCapabilityPanel(permissions, capabilities);
      return false;
    }
  } catch (error) {
    setCheck('systemCheck', false, `系统检查：失败 ${error.message}`);
    showError(error, '系统检测未完成，请重试或联系监考老师');
    renderCapabilityPanel(permissions, capabilities);
    return false;
  }

  state.systemReady = true;
  const incomplete = [!capabilities?.processScan && '进程检测', !capabilities?.networkScan && '域名检测', !capabilities?.hardwareScan && '外设检测', !capabilities?.vmScan && '虚拟机检测', !capabilities?.activeWindow && '活动窗口检测'].filter(Boolean);
  setCheck('systemCheck', incomplete.length ? null : true, incomplete.length ? `系统检查：${incomplete.join('、')}不可用，详见权限列表` : '系统检查：基础检测可用，域名采集范围详见权限列表');
  renderCapabilityPanel(permissions, capabilities);
  updateSetupButtons();
  return true;
}

async function detectMedia() {
  if (!state.allPermissionsGranted || !state.systemReady) {
    setCheck('systemCheck', false, '系统检查：请先完成系统权限检测');
    updateSetupButtons();
    return false;
  }

  stopStream(state.cameraStream);
  stopStream(state.screenStream);
  state.cameraStream = null;
  state.screenStream = null;
  state.mediaReady = false;
  updateLocalPreviews();
  updateSetupButtons();

  setCheck('screenCheck', null, '屏幕检测：正在检测');
  setCheck('cameraCheck', null, '摄像头采集：正在检测');
  state.screenCaptureProbe = await probeScreenCaptureFrame();
  const screenOk = state.screenCaptureProbe.ok === true;
  const permissions = await window.proctorApi.getSystemPermissionStatus().catch(() => null);
  const cameraOk = cameraAuthorized(permissions);
  state.mediaReady = screenOk;
  setCheck('screenCheck', screenOk, screenOk ? '屏幕检测：以获取画面' : '屏幕检测：未获取画面');
  setCheck('cameraCheck', cameraOk, cameraOk ? '摄像头采集：以获取画面' : '摄像头采集：未授权');
  await refreshPermissionStatus().catch(() => null);
  updateSetupButtons();
  return state.mediaReady;
}

async function requestDesktopPair() {
  const serverUrl = state.serverUrl;
  const generation = state.monitoringGeneration;
  const activeSession = () => state.session && state.session.status !== 'FINISHED';
  if (activeSession()) throw new Error('已有考试会话，请先结束当前会话');
  if (!state.allPermissionsGranted || !state.systemReady || !state.mediaReady) {
    throw new Error('请先完成系统权限和画面检测');
  }
  if (!state.desktopInfo) state.desktopInfo = await window.proctorApi.getDesktopInfo();
  configureCaptureProfile(state.desktopInfo.os);
  const permissions = await window.proctorApi.getSystemPermissionStatus().catch(() => null);
  const fingerprint = await window.proctorApi.confirmPeripheralBaseline();
  if (state.serverUrl !== serverUrl || state.monitoringGeneration !== generation || activeSession()) {
    throw new Error('客户端状态已改变，请重新生成登录二维码');
  }
  if (!/^(?:usb-v[456]|mac-usb-v3):[0-9a-f]{64}$/.test(fingerprint)) throw new Error('设备检测未完成，请重新检测');
  state.baselineFingerprint = fingerprint;
  const pair = await api('/api/client/pair', {
    method: 'POST',
    body: JSON.stringify({
      ...state.desktopInfo,
      screenOk: screenSourceUsable(),
      desktopCameraOk: cameraAuthorized(permissions),
      peripheralsFingerprint: fingerprint
    })
  });
  if (state.serverUrl !== serverUrl || state.monitoringGeneration !== generation || activeSession()) {
    throw new Error('客户端状态已改变，请重新生成登录二维码');
  }
  if (!pair.pollToken) throw new Error('服务器缺少安全配对凭证，请更新监考后台');
  state.pairPollContext = null;
  state.pairPollBusy = false;
  state.pairCode = pair.pairCode;
  state.pairPollToken = pair.pollToken;
  return pair;
}

async function enterLogin() {
  if (!(await ensureLatestClient())) return;
  await refreshPermissionStatus();
  if (!state.allPermissionsGranted || !state.systemReady || !state.mediaReady) {
    throw new Error('所有权限已授权并完成屏幕与摄像头检测后才能进入登录');
  }
  clearInterval(state.pairTimer);
  $('loginStatus').textContent = '';
  $('credentialForm').classList.add('hidden');
  state.loginStepReached = true;
  selectLoginMethod('qr');
  updateSetupButtons();
  setOnly('loginPanel');
  await createPair();
}

async function createPair() {
  if (!(await ensureLatestClient())) return;
  state.credentialMaterials = false;
  const pair = await requestDesktopPair();
  await showPair(pair);
}

async function showPair(pair, credentialTicket = '') {
  const candidateOrigin = mobileWebsiteOrigin();
  if (!candidateOrigin) throw new Error('无法确定考生浏览器页面地址');
  const candidateUrl = new URL(mobileWebsiteUrl());
  candidateUrl.searchParams.set('apiBase', mobileApiBase());
  candidateUrl.searchParams.set('pairCode', pair.pairCode);
  if (pair.recoverySecret) { candidateUrl.searchParams.set('reconnect', '1'); candidateUrl.hash = new URLSearchParams({ recoverySecret: pair.recoverySecret }).toString(); }
  if (pair.qrLoginSecret) candidateUrl.hash = new URLSearchParams({ testSecret: pair.qrLoginSecret }).toString();
  if (credentialTicket) candidateUrl.hash = new URLSearchParams({ credentialTicket }).toString();
  $('pairTitle').textContent = credentialTicket ? '完成第二机位材料' : '二维码登录';
  $('pairCode').textContent = pair.pairCode;
  $('pairHint').textContent = `有效期至 ${new Date(pair.expiresAt).toLocaleTimeString()}`;
  $('refreshPairBtn').classList.toggle('hidden', Boolean(credentialTicket));
  selectLoginMethod('qr');
  setOnly('loginPanel');
  const pairQr = $('pairQr');
  pairQr.removeAttribute('src');
  $('pairStatus').textContent = '正在生成登录二维码';
  try {
    pairQr.src = await window.proctorApi.createQrDataUrl(candidateUrl.toString());
    if (typeof pairQr.decode === 'function') await pairQr.decode();
    $('pairStatus').textContent = credentialTicket ? '账号密码已验证。所在考室要求第二机位，请扫码拍摄并提交审核材料。' : '请使用手机扫码，登录方式将按考生所在考室设置校验。';
  } catch (error) {
    console.error('登录二维码生成失败', error);
    pairQr.removeAttribute('src');
    $('pairStatus').textContent = '二维码暂时无法显示，请在考生网页输入上方 6 位配对码。';
    showError(error, '二维码生成失败，请稍后重试');
  }
  clearInterval(state.pairTimer);
  state.pairTimer = window.setInterval(pollPair, 2500);
}

async function submitCredentialLogin() {
  if (!(await ensureLatestClient())) return;
  if (!$('credentialForm').reportValidity()) return;
  await refreshPermissionStatus();
  if (!state.allPermissionsGranted) throw new Error('请返回完成全部权限授权后再登录');
  const pair = await requestDesktopPair();
  const result = await api('/api/client/credential-login', {
    method: 'POST', body: JSON.stringify({
      pairCode: pair.pairCode, examCode: $('loginExamCode').value.trim(), name: $('loginName').value.trim(),
      examNumber: $('loginExamNumber').value.trim(), password: $('loginPassword').value
    })
  });
  $('loginPassword').value = '';
  if (result.requiresSecondCamera) {
    state.credentialMaterials = true;
    await showPair(pair, result.credentialTicket);
  } else {
    clearInterval(state.pairTimer);
    state.pairTimer = window.setInterval(pollPair, 2500);
    await pollPair();
  }
}

async function pollPair() {
  if (!state.pairCode || !state.pairPollToken || !state.desktopInfo || state.pairPollBusy) return;
  const pairCode = state.pairCode, pollToken = state.pairPollToken, serverUrl = state.serverUrl;
  const context = { pairCode, pollToken, serverUrl };
  state.pairPollContext = context;
  state.pairPollBusy = true;
  try {
    const result = await api(`/api/client/pair?deviceId=${encodeURIComponent(state.desktopInfo.deviceId)}&pairCode=${encodeURIComponent(pairCode)}`, { headers: { 'x-proctor-pair-poll-token': pollToken } });
    if (state.pairCode !== pairCode || state.pairPollToken !== pollToken || state.serverUrl !== serverUrl) return;
    lastPairError = '';
    const login = result.testLogin || result.loginRequest;
    if (!login) return;
    if (result.desktopSessionToken) {
      state.sessionToken = result.desktopSessionToken;
      state.sessionServerOrigin = new URL(serverUrl).origin;
      state.sessionRevoked = false;
    }
    if (login.session && login.status !== 'REJECTED' && (!state.sessionToken || state.sessionServerOrigin !== new URL(serverUrl).origin)) {
      throw new Error('正在重新获取登录凭据，请稍候');
    }
    state.loginRequest = result.testLogin ? null : login;
    state.candidate = login.candidate;
    state.exam = login.exam;
    state.requirements = login.requirements || {
      requireFrontCamera: login.exam.requireFrontCamera === true,
      requireSecondCamera: login.exam.requireMiniProgram === true
    };
    $('pairStatus').textContent = result.testLogin ? '登录成功，正在进入' : '登录请求已提交，等待监考审核';
    $('waitingHint').textContent = state.requirements.requireFrontCamera
      ? '正在采集电脑屏幕和前置摄像头，并上传请求登录阶段录像。请勿触碰显示器及电脑。'
      : '正在采集电脑屏幕，并上传请求登录阶段录像。请勿触碰显示器及电脑。';
    if (!result.testLogin) setOnly('waitingPanel');
    const contestOrigin = contestWebsiteOrigin();
    const allowedHosts = [new URL(state.serverUrl).hostname, new URL(state.exam.platformBaseUrl).hostname];
    if (contestOrigin) allowedHosts.push(new URL(contestOrigin).hostname);
    await window.proctorApi.setAllowedHosts(allowedHosts);
    await window.proctorApi.setContestScope(state.exam.platformBaseUrl, state.exam.platformContestId, contestOrigin, state.exam.platform, state.serverUrl);
    watchScreenControl(login.session);
    if (login.status === 'REJECTED') {
      if ((login.rejectReason || '').includes('取消')) {
        await resetWaitingLogin(login.rejectReason || '登录请求已取消');
        return;
      }
      $('rejectBox').classList.remove('hidden');
      $('rejectBox').textContent = login.rejectReason || '登录请求未通过，请在考生网页端重新提交。';
      clearInterval(state.pairTimer);
      await window.proctorApi.releaseScreenControl();
      state.sessionToken = '';
      stopRecorders();
      stopMonitoringTimers();
      await window.proctorApi.setWindowMode('setup');
      return;
    }
    if (login.status === 'APPROVED' && login.session) {
      state.session = login.session;
      await enterApproved();
      clearInterval(state.pairTimer);
      try {
        await startSubmittedMonitoring(login.session, state.requirements);
      } catch (error) {
        showError(error, '监考采集启动未完成，正在自动重试');
        window.setTimeout(() => {
          if (state.session?.id === login.session.id && !state.heartbeatTimer) {
            void startSubmittedMonitoring(login.session, state.requirements).catch((retryError) => {
              showError(retryError, '监考采集暂未恢复，请联系监考老师');
            });
          }
        }, 3000);
      }
    } else if (login.session) {
      await startSubmittedMonitoring(login.session, state.requirements);
    }
  } catch (error) {
    if (lastPairError !== errorMessage(error)) showError(error, '登录后的考试页面暂未加载，正在自动重试');
    lastPairError = errorMessage(error);
  } finally {
    if (state.pairPollContext === context) { state.pairPollBusy = false; state.pairPollContext = null; }
  }
}

async function startSubmittedMonitoring(session, requirements) {
  const alreadyMonitoring = state.session?.id === session.id && state.heartbeatTimer;
  state.session = session;
  watchScreenControl(session);
  state.requirements = requirements || state.requirements;
  await saveRendererRecovery();
  if (state.candidate) $('candidateInfo').innerHTML = candidateInfo(state.candidate, state.requirements?.roomName, state.session?.memberName);
  updateLocalPreviews();
  if (alreadyMonitoring) return;
  if (state.monitoringStarting && state.monitoringSessionId === session.id) return;

  state.monitoringStarting = true;
  state.monitoringSessionId = session.id;
  const generation = ++state.monitoringGeneration;
  state.heartbeatSnapshot = null;
  state.heartbeatSnapshotRequest = null;
  state.peripheralSnapshot = null;
  state.peripheralSnapshotRequest = null;
  state.peripheralSnapshotSchedule = null;
  let screenOk = false;
  try {
    // Keep the authenticated connection alive while devices or drivers are
    // still opening. Capture readiness is reported after this setup completes.
    await startHeartbeat(generation);
    if (generation !== state.monitoringGeneration || state.finishedScreenVisible) return;
    screenOk = await ensureScreenCapture();
    if (generation !== state.monitoringGeneration || state.finishedScreenVisible) return;
    await window.proctorDesktopMicrophone?.acquire?.();
    if (generation !== state.monitoringGeneration || state.finishedScreenVisible) return;
    if (state.requirements?.requireFrontCamera) await ensureCameraCapture();
    else {
      stopStream(state.cameraStream);
      state.cameraStream = null;
      updateLocalPreviews();
    }
    if (generation !== state.monitoringGeneration || state.finishedScreenVisible) return;
    startSegmentRecorders();
    // WebRTC 推流异步启动，不阻塞心跳上报。
    void startRtmpStreams();
    setCheck('screenCheck', screenCaptureLive() ? true : screenOk, screenCaptureLive() ? state.requirements?.isPublicTest ? '屏幕检测：正在进行测试推流，不保存录像' : '屏幕检测：1080p/30fps 实时采集中，录像按考试设置保存' : '屏幕检测：等待重新采集');
    if (state.requirements?.requireFrontCamera) setCheck('cameraCheck', cameraCaptureLive(), cameraCaptureLive() ? '摄像头采集：以获取画面' : '摄像头采集：等待重新采集');
  } finally {
    if (generation === state.monitoringGeneration) state.monitoringStarting = false;
  }

  if (screenOk) {
    setCheck('screenCheck', true, '屏幕采集：正在推流到监考端');
  } else {
    warnCandidate('电脑屏幕采集启动失败，已上报监考老师。请检查屏幕录制权限或联系监考老师。');
  }
}

async function resetWaitingLogin(message) {
  await window.proctorApi.saveRendererRecovery?.(null);
  clearInterval(state.clockTimer);
  state.clockTimer = 0;
  clearInterval(state.pairTimer);
  state.pairTimer = 0;
  stopRecorders();
  stopMonitoringTimers();
  await window.proctorApi.setWindowMode('setup').catch(() => {});
  await window.proctorApi.releaseScreenControl().catch(() => {});
  state.sessionToken = '';
  state.sessionServerOrigin = '';
  state.pairPollToken = '';
  state.pairPollContext = null;
  state.pairPollBusy = false;
  state.contestLoadGeneration++;
  await window.proctorApi.setContestScope('', '').catch(() => {});
  state.session = null;
  state.loginRequest = null;
  state.candidate = null;
  state.exam = null;
  state.requirements = null;
  state.monitorPreviewHidden = false;
  state.contestPageLoaded = false;
  state.contestPageLoading = false;
  state.contestPageRetryAt = 0;
  state.finishedScreenVisible = false;
  state.pairCode = '';
  $('pairCode').textContent = '------';
  $('pairStatus').textContent = message || '登录请求已取消';
  $('waitingHint').textContent = '请勿触碰显示器及电脑。审核通过后将显示考试信息。';
  $('rejectBox').classList.add('hidden');
  $('rejectBox').textContent = '';
  setOnly('setupPanel');
  updateSetupButtons();
}

// 不论是考生确认、监考老师强制结束还是到时自动结束，都进入同一终态页面。
async function showFinishedScreen(message) {
  if (state.finishedScreenVisible) return;
  state.finishedScreenVisible = true;
  await window.proctorApi.saveRendererRecovery?.(null);
  if (state.session) state.session = { ...state.session, status: 'FINISHED' };
  clearInterval(state.clockTimer);
  state.clockTimer = 0;
  clearInterval(state.pairTimer);
  state.pairTimer = 0;
  stopRecorders();
  stopMonitoringTimers();
  await window.proctorApi.stopRtmpStreams().catch(() => {});
  await window.proctorApi.stopRtmpPipes().catch(() => {});
  state.loginRequest = null;
  state.requirements = null;
  state.monitorPreviewHidden = false;
  state.contestPageLoaded = false;
  state.contestPageLoading = false;
  state.contestPageRetryAt = 0;
  state.pairCode = '';
  state.rtmpStreamingChannels = new Set();
  state.rtmpFps = {};
  state.rtmpWriteFailures = {};
  state.rtmpStreaming = false;
  state.contestLoadGeneration++;
  $('ojView').src = 'about:blank';
  await window.proctorApi.setContestScope('', '').catch(() => {});
  $('lockPanel').classList.add('hidden');
  $('finishConfirmModal').classList.add('hidden');
  $('finishedMessage').textContent = message || '本场考试已经结束，无法再次进入。';
  setOnly('finishedPanel');
  await window.proctorApi.setWindowMode('setup').catch(() => {});
}

async function cancelLoginRequest() {
  const sessionId = state.session?.id;
  const loginRequestId = state.loginRequest?.id;
  if (!sessionId && !loginRequestId) {
    await resetWaitingLogin('登录请求已取消');
    return;
  }
  await api('/api/client/login-request/cancel', {
    method: 'POST',
    body: JSON.stringify({ sessionId, loginRequestId })
  });
  await resetWaitingLogin('登录请求已取消，可重新生成二维码');
}

async function enterApproved() {
  $('testDisconnectBtn').classList.toggle('hidden', !state.requirements?.isPublicTest);
  $('testStreamStatus').classList.toggle('hidden', !state.requirements?.isPublicTest);
  state.finishedScreenVisible = false;
  setOnly('examPanel');
  $('candidateInfo').innerHTML = candidateInfo(state.candidate, state.requirements?.roomName, state.session?.memberName);
  $('examName').textContent = state.exam.name;
  $('novaJudgeWaiting').classList.toggle('hidden', !isNovaJudgeExam());
  $('ojView').classList.toggle('hidden', isNovaJudgeExam());
  if (isNovaJudgeExam()) showNovaJudgeLogin('waiting');
  state.ojLoginRetryId = '';
  $('rulesBox').textContent = isNovaJudgeExam() ? state.exam.rules : state.requirements?.isPublicTest ? state.exam.rules : `${state.exam.rules || '请遵守考试规则，独立完成答题。'}\n\n题目、提交和排行榜将在独立比赛网页中显示，并由 HydroOJ 提供数据与判题服务。`;
  state.contestPageLoaded = false;
  state.contestPageLoading = false;
  state.contestPageRetryAt = 0;
  updateLocalPreviews();
  installWebviewGuards();
  startClock();
  openContestHome();
}

async function requestOjAndOpen() {
  if (isNovaJudgeExam()) { state.contestPageLoaded = false; state.contestPageRetryAt = 0; openContestHome(); return; }
  try {
    const ticket = await api('/api/client/oj-cookie', {
      method: 'POST',
      body: JSON.stringify({ sessionId: state.session.id })
    });
    if (ticket.loginUrl) $('ojView').src = ticket.loginUrl;
  } catch (error) {
    showError(error, '考试平台登录失败，请稍后重试或联系监考老师');
  }
}

function openContestHome() {
  if (!state.exam || state.finishedScreenVisible) return;
  const nova = isNovaJudgeExam();
  if (nova && (!state.session?.startedAt || state.session.status !== 'IN_EXAM' || state.session.lockdown)) return;
  const url = contestWebsiteUrl();
  if (!url) {
    $('examStatus').textContent = '比赛网页地址未配置，请在客户端 config.js 中配置 PROCTOR_CLIENT_WEB_URL。';
    return;
  }
  if (state.contestPageLoading || state.contestPageLoaded || Date.now() < state.contestPageRetryAt) return;
  const generation = ++state.contestLoadGeneration;
  const sessionId = state.session.id;
  const current = () => generation === state.contestLoadGeneration && state.session?.id === sessionId && !state.finishedScreenVisible;
  $('examStatus').textContent = nova ? '正在自动登录 NovaJudge 比赛' : '已打开项目内置比赛网页，题目由本项目发布，HydroOJ 负责判题。';
  if (nova) {
    showNovaJudgeLogin('loading');
  }
  const visibleUrl = new URL(url);
  visibleUrl.search = '';
  visibleUrl.hash = '';
  $('browserUrl').textContent = visibleUrl.toString();
  $('browserUrl').title = visibleUrl.toString();
  const view = $('ojView');
  const extraHeaders = [
    'X-Proctor-Client: desktop',
    `X-Proctor-Session-Token: ${state.sessionToken}`,
    ''
  ].join('\r\n');
  state.contestPageLoading = true;
  const waitForAttached = () => new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      attempts += 1;
      try {
        if (typeof view.getWebContentsId !== 'function' || view.getWebContentsId() > 0) {
          resolve();
          return;
        }
      } catch {
        // The element is visible before Electron has attached its guest contents.
      }
      if (attempts >= 40) {
        reject(new Error('考试页面容器尚未准备完成'));
        return;
      }
      window.setTimeout(check, 50);
    };
    window.requestAnimationFrame(check);
  });
  view.classList.remove('hidden');
  const loading = waitForAttached().then(async () => {
    let target = url;
    if (nova) {
      const login = await api('/api/client/oj-cookie', { method: 'POST', body: JSON.stringify({ sessionId }) });
      if (!current() || state.session.status !== 'IN_EXAM' || state.session.lockdown) return;
      target = await window.proctorApi.installNovaJudgeLogin(login);
    }
    if (!current()) return;
    return typeof view.loadURL === 'function'
      ? view.loadURL(target, nova ? {} : { extraHeaders })
      : Promise.resolve().then(() => { view.src = target; });
  });
  Promise.resolve(loading)
    .then(() => {
      if (!current() || (nova && (state.session.status !== 'IN_EXAM' || state.session.lockdown))) return;
      state.contestPageLoaded = true;
      if (nova) showNovaJudgeLogin('ready');
      state.contestPageRetryAt = 0;
      view.setZoomFactor?.(state.browserZoomFactor);
    })
    .catch((error) => {
      if (!current()) return;
      if (nova) {
        showNovaJudgeLogin('failed');
      }
      state.contestPageLoaded = false;
      state.contestPageRetryAt = nova ? Infinity : Date.now() + 3000;
      if (!nova) showError(error, '考试页面暂时无法打开，正在自动重试');
    })
    .finally(() => { if (current()) state.contestPageLoading = false; });
}

function refreshContestPage() {
  const view = $('ojView');
  const currentUrl = typeof view.getURL === 'function' ? view.getURL() : '';
  if (currentUrl && currentUrl !== 'about:blank' && browserNavigationAllowed(currentUrl)) {
    view.reload();
    return;
  }
  state.contestPageLoaded = false;
  state.contestPageLoading = false;
  state.contestPageRetryAt = 0;
  openContestHome();
}

window.proctorApi.onRefreshShortcut(() => {
  if (state.session) {
    refreshContestPage();
    return;
  }
  void checkServerConnection()
    .then(() => refreshPermissionStatus())
    .then(() => updateSetupButtons())
    .catch((error) => showError(error, '页面刷新失败，请稍后重试'));
});

function contestParentUrl() {
  try {
    const url = new URL($('ojView').getURL());
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = path.slice(0, path.lastIndexOf('/')) || '/';
    if (!browserNavigationAllowed(url.toString())) return '';
    return url.toString();
  } catch { return ''; }
}

function updateBrowserHistoryButtons() {
  const view = $('ojView');
  try {
    $('browserBackBtn').disabled = !contestParentUrl();
    $('browserForwardBtn').disabled = !view.canGoForward?.();
  } catch {
    $('browserBackBtn').disabled = true;
    $('browserForwardBtn').disabled = true;
  }
}

function navigateContestHistory(direction) {
  const view = $('ojView');
  try {
    if (direction === 'back' && contestParentUrl()) view.src = contestParentUrl();
    if (direction === 'forward' && view.canGoForward?.()) view.goForward();
  } finally {
    window.setTimeout(updateBrowserHistoryButtons, 0);
  }
}

function setContestZoom(nextFactor) {
  state.browserZoomFactor = Math.round(clamp(nextFactor, 0.5, 2) * 10) / 10;
  $('browserZoomPercent').textContent = `${Math.round(state.browserZoomFactor * 100)}%`;
  $('ojView').setZoomFactor?.(state.browserZoomFactor);
}

function installWebviewGuards() {
  const view = $('ojView');
  if (view.dataset.guardsInstalled === '1') return;
  view.dataset.guardsInstalled = '1';
  const block = (event) => {
    const url = event.url || event.newURL || '';
    if (browserNavigationAllowed(url)) return;
    if (isNovaJudgeExam()) {
      try {
        const target = new URL(url);
        if (target.origin === new URL(state.exam.platformBaseUrl).origin && (/^\/api\/problems\/[^/]+\/assets\/[^/]+$/.test(target.pathname)
          || [`/api/contests/${state.exam.platformContestId}/editorial`, `/api/contests/${state.exam.platformContestId}/rank-export`].includes(target.pathname)
          || /\.(?:pdf|zip|7z|rar|tar|gz|txt|csv|xlsx?|docx?|pptx?|cpp|c|h|py|java|in|out)$/i.test(target.pathname))) {
          event.preventDefault?.(); return;
        }
      } catch {}
    }
    event.preventDefault?.();
    state.contestPageLoaded = false;
    void reportAlert('NETWORK_POLICY', 4, `内置浏览器尝试访问非考试范围页面：${url}`, true);
    openContestHome();
  };
  const updateVisibleUrl = (event) => {
    try {
      const visibleUrl = new URL(event.url);
      visibleUrl.search = '';
      visibleUrl.hash = '';
      $('browserUrl').textContent = visibleUrl.toString();
      $('browserUrl').title = visibleUrl.toString();
    } catch {
      // 加载失败时保留最近一次有效考试地址。
    }
    updateBrowserHistoryButtons();
  };
  view.addEventListener('will-navigate', block);
  view.addEventListener('will-frame-navigate', block);
  view.addEventListener('did-navigate', updateVisibleUrl);
  view.addEventListener('did-navigate-in-page', updateVisibleUrl);
  view.addEventListener('did-fail-load', (event) => {
    if (event.errorCode === -3) return;
    state.contestPageLoaded = false;
    state.contestPageLoading = false;
    state.contestPageRetryAt = isNovaJudgeExam() ? Infinity : Date.now() + 3000;
    if (isNovaJudgeExam() && !state.finishedScreenVisible) showNovaJudgeLogin('failed');
  });
  view.addEventListener('dom-ready', () => {
    if (isNovaJudgeExam() && state.session?.status === 'IN_EXAM') {
      void view.executeJavaScript("Boolean(document.querySelector('input[name=\"password\"]'))").then(needsLogin => {
        if (!needsLogin || state.contestPageLoading) return;
        state.contestPageLoaded = false; state.contestPageRetryAt = 0; openContestHome();
      }).catch(() => {});
    }
    view.setZoomFactor?.(state.browserZoomFactor);
    updateBrowserHistoryButtons();
  });
}

function startClock() {
  clearInterval(state.clockTimer);
  const updateClock = () => {
    if (!state.contestPageLoading && !state.contestPageLoaded && contestWebsiteUrl()) openContestHome();
    const now = Date.now();
    const startAt = new Date(state.exam.startAt).getTime();
    const activeStatus = ['IN_EXAM', 'LOCKED', 'FINISHED'].includes(state.session.status);
    if (!state.session.startedAt && !activeStatus) {
      $('timeLabel').textContent = '考试总时长';
      $('timeValue').textContent = formatDuration(Number(state.exam.durationMinutes || 0) * 60_000);
      $('timeValue').parentElement?.classList.remove('urgent');
      if (isNovaJudgeExam()) {
        const remaining = Math.max(0, startAt - now);
        $('novaJudgeCountdown').textContent = remaining > 0 ? `距开考还有 ${formatDuration(remaining)}` : '考试已开始，请确认开始考试';
        $('startBtn').disabled = now < startAt || now >= new Date(state.exam.endAt).getTime() || state.session.lockdown;
        $('startBtn').classList.remove('hidden'); $('finishBtn').classList.add('hidden');
        if (now >= new Date(state.exam.endAt).getTime()) void showFinishedScreen('本场考试已结束，无法再次进入。');
        return;
      }
      // 开始考试由内置考试网页的概览页统一处理，避免出现两套入口。
      $('startBtn').classList.add('hidden');
      $('finishBtn').classList.add('hidden');
      return;
    }
    const started = state.session.startedAt ? new Date(state.session.startedAt).getTime() : startAt;
    const serverEnd = state.session.effectiveEndAt ? new Date(state.session.effectiveEndAt).getTime() : Number.NaN;
    const end = Number.isFinite(serverEnd)
      ? serverEnd
      : state.exam.contestRule === 'ACM' || !state.exam.flexible
        ? new Date(state.exam.endAt).getTime()
        : Math.min(started + state.exam.durationMinutes * 60000, new Date(state.exam.endAt).getTime());
    const finished = state.session.status === 'FINISHED' || now >= end;
    const remaining = Math.max(0, end - now);
    $('timeLabel').textContent = finished ? '考试已结束' : '考试剩余时间';
    $('timeValue').textContent = finished ? '00:00:00' : formatDuration(remaining);
    $('timeValue').parentElement?.classList.toggle('urgent', !finished && remaining <= 10 * 60_000);
    $('startBtn').classList.add('hidden');
    $('finishBtn').classList.toggle('hidden', finished);
    if (finished) {
      void showFinishedScreen('本场考试已结束，无法再次进入。').catch((error) => {
        state.finishedScreenVisible = false;
        showError(error);
      });
    }
  };
  updateClock();
  // Keep the shell clock in step with the embedded contest countdown. Both use
  // the server-provided effective end time and refresh four times per second.
  state.clockTimer = window.setInterval(updateClock, 250);
}

async function startExam() {
  if (!confirm('确认开始考试后将正式计时，是否继续？')) return;
  state.session = await api('/api/client/session/start', {
    method: 'POST',
    body: JSON.stringify({ sessionId: state.session.id, confirm: true })
  });
  if (isNovaJudgeExam()) { $('novaJudgeCountdown').textContent = '监考已开始，正在连接答题平台。'; openContestHome(); }
  $('ojView').focus();
}

async function finishExam() {
  const expected = `考号${state.candidate.examNumber}，姓名${state.candidate.name || state.candidate.teamName || state.candidate.examNumber}确认结束考试`;
  $('finishConfirmExpected').textContent = expected;
  $('finishConfirmInput').value = '';
  $('finishConfirmSubmit').disabled = true;
  $('finishConfirmModal').classList.remove('hidden');
  window.setTimeout(() => $('finishConfirmInput').focus(), 0);
}

async function confirmFinishExam() {
  const expected = $('finishConfirmExpected').textContent;
  const input = $('finishConfirmInput').value.trim();
  if (input !== expected) return;
  $('finishConfirmSubmit').disabled = true;
  state.session = await api('/api/client/session/finish', {
    method: 'POST',
    body: JSON.stringify({ sessionId: state.session.id, confirmationText: input })
  });
  await showFinishedScreen('你已确认结束本场考试，无法再次进入。');
}

async function finishCheatingExam() {
  await finishExam();
}

async function appealCheating() {
  if (!window.proctorWindowPolicy(state.session).cheating) throw new Error('当前没有需要申诉的作弊标记');
  $('appealError').textContent = '';
  $('appealModal').classList.remove('hidden');
  $('appealMessage').focus();
}

async function submitCheatingAppeal() {
  const message = $('appealMessage').value.trim();
  if (!message) { $('appealError').textContent = '请填写申诉内容'; return; }
  if (!state.session || !window.proctorWindowPolicy(state.session).cheating) {
    $('appealError').textContent = '考试状态已变化，请关闭窗口后重新检查'; return;
  }
  if ($('appealSubmit').disabled) return;
  const sessionId = state.session.id;
  $('appealSubmit').disabled = true;
  $('appealError').textContent = '';
  try {
    await api('/api/client/cheating/appeal', { method: 'POST', body: JSON.stringify({ sessionId, message }) });
    if (state.session?.id !== sessionId) return;
    $('appealMessage').value = '';
    $('appealModal').classList.add('hidden');
    showToast('申诉已提交，请等待监考老师处理');
  } catch (error) {
    $('appealError').textContent = window.proctorUserMessage(error, '申诉未提交成功，请稍后重试或联系监考老师');
  } finally { $('appealSubmit').disabled = false; }
}

async function startHeartbeat(generation = state.monitoringGeneration) {
  window.proctorDesktopVoice?.start?.();
  clearInterval(state.heartbeatTimer);
  clearInterval(state.mediaStateTimer);
  clearInterval(state.liveFrameTimer);
  clearInterval(state.reconnectTimer);
  state.reconnectTimer = 0;
  await window.proctorApi.startNetworkDomainMonitor();
  if (generation !== state.monitoringGeneration || state.finishedScreenVisible) return;
  await window.proctorApi.resetNetworkDomainObservations();
  if (generation !== state.monitoringGeneration || state.finishedScreenVisible) return;
  await window.proctorApi.setWindowMode(window.proctorWindowPolicy(state.session).mode);
  await window.proctorApi.watchUsbEvents?.(state.session.id).catch(error => console.warn('[usb-events]', errorMessage(error)));
  if (generation !== state.monitoringGeneration || state.finishedScreenVisible) return;
  startExamConnectionDisplay();
  state.heartbeatTimer = window.setInterval(() => void heartbeatTick(), 5000);
  ensureUploadFlushTimer();
  state.mediaStateTimer = window.setInterval(() => void refreshMediaState(), 8000);
  state.liveFrameTimer = 0;
  await heartbeatTick();
  await refreshMediaState().catch(() => null);
}

async function refreshMediaState() {
  if (state.requirements?.isPublicTest && state.session?.id) {
    const result = await api(`/api/client/test-environment?sessionId=${encodeURIComponent(state.session.id)}`).catch(() => null);
    const labels = { DESKTOP_SCREEN: '屏幕', DESKTOP_CAMERA: '前置', MOBILE_CAMERA: '第二机位' };
    $('testStreamStatus').textContent = result ? result.channels.filter(item => item.channel !== 'MOBILE_CAMERA' || state.requirements?.requireSecondCamera).map(item => `${labels[item.channel]}：${item.ready ? '推流通过' : item.available ? '等待推流' : '检测暂不可用'}`).join(' · ') : '推流检测暂不可用';
  }
  const context = {
    sessionId: state.session?.id,
    generation: state.monitoringGeneration,
    serverUrl: state.serverUrl,
    sessionToken: state.sessionToken
  };
  const requestId = ++state.mediaStateRequestId;
  if (!context.sessionId || state.finishedScreenVisible || state.session.status === 'FINISHED') {
    updateLocalPreviews();
    return;
  }
  updateLocalPreviews();
  // The second device continues uploading its own audit stream, but the
  // desktop client deliberately never pulls or renders the MOBILE_CAMERA HLS
  // channel. Only the local screen and computer camera are shown here.
  const recoveryPairCode = state.mobileReconnectPairCode;
  const query = new URLSearchParams({ sessionId: context.sessionId });
  if (recoveryPairCode) query.set('recoveryPairCode', recoveryPairCode);
  const result = await api(`/api/client/media-state?${query}`);
  if (requestId !== state.mediaStateRequestId || !mobileReconnectContextIsCurrent(context)) return;
  const mobileLastSeenAt = result.session?.lastMiniProgramSeenAt ? new Date(result.session.lastMiniProgramSeenAt).getTime() : 0;
  const requireSecondCamera = Boolean(result.session?.requireSecondCamera);
  const mobileOffline = requireSecondCamera && (Boolean(result.session?.miniProgramOfflineAt) || !mobileLastSeenAt || Date.now() - mobileLastSeenAt > 15_000);
  $('mobileReconnectQr').classList.toggle('hidden', !requireSecondCamera);
  $('mobileReconnectQr').classList.toggle('offline', mobileOffline);
  $('mobileReconnectQrTitle').textContent = mobileOffline ? '第二机位已断联' : '第二机位重连';
  if (requireSecondCamera) {
    // A recovery code is one-use. Replace it as soon as a scan consumes it,
    // including repeated disconnect tests on the same phone and session.
    if (recoveryPairCode && recoveryPairCode === state.mobileReconnectPairCode &&
      (!result.recoveryPair || result.recoveryPair.claimedAt)) resetMobileReconnectQr(false);
    void ensureMobileReconnectQr();
  } else resetMobileReconnectQr();
}

function mobileReconnectContextIsCurrent(context) {
  return context.sessionId === state.session?.id
    && context.generation === state.monitoringGeneration
    && context.serverUrl === state.serverUrl
    && context.sessionToken === state.sessionToken
    && !state.finishedScreenVisible && state.session?.status !== 'FINISHED';
}

function resetMobileReconnectQr(hide = true) {
  state.mobileReconnectQrContext = null;
  state.mobileReconnectQrGenerating = false;
  state.mobileReconnectPairCode = '';
  state.mobileReconnectPairExpiresAt = 0;
  $('mobileReconnectQrImage').removeAttribute('src');
  $('mobileReconnectQrCode').textContent = '------';
  $('mobileReconnectQrStatus').textContent = '正在生成重连二维码';
  if (hide) {
    $('mobileReconnectQr').classList.add('hidden');
    $('mobileReconnectQr').classList.remove('offline');
    $('mobileReconnectQrTitle').textContent = '第二机位重连';
  }
}

async function ensureMobileReconnectQr(force = false) {
  if (!state.session?.id || !state.desktopInfo || state.finishedScreenVisible || state.session.status === 'FINISHED') return;
  if (!state.mobileReconnectQrContext || !mobileReconnectContextIsCurrent(state.mobileReconnectQrContext)) {
    resetMobileReconnectQr(false);
    state.mobileReconnectQrContext = {
      sessionId: state.session.id,
      generation: state.monitoringGeneration,
      serverUrl: state.serverUrl,
      sessionToken: state.sessionToken
    };
  }
  const context = state.mobileReconnectQrContext;
  const isCurrent = () => context === state.mobileReconnectQrContext && mobileReconnectContextIsCurrent(context);
  if (state.mobileReconnectQrGenerating) return;
  if (!force && state.mobileReconnectPairCode && state.mobileReconnectPairExpiresAt > performance.now() + 30_000) return;
  if (state.mobileReconnectPairExpiresAt <= performance.now()) {
    $('mobileReconnectQrImage').removeAttribute('src');
    $('mobileReconnectQrCode').textContent = '------';
    state.mobileReconnectPairCode = '';
  }
  state.mobileReconnectQrGenerating = true;
  $('mobileReconnectQrStatus').textContent = '正在生成重连二维码';
  const requestedAt = performance.now();
  try {
    const pair = await api('/api/client/pair', {
      method: 'POST',
      body: JSON.stringify({
        ...state.desktopInfo,
        sessionId: context.sessionId,
        screenOk: screenCaptureLive() || screenSourceUsable(),
        desktopCameraOk: cameraCaptureLive(),
        peripheralsFingerprint: state.baselineFingerprint
      })
    });
    if (!isCurrent()) return;
    // A relative server lifetime is independent of the computer's wall clock.
    // Subtract the complete request time conservatively before caching the QR.
    const serverNow = new Date(pair.serverNow).getTime();
    const lifetime = Number.isFinite(serverNow)
      ? new Date(pair.expiresAt).getTime() - serverNow
      : new Date(pair.expiresAt).getTime() - Date.now();
    const receivedAt = performance.now();
    const expiresAt = receivedAt + Math.max(0, lifetime - (receivedAt - requestedAt));
    const mobileOrigin = mobileWebsiteOrigin();
    if (!mobileOrigin) throw new Error('未配置手机第二机位页面地址');
    const url = new URL(mobileWebsiteUrl());
    url.searchParams.set('apiBase', mobileApiBase());
    url.searchParams.set('pairCode', pair.pairCode);
    url.searchParams.set('reconnect', '1');
    if (!pair.recoverySecret) throw new Error('服务器缺少安全恢复凭证，请更新监考后台');
    url.hash = 'recoverySecret=' + encodeURIComponent(pair.recoverySecret);
    const dataUrl = await window.proctorApi.createQrDataUrl(url.toString());
    if (!isCurrent()) return;
    // Decode off the visible image so a late response cannot replace another
    // session's displayed QR while its image decoding is still in progress.
    const image = new Image();
    image.src = dataUrl;
    if (typeof image.decode === 'function') await image.decode();
    if (!isCurrent()) return;
    if (!Number.isFinite(expiresAt) || expiresAt <= performance.now()) throw new Error('重连二维码已过期，请稍后重试');
    $('mobileReconnectQrImage').src = dataUrl;
    state.mobileReconnectPairCode = pair.pairCode;
    state.mobileReconnectPairExpiresAt = expiresAt;
    $('mobileReconnectQrCode').textContent = pair.pairCode;
    $('mobileReconnectQrStatus').textContent = '手机扫码后将直接恢复第二机位';
  } catch (error) {
    if (!isCurrent()) return;
    if (state.mobileReconnectPairExpiresAt <= performance.now()) {
      $('mobileReconnectQrImage').removeAttribute('src');
      $('mobileReconnectQrCode').textContent = '------';
      state.mobileReconnectPairCode = '';
    }
    $('mobileReconnectQrStatus').textContent = '二维码暂不可用';
    showError(error, '重连二维码生成失败，请稍后重试');
  } finally {
    if (context === state.mobileReconnectQrContext) state.mobileReconnectQrGenerating = false;
  }
}

function offlineDurationText() {
  if (!state.networkOfflineSince) return '';
  return formatDuration(Date.now() - state.networkOfflineSince);
}

function renderExamConnectionStatus(connection) {
  const badge = $('examConnectionStatus');
  badge.classList.toggle('hidden', !connection.active);
  badge.classList.toggle('connected', connection.phase === 'connected');
  badge.classList.toggle('offline', connection.phase === 'offline');
  $('examConnectionText').textContent = connection.phase === 'connected' ? '监考连接正常' : connection.phase === 'offline' ? `连接已断开 · ${connection.offlineSeconds} 秒 · 自动重连中` : '连接检测中…';
  const modal = $('networkWarningModal');
  const wasVisible = !modal.classList.contains('hidden');
  modal.classList.toggle('hidden', !connection.warning);
  $('networkWarningDuration').textContent = `已断开 ${connection.offlineSeconds} 秒`;
  $('networkReconnectNow').disabled = state.heartbeatBusy;
  if (connection.warning && !wasVisible) $('networkReconnectNow').focus();
  if (connection.active && connection.phase === 'offline') startReconnectLoop();
}

const examConnection = window.createExamConnectionMonitor({ changed: renderExamConnectionStatus });
function startExamConnectionDisplay() {
  if (state.connectionStatusTimer) return;
  examConnection.start();
  state.connectionStatusTimer = window.setInterval(() => examConnection.tick(), 1000);
}
function stopExamConnectionDisplay() {
  clearInterval(state.connectionStatusTimer); state.connectionStatusTimer = 0;
  examConnection.stop();
}

function setOfflineStatus(error) {
  examConnection.disconnected();
  if (!state.networkOfflineSince) state.networkOfflineSince = Date.now();
  const queuedText = '录屏片段正在本地保存，恢复连接后会自动补传';
  $('examStatus').textContent = `网络连接异常，已断开 ${offlineDurationText()}，正在第 ${state.reconnectAttempts + 1} 次重连；${queuedText}。`;
}

function stopReconnectLoop() {
  clearInterval(state.reconnectTimer);
  state.reconnectTimer = 0;
  state.reconnectAttempts = 0;
  state.networkOfflineSince = 0;
}

function startReconnectLoop() {
  if (state.reconnectTimer || !state.session || state.session.status === 'FINISHED') return;
  state.reconnectTimer = window.setInterval(() => void heartbeatTick(), 2000);
}

async function heartbeatTick() {
  if (state.testDisconnecting || state.heartbeatBusy || !state.session || state.session.status === 'FINISHED' || state.finishedScreenVisible) return;
  state.heartbeatBusy = true;
  const generation = state.monitoringGeneration;
  try {
    await sendHeartbeat();
    if (generation !== state.monitoringGeneration || state.finishedScreenVisible) return;
    void flushPendingAlerts();
    if (state.reconnectTimer || state.networkOfflineSince) {
      stopReconnectLoop();
      warnCandidate('网络已恢复，正在补传断网期间录屏。');
      $('examStatus').textContent = state.session.startedAt ? '网络已恢复，考试继续进行中' : '网络已恢复，等待确认开始考试';
    }
    void flushUploadQueue();
  } catch (error) {
    if (generation !== state.monitoringGeneration || state.finishedScreenVisible) return;
    state.reconnectAttempts += 1;
    if (!state.networkOfflineSince) void reportAlert('CLIENT_OFFLINE', 4, '客户端网络连接中断', true);
    setOfflineStatus(error);
    startReconnectLoop();
  } finally {
    state.heartbeatBusy = false;
  }
}

function normalizedSecurityList(value) {
  // Missing/failed scans are unknown, never a successful recovery observation.
  return Array.isArray(value) ? [...new Set(value)].sort() : undefined;
}

function observeLocalCondition(observed, key, active, severity, now) {
  const entry = observed[key] ||= { active: false, severity: 0 };
  if (active === undefined || active) {
    delete entry.healthySince;
    delete entry.lastHealthyAt;
    if (active === undefined) return false;
    const report = !entry.active || severity > entry.severity;
    entry.active = true;
    entry.severity = Math.max(entry.severity, severity);
    return report;
  }
  if (!entry.active) return false;
  // One empty process/DNS sample is commonly enumeration jitter. Heartbeats
  // retain every current observation, while local offline evidence only opens
  // a new episode after a sustained sequence of healthy scans.
  if (entry.lastHealthyAt === undefined || now < entry.lastHealthyAt || now - entry.lastHealthyAt > 15_000) entry.healthySince = now;
  entry.lastHealthyAt = now;
  if (now - entry.healthySince >= 30_000) {
    entry.active = false;
    entry.severity = 0;
    delete entry.healthySince;
    delete entry.lastHealthyAt;
  }
  return false;
}

function observeSecuritySnapshot(snapshot, context) {
  const scope = `${context.serverUrl}:${context.sessionId}:${context.generation}`;
  if (state.securityAlertObservation?.scope !== scope) state.securityAlertObservation = { scope };
  const observed = state.securityAlertObservation;
  const now = Date.now();
  for (const [field, type, prefix] of [
    ['disallowedProcesses', 'PROCESS_POLICY', '发现不允许的进程：'],
    ['networkRemotes', 'NETWORK_POLICY', '发现外部域名活动（来源见括号）：']
  ]) {
    const values = normalizedSecurityList(snapshot[field]);
    const active = values ? values.length > 0 : undefined;
    if (observeLocalCondition(observed, field, active, 4, now)) {
      // Keep the durable offline alert/evidence path, but only on an actual
      // scan transition. Heartbeats carry the complete current set and the
      // server merges both paths into the same ongoing incident.
      void reportAlert(type, 4, `${prefix}${values.join('、')}`, true, { transition: true }).catch(() => {});
    }
  }
  const status = snapshot.networkDomainStatus;
  const abnormal = status ? ['unavailable', 'idle'].includes(status.state) : undefined;
  const severity = status?.state === 'unavailable' ? 4 : 2;
  if (observeLocalCondition(observed, 'networkMonitor', abnormal, severity, now)) {
    void reportAlert('NETWORK_POLICY', severity,
      `整机域名检测状态：${status.message}`, false, { key: 'network-monitor', transition: true }).catch(() => {});
  }
}

async function sendHeartbeat() {
  if (!state.session) return;
  const generation = state.monitoringGeneration;
  const sessionId = state.session.id;
  const hosts = currentServerHosts();
  // OS scans can be slow on Windows. Refresh them independently so they do
  // not hold up the online heartbeat or revoke a connected candidate.
  const scanScope = `${state.serverUrl}:${sessionId}:${generation}`;
  // USB observations have their own IPC and freshness. A slow process
  // signature check must never delay a successful device observation.
  const peripheralSchedule = state.peripheralSnapshotSchedule;
  if (!state.peripheralSnapshotRequest && (!peripheralSchedule || peripheralSchedule.scope !== scanScope || Date.now() - peripheralSchedule.startedAt >= 5000)) {
    const context = { generation, sessionId, serverUrl: state.serverUrl };
    const isCurrent = () => context.generation === state.monitoringGeneration && context.sessionId === state.session?.id && context.serverUrl === state.serverUrl;
    state.peripheralSnapshotRequest = context;
    state.peripheralSnapshotSchedule = { scope: scanScope, startedAt: Date.now() };
    void window.proctorApi.getPeripheralSnapshot().then(snapshot => {
      if (isCurrent()) state.peripheralSnapshot = { ...snapshot, scope: scanScope, observedAt: Date.now() };
    }).catch(error => {
      if (isCurrent()) state.peripheralSnapshot = { peripheralScanOk: false, scope: scanScope, observedAt: Date.now() };
      console.warn('[heartbeat-peripherals]', errorMessage(error));
    }).finally(() => { if (state.peripheralSnapshotRequest === context) state.peripheralSnapshotRequest = null; });
  }
  const scanSchedule = state.heartbeatSnapshotSchedule;
  // Keep the normal five-second scan cadence during the faster two-second
  // reconnect loop, without delaying heartbeat delivery or USB observations.
  if (!state.heartbeatSnapshotRequest && (!scanSchedule || scanSchedule.scope !== scanScope || Date.now() - scanSchedule.startedAt >= 5000)) {
    const context = { generation, sessionId, serverUrl: state.serverUrl };
    state.heartbeatSnapshotRequest = context;
    state.heartbeatSnapshotSchedule = { scope: scanScope, startedAt: Date.now() };
    void window.proctorApi.getSecuritySnapshot(hosts).then(snapshot => {
      if (context.generation === state.monitoringGeneration && context.sessionId === state.session?.id && context.serverUrl === state.serverUrl) {
        state.heartbeatSnapshot = snapshot;
        state.heartbeatSnapshotFreshness = { scope: scanScope, observedAt: Date.now() };
        observeSecuritySnapshot(snapshot, context);
      }
    }).catch(error => {
      if (context.generation === state.monitoringGeneration && context.sessionId === state.session?.id && context.serverUrl === state.serverUrl) {
        state.heartbeatSnapshotFreshness = null;
        observeSecuritySnapshot({}, context);
      }
      console.warn('[heartbeat-security]', errorMessage(error));
    })
      .finally(() => { if (state.heartbeatSnapshotRequest === context) state.heartbeatSnapshotRequest = null; });
  }
  const snapshot = state.heartbeatSnapshot || {};
  // A single cached healthy result must expire before the server's ten-second
  // recovery window. Allow normal five-second scans some scheduling tolerance,
  // but treat failures or a stalled scan as unknown instead of repeating []
  // forever. USB uses its independent observation and the same expiry bound.
  const snapshotFreshness = state.heartbeatSnapshotFreshness;
  const snapshotFresh = snapshotFreshness?.scope === scanScope && Date.now() - snapshotFreshness.observedAt < 7500;
  const peripheral = state.peripheralSnapshot?.scope === scanScope ? state.peripheralSnapshot : null;
  const peripheralFresh = peripheral && Date.now() - peripheral.observedAt < 7500;
  // A slow heartbeat response can skip one polling tick. When the next tick
  // starts a fresh probe, an expired prior success is unknown until that probe
  // completes, rather than evidence of probe failure. Never extend this grace
  // to an explicit failure, and never send the stale fingerprint during it.
  const awaitingPeripheral = (!peripheral || !peripheralFresh && peripheral.peripheralScanOk === true && peripheral.peripheralsFingerprint)
    && state.peripheralSnapshotRequest
    && state.peripheralSnapshotSchedule?.scope === scanScope && Date.now() - state.peripheralSnapshotSchedule.startedAt < 7500;
  const peripheralScanOk = awaitingPeripheral ? undefined
    : Boolean(peripheralFresh && peripheral.peripheralScanOk === true && peripheral.peripheralsFingerprint);
  if (generation !== state.monitoringGeneration || state.session?.id !== sessionId || state.finishedScreenVisible) return;
  const screenCaptureOk = !!state.screenStream?.getVideoTracks().some((track) => track.readyState === 'live');
  const cameraCaptureOk = !!state.cameraStream?.getVideoTracks().some((track) => track.readyState === 'live');
  // 心跳不仅检查本地轨道，还检查对应 RTMP 管道是否已启动，避免“本地有预览但后台无流”仍显示正常。
  const screenOk = screenCaptureOk && (state.whipStartingChannels.has('DESKTOP_SCREEN') || state.rtmpStreamingChannels.has('DESKTOP_SCREEN'));
  const desktopCameraOk = cameraCaptureOk && (state.whipStartingChannels.has('DESKTOP_CAMERA') || state.rtmpStreamingChannels.has('DESKTOP_CAMERA'));
  // The authenticated heartbeat owns peripheral decisions and recording events.
  // A separate direct alert can race a fingerprint-format migration or a proctor
  // unlock and incorrectly lock the session after the server accepted its state.

  const disallowedProcesses = snapshotFresh ? normalizedSecurityList(snapshot.disallowedProcesses) : undefined;
  const abnormalNetwork = snapshotFresh ? normalizedSecurityList(snapshot.networkRemotes) : undefined;

  if (generation !== state.monitoringGeneration || state.session?.id !== sessionId || state.finishedScreenVisible) return;
  const usbEvents = await window.proctorApi.readUsbEvents?.(sessionId).catch(() => ({ available: false, events: [] }));
  if (generation !== state.monitoringGeneration || state.session?.id !== sessionId || state.finishedScreenVisible) return;
  const result = await api('/api/client/heartbeat', {
    method: 'POST',
    body: JSON.stringify({
      sessionId: state.session.id,
      deviceId: state.desktopInfo.deviceId,
      side: 'DESKTOP',
      capture: state.monitoringStarting ? undefined : { screenOk, desktopCameraOk },
      system: {
        processes: disallowedProcesses,
        networkRemotes: abnormalNetwork,
        peripheralsFingerprint: peripheralScanOk ? peripheral.peripheralsFingerprint : undefined,
        peripheralScanOk: usbEvents?.available === false ? false : peripheralScanOk,
        peripheralEvents: usbEvents?.events,
        vmSignals: snapshotFresh ? normalizedSecurityList(snapshot.vmSignals) : undefined,
        activeWindow: snapshot.activeWindow
      }
    })
  });
  if (generation !== state.monitoringGeneration || state.session?.id !== sessionId || state.finishedScreenVisible) return;
  if (result.acceptedPeripheralEventIds?.length) await window.proctorApi.acknowledgeUsbEvents?.(sessionId, result.acceptedPeripheralEventIds).catch(() => {});
  examConnection.connected();
  if (isNovaJudgeExam() && state.session.status !== 'FINISHED') void examNoticeInbox.poll({ serverUrl: state.serverUrl, sessionId });
  void flushUploadQueue();

  if (result.requirements) {
    const previouslyRequiredCamera = state.requirements?.requireFrontCamera === true;
    state.requirements = { ...state.requirements, ...result.requirements };
    for (const entry of state.recordingBuffers.values()) if (entry.sessionId === sessionId && entry.serverUrl === state.serverUrl) {
      entry.full = state.requirements.saveFullRecording === true;
      const incidents = state.requirements.saveIncidentRecording === true;
      if (entry.incidents !== incidents || !window.proctorRecordingEnabled(state.requirements)) entry.buffer.clear();
      entry.incidents = incidents;
    }
    if (!state.requirements.requireFrontCamera) {
      stopStream(state.cameraStream);
      state.cameraStream = null;
      await stopWhipChannel('DESKTOP_CAMERA');
    } else if (!previouslyRequiredCamera && !cameraCaptureLive()) {
      await ensureCameraCapture();
      startSegmentRecorders();
    }
    updateLocalPreviews();
  }

  for (const event of result.recordingEvents || []) markRecordingEvent(event);

  // 掉线重登后心跳会返回新会话并可能签发新桌面端令牌，保存以便后续请求使用
  if (result.desktopSessionToken) {
    state.sessionToken = result.desktopSessionToken;
    state.sessionServerOrigin = new URL(state.serverUrl).origin;
    window.proctorDesktopVoice?.start?.();
  }

  const wasLocked = window.proctorWindowPolicy(state.session).mode === 'locked';
  const previousSessionId = state.session.id;
  state.session = { ...state.session, ...(result.session || {}) };
  if (result.session?.peripheralsBaselineFingerprint) {
    // Also covers format migrations and an unlock that happened entirely between
    // two heartbeats, without requiring the renderer to observe the locked state.
    state.baselineFingerprint = result.session.peripheralsBaselineFingerprint;
  }
  if (state.requirements?.isPublicTest && state.session.miniProgramOfflineAt && state.testMobileOfflineAt !== state.session.miniProgramOfflineAt) {
    state.testMobileOfflineAt = state.session.miniProgramOfflineAt;
    void ensureMobileReconnectQr(true);
  }
  if (isNovaJudgeExam() && result.ojLoginRetryId && result.ojLoginRetryId !== state.ojLoginRetryId) {
    state.ojLoginRetryId = result.ojLoginRetryId;
    state.contestLoadGeneration++; state.contestPageLoading = false; state.contestPageLoaded = false; state.contestPageRetryAt = 0;
    openContestHome();
  }
  watchScreenControl();
  if (state.session.id !== previousSessionId) {
    state.rtmpStreamingChannels = new Set();
    state.rtmpFps = {};
    state.rtmpWriteFailures = {};
    state.rtmpStreaming = false;
  }
  if (state.session.status !== 'FINISHED') {
    void window.proctorDesktopMicrophone?.acquire?.();
    startSegmentRecorders();
  }
  if (state.session.status !== 'FINISHED') {
    void startRtmpStreams();
  }
  const windowPolicy = window.proctorWindowPolicy(state.session);
  const locked = windowPolicy.mode === 'locked';
  const cheatingLocked = windowPolicy.cheating;
  $('lockPanel').classList.toggle('hidden', !locked);
  $('lockReason').textContent = state.session.lockdownReason || '检测到异常行为，等待管理员网页端解锁。';
  $('cheatingActions').classList.toggle('hidden', !cheatingLocked);
  if (wasLocked && !locked && (state.session.lockdownReason || '').includes('取消')) {
    warnCandidate(state.session.lockdownReason);
  }
  if (!locked && state.session.status === 'IN_EXAM') $('examStatus').textContent = '考试进行中，监控正常';
  if (!locked && state.session.status === 'APPROVED') $('examStatus').textContent = '审核通过，等待确认开始考试';
  if (state.session.status === 'FINISHED') {
    await showFinishedScreen('本场考试已结束，无法再次进入。');
    return;
  }
  await saveRendererRecovery();
  await window.proctorApi.setWindowMode(windowPolicy.mode);
  if (wasLocked !== locked) {
    state.captureRecoveryRetries = 0;
    scheduleWindowModeCaptureRecovery();
  }
}

function recordStream(stream, channel) {
  if (!window.proctorRecordingEnabled(state.requirements)) return;
  if (!stream?.active || !state.session?.id || state.finishedScreenVisible) return;
  if (!window.MediaRecorder) {
    warnCandidate('当前客户端无法启动录像，请联系监考老师。', 'recording-unavailable');
    return;
  }
  const mimeType = window.proctorRecordingMimeTypes(state.desktopInfo?.os)
    .find((type) => MediaRecorder.isTypeSupported(type));
  const sessionId = state.session.id;
  const key = `${state.serverUrl}:${sessionId}:${channel}`;
  let entry = state.recordingBuffers.get(key);
  for (const [previous, value] of state.recordingBuffers) if (value.sessionId !== sessionId || value.serverUrl !== state.serverUrl) { value.buffer.clear(); state.recordingBuffers.delete(previous); }
  if (!entry) {
    entry = { sessionId, serverUrl: state.serverUrl, channel, full: state.requirements?.saveFullRecording === true, incidents: state.requirements?.saveIncidentRecording === true };
    entry.buffer = window.createProctorRecordingBuffer({
      saveFull: () => entry.full,
      saveIncidents: () => entry.incidents,
      onSave: async (clip, evidenceOnly) => {
        await queueUpload(clip.blob, clip.filename, { ...clip.fields, evidenceOnly: String(evidenceOnly) }, clip.context.sessionToken, clip.context.serverUrl);
        void flushUploadQueue();
      }
    });
    state.recordingBuffers.set(key, entry);
  }
  const onError = (error) => {
    console.error('[recording]', channel, error);
    warnCandidate('录像保存出现异常，正在重试；请联系监考老师。', `recording-${channel}`);
    void reportAlert(channel === 'DESKTOP_SCREEN' ? 'SCREEN_CAPTURE_LOST' : 'CAMERA_CAPTURE_LOST', 5, '监考录像编码或保存失败');
  };
  let recording;
  try {
    recording = window.createProctorRecordingStream(stream, {
      width: channel === 'DESKTOP_SCREEN' ? 1920 : 1280, height: channel === 'DESKTOP_SCREEN' ? 1080 : 720,
      frameRate: captureProfile.recordingFrameRate, onError
    });
  } catch (error) { onError(error); return; }
  const controller = window.createProctorRecordingController({
    stream: recording.stream, sourceStream: stream, channel, sessionId,
    recorderOptions: {
      ...(mimeType ? { mimeType } : {}),
      videoBitsPerSecond: channel === 'DESKTOP_SCREEN' ? captureProfile.screenBitrate : captureProfile.cameraBitrate,
      audioBitsPerSecond: captureProfile.audioBitrate
    },
    isActive: () => window.proctorRecordingEnabled(state.requirements) && !state.finishedScreenVisible && state.session?.id === sessionId &&
      window.proctorCapturePolicy(state.session, state.requirements).channels.includes(channel) &&
      stream === (channel === 'DESKTOP_SCREEN' ? state.screenStream : state.cameraStream),
    getContext: () => ({ sessionToken: state.sessionToken, serverUrl: state.serverUrl }),
    onSave: async (blob, filename, fields, context) => {
      await entry.buffer.add({ id: fields.uploadId, startedAt: fields.startedAt, endedAt: fields.endedAt, blob, filename, fields, context });
    },
    onError, onStopped: recording.stop
  });
  state.mediaRecorders.push(controller);
}

function markRecordingEvent(event) {
  if (!state.session?.id || state.requirements?.isPublicTest || state.requirements?.saveIncidentRecording !== true) return;
  for (const entry of state.recordingBuffers.values()) {
    if (entry.sessionId === state.session.id && entry.serverUrl === state.serverUrl && entry.channel === event.channel) {
      trackRecordingSave(entry.buffer.mark(event).catch(error => console.error('[recording-evidence]', error)));
    }
  }
}

function flushRecorders() {
  state.mediaRecorders.forEach((controller) => controller.flush());
}

function startSegmentRecorders() {
  if (!window.proctorRecordingEnabled(state.requirements)) {
    for (const entry of state.recordingBuffers.values()) { entry.full = false; entry.incidents = false; entry.buffer.clear(); }
    state.recordingBuffers.clear();
    void stopRecorders(); return;
  }
  const desired = new Map(window.proctorCapturePolicy(state.session, state.requirements).channels.map((channel) => [
    channel, channel === 'DESKTOP_SCREEN' ? state.screenStream : state.cameraStream
  ]));
  state.mediaRecorders = state.mediaRecorders.filter((controller) => {
    if (!controller.stopped && controller.sessionId === state.session?.id && controller.stream.active && desired.get(controller.channel) === controller.stream) return true;
    trackRecordingSave(controller.stop());
    return false;
  });
  for (const [channel, stream] of desired) {
    if (!state.mediaRecorders.some((controller) => controller.channel === channel)) recordStream(stream, channel);
  }
}

function waitForWhipIce(peer, timeoutMs = 1000) {
  if (peer.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = window.setTimeout(done, timeoutMs);
    function done() {
      window.clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange', changed);
      resolve();
    }
    function changed() {
      if (peer.iceGatheringState === 'complete') done();
    }
    peer.addEventListener('icegatheringstatechange', changed);
  });
}

function waitForWhipConnection(peer, timeoutMs = 15000) {
  if (peer.connectionState === 'connected') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => done(new Error('WebRTC 媒体连接超时')), timeoutMs);
    function cleanup() {
      window.clearTimeout(timer);
      peer.removeEventListener('connectionstatechange', changed);
    }
    function done(error) {
      cleanup();
      if (error) reject(error);
      else resolve();
    }
    function changed() {
      if (peer.connectionState === 'connected') done();
      if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
        done(new Error('WebRTC 媒体连接失败（' + peer.connectionState + '）'));
      }
    }
    peer.addEventListener('connectionstatechange', changed);
  });
}

function preferWhipH264(transceiver) {
  window.proctorPreferH264(transceiver);
}

function whipEncoding(channel) {
  const screen = channel === 'DESKTOP_SCREEN';
  return {
    maxBitrate: screen ? captureProfile.screenLiveBitrate : captureProfile.cameraLiveBitrate,
    maxFramerate: screen ? captureProfile.frameRate : captureProfile.cameraFrameRate,
  };
}

async function configureWhipSender(sender, channel) {
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length) parameters.encodings = [{}];
  Object.assign(parameters.encodings[0], whipEncoding(channel));
  // Screen text must not blur when congestion requires adaptation. Cameras
  // can trade resolution for motion; keep their bandwidth below the screen.
  parameters.degradationPreference = channel === 'DESKTOP_SCREEN' ? 'maintain-resolution' : 'maintain-framerate';
  try {
    await sender.setParameters(parameters);
  } catch {
    // Older Chromium versions may reject this optional preference. Retain
    // bitrate/fps limits even when that individual option is unsupported.
    delete parameters.degradationPreference;
    await sender.setParameters(parameters).catch(() => {});
  }
}

function whipEndpoint(sessionId, channel) {
  return apiUrl('/api/client/whip?sessionId=' + encodeURIComponent(sessionId) + '&channel=' + encodeURIComponent(channel));
}

async function publishDesktopWhip(channel, stream, attempt) {
  const peer = new RTCPeerConnection({
    iceServers: [],
    bundlePolicy: 'max-bundle'
  });
  const endpoint = whipEndpoint(attempt.sessionId, channel);
  const token = attempt.sessionToken;
  const headers = {
    'x-proctor-client': 'desktop', 'x-proctor-session-token': token, authorization: 'Bearer ' + token
  };
  let resourceEndpoint = '';
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    peer.close();
    if (resourceEndpoint) {
      const abort = new AbortController();
      const timer = window.setTimeout(() => abort.abort(), 5000);
      await fetch(resourceEndpoint, { method: 'DELETE', keepalive: true, headers, signal: abort.signal }).catch(() => {});
      window.clearTimeout(timer);
    }
  };
  const abort = () => { void stop(); };
  attempt.abort.signal.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(() => attempt.abort.abort(), 20000);
  try {
  if (attempt.abort.signal.aborted) throw new Error('推流已取消');
  const track = stream?.getVideoTracks?.()[0];
  if (!track || track.readyState !== 'live') throw new Error(channel + ' 没有可用的视频轨道');
  try { track.contentHint = channel === 'DESKTOP_SCREEN' ? 'text' : 'motion'; } catch {}
  const transceiver = peer.addTransceiver(track, {
    direction: 'sendonly', streams: [stream],
    sendEncodings: [whipEncoding(channel)]
  });
  preferWhipH264(transceiver);
  await configureWhipSender(transceiver.sender, channel);
  for (const audio of stream.getAudioTracks?.() || []) {
    if (audio.readyState !== 'live') continue;
    peer.addTransceiver(audio, { direction: 'sendonly', streams: [stream], sendEncodings: [{ maxBitrate: captureProfile.audioBitrate }] });
  }

  const offer = await peer.createOffer();
  await peer.setLocalDescription(offer);
  await waitForWhipIce(peer);
  const localSdp = peer.localDescription?.sdp;
  if (!localSdp) {
    peer.close();
    throw new Error('浏览器未生成 WebRTC SDP');
  }

  const authHeaders = {
    'content-type': 'application/sdp',
    accept: 'application/sdp',
    ...headers
  };
  const response = await fetch(endpoint, { method: 'POST', headers: authHeaders, body: localSdp, signal: attempt.abort.signal });
  if (!response.ok) {
    const message = await response.text().catch(() => '');
    peer.close();
    throw new Error(message || 'WebRTC 建连失败（' + response.status + '）');
  }

  const location = response.headers.get('location');
  resourceEndpoint = location ? new URL(location, endpoint).toString() : '';
  if (resourceEndpoint && new URL(resourceEndpoint).origin !== new URL(endpoint).origin) {
    resourceEndpoint = '';
    throw new Error('推流资源地址不属于监考服务器');
  }
  const answer = await response.text();
  await peer.setRemoteDescription({ type: 'answer', sdp: answer });
  await waitForWhipConnection(peer);
  if (attempt.abort.signal.aborted) throw new Error('推流已取消');
  return { peer, stream, stop };
  } catch (error) {
    // Remove a late-created resource even if cancellation already closed the peer.
    stopped = false;
    await stop();
    throw error;
  } finally {
    window.clearTimeout(timeout);
    attempt.abort.signal.removeEventListener('abort', abort);
  };
}

function clearWhipReconnect(channel) {
  const timer = state.whipReconnectTimers.get(channel);
  if (timer) window.clearTimeout(timer);
  state.whipReconnectTimers.delete(channel);
}

function scheduleWhipReconnect(channel) {
  const policy = window.proctorCapturePolicy(state.session, state.requirements);
  if (!policy.channels.includes(channel) || state.whipReconnectTimers.has(channel)) return;
  const timer = window.setTimeout(() => {
    state.whipReconnectTimers.delete(channel);
    void startRtmpStreams();
  }, 2500);
  state.whipReconnectTimers.set(channel, timer);
}

function setWhipChannelStatus(channel, connected) {
  if (connected) state.rtmpStreamingChannels.add(channel);
  else state.rtmpStreamingChannels.delete(channel);
  state.rtmpStreaming = state.rtmpStreamingChannels.size > 0;
  const status = connected ? 'WebRTC 直播中 · 1080p/30fps' : 'WebRTC 正在重连';
  setPreviewStatus(channel === 'DESKTOP_SCREEN' ? 'screenPreviewStatus' : 'cameraPreviewStatus', status);
}

async function stopWhipChannel(channel) {
  clearWhipReconnect(channel);
  const attempt = state.whipAttempts.get(channel);
  state.whipAttempts.delete(channel);
  state.whipStartingChannels.delete(channel);
  attempt?.abort.abort();
  const publisher = state.whipPublishers.get(channel);
  state.whipPublishers.delete(channel);
  state.rtmpStreamingChannels.delete(channel);
  state.rtmpStreaming = state.rtmpStreamingChannels.size > 0;
  if (publisher) await publisher.stop().catch(() => {});
}

async function startWhipChannel(channel, stream, attempt) {
  clearWhipReconnect(channel);
  try {
    const publisher = await publishDesktopWhip(channel, stream, attempt);
    if (state.whipAttempts.get(channel) !== attempt || state.finishedScreenVisible || state.session?.id !== attempt.sessionId ||
        !window.proctorCapturePolicy(state.session, state.requirements).channels.includes(channel)) {
      await publisher.stop();
      return;
    }
    state.whipPublishers.set(channel, publisher);
    setWhipChannelStatus(channel, true);
    publisher.peer.addEventListener('connectionstatechange', () => {
      if (state.whipPublishers.get(channel) !== publisher) return;
      const connectionState = publisher.peer.connectionState;
      if (connectionState === 'connected') {
        setWhipChannelStatus(channel, true);
      } else if (connectionState === 'failed' || connectionState === 'closed') {
        state.whipPublishers.delete(channel);
        void publisher.stop();
        setWhipChannelStatus(channel, false);
        scheduleWhipReconnect(channel);
      }
    });
  } catch (error) {
    if (state.whipAttempts.get(channel) !== attempt || attempt.abort.signal.aborted || state.finishedScreenVisible) return;
    console.warn('[webrtc:' + channel + ']', errorMessage(error));
    setWhipChannelStatus(channel, false);
    scheduleWhipReconnect(channel);
  }
}

async function startRtmpStreams() {
  if (!state.session?.id || state.session.status === 'FINISHED' || state.finishedScreenVisible || state.captureRecoveryBusy) return;
  if (state.rtmpStreamingSessionId !== state.session.id) {
    void stopWhipPublishers();
    state.rtmpStreamingSessionId = state.session.id;
  }

  const available = new Map([
    ['DESKTOP_SCREEN', screenCaptureLive() ? state.screenStream : null],
    ['DESKTOP_CAMERA', state.requirements?.requireFrontCamera && cameraCaptureLive() ? state.cameraStream : null]
  ]);
  for (const [channel, publisher] of state.whipPublishers) {
    if (available.get(channel) !== publisher.stream) void stopWhipChannel(channel);
  }
  const pending = [...available.entries()].filter(
    ([channel, stream]) => stream && !state.whipPublishers.has(channel) && !state.whipStartingChannels.has(channel)
  );
  if (!pending.length) return;

  const sessionId = state.session.id;
  pending.forEach(([channel]) => state.whipStartingChannels.add(channel));
  await Promise.allSettled(
    pending.map(async ([channel, stream]) => {
      const attempt = { sessionId, sessionToken: state.sessionToken, abort: new AbortController() };
      state.whipAttempts.set(channel, attempt);
      try {
        await startWhipChannel(channel, stream, attempt);
      } finally {
        if (state.whipAttempts.get(channel) === attempt) {
          state.whipAttempts.delete(channel);
          state.whipStartingChannels.delete(channel);
        }
      }
    })
  );
}

async function stopWhipPublishers() {
  state.whipReconnectTimers.forEach((timer) => window.clearTimeout(timer));
  state.whipReconnectTimers.clear();
  state.whipStartingChannels.clear();
  state.whipAttempts.forEach((attempt) => attempt.abort.abort());
  state.whipAttempts.clear();
  const publishers = [...state.whipPublishers.values()];
  state.whipPublishers.clear();
  state.rtmpStreamingChannels = new Set();
  state.rtmpStreaming = false;
  await Promise.all(publishers.map((publisher) => publisher.stop().catch(() => {})));
}

async function stopRtmpStreams() {
  const stopped = stopWhipPublishers();
  state.rtmpStreamingSessionId = '';
  state.rtmpFps = {};
  state.rtmpWriteFailures = {};
  await stopped;
}

function stopRecorders() {
  const pending = state.mediaRecorders.map((controller) => trackRecordingSave(controller.stop()));
  state.mediaRecorders = [];
  return Promise.allSettled(pending).then(() => {
    if (!state.session || state.session.status === 'FINISHED') {
      for (const entry of state.recordingBuffers.values()) entry.buffer.clear();
      state.recordingBuffers.clear();
    }
  });
}

function trackRecordingSave(promise) {
  state.recordingSaves.add(promise);
  void promise.finally(() => state.recordingSaves.delete(promise));
  return promise;
}

function stopMonitoringTimers() {
  window.proctorDesktopVoice?.stop?.();
  window.proctorDesktopMicrophone?.stop?.();
  stopExamConnectionDisplay();
  state.monitoringGeneration += 1;
  window.clearTimeout(state.captureRecoveryTimer);
  state.captureRecoveryTimer = 0;
  state.captureRecoveryRetries = 0;
  evidenceFlushTimers.forEach((timer) => window.clearTimeout(timer));
  evidenceFlushTimers.clear();
  void window.proctorApi.stopNetworkDomainMonitor();
  clearInterval(state.heartbeatTimer);
  clearInterval(state.mediaStateTimer);
  clearInterval(state.liveFrameTimer);
  state.heartbeatTimer = 0;
  // Final chunks arrive asynchronously after stop(); keep draining saved evidence.
  ensureUploadFlushTimer();
  state.mediaStateTimer = 0;
  state.liveFrameTimer = 0;
  state.monitoringSessionId = '';
  state.monitoringStarting = false;
  resetMobileReconnectQr();
  stopStream(state.screenStream);
  stopStream(state.cameraStream);
  state.screenStream = null;
  state.cameraStream = null;
  updateLocalPreviews();
  void stopRtmpStreams();
  stopReconnectLoop();
}

window.addEventListener('online', () => {
  void flushUploadQueue();
  void flushPendingAlerts();
  void heartbeatTick();
});

window.addEventListener('offline', () => {
  if (!state.session || state.session.status === 'FINISHED' || state.finishedScreenVisible) return;
  setOfflineStatus(new Error('本地网络已断开'));
  startReconnectLoop();
});

$('networkReconnectNow').addEventListener('click', () => void heartbeatTick());
$('networkWarningDismiss').addEventListener('click', () => examConnection.dismiss());

window.addEventListener('beforeunload', (event) => {
  if (state.mediaRecorders.some((controller) => !controller.stopped)) {
    void stopRecorders();
    stopMonitoringTimers();
  }
  if (!state.recordingSaves.size && !state.uploadFallback.size) return;
  // Native close and macOS Quit must obey the same final-chunk rule as Exit.
  event.preventDefault();
  event.returnValue = false;
  warnCandidate('最后的录像片段仍在保存，请稍候再退出客户端。', 'recording-close');
});

window.addEventListener('blur', async () => {
  if (!state.session || state.session.status === 'FINISHED') return;
  // The main process intentionally focuses its broadcast window. That focus
  // change must not be reported as a candidate switching away from the exam.
  if (await window.proctorApi.isScreenControlDisplaying().catch(() => false)) return;
  await reportAlert('SCREEN_SWITCH', 4, '客户端窗口失去焦点，疑似切屏', true);
});

const performPermissionAction = window.createPermissionActions({
  api: window.proctorApi,
  requestLocalNetwork: requestLocalNetworkPermission,
  hosts: currentServerHosts,
  probeMedia: async (target) => {
    const stream = await navigator.mediaDevices.getUserMedia(target === 'camera' ? { video: true, audio: false } : { audio: true, video: false });
    stream.getTracks().forEach((track) => track.stop());
  },
  probeScreen: async () => {
    const stream = await captureScreen();
    stream.getTracks().forEach((track) => track.stop());
    state.screenCaptureProbe = { ok: true, sourceCount: 1, verifiedFrame: true };
  }
});

async function openPermissionTarget(target) {
  if (permissionRequestTarget) return;
  permissionRequestTarget = target;
  lastPermissionTarget = target;
  permissionRefreshOnFocus = true;
  const cards = [...$('capabilityPanel').querySelectorAll('[data-permission]')];
  for (const card of cards) {
    card.setAttribute('aria-disabled', 'true');
    if (card.dataset.permission === target) {
      card.setAttribute('aria-busy', 'true');
      card.classList.add('loading');

    }
  }
  setPermissionHint('正在申请或检测所选权限，请完成弹出的系统授权。');
  let message = '';
  try {
    message = await performPermissionAction(target);
  } catch (error) {
    console.error('[permissions]', error);
    showError(error, '权限申请未完成，请再次点击对应卡片重试');
  } finally {
    permissionRequestTarget = '';
    await refreshPermissionStatus(message).catch(() => {
      setPermissionHint(message || '权限状态刷新失败，请再次点击卡片重试。');
      for (const card of cards) {
        card.setAttribute('aria-disabled', 'false');
        card.setAttribute('aria-busy', 'false');
        card.classList.remove('loading');
        if (card.dataset.permission === target) card.querySelector('span').textContent = '检测失败';
      }
    });
    updateSetupButtons();
  }
}

window.addEventListener('focus', () => {
  if (!permissionRefreshOnFocus || state.session) return;
  clearTimeout(permissionFocusTimer);
  permissionFocusTimer = window.setTimeout(() => {
    if (permissionRequestTarget) return;
    const recheck = lastPermissionTarget === 'domain' ? window.proctorApi.startNetworkDomainMonitor() : Promise.resolve();
    void recheck.then(() => refreshPermissionStatus())
      .then(() => updateSetupButtons()).catch(() => {});
  }, 300);
});

enableMonitorPreviewDrag();
enableMonitorPreviewRestoreDrag();
$('clientUpdateDownload').addEventListener('click', () => {
  $('clientUpdateDownload').disabled = true;
  void window.proctorApi.downloadClientUpdate().catch(() => {})
    .finally(() => { $('clientUpdateDownload').disabled = false; });
});
$('clientUpdateRetry').addEventListener('click', () => void ensureLatestClient(true));
$('clientUpdateExit').addEventListener('click', () => void window.proctorApi.quitApp().catch(showError));
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());
void (async () => {
  window.proctorApi.onNovaJudgeSubmitStatus?.(renderNovaJudgeSubmit);
  await window.proctorApi.getNovaJudgeSubmitStatus?.().then(renderNovaJudgeSubmit);
  state.desktopInfo = await window.proctorApi.getDesktopInfo();
  configureCaptureProfile(state.desktopInfo.os);
  const saved = await window.proctorApi.getRendererRecovery?.();
  if (saved) {
    // Keep retrying the SAME backend/session during a temporary network outage.
    // A renderer crash must not choose another server or create another login.
    const resume = async () => {
      try { await restoreRendererRecovery(saved); }
      catch (error) {
        if (/客户端会话令牌无效或已过期|未找到有效客户端会话|客户端会话不存在/.test(errorMessage(error))) await handleRevokedClientSession();
        if (state.sessionRevoked || state.finishedScreenVisible || !state.sessionToken) { $('app').inert = false; return; }
        console.warn('[renderer-recovery]', errorMessage(error));
        window.setTimeout(() => void resume(), 3000);
      }
    };
    await resume();
    return;
  }
  // A renderer hot reload starts on the setup page. Clear the previous exam's
  // browser scope before probing /api/health, then initialise in order so the
  // host allowlist cannot race the connection and permission checks.
  await window.proctorApi.setContestScope('', '').catch(() => {});
  window.proctorApi.onClientUpdate(renderClientUpdate);
  await ensureLatestClient();
  await checkServerConnection().catch(() => {});
  await refreshPermissionStatus().then(() => updateSetupButtons()).catch(() => {});
})();
$('permissionBtn').addEventListener('click', () => void runWithButtonBusy('permissionBtn', '检测中...', detectMedia));
$('submitCliRetry').addEventListener('click', () => void window.proctorApi.retryNovaJudgeSubmit());
$('permissionStatusBtn').addEventListener('click', async () => {
  await runWithButtonBusy('permissionStatusBtn', '检测中...', detectSystemPermissions);
});
$('capabilityPanel').addEventListener('click', (event) => {
  const card = event.target.closest('[data-permission]');
  if (!card) return;
  void openPermissionTarget(card.dataset.permission);
});
$('capabilityPanel').addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const card = event.target.closest('[data-permission]');
  if (!card) return;
  event.preventDefault();
  void openPermissionTarget(card.dataset.permission);
});
$('networkPermissionBtn').addEventListener('click', async () => {
  await runWithButtonBusy('networkPermissionBtn', '打开中...', async () => {
    await requestLocalNetworkPermission();
    await refreshPermissionStatus('已重新检测本地网络权限。').catch(() => null);
  });
});
$('screenPermissionBtn').addEventListener('click', async () => {
  await runWithButtonBusy('screenPermissionBtn', '打开中...', async () => {
    await window.proctorApi.openMacPrivacyPane('screen').catch(() => false);
    await refreshPermissionStatus('授权后请完全退出并重新打开客户端，再点击“检测屏幕与摄像头”。').catch(() => null);
  });
});
$('cameraPermissionBtn').addEventListener('click', async () => {
  await runWithButtonBusy('cameraPermissionBtn', '打开中...', async () => {
    const status = await window.proctorApi.getSystemPermissionStatus();
    if (status.platform === 'darwin') {
      const prompted = await window.proctorApi.askMacMediaAccess('camera').catch(() => false);
      if (!prompted) await window.proctorApi.openMacPrivacyPane('camera').catch(() => false);
    }
    if (status.platform === 'win32') await window.proctorApi.openWindowsPrivacyPane('camera').catch(() => false);
    await refreshPermissionStatus('摄像头授权后请重新点击“检测屏幕与摄像头”。').catch(() => null);
  });
});
$('microphonePermissionBtn').addEventListener('click', async () => {
  await runWithButtonBusy('microphonePermissionBtn', '打开中...', async () => {
    const status = await window.proctorApi.getSystemPermissionStatus();
    if (status.platform === 'darwin') {
      const prompted = await window.proctorApi.askMacMediaAccess('microphone').catch(() => false);
      if (!prompted) await window.proctorApi.openMacPrivacyPane('microphone').catch(() => false);
    }
    if (status.platform === 'win32') await window.proctorApi.openWindowsPrivacyPane('microphone').catch(() => false);
    await refreshPermissionStatus('麦克风授权后请重新点击“检测屏幕与摄像头”。').catch(() => null);
  });
});
$('accessibilityPermissionBtn').addEventListener('click', async () => {
  await runWithButtonBusy('accessibilityPermissionBtn', '打开中...', async () => {
    const prompted = await window.proctorApi.promptMacAccessibility().catch(() => false);
    if (!prompted) await window.proctorApi.openMacPrivacyPane('accessibility').catch(() => false);
    await refreshPermissionStatus('辅助功能授权后请完全退出并重新打开客户端。').catch(() => null);
  });
});
$('adminRelaunchBtn').addEventListener('click', () => {
  void window.proctorApi.relaunchAsAdmin().catch(showError);
});
$('pairBtn').addEventListener('click', () => void runWithButtonBusy('pairBtn', '检测中...', enterLogin));
$('qrLoginBtn').addEventListener('click', () => { selectLoginMethod('qr'); void runWithButtonBusy('qrLoginBtn', '生成中...', createPair); });
$('credentialLoginBtn').addEventListener('click', () => { clearInterval(state.pairTimer); state.pairCode = ''; selectLoginMethod('credentials'); $('loginStatus').textContent = ''; $('loginExamCode').focus(); });
$('credentialForm').addEventListener('submit', (event) => { event.preventDefault(); void runWithButtonBusy('credentialSubmitBtn', '登录中...', submitCredentialLogin); });
$('loginBackBtn').addEventListener('click', () => { $('loginPassword').value = ''; setOnly('setupPanel'); });
$('refreshPairBtn').addEventListener('click', () => void runWithButtonBusy('refreshPairBtn', '刷新中...', createPair));
$('cancelLoginRequestBtn').addEventListener('click', () => void runWithButtonBusy('cancelLoginRequestBtn', '取消中...', cancelLoginRequest));
$('monitorPreviewHide').addEventListener('click', (event) => { event.stopPropagation(); hideMonitorPreview(); });
$('monitorPreviewRestore').addEventListener('click', () => {
  if (state.monitorPreviewRestoreDragged) {
    state.monitorPreviewRestoreDragged = false;
    return;
  }
  restoreMonitorPreview();
});
$('browserRefreshBtn').addEventListener('click', refreshContestPage);
$('examNoticeConfirm').addEventListener('click', () => void examNoticeInbox.confirm());
$('browserBackBtn').addEventListener('click', () => navigateContestHistory('back'));
$('browserForwardBtn').addEventListener('click', () => navigateContestHistory('forward'));
$('browserZoomInBtn').addEventListener('click', () => setContestZoom(state.browserZoomFactor + 0.1));
$('browserZoomOutBtn').addEventListener('click', () => setContestZoom(state.browserZoomFactor - 0.1));
$('browserUrl').addEventListener('copy', (event) => event.preventDefault());
$('browserUrl').addEventListener('contextmenu', (event) => event.preventDefault());
$('browserUrl').addEventListener('dragstart', (event) => event.preventDefault());
$('testDisconnectBtn').addEventListener('click', () => void testDesktopDisconnect().catch(showError));
$('mobileReconnectQrRefresh').addEventListener('click', () => void ensureMobileReconnectQr(true));
$('novaJudgeRetryBtn').addEventListener('click', () => { state.contestPageRetryAt = 0; state.contestPageLoaded = false; openContestHome(); });
$('startBtn').addEventListener('click', () => void startExam().catch(showError));
$('finishBtn').addEventListener('click', () => void finishExam().catch(showError));
$('finishConfirmInput').addEventListener('input', () => {
  $('finishConfirmSubmit').disabled = $('finishConfirmInput').value.trim() !== $('finishConfirmExpected').textContent;
});
$('finishConfirmInput').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !$('finishConfirmSubmit').disabled) $('finishConfirmSubmit').click();
});
$('finishConfirmCancel').addEventListener('click', () => $('finishConfirmModal').classList.add('hidden'));
$('finishConfirmSubmit').addEventListener('click', () => void confirmFinishExam().catch((error) => {
  showError(error);
  $('finishConfirmSubmit').disabled = $('finishConfirmInput').value.trim() !== $('finishConfirmExpected').textContent;
}));
$('exitExamBtn').addEventListener('click', async () => {
  $('exitExamBtn').disabled = true;
  $('exitExamBtn').textContent = '正在保存录像…';
  try {
    await stopRecorders();
    await Promise.allSettled([...state.recordingSaves]);
    if (state.uploadFallback.size) throw new Error('录像尚未保存到本地磁盘，请等待上传完成后再退出');
    await window.proctorApi.setWindowMode('exit');
  } catch (error) {
    $('exitExamBtn').disabled = false;
    $('exitExamBtn').textContent = '退出考试';
    showError(error, '客户端退出失败');
  }
});
$('appealCheatingBtn').addEventListener('click', () => void appealCheating().catch(showError));
$('appealCancel').addEventListener('click', () => $('appealModal').classList.add('hidden'));
$('appealSubmit').addEventListener('click', () => void submitCheatingAppeal());
$('acceptCheatingBtn').addEventListener('click', () => void finishCheatingExam().catch(showError));

async function testDesktopDisconnect() {
  if (state.testDisconnecting || !state.requirements?.isPublicTest || !state.session?.id) return;
  state.testDisconnecting = true;
  $('testDisconnectBtn').disabled = true;
  $('testDisconnectBtn').textContent = '正在断开连接…';
  const session = state.session, requirements = state.requirements;
  stopMonitoringTimers();
  try {
    const pair = await api('/api/client/test-disconnect', { method: 'POST', body: JSON.stringify({ sessionId: session.id, deviceId: state.desktopInfo.deviceId, side: 'DESKTOP' }) });
    await stopRecorders();
    await stopRtmpStreams();
    await window.proctorApi.stopRtmpStreams().catch(() => {});
    await window.proctorApi.stopRtmpPipes().catch(() => {});
    await resetWaitingLogin('断网重连测试：已退出登录，请在两分钟内用手机扫描二维码恢复。');
    $('ojView').src = 'about:blank';
    state.pairCode = pair.pairCode;
    state.pairPollToken = pair.pollToken;
    await showPair(pair);
    $('pairTitle').textContent = '断网重连测试';
    $('pairStatus').textContent = '已退出当前连接。请使用手机扫码恢复，原体验计时继续。二维码两分钟有效。';
  } catch (error) {
    if (state.session?.id === session.id) await startSubmittedMonitoring(session, requirements).catch(() => {});
    throw error;
  } finally {
    state.testDisconnecting = false;
    $('testDisconnectBtn').disabled = false;
    $('testDisconnectBtn').textContent = '断网重连测试';
  }
}
