'use client';

import jsQR from 'jsqr';
import { ROOM_VIDEO_MIN_SECONDS, ROOM_VIDEO_MAX_SECONDS } from '@cwnupaa/proctor-shared';
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  CameraIcon,
  Check,
  ChevronRight,
  CircleStop,
  Eye,
  EyeOff,
  FlipHorizontal2,
  LoaderCircle,
  Mic,
  QrCode,
  Radio,
  RefreshCw,
  RotateCw,
  Send,
  Server,
  ShieldCheck,
  Video,
  X
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ClientApi, ClientApiError, absoluteMediaUrl, defaultApiBase, trustedApiBase, restoreBoundSession, isExpiredClientSessionError } from '@/lib/api';
import { extensionForMime, publishWhip, supportedRecordingMime, whipErrorMessage, type WhipPublisher } from '@/lib/whip';
import { readWithDeadline, startSerialPolling } from '@/lib/contest-polling';
import { deleteMediaUpload, listMediaUploads, queueMediaUpload, queuedMediaToken, type QueuedMediaUpload } from '@/lib/offline-media';
import { startSegmentRecorder } from '@/lib/segment-recorder';
import { acquireCaptureLock } from '@/lib/capture-lock';
import { cameraErrorMessage, requestCameraStream } from '@/lib/camera';
import CameraAccessPrompt from '@/components/CameraAccessPrompt';
import '@cwnupaa/proctor-shared/recording-buffer';
import type { RecordingBuffer, RecordingEvent } from '@cwnupaa/proctor-shared/recording-buffer';

type BufferedMobileClip = QueuedMediaUpload & { startedAt: string; endedAt: string };

type AppStep = 'identity' | 'materials' | 'monitor';
type CaptureMode = 'photo' | 'video' | 'qr';
type VideoRotation = 0 | 90 | 180 | 270;

interface Exam {
  isPublicTest?: boolean;
  id: string;
  examCode: string;
  name: string;
  startAt: string;
  latestStartAt: string;
  endAt: string;
  durationMinutes: number;
  contestType: 'INDIVIDUAL' | 'TEAM';
  teamAccountMode?: 'MEMBER_ACCOUNTS' | 'TEAM_ACCOUNT';
  requireMiniProgram: boolean;
  requireFrontCamera: boolean;
}

interface CandidateForm {
  examId: string;
  examCode: string;
  school: string;
  college: string;
  name: string;
  teamName: string;
  studentId: string;
  examNumber: string;
  password: string;
}

interface ClientSession {
  id: string;
  status: 'WAITING_REVIEW' | 'APPROVED' | 'IN_EXAM' | 'LOCKED' | 'OFFLINE' | 'FINISHED';
  lockdown: boolean;
  lockdownReason?: string | null;
}

interface HeartbeatResult {
  session: ClientSession;
  requirements?: RoomRequirements;
  miniProgramSessionToken?: string | null;
  recordingEvents?: RecordingEvent[];
}

interface LoginRequestResult {
  id: string;
  candidateId: string;
  sessionId: string;
  miniProgramSessionToken: string;
  requirements: RoomRequirements;
}

interface ReconnectResult {
  sessionId: string;
  session: ClientSession;
  miniProgramSessionToken: string;
  requirements: RoomRequirements;
}

interface RoomRequirements {
  saveFullRecording?: boolean;
  saveIncidentRecording?: boolean;
  isPublicTest?: boolean;
  requireSecondCamera: boolean;
  requireFrontCamera: boolean;
  loginMode: 'CREDENTIALS' | 'SECOND_CAMERA_QR';
}

interface UploadedMedia {
  segment?: { id?: string; objectPath?: string };
  stored?: { url?: string; objectPath?: string };
}

interface VoiceMessage {
  id: string;
  objectPath: string;
  createdAt: string;
}

interface PairPayload {
  type: 'CWNU_PAA_PROCTOR_PAIR';
  pairCode: string;
  serverUrl?: string;
  reconnect?: boolean;
  recoverySecret?: string;
  publicTest?: boolean;
  testSecret?: string;
}

const EMPTY_FORM: CandidateForm = {
  examId: '',
  examCode: '',
  school: '',
  college: '',
  name: '',
  teamName: '',
  studentId: '',
  examNumber: '',
  password: ''
};

const STORAGE = {
  apiBase: 'proctor.client.apiBase',
  deviceId: 'proctor.client.deviceId',
  sessionId: 'proctor.client.sessionId',
  sessionToken: 'proctor.client.sessionToken',
  sessionApiBase: 'proctor.client.sessionApiBase',
  loginRequestId: 'proctor.client.loginRequestId'
} as const;

function createDeviceId() {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : Math.random().toString(16).slice(2);
  return `web_${Date.now()}_${random}`;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((track) => track.stop());
}

async function createLandscapeStream(
  source: MediaStream,
  rotationRef: { current: VideoRotation }
) {
  const canvas = document.createElement('canvas');
  const captureStream = canvas.captureStream?.bind(canvas);
  if (!captureStream) return { stream: source, stop: () => {} };

  const sourceVideo = document.createElement('video');
  sourceVideo.muted = true;
  sourceVideo.playsInline = true;
  sourceVideo.srcObject = source;
  await sourceVideo.play();

  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) return { stream: source, stop: () => { sourceVideo.srcObject = null; } };

  let stopped = false;
  let animationFrame = 0;
  let lastRenderAt = -Infinity;
  const frameInterval = 1000 / 20;
  const render = (now = performance.now()) => {
    if (stopped) return;
    animationFrame = window.requestAnimationFrame(render);
    // captureStream limits emitted frames, but does not limit canvas work.
    // Keep rotation drawing at the same rate even on 60/120 Hz phone displays.
    if (now - lastRenderAt < frameInterval) return;
    lastRenderAt = Number.isFinite(lastRenderAt) ? now - (now - lastRenderAt) % frameInterval : now;
    const sourceWidth = sourceVideo.videoWidth || 1280;
    const sourceHeight = sourceVideo.videoHeight || 720;
    const quarterTurn = rotationRef.current === 90 || rotationRef.current === 270;
    const viewportWidth = quarterTurn ? canvas.height : canvas.width;
    const viewportHeight = quarterTurn ? canvas.width : canvas.height;
    const scale = Math.max(viewportWidth / sourceWidth, viewportHeight / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;

    context.save();
    context.fillStyle = '#000';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(rotationRef.current * Math.PI / 180);
    context.drawImage(sourceVideo, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
    context.restore();

  };
  render();

  const stream = captureStream(20);
  return {
    stream,
    stop: () => {
      stopped = true;
      window.cancelAnimationFrame(animationFrame);
      sourceVideo.pause();
      sourceVideo.srcObject = null;
      stopStream(stream);
    }
  };
}

function readPairPayload(value: string): PairPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    try {
      const url = new URL(value.trim());
      const pairCode = url.searchParams.get('pairCode') || '';
      const serverUrl = url.searchParams.get('apiBase') || url.origin;
      const publicTest = url.searchParams.get('publicTest') === '1';
      const testSecret = new URLSearchParams(url.hash.slice(1)).get('testSecret') || undefined;
      const recoverySecret = new URLSearchParams(url.hash.slice(1)).get('recoverySecret') || url.searchParams.get('recoverySecret') || undefined;
      const reconnect = url.searchParams.get('reconnect') === '1' || Boolean(recoverySecret);
      if (/^\d{6}$/.test(pairCode)) parsed = { type: 'CWNU_PAA_PROCTOR_PAIR', pairCode, serverUrl, reconnect, recoverySecret, publicTest, testSecret };
    } catch {
      // Fall through to the normal JSON payload error below.
    }
    if (!parsed) throw new Error('二维码内容不是有效的监考配对信息');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('二维码内容无效');
  const payload = parsed as Partial<PairPayload>;
  if (payload.type !== 'CWNU_PAA_PROCTOR_PAIR') throw new Error('二维码类型不正确');
  if (!payload.pairCode || !/^\d{6}$/.test(payload.pairCode)) throw new Error('二维码缺少有效配对码');
  if (payload.serverUrl && !/^https?:\/\//i.test(payload.serverUrl)) throw new Error('二维码服务器地址无效');
  if (payload.recoverySecret && !/^[a-z\d_-]{32,128}$/i.test(payload.recoverySecret)) throw new Error('重连二维码凭据无效');
  return payload as PairPayload;
}

function uploadPath(result: UploadedMedia) {
  return result.segment?.objectPath || result.stored?.url || result.stored?.objectPath || '';
}

function useObjectUrl(blob: Blob | null) {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (!blob) {
      setUrl('');
      return;
    }
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [blob]);
  return url;
}

function CaptureDialog({
  mode,
  reconnecting = false,
  onClose,
  onPhoto,
  onVideo,
  onQr
}: {
  mode: CaptureMode;
  reconnecting?: boolean;
  onClose: () => void;
  onPhoto: (blob: Blob) => void;
  onVideo: (blob: Blob) => void;
  onQr: (value: string) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const scanFrameRef = useRef(0);
  const stopTimerRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef(0);
  const cameraGenerationRef = useRef(0);
  const requestingCameraRef = useRef(false);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [nativeCapture, setNativeCapture] = useState(false);
  const [cameraPrompt, setCameraPrompt] = useState(false);
  const [requestingCamera, setRequestingCamera] = useState(false);
  const [manualPairCode, setManualPairCode] = useState('');
  const canRequestCamera = typeof window !== 'undefined' && window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia);

  const cleanup = useCallback(() => {
    cameraGenerationRef.current += 1;
    requestingCameraRef.current = false;
    window.cancelAnimationFrame(scanFrameRef.current);
    if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      // Closing/cancelling the dialog must not submit a partially captured video.
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    stopStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
  }, []);

  const openCamera = useCallback(async () => {
    if (requestingCameraRef.current) return;
    cleanup();
    const generation = cameraGenerationRef.current;
    requestingCameraRef.current = true;
    setReady(false);
    setError('');
    setCameraPrompt(false);
    setNativeCapture(false);
    setRequestingCamera(true);
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setNativeCapture(true);
      setRequestingCamera(false);
      requestingCameraRef.current = false;
      setError(!window.isSecureContext ? '当前地址不支持网页摄像头授权，请使用 HTTPS 安全地址打开。也可以使用手机系统相机完成材料拍摄。' : '当前浏览器不支持网页摄像头，请使用支持摄像头的浏览器打开。也可以使用手机系统相机完成材料拍摄。');
      setCameraPrompt(true);
      return;
    }
    try {
      const stream = await requestCameraStream({
        video: {
          facingMode: mode === 'photo' ? 'user' : { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 }
        },
        audio: mode === 'video'
      });
      if (generation !== cameraGenerationRef.current) return stopStream(stream);
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      if (generation !== cameraGenerationRef.current) return;
      setReady(true);
    } catch (cause) {
      if (generation !== cameraGenerationRef.current) return;
      cleanup();
      setNativeCapture(true);
      setError(cameraErrorMessage(cause, mode === 'video'));
      setRequestingCamera(false);
      setCameraPrompt(true);
    } finally {
      if (generation === cameraGenerationRef.current) {
        requestingCameraRef.current = false;
        setRequestingCamera(false);
      }
    }
  }, [cleanup, mode]);

  useEffect(() => {
    void openCamera();
    return cleanup;
  }, [cleanup, openCamera]);

  function retryCamera() {
    // Invoke getUserMedia in the click handler, preserving the user gesture on mobile browsers.
    void openCamera();
  }

  async function useNativeFile(file?: File) {
    if (!file) return;
    setError('');
    if (mode === 'photo') return onPhoto(file);
    if (mode === 'video') return onVideo(file);
    try {
      const canvas = canvasRef.current;
      if (!canvas) throw new Error('图片读取失败');
      let source: CanvasImageSource;
      let sourceWidth = 0;
      let sourceHeight = 0;
      let release = () => {};
      if (typeof window.createImageBitmap === 'function') {
        const bitmap = await createImageBitmap(file);
        source = bitmap;
        sourceWidth = bitmap.width;
        sourceHeight = bitmap.height;
        release = () => bitmap.close();
      } else {
        const objectUrl = URL.createObjectURL(file);
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
          const element = new Image();
          element.onload = () => resolve(element);
          element.onerror = () => reject(new Error('图片读取失败'));
          element.src = objectUrl;
        });
        source = image;
        sourceWidth = image.naturalWidth;
        sourceHeight = image.naturalHeight;
        release = () => URL.revokeObjectURL(objectUrl);
      }
      const scale = Math.min(1, 1800 / Math.max(sourceWidth, sourceHeight));
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('图片解析失败');
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      release();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      const result = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' });
      if (!result?.data) throw new Error('没有识别到二维码，请拍清楚完整二维码后重试');
      readPairPayload(result.data);
      cleanup();
      onQr(result.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '二维码识别失败');
    }
  }

  function useManualPairCode() {
    const code = manualPairCode.trim();
    if (!/^\d{6}$/.test(code)) return setError('请输入电脑客户端显示的 6 位配对码');
    cleanup();
    onQr(JSON.stringify({ type: 'CWNU_PAA_PROCTOR_PAIR', pairCode: code }));
  }

  useEffect(() => {
    if (mode !== 'qr' || !ready) return;
    let finished = false;
    const scan = () => {
      if (finished) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (context) {
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
          const result = jsQR(pixels.data, pixels.width, pixels.height, { inversionAttempts: 'attemptBoth' });
          if (result?.data) {
            try {
              readPairPayload(result.data);
              finished = true;
              cleanup();
              onQr(result.data);
              return;
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : '二维码无效');
            }
          }
        }
      }
      scanFrameRef.current = window.requestAnimationFrame(scan);
    };
    scanFrameRef.current = window.requestAnimationFrame(scan);
    return () => {
      finished = true;
      window.cancelAnimationFrame(scanFrameRef.current);
    };
  }, [cleanup, mode, onQr, ready]);

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.min(ROOM_VIDEO_MAX_SECONDS, Math.floor((Date.now() - started) / 1000))), 250);
    return () => window.clearInterval(timer);
  }, [recording]);

  function takePhoto() {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth) return setError('摄像头尚未就绪');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    context?.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        if (!blob) return setError('照片生成失败，请重试');
        cleanup();
        onPhoto(blob);
      },
      'image/jpeg',
      0.9
    );
  }

  function stopRecording() {
    if (Date.now() - recordingStartedAtRef.current < ROOM_VIDEO_MIN_SECONDS * 1000) {
      setError('请至少录制 3 秒环境视频');
      return;
    }
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
  }

  function startRecording() {
    if (recorderRef.current) return;
    const stream = streamRef.current;
    if (!stream) return setError('摄像头尚未就绪');
    const mime = supportedRecordingMime('video');
    try {
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 1_200_000, audioBitsPerSecond: 32_000 });
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = () => setError('环境视频录制失败，请重试');
      recorder.onstop = () => {
        recorderRef.current = null;
        if (stopTimerRef.current) window.clearTimeout(stopTimerRef.current);
        const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'video/webm' });
        setRecording(false);
        if (!blob.size) return setError('没有录制到视频内容，请重试');
        cleanup();
        onVideo(blob);
      };
      recorder.start(500);
      recordingStartedAtRef.current = Date.now();
      setError('');
      setSeconds(0);
      setRecording(true);
      // Leave room for the final encoded frame before the 15-second limit.
      stopTimerRef.current = window.setTimeout(stopRecording, ROOM_VIDEO_MAX_SECONDS * 1000 - 200);
    } catch (cause) {
      recorderRef.current = null;
      setError(cause instanceof Error ? cause.message : '浏览器不支持视频录制');
    }
  }

  const title = mode === 'photo' ? '拍摄手持身份证明照片' : mode === 'video' ? '录制周围环境视频' : reconnecting ? '断网重连 · 扫描客户端二维码' : '扫描电脑端配对二维码';

  return (
    <div className="capture-backdrop" role="presentation">
      <section className="capture-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <div>
            <strong>{title}</strong>
            <span>{mode === 'qr' ? reconnecting ? '扫描电脑端左下角的第二机位重连二维码，无需密码或重新拍摄材料' : '将二维码完整放入取景框' : mode === 'video' ? '录制 3–15 秒，请缓慢环绕拍摄考场' : '请确保本人和证件信息清晰可见'}</span>
          </div>
          <button className="icon-button" type="button" onClick={() => { cleanup(); onClose(); }} aria-label="关闭">
            <X size={20} />
          </button>
        </header>
        {nativeCapture ? (
          <div className="native-capture">
            {mode === 'qr' ? <QrCode size={46} /> : mode === 'video' ? <Video size={46} /> : <Camera size={46} />}
            <strong>{canRequestCamera ? '摄像头未开启' : '系统相机兼容模式'}</strong>
            <p>{mode === 'qr' ? reconnecting ? '请拍摄或选择完整二维码图片，重连不能只输入配对码。' : '可用手机系统相机拍摄电脑二维码，也可以直接输入电脑端显示的 6 位配对码。' : mode === 'video' ? '调用手机系统相机录制 3–15 秒环境视频，无需网页摄像头权限。' : '调用手机系统相机拍摄身份照片，无需网页摄像头权限。'}</p>
            <label className="primary native-capture-action">
              {mode === 'qr' ? <QrCode size={19} /> : mode === 'video' ? <Video size={19} /> : <Camera size={19} />}
              {mode === 'qr' ? '拍摄或选择二维码' : mode === 'video' ? '录制或选择视频' : '拍摄或选择照片'}
              <input
                type="file"
                accept={mode === 'video' ? 'video/*' : 'image/*'}
                capture={mode === 'photo' ? 'user' : 'environment'}
                onChange={event => void useNativeFile(event.target.files?.[0])}
              />
            </label>
            {mode === 'qr' && !reconnecting ? <div className="manual-pair-code"><span>或输入配对码</span><div><input inputMode="numeric" maxLength={6} value={manualPairCode} onChange={event => setManualPairCode(event.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="6 位配对码" /><button className="secondary" type="button" onClick={useManualPairCode}>确认绑定</button></div></div> : null}
          </div>
        ) : null}
        <div className={`capture-viewport ${mode === 'qr' ? 'qr-mode' : ''}`} hidden={nativeCapture}>
          <video ref={videoRef} muted playsInline />
          {mode === 'qr' ? <div className="qr-frame"><i /><i /><i /><i /></div> : null}
          {!ready && !error ? <div className="capture-loading"><LoaderCircle className="spin" />正在打开摄像头</div> : null}
          {recording ? <div className="recording-badge"><span /> {seconds}s / {ROOM_VIDEO_MAX_SECONDS}s</div> : null}
        </div>
        <canvas ref={canvasRef} hidden />
        {error ? <div className="inline-error"><AlertTriangle size={17} />{error}</div> : null}
        <footer>
          {nativeCapture && canRequestCamera ? <button className="primary capture-action" type="button" onClick={retryCamera} disabled={requestingCamera}><RefreshCw size={19} />重新获取摄像头权限</button> : null}
          {!nativeCapture && mode === 'photo' ? <button className="primary capture-action" type="button" disabled={!ready} onClick={takePhoto}><Camera size={19} />拍照</button> : null}
          {!nativeCapture && mode === 'video' && !recording ? <button className="primary capture-action" type="button" disabled={!ready} onClick={startRecording}><Video size={19} />开始录制</button> : null}
          {!nativeCapture && mode === 'video' && recording ? <button className="danger capture-action" type="button" disabled={seconds < ROOM_VIDEO_MIN_SECONDS} onClick={stopRecording}><CircleStop size={19} />{seconds < ROOM_VIDEO_MIN_SECONDS ? '至少录制 3 秒' : '停止并使用'}</button> : null}
          {!nativeCapture && mode === 'qr' ? <span className="scan-hint"><QrCode size={18} />正在自动识别二维码</span> : null}
        </footer>
      </section>
      {cameraPrompt ? <CameraAccessPrompt message={error} onRetry={canRequestCamera ? retryCamera : undefined} onDismiss={() => setCameraPrompt(false)} /> : null}
    </div>
  );
}

export default function CandidateApp({ configuredApiBase }: { configuredApiBase: string }) {
  const [hydrated, setHydrated] = useState(false);
  const [step, setStep] = useState<AppStep>('identity');
  const [apiBase, setApiBase] = useState(() => defaultApiBase(configuredApiBase));
  const [deviceId, setDeviceId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [loginRequestId, setLoginRequestId] = useState('');
  const [form, setForm] = useState<CandidateForm>(EMPTY_FORM);
  const [exams, setExams] = useState<Exam[]>([]);
  const [serverState, setServerState] = useState<'checking' | 'connected' | 'failed'>('checking');
  const [captureMode, setCaptureMode] = useState<CaptureMode | null>(null);
  const [identityPhoto, setIdentityPhoto] = useState<Blob | null>(null);
  const [roomVideo, setRoomVideo] = useState<Blob | null>(null);
  const [pairCode, setPairCode] = useState('');
  const [credentialTicket, setCredentialTicket] = useState('');
  const [ticketReady, setTicketReady] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [roomRequirements, setRoomRequirements] = useState<RoomRequirements | null>(null);
  const [session, setSession] = useState<ClientSession | null>(null);
  const [cameraFacing, setCameraFacing] = useState<'user' | 'environment'>('environment');
  const [videoRotation, setVideoRotation] = useState<VideoRotation>(270);
  const [previewReady, setPreviewReady] = useState(false);
  const [monitorControlsVisible, setMonitorControlsVisible] = useState(true);
  const [streamState, setStreamState] = useState<'idle' | 'connecting' | 'connected' | 'failed'>('idle');
  const [capturePermissionBlocked, setCapturePermissionBlocked] = useState(false);
  const [captureIssue, setCaptureIssue] = useState('');
  const [publisherCameraPrompt, setPublisherCameraPrompt] = useState('');
  const [recordingIssue, setRecordingIssue] = useState('');
  const [connectionLost, setConnectionLost] = useState(false);
  const [pendingReconnectCode, setPendingReconnectCode] = useState('');
  const [pendingRecoverySecret, setPendingRecoverySecret] = useState('');
  const [scannedLoginProof, setScannedLoginProof] = useState<{ code: string; secret: string } | null>(null);
  const [testPair, setTestPair] = useState<{ code: string; secret: string } | null>(null);
  const joiningPairRef = useRef(false);
  const reconnectScanRef = useRef(false);
  const [voiceState, setVoiceState] = useState('等待监考老师语音');
  const [recordingVoice, setRecordingVoice] = useState(false);
  const photoUrl = useObjectUrl(identityPhoto);
  const roomVideoUrl = useObjectUrl(roomVideo);
  const previewRef = useRef<HTMLVideoElement>(null);
  const monitorStreamRef = useRef<MediaStream | null>(null);
  const sourceCameraStreamRef = useRef<MediaStream | null>(null);
  const stopLandscapeProcessorRef = useRef<(() => void) | null>(null);
  const videoRotationRef = useRef<VideoRotation>(270);
  const publisherRef = useRef<WhipPublisher | null>(null);
  const publisherStartingRef = useRef(false);
  const connectionGenerationRef = useRef(0);
  const releaseCaptureLockRef = useRef<(() => void) | null>(null);
  const captureOwnedElsewhereRef = useRef(false);
  const publishGenerationRef = useRef(0);
  const stopClipRecorderRef = useRef<(() => Promise<void>) | null>(null);
  const recordingRequirementsRef = useRef(roomRequirements);
  recordingRequirementsRef.current = roomRequirements;
  const voiceRecorderRef = useRef<MediaRecorder | null>(null);
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceStartingRef = useRef(false);
  const voiceGenerationRef = useRef(0);
  const voiceTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const heartbeatFailuresRef = useRef(0);
  const clipUploadBusyRef = useRef(false);
  const clipUploadBackoffRef = useRef({ until: 0, failures: 0 });
  const clipUploadRetryRef = useRef(new Map<string, { at: number; apiBase: string; sessionId: string; token: string }>());
  const unsavedClipsRef = useRef(new Map<string, QueuedMediaUpload>());
  const recentClipsRef = useRef(new Map<string, QueuedMediaUpload>());
  const recordingBuffersRef = useRef(new Map<string, { full: boolean; incidents: boolean; buffer: RecordingBuffer<BufferedMobileClip> }>());
  const lastVoiceAtRef = useRef('');
  const playedVoicesRef = useRef(new Set<string>());
  const lastAlertReportsRef = useRef(new Map<string, number>());
  const pendingAlertReportsRef = useRef(new Map<string, { eventId: string; occurredAt: string; message: string }>());

  const selectedExam = useMemo(() => exams.find((exam) => exam.id === form.examId) || null, [exams, form.examId]);
  const api = useMemo(() => new ClientApi(apiBase, sessionToken), [apiBase, sessionToken]);
  const publicTest = roomRequirements?.isPublicTest === true;
  const testDisconnectingRef = useRef(false);
  const [testMediaMessage, setTestMediaMessage] = useState('正在检测实际推流…');
  const secondCameraRequired = roomRequirements?.requireSecondCamera === true;
  const sessionFinished = session?.status === 'FINISHED';

  useEffect(() => {
    return () => {
      voiceGenerationRef.current += 1;
      voiceStartingRef.current = false;
      if (voiceTimerRef.current) window.clearTimeout(voiceTimerRef.current);
      const recorder = voiceRecorderRef.current;
      voiceRecorderRef.current = null;
      if (recorder) {
        recorder.onstop = null;
        if (recorder.state !== 'inactive') recorder.stop();
      }
      stopStream(voiceStreamRef.current);
      voiceStreamRef.current = null;
      setRecordingVoice(false);
    };
  }, [sessionId, sessionFinished]);

  const clearSession = useCallback(() => {
    connectionGenerationRef.current += 1;
    Object.values(STORAGE).slice(2).forEach((key) => localStorage.removeItem(key));
    setSessionId('');
    setSessionToken('');
    setLoginRequestId('');
    setSession(null);
    setPublisherCameraPrompt('');
    setStep('identity');
  }, []);

  useEffect(() => {
    const savedBase = localStorage.getItem(STORAGE.apiBase);
    const savedDevice = localStorage.getItem(STORAGE.deviceId) || createDeviceId();
    const savedRequest = localStorage.getItem(STORAGE.loginRequestId) || '';
    const query = new URLSearchParams(window.location.search);
    const queryBase = query.get('apiBase')?.trim() || '';
    const queryPair = query.get('pairCode')?.trim() || '';
    const queryTest = query.get('publicTest') === '1';
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const testSecret = hash.get('testSecret') || '';
    const recoverySecret = hash.get('recoverySecret') || query.get('recoverySecret') || '';
    const queryReconnect = query.get('reconnect') === '1' || Boolean(recoverySecret);
    const materialTicket = queryReconnect ? '' : hash.get('credentialTicket') || '';
    if (materialTicket) {
      setCredentialTicket(materialTicket);
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    }
    let resolvedBase = trustedApiBase(configuredApiBase);
    let rejected = false;
    try { resolvedBase = trustedApiBase(configuredApiBase, queryBase || savedBase); }
    catch (cause) { rejected = true; setMessage(cause instanceof Error ? cause.message : '服务器地址无效'); }
    const restored = restoreBoundSession(localStorage, 'proctor.client', resolvedBase);
    const newTestScan = !queryReconnect && /^[A-Za-z0-9_-]{43}$/.test(testSecret) && !rejected;
    if (newTestScan && /^\d{6}$/.test(queryPair)) setScannedLoginProof({ code: queryPair, secret: testSecret });
    const newRecoveryScan = queryReconnect && /^\d{6}$/.test(queryPair) && /^[a-z\d_-]{32,128}$/i.test(recoverySecret) && !rejected;
    const replaceSavedSession = Boolean(materialTicket || rejected || newTestScan || newRecoveryScan);
    if (replaceSavedSession) clearSession();
    setApiBase(resolvedBase);
    localStorage.setItem(STORAGE.apiBase, resolvedBase);
    if (/^\d{6}$/.test(queryPair)) {
      if (newRecoveryScan) {
        setPendingReconnectCode(queryPair);
        setPendingRecoverySecret(recoverySecret);
        setMessage('正在恢复第二机位连接…');
      } else if (queryReconnect) {
        setMessage('重连二维码缺少有效恢复凭据，请扫描电脑端新生成的完整二维码');
      } else if (queryTest && /^[A-Za-z0-9_-]{43}$/.test(testSecret) && !rejected) {
        setScannedLoginProof({ code: queryPair, secret: testSecret });
        setPairCode(queryPair);
        setMessage('客户端已绑定，请填写考试编号、姓名、考号和密码。');
      } else if (queryTest && !restored.id) {
        setMessage('请输入客户端配对码');
      } else {
        setPairCode(queryPair);
        setMessage('客户端已绑定，请填写考生信息。');
      }
    }
    localStorage.setItem(STORAGE.deviceId, savedDevice);
    setDeviceId(savedDevice);
    setSessionId(replaceSavedSession ? '' : restored.id);
    setSessionToken(replaceSavedSession ? '' : restored.token);
    setLoginRequestId(replaceSavedSession || !restored.id ? '' : savedRequest);
    if (restored.id && restored.token && !replaceSavedSession) setStep('monitor');
    if (materialTicket || recoverySecret || testSecret) window.history.replaceState(null, '', window.location.pathname + window.location.search.replace(/([?&])recoverySecret=[^&]*&?/, '$1').replace(/[?&]$/, ''));
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated || !credentialTicket || ticketReady) return;
    let cancelled = false;
    setBusy('ticket');
    setMessage('正在核对电脑端登录信息…');
    void api.request<{ exam: Exam; requirements: RoomRequirements; pairCode: string; name: string; studentId: string; examNumber: string }>('/api/client/credential-login', {
      method: 'POST', body: JSON.stringify({ credentialTicket, action: 'inspect' })
    }).then(result => {
      if (cancelled) return;
      setExams(current => [...current.filter(exam => exam.id !== result.exam.id), result.exam]);
      setForm({ ...EMPTY_FORM, examId: result.exam.id, examCode: result.exam.examCode, name: result.name || '', studentId: result.studentId || '', examNumber: result.examNumber });
      setRoomRequirements(result.requirements);
      setPairCode(result.pairCode);
      setTicketReady(true);
      setServerState('connected');
      setStep('materials');
      setMessage('电脑端账号密码已验证，请完成所在考室要求的第二机位材料。');
    }).catch(cause => { if (!cancelled) setMessage(cause instanceof Error ? cause.message : '登录信息已失效，请在电脑重新登录'); })
      .finally(() => { if (!cancelled) setBusy(''); });
    return () => { cancelled = true; };
  }, [api, hydrated, credentialTicket, ticketReady]);

  const loadExams = useCallback(async () => {
    const generation = connectionGenerationRef.current;
    setServerState('checking');
    try {
      const client = new ClientApi(apiBase);
      const result = await client.request<Exam[]>('/api/client/exams');
      if (generation !== connectionGenerationRef.current || joiningPairRef.current) return;
      setExams(current => [...result, ...current.filter(item => !result.some(exam => exam.id === item.id) && new Date(item.latestStartAt).getTime() >= Date.now())]);
      setServerState('connected');
      // Loading the login page must preserve the disconnect/scan instructions.
    } catch (cause) {
      if (generation !== connectionGenerationRef.current || joiningPairRef.current) return;
      setServerState('failed');
      setMessage(cause instanceof Error ? cause.message : '连接监考服务器失败');
    }
  }, [apiBase]);

  useEffect(() => {
    if (hydrated && step === 'identity' && !credentialTicket) void loadExams();
  }, [hydrated, loadExams, step, credentialTicket]);

  useEffect(() => {
    if (!/^\d{10}$/.test(form.examCode)) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const result = await api.request<Exam[]>(`/api/client/exams?examCode=${form.examCode}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const exam = result[0];
        if (exam) setExams(current => [...current.filter(item => item.id !== exam.id), exam]);
        setForm(current => current.examCode === form.examCode ? { ...current, examId: exam?.id || '' } : current);
        setMessage(exam ? '' : '未找到该编号对应的可参加考试');
      } catch (cause) { if (!controller.signal.aborted) setMessage(cause instanceof Error ? cause.message : '考试查询失败'); }
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [form.examCode, api, testPair]);

  function updateForm(key: keyof CandidateForm, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function verifyIdentity() {
    if (!selectedExam) return setMessage('请输入有效的 10 位考试编号');
    const required: Array<[keyof CandidateForm, string]> = [
      ['name', '请输入姓名'],
      ['examNumber', '请输入考号'],
      ['password', '请输入密码']
    ];
    const missing = required.find(([key]) => !form[key].trim());
    if (missing) return setMessage(missing[1]);
    setBusy('verify');
    setMessage('');
    try {
      const verified = await api.request<{ requirements?: RoomRequirements | null }>('/api/client/candidate-verify', {
        method: 'POST',
        body: JSON.stringify({
          examCode: form.examCode, name: form.name.trim(), examNumber: form.examNumber.trim(), password: form.password
        })
      });
      setRoomRequirements(verified.requirements || null);
      setStep('materials');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '信息核对失败');
    } finally {
      setBusy('');
    }
  }

  const stopPublisher = useCallback(async () => {
    publishGenerationRef.current += 1;
    publisherStartingRef.current = false;
    const stopClipRecorder = stopClipRecorderRef.current;
    stopClipRecorderRef.current = null;
    const recordingSaved = stopClipRecorder?.();
    const publisher = publisherRef.current;
    publisherRef.current = null;
    // Release only this generation's resources before any asynchronous work.
    // A new camera may start while the previous WHIP DELETE is still pending.
    stopLandscapeProcessorRef.current?.();
    stopLandscapeProcessorRef.current = null;
    stopStream(monitorStreamRef.current);
    monitorStreamRef.current = null;
    stopStream(sourceCameraStreamRef.current);
    sourceCameraStreamRef.current = null;
    if (previewRef.current) previewRef.current.srcObject = null;
    setPreviewReady(false);
    releaseCaptureLockRef.current?.();
    releaseCaptureLockRef.current = null;
    setStreamState('idle');
    if (publisher) await publisher.stop().catch(() => {});
    await recordingSaved;
  }, []);

  const reconnectWithPair = useCallback(async (code: string, recoverySecret?: string, serverUrl?: string, testLogin = false) => {
    if (!deviceId || joiningPairRef.current) return;
    if (!testLogin && (!recoverySecret || !/^[a-z\d_-]{32,128}$/i.test(recoverySecret))) {
      setMessage('重连需要扫描电脑端完整二维码，不能只输入 6 位配对码');
      return;
    }
    joiningPairRef.current = true;
    // Ignore every heartbeat from the connection whose token is being replaced.
    connectionGenerationRef.current += 1;
    setCaptureMode(null);
    setBusy('reconnect');
    setMessage('正在恢复第二机位连接…');
    try {
      await stopPublisher();
      const nextBase = trustedApiBase(configuredApiBase, serverUrl || apiBase);
      if (testLogin || nextBase !== apiBase) {
        clearSession();
        if (testLogin) setStep('materials');
      }
      setApiBase(nextBase);
      localStorage.setItem(STORAGE.apiBase, nextBase);
      let payload: BodyInit;
      if (testLogin) {
        if (!identityPhoto || !roomVideo) throw new Error('请拍摄手持身份证明照片并录制环境视频');
        const materials = new FormData();
        Object.entries({ pairCode: code, deviceId, examCode: form.examCode, name: form.name.trim(), examNumber: form.examNumber.trim(), password: form.password }).forEach(([key, value]) => materials.append(key, value));
        if (recoverySecret) materials.append('testSecret', recoverySecret);
        materials.append('identityPhoto', identityPhoto, 'identity.jpg');
        materials.append('roomVideo', roomVideo, `room.${extensionForMime(roomVideo.type)}`);
        payload = materials;
      } else payload = JSON.stringify({ pairCode: code, recoverySecret, deviceId });
      const result = await new ClientApi(nextBase).request<ReconnectResult>(testLogin ? '/api/client/public-test-login' : '/api/client/reconnect', {
        method: 'POST',
        body: payload
      });
      connectionGenerationRef.current += 1;
      localStorage.removeItem(STORAGE.loginRequestId);
      setLoginRequestId('');
      localStorage.setItem(STORAGE.sessionId, result.sessionId);
      localStorage.setItem(STORAGE.sessionToken, result.miniProgramSessionToken);
      localStorage.setItem(STORAGE.sessionApiBase, nextBase);
      setTestPair(null);
      setScannedLoginProof(null);
      setIdentityPhoto(null);
      setRoomVideo(null);
      setCredentialTicket('');
      setTicketReady(false);
      setForm(current => ({ ...current, password: '' }));
      setSessionId(result.sessionId);
      setSessionToken(result.miniProgramSessionToken);
      setSession(result.session);
      setRoomRequirements(result.requirements);
      setPairCode(code);
      setConnectionLost(false);
      setCapturePermissionBlocked(false);
      setCaptureIssue('');
      setStreamState('idle');
      setCaptureMode(null);
      setStep('monitor');
      setMessage(testLogin ? '登录成功，正在连接第二机位…' : result.requirements.requireSecondCamera ? '会话已恢复，正在重新连接第二机位视频…' : '会话已恢复，本考室不要求第二机位');
    } catch (cause) {
      if (!testLogin) { setConnectionLost(true); setStreamState('failed'); }
      setMessage(cause instanceof Error ? cause.message : '第二机位重连失败');
    } finally {
      joiningPairRef.current = false;
      setBusy('');
      setPendingReconnectCode('');
      setPendingRecoverySecret('');
    }
  }, [apiBase, clearSession, configuredApiBase, deviceId, form.examCode, form.name, form.examNumber, form.password, identityPhoto, roomVideo, stopPublisher]);

  useEffect(() => {
    if (!pendingReconnectCode || !deviceId) return;
    void reconnectWithPair(pendingReconnectCode, pendingRecoverySecret);
  }, [deviceId, pendingReconnectCode, pendingRecoverySecret, reconnectWithPair]);

  const recoverDesktopWithPair = useCallback(async (code: string, secret?: string, serverUrl?: string) => {
    if (joiningPairRef.current) return;
    if (!sessionId || !sessionToken || !secret || !/^[A-Za-z0-9_-]{43}$/.test(secret)) {
      setCaptureMode(null);
      setMessage('恢复电脑登录需要使用仍在监考中的第二机位扫描完整登录二维码；第二机位掉线请扫描在线客户端左下角的重连二维码。');
      return;
    }
    joiningPairRef.current = true;
    connectionGenerationRef.current += 1;
    setCaptureMode(null);
    setBusy('reconnect');
    setMessage('正在恢复电脑客户端登录…');
    try {
      const nextBase = trustedApiBase(configuredApiBase, serverUrl || apiBase);
      if (nextBase !== apiBase) throw new Error('请扫描本场考试客户端的登录二维码');
      const result = await new ClientApi(nextBase, sessionToken).request<Omit<ReconnectResult, 'miniProgramSessionToken'>>('/api/client/reconnect', {
        method: 'POST', body: JSON.stringify({ side: 'DESKTOP', sessionId, deviceId, pairCode: code, recoverySecret: secret }),
      });
      setSession(result.session);
      setRoomRequirements(result.requirements);
      setStreamState('idle');
      setConnectionLost(false);
      setMessage('电脑客户端登录已恢复，第二机位继续监考。');
    } catch (cause) {
      setStreamState('failed');
      setMessage(cause instanceof Error ? cause.message : '电脑客户端重连失败');
    } finally {
      joiningPairRef.current = false;
      setBusy('');
    }
  }, [apiBase, configuredApiBase, deviceId, sessionId, sessionToken]);

  const acceptQr = useCallback((raw: string) => {
    try {
      const payload = readPairPayload(raw);
      // Recovery grants restore the existing session before any initial-login
      // flags or cached identity/material state can select a different flow.
      if (payload.reconnect || payload.recoverySecret) {
        if (!payload.recoverySecret) throw new Error('请扫描电脑端左下角完整的第二机位重连二维码，不能只输入配对码');
        void reconnectWithPair(payload.pairCode, payload.recoverySecret, payload.serverUrl);
        reconnectScanRef.current = false;
        return;
      }
      const reconnectIntent = reconnectScanRef.current || step === 'monitor';
      if (reconnectIntent) {
        if (!sessionId || !sessionToken) throw new Error('请扫描已登录电脑客户端左下角的第二机位重连二维码，恢复连接无需密码或重新拍摄材料');
        void recoverDesktopWithPair(payload.pairCode, payload.testSecret, payload.serverUrl);
        reconnectScanRef.current = false;
        return;
      }
      if (payload.serverUrl) {
        const normalized = trustedApiBase(configuredApiBase, payload.serverUrl);
        if (normalized !== apiBase) clearSession();
        setApiBase(normalized);
        localStorage.setItem(STORAGE.apiBase, normalized);
      }
      if (payload.testSecret && /^[A-Za-z0-9_-]{43}$/.test(payload.testSecret)) setScannedLoginProof({ code: payload.pairCode, secret: payload.testSecret });
      else setScannedLoginProof(null);
      if (payload.publicTest) {
        if (!payload.testSecret || !/^[A-Za-z0-9_-]{43}$/.test(payload.testSecret)) throw new Error('请扫描完整的公开测试二维码');
        setTestPair({ code: payload.pairCode, secret: payload.testSecret });
        setPairCode(payload.pairCode);
        setCaptureMode(null);
        setStep('identity');
        setMessage('客户端已绑定，请填写考试编号、姓名、考号和密码。');
        return;
      }
      setTestPair(null);
      setPairCode(payload.pairCode);
      setCaptureMode(null);
      setMessage('电脑端配对二维码识别成功');
    } catch (cause) {
      setCaptureMode(null);
      reconnectScanRef.current = false;
      setMessage(cause instanceof Error ? cause.message : '二维码无效');
    }
  }, [apiBase, clearSession, configuredApiBase, reconnectWithPair, recoverDesktopWithPair, sessionId, sessionToken, step]);

  async function submitLoginRequest() {
    const requireSecondCamera = roomRequirements?.requireSecondCamera ?? selectedExam?.requireMiniProgram;
    if (requireSecondCamera && !identityPhoto) return setMessage('请拍摄手持身份证明照片');
    if (requireSecondCamera && !roomVideo) return setMessage('请录制周围环境视频');
    if (roomRequirements?.isPublicTest || selectedExam?.isPublicTest) {
      const grant = testPair || scannedLoginProof;
      if (!/^\d{6}$/.test(pairCode)) return setMessage('请输入客户端显示的 6 位配对码');
      await reconnectWithPair(pairCode, grant?.code === pairCode ? grant.secret : undefined, undefined, true);
      return;
    }
    if (!selectedExam) return setMessage('考试信息已失效，请返回重新选择');
    if (!pairCode) return setMessage('请输入客户端配对码');
    setBusy('submit');
    setMessage('正在上传审核材料…');
    try {
      let identityPhotoPath = '';
      let roomVideoPath = '';
      let identityPhotoMediaId = '';
      let roomVideoMediaId = '';
      const materialAuthorization = identityPhoto || roomVideo
        ? await new ClientApi(apiBase).request<{ uploadTicket: string }>('/api/client/material-upload-ticket', {
          method: 'POST',
          body: JSON.stringify(credentialTicket
            ? { credentialTicket, pairCode, miniProgramDeviceId: deviceId }
            : { ...form, pairCode, miniProgramDeviceId: deviceId }),
        })
        : null;
      const uploadTicket = materialAuthorization?.uploadTicket;
      if (identityPhoto) {
        const uploaded = await api.upload<UploadedMedia>('/api/client/upload', identityPhoto, `identity-${Date.now()}.jpg`, {
          examId: selectedExam.id,
          channel: 'IDENTITY_PHOTO',
          uploadTicket: uploadTicket!,
        }, { 'x-proctor-upload-ticket': uploadTicket! });
        identityPhotoPath = uploadPath(uploaded);
        identityPhotoMediaId = uploaded.segment?.id || '';
      }
      if (roomVideo) {
        const mime = roomVideo.type || 'video/webm';
        const uploaded = await api.upload<UploadedMedia>(
          '/api/client/upload',
          roomVideo,
          `room-${Date.now()}.${extensionForMime(mime)}`,
          { examId: selectedExam.id, channel: 'ROOM_VIDEO', uploadTicket: uploadTicket! },
          { 'x-proctor-upload-ticket': uploadTicket! },
        );
        roomVideoPath = uploadPath(uploaded);
        roomVideoMediaId = uploaded.segment?.id || '';
      }
      const result = await api.request<LoginRequestResult>(credentialTicket ? '/api/client/credential-login' : '/api/login-requests', {
        method: 'POST',
        body: JSON.stringify(credentialTicket ? {
          credentialTicket, miniProgramDeviceId: deviceId, identityPhotoPath, roomVideoPath,
          uploadTicket, identityPhotoMediaId, roomVideoMediaId,
        } : {
          ...form,
          pairCode,
          miniProgramDeviceId: deviceId,
          teamName: selectedExam.contestType === 'TEAM' ? form.teamName : undefined,
          identityPhotoPath: identityPhotoPath || undefined,
          roomVideoPath: roomVideoPath || undefined,
          uploadTicket, identityPhotoMediaId: identityPhotoMediaId || undefined, roomVideoMediaId: roomVideoMediaId || undefined,
        })
      });
      localStorage.setItem(STORAGE.sessionId, result.sessionId);
      localStorage.setItem(STORAGE.sessionToken, result.miniProgramSessionToken);
      localStorage.setItem(STORAGE.sessionApiBase, apiBase);
      localStorage.setItem(STORAGE.loginRequestId, result.id);
      setSessionId(result.sessionId);
      setSessionToken(result.miniProgramSessionToken);
      setLoginRequestId(result.id);
      setSession({ id: result.sessionId, status: 'WAITING_REVIEW', lockdown: false });
      setRoomRequirements(result.requirements);
      setStep('monitor');
      setMessage('登录请求已提交，等待监考老师审核');
      window.scrollTo({ top: 0 });
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '提交登录请求失败');
    } finally {
      setBusy('');
    }
  }

  const reportAlert = useCallback(
    async (type: 'SCREEN_SWITCH' | 'MOBILE_CAMERA_LOST', alertMessage: string) => {
      if (publicTest || !sessionId || !sessionToken || captureOwnedElsewhereRef.current) return;
      const now = Date.now();
      const key = `${sessionId}:${type}`;
      const lastAt = lastAlertReportsRef.current.get(key) || 0;
      if (now - lastAt < 5 * 60_000) return;
      lastAlertReportsRef.current.set(key, now);
      const event = pendingAlertReportsRef.current.get(key) || { eventId: crypto.randomUUID(), occurredAt: new Date(now).toISOString(), message: alertMessage };
      pendingAlertReportsRef.current.set(key, event);
      const entry = recordingBuffersRef.current.get(`${apiBase}:${sessionId}`);
      if (entry) void entry.buffer.mark({ id: event.eventId, occurredAt: event.occurredAt }).catch(() => {});
      const reported = await new ClientApi(apiBase, sessionToken)
        .request('/api/client/alerts', {
          method: 'POST',
          body: JSON.stringify({ sessionId, type, severity: 4, ...event })
        })
        .then(() => true)
        .catch(() => false);
      if (reported) pendingAlertReportsRef.current.delete(key);
      else if (lastAlertReportsRef.current.get(key) === now) lastAlertReportsRef.current.delete(key);
    },
    [apiBase, sessionId, sessionToken, publicTest]
  );

  useEffect(() => {
    if (step !== 'monitor' || !sessionId || !sessionToken) return;
    const timer = window.setInterval(() => {
      for (const [key, event] of pendingAlertReportsRef.current) {
        if (!key.startsWith(`${sessionId}:`)) continue;
        const type = key.slice(sessionId.length + 1);
        if (type === 'SCREEN_SWITCH' || type === 'MOBILE_CAMERA_LOST') void reportAlert(type, event.message);
      }
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [reportAlert, sessionId, sessionToken, step]);

  const flushClipUploads = useCallback(async () => {
    if (clipUploadBusyRef.current || performance.now() < clipUploadBackoffRef.current.until) return;
    clipUploadBusyRef.current = true;
    try {
      const deferred = new Set<string>();
      for (const [id, retry] of clipUploadRetryRef.current) {
        if (retry.apiBase === apiBase && retry.sessionId === sessionId && retry.token !== sessionToken) clipUploadRetryRef.current.delete(id);
        else if (retry.at > performance.now()) deferred.add(id);
      }
      const queued = await listMediaUploads(deferred, 8, apiBase).catch(() => []);
      const savedIds = new Set([...queued.map(item => item.id), ...recentClipsRef.current.keys()]);
      const pending = new Map(queued.map(item => [item.id, item]));
      for (const [id, item] of recentClipsRef.current) {
        if (!deferred.has(id) && item.apiBase === apiBase) pending.set(id, item);
      }
      for (const [id, item] of unsavedClipsRef.current) {
        if (!deferred.has(id) && (!item.apiBase || item.apiBase === apiBase)) pending.set(id, item);
      }
      let attempts = 0;
      const priority = (item: QueuedMediaUpload) => item.apiBase === apiBase && item.fields.sessionId === sessionId
        && (recentClipsRef.current.has(item.id) || unsavedClipsRef.current.has(item.id)) ? 0 : 1;
      for (const item of [...pending.values()].sort((left, right) => priority(left) - priority(right) || left.createdAt - right.createdAt)) {
        if (attempts++ >= 8) break;
        let targetBase = item.apiBase || apiBase, token = item.token;
        try {
          targetBase = trustedApiBase(configuredApiBase, item.apiBase || apiBase);
          token = queuedMediaToken({ ...item, apiBase: targetBase }, { apiBase, sessionId, token: sessionToken });
          await new ClientApi(targetBase, token).upload('/api/client/upload', item.blob, item.filename, {
            ...item.fields,
            uploadId: item.fields.uploadId || item.id
          });
          if (savedIds.has(item.id)) await deleteMediaUpload(item.id);
          unsavedClipsRef.current.delete(item.id);
          recentClipsRef.current.delete(item.id);
          clipUploadRetryRef.current.delete(item.id);
          clipUploadBackoffRef.current = { until: 0, failures: 0 };
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : '';
          if (cause instanceof ClientApiError && [401, 403, 404, 410].includes(cause.status)
            || /补传窗口已关闭|令牌无效|考试已结束|客户端会话不存在/.test(reason)) {
            // Authorization expiry must not destroy the only saved copy.
            clipUploadRetryRef.current.set(item.id, { at: performance.now() + 60_000 + Math.random() * 10_000,
              apiBase: targetBase, sessionId: item.fields.sessionId, token });
            continue;
          }
          const failures = Math.min(clipUploadBackoffRef.current.failures + 1, 4);
          clipUploadBackoffRef.current = { failures, until: performance.now() + Math.min(30_000, 2000 * 2 ** failures) * (0.75 + Math.random() * 0.5) };
          break;
        }
      }
    } finally {
      clipUploadBusyRef.current = false;
    }
  }, [apiBase, configuredApiBase, sessionId, sessionToken]);

  const startClipRecorder = useCallback(
    (stream: MediaStream, generation: number) => {
      if (!globalThis.proctorRecordingEnabled(recordingRequirementsRef.current)) return;
      const mime = supportedRecordingMime('video');
      if (!sessionId || !sessionToken) return;
      if (!mime) {
        setRecordingIssue('当前浏览器无法保存第二机位录像，请更换支持录像的浏览器并联系监考老师');
        void reportAlert('MOBILE_CAMERA_LOST', '浏览器不支持第二机位录像保存');
        return;
      }
      setRecordingIssue('');
      stopClipRecorderRef.current?.();
      const key = `${apiBase}:${sessionId}`;
      for (const [previous, value] of recordingBuffersRef.current) if (previous !== key) { value.buffer.clear(); recordingBuffersRef.current.delete(previous); }
      let entry = recordingBuffersRef.current.get(key);
      if (!entry) {
        const value = { full: recordingRequirementsRef.current?.saveFullRecording === true, incidents: recordingRequirementsRef.current?.saveIncidentRecording === true, buffer: null as unknown as RecordingBuffer<BufferedMobileClip> };
        value.buffer = globalThis.createProctorRecordingBuffer<BufferedMobileClip>({
          saveFull: () => value.full,
          saveIncidents: () => value.incidents,
          onSave: async (clip, evidenceOnly) => {
            const item = { ...clip, fields: { ...clip.fields, evidenceOnly: String(evidenceOnly) } };
            try {
              await queueMediaUpload(item);
              recentClipsRef.current.set(item.id, item);
              while (recentClipsRef.current.size > 8) {
                const oldest = recentClipsRef.current.keys().next().value;
                if (oldest === undefined) break;
                recentClipsRef.current.delete(oldest);
              }
            }
            catch {
              unsavedClipsRef.current.set(item.id, item);
              setRecordingIssue('录像暂存失败，正在尝试直接补传；请保持页面开启、检查手机存储空间并联系监考老师');
              void reportAlert('MOBILE_CAMERA_LOST', '第二机位录像本地暂存失败，正在尝试直接补传');
            }
            void flushClipUploads();
          }
        });
        entry = value;
        recordingBuffersRef.current.set(key, entry);
      }
      const onError = () => {
        setRecordingIssue('第二机位录像保存异常，请重新连接摄像头或联系监考老师');
        void reportAlert('MOBILE_CAMERA_LOST', '第二机位录像保存异常，需重新连接摄像头');
      };
      let recording: ReturnType<typeof globalThis.createProctorRecordingStream>;
      try { recording = globalThis.createProctorRecordingStream(stream, { width: 1280, height: 720, frameRate: 20, onError }); }
      catch { onError(); return; }
      stopClipRecorderRef.current = startSegmentRecorder({
        stream: recording.stream,
        mimeType: mime,
        isCurrent: () => generation === publishGenerationRef.current,
        onClip: ({ blob, startedAt, endedAt }) => {
          const uploadId = crypto.randomUUID();
          const item: QueuedMediaUpload = {
            id: uploadId,
            createdAt: Date.now(),
            blob,
            filename: `mobile-${uploadId}.${extensionForMime(blob.type)}`,
            fields: { sessionId, channel: 'MOBILE_CAMERA', uploadId, startedAt, endedAt },
            token: sessionToken,
            apiBase
          };
          return entry.buffer.add({ ...item, startedAt, endedAt }).catch(onError);
        },
        onError, onStopped: recording.stop
      });
    },
    [apiBase, flushClipUploads, reportAlert, sessionId, sessionToken]
  );

  useEffect(() => {
    const entry = recordingBuffersRef.current.get(`${apiBase}:${sessionId}`);
    if (entry) {
      entry.full = roomRequirements?.saveFullRecording === true;
      const incidents = roomRequirements?.saveIncidentRecording === true;
      if (entry.incidents !== incidents || !globalThis.proctorRecordingEnabled(roomRequirements)) entry.buffer.clear();
      entry.incidents = incidents;
    }
    // Changing recording options leaves the camera and its live publisher running.
    if (!globalThis.proctorRecordingEnabled(roomRequirements) || step !== 'monitor' || sessionFinished || captureMode) {
      if (!globalThis.proctorRecordingEnabled(roomRequirements)) recordingBuffersRef.current.delete(`${apiBase}:${sessionId}`);
      const stop = stopClipRecorderRef.current;
      stopClipRecorderRef.current = null;
      void stop?.();
      setRecordingIssue('');
      return;
    }
    const stream = monitorStreamRef.current;
    if (stream?.active && !stopClipRecorderRef.current) startClipRecorder(stream, publishGenerationRef.current);
  }, [apiBase, sessionId, roomRequirements?.saveFullRecording, roomRequirements?.saveIncidentRecording, publicTest, step, sessionFinished, captureMode, streamState, startClipRecorder]);

  const startPublisher = useCallback(async () => {
    if (joiningPairRef.current || testDisconnectingRef.current || !secondCameraRequired || !sessionId || !sessionToken || sessionFinished || captureMode || publisherStartingRef.current || publisherRef.current) return;
    const generation = ++publishGenerationRef.current;
    publisherStartingRef.current = true;
    captureOwnedElsewhereRef.current = false;
    setCaptureIssue('');
    setPublisherCameraPrompt('');
    setStreamState('connecting');
    setMessage((current) => current || '正在连接第二机位视频…');
    let requestingCamera = false;
    try {
      const releaseLock = await acquireCaptureLock(`${apiBase}:${sessionId}`);
      if (generation !== publishGenerationRef.current) return releaseLock?.();
      if (!releaseLock) {
        captureOwnedElsewhereRef.current = true;
        setCapturePermissionBlocked(true);
        setStreamState('failed');
        setCaptureIssue('另一个网页已开启本场第二机位，请关闭重复页面后重新推流');
        return;
      }
      releaseCaptureLockRef.current = releaseLock;
      requestingCamera = true;
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setCapturePermissionBlocked(true);
        throw new Error('登录已支持局域网 HTTP；当前考室要求实时第二机位，手机浏览器仅允许在 HTTPS 下持续使用摄像头');
      }
      const sourceStream = await requestCameraStream({
        video: {
          facingMode: { ideal: cameraFacing },
          width: { ideal: 1280, max: 1280 },
          height: { ideal: 720, max: 720 },
          frameRate: { ideal: 20, max: 20 }
        },
        audio: false
      });
      if (generation !== publishGenerationRef.current) return stopStream(sourceStream);
      setCapturePermissionBlocked(false);
      sourceCameraStreamRef.current = sourceStream;
      const landscape = await createLandscapeStream(sourceStream, videoRotationRef);
      if (generation !== publishGenerationRef.current) {
        landscape.stop();
        stopStream(sourceStream);
        return;
      }
      const stream = landscape.stream;
      stopLandscapeProcessorRef.current = landscape.stop;
      monitorStreamRef.current = stream;
      sourceStream.getVideoTracks().forEach((track) => {
        track.addEventListener('ended', () => {
          if (generation !== publishGenerationRef.current) return;
          setStreamState('failed');
          void reportAlert('MOBILE_CAMERA_LOST', '浏览器第二机位摄像头轨道已停止');
        });
      });
      if (previewRef.current) {
        previewRef.current.srcObject = stream;
        await previewRef.current.play().catch(() => {});
      }
      if (generation !== publishGenerationRef.current) return;
      if (!publicTest) startClipRecorder(stream, generation);
      const client = new ClientApi(apiBase, sessionToken);
      const publisher = await publishWhip({
        endpoint: client.whipEndpoint(sessionId),
        stream,
        token: sessionToken,
        onStateChange: (state) => {
          if (generation !== publishGenerationRef.current) return;
          if (state === 'connected') {
            reconnectAttemptsRef.current = 0;
            setStreamState('connected');
          }
          if (state === 'failed' || state === 'disconnected') setStreamState('failed');
        }
      });
      if (generation !== publishGenerationRef.current) return void publisher.stop();
      publisherRef.current = publisher;
      reconnectAttemptsRef.current = 0;
      setStreamState('connected');
    } catch (cause) {
      if (generation !== publishGenerationRef.current) return;
      const cameraFailed = !sourceCameraStreamRef.current;
      void stopPublisher();
      setStreamState('failed');
      const acquisitionFailed = requestingCamera && cameraFailed;
      const reason = acquisitionFailed && window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function'
        ? cameraErrorMessage(cause)
        : whipErrorMessage(cause);
      if (acquisitionFailed) {
        // Each acquisition failure needs a fresh user retry, rather than a background prompt loop.
        setCapturePermissionBlocked(true);
        setPublisherCameraPrompt(reason);
      }
      setCaptureIssue(reason);
      setMessage(reason);
      void reportAlert('MOBILE_CAMERA_LOST', `浏览器第二机位采集或 WHIP 推流异常：${reason}`);
    } finally {
      if (generation === publishGenerationRef.current) publisherStartingRef.current = false;
    }
  }, [publicTest, apiBase, cameraFacing, captureMode, reportAlert, secondCameraRequired, sessionFinished, sessionId, sessionToken, startClipRecorder, stopPublisher]);

  useEffect(() => {
    if (step !== 'monitor' || !sessionId || !sessionToken || !secondCameraRequired || sessionFinished || captureMode) {
      void stopPublisher();
      return;
    }
    void startPublisher();
    return () => {
      void stopPublisher();
    };
  }, [captureMode, secondCameraRequired, sessionFinished, sessionId, sessionToken, startPublisher, step, stopPublisher]);

  useEffect(() => {
    if (!secondCameraRequired || step !== 'monitor' || streamState !== 'failed' || sessionFinished || captureMode || capturePermissionBlocked) return;
    reconnectAttemptsRef.current += 1;
    const delay = Math.min(15_000, 2_000 * 2 ** Math.min(reconnectAttemptsRef.current - 1, 3)) * (0.75 + Math.random() * 0.5);
    const timer = window.setTimeout(() => {
      const stopped = stopPublisher();
      const generation = publishGenerationRef.current;
      void stopped.then(() => { if (generation === publishGenerationRef.current) return startPublisher(); });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [captureMode, capturePermissionBlocked, secondCameraRequired, sessionFinished, startPublisher, step, stopPublisher, streamState]);

  const heartbeat = useCallback(async (signal: AbortSignal) => {
    if (joiningPairRef.current || testDisconnectingRef.current || !sessionId || !sessionToken || !deviceId || captureOwnedElsewhereRef.current) return;
    const generation = connectionGenerationRef.current;
    try {
      const result = await readWithDeadline(requestSignal => new ClientApi(apiBase, sessionToken).request<HeartbeatResult>('/api/client/heartbeat', {
        signal: requestSignal,
        method: 'POST',
        body: JSON.stringify({
          sessionId,
          deviceId,
          side: 'MINIPROGRAM',
          capture: { mobileCameraOk: !secondCameraRequired || streamState === 'connected' }
        })
      }), signal, 10_000);
      if (signal.aborted || generation !== connectionGenerationRef.current || joiningPairRef.current || testDisconnectingRef.current) return;
      heartbeatFailuresRef.current = 0;
      if (result.miniProgramSessionToken && result.miniProgramSessionToken !== sessionToken) {
        localStorage.setItem(STORAGE.sessionToken, result.miniProgramSessionToken);
        setSessionToken(result.miniProgramSessionToken);
      }
      setConnectionLost(false);
      setSession(result.session);
      if (result.requirements) setRoomRequirements(result.requirements);
      const entry = recordingBuffersRef.current.get(`${apiBase}:${sessionId}`);
      if (entry) {
        if (result.requirements) {
          entry.full = result.requirements.saveFullRecording === true;
          const incidents = result.requirements.saveIncidentRecording === true;
          if (entry.incidents !== incidents || !globalThis.proctorRecordingEnabled(result.requirements)) entry.buffer.clear();
          entry.incidents = incidents;
        }
        if (entry.incidents) for (const event of result.recordingEvents || []) if (event.channel === 'MOBILE_CAMERA') void entry.buffer.mark(event).catch(() => {});
      }
      void flushClipUploads();
      if (result.session.status === 'FINISHED') {
        await stopPublisher();
        if (signal.aborted || generation !== connectionGenerationRef.current || joiningPairRef.current || testDisconnectingRef.current) return;
        setMessage('考试已结束');
      } else if (result.session.lockdown) {
        setMessage(result.session.lockdownReason || '当前会话已被锁定，请等待管理员处理');
      } else if (result.session.status === 'WAITING_REVIEW') {
        setMessage('登录请求已提交，等待监考老师审核');
      } else {
        setMessage(secondCameraRequired ? '监考中，请保持本页面和摄像头开启' : '监考中，本考室不要求第二机位');
      }
    } catch (cause) {
      if (signal.aborted || generation !== connectionGenerationRef.current || joiningPairRef.current || testDisconnectingRef.current) return;
      if (isExpiredClientSessionError(cause)) {
        await stopPublisher();
        if (signal.aborted || generation !== connectionGenerationRef.current || joiningPairRef.current) return;
        clearSession();
        setRoomRequirements(null);
        setMessage('监考会话已失效，请返回电脑客户端重新登录');
        return;
      }
      const reason = cause instanceof Error ? cause.message : '心跳上报失败';
      heartbeatFailuresRef.current = Math.min(heartbeatFailuresRef.current + 1, 3);
      void reportAlert('MOBILE_CAMERA_LOST', '第二机位网络连接中断');
      setConnectionLost(true);
      setMessage(/令牌/.test(reason) ? '会话已失效，请重新登录' : '网络连接中断，正在自动重连…');
    }
  }, [apiBase, clearSession, deviceId, flushClipUploads, secondCameraRequired, sessionId, sessionToken, stopPublisher, streamState, reportAlert]);

  useEffect(() => {
    // Keep the authenticated phone connected when its camera is optional so
    // enabling the second camera in the room can refresh policy and start it.
    if (step !== 'monitor' || sessionFinished) return;
    return startSerialPolling(heartbeat, () => heartbeatFailuresRef.current
      ? Math.min(20_000, 5000 * 2 ** (heartbeatFailuresRef.current - 1)) * (0.75 + Math.random() * 0.5) : 5000);
  }, [heartbeat, sessionFinished, step]);

  const pollVoice = useCallback(async (signal: AbortSignal) => {
    if (publicTest || !sessionId || !sessionToken) return;
    try {
      const query = lastVoiceAtRef.current ? `&after=${encodeURIComponent(lastVoiceAtRef.current)}` : '';
      const voices = await readWithDeadline(requestSignal => new ClientApi(apiBase, sessionToken).request<VoiceMessage[]>(
        `/api/client/voice?sessionId=${encodeURIComponent(sessionId)}${query}`, { signal: requestSignal }
      ), signal);
      if (signal.aborted) return;
      for (const voice of voices) {
        if (signal.aborted) return;
        lastVoiceAtRef.current = voice.createdAt;
        if (playedVoicesRef.current.has(voice.id)) continue;
        playedVoicesRef.current.add(voice.id);
        setVoiceState('正在播放监考老师语音');
        const audio = new Audio(absoluteMediaUrl(apiBase, voice.objectPath));
        await audio.play().catch(() => setVoiceState('收到语音，请点击页面后等待再次播放'));
        audio.onended = () => setVoiceState('等待监考老师语音');
      }
    } catch (cause) {
      if (signal.aborted) return;
      setVoiceState(cause instanceof Error ? cause.message : '语音接收失败');
    }
  }, [publicTest, apiBase, sessionId, sessionToken]);

  useEffect(() => {
    if (step !== 'monitor' || !secondCameraRequired || sessionFinished) return;
    return startSerialPolling(pollVoice, () => 3000);
  }, [pollVoice, secondCameraRequired, sessionFinished, step]);

  useEffect(() => {
    if (step !== 'monitor' || !secondCameraRequired || sessionFinished) return;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') void reportAlert('SCREEN_SWITCH', '浏览器客户网页切到后台或离开第二机位监考页面');
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [reportAlert, secondCameraRequired, sessionFinished, step]);

  async function flipCamera() {
    await stopPublisher();
    setCameraFacing((current) => (current === 'environment' ? 'user' : 'environment'));
  }

  async function openReconnectScanner() {
    reconnectScanRef.current = true;
    await stopPublisher();
    setMessage('第二机位掉线：扫描在线客户端左下角重连二维码。电脑掉线：用本机扫描客户端登录二维码。');
    setCaptureMode('qr');
  }

  function closeCaptureDialog() {
    reconnectScanRef.current = false;
    setCaptureMode(null);
    if (step === 'monitor' && session?.status !== 'FINISHED') setStreamState('failed');
  }

  function rotateVideo() {
    setVideoRotation((current) => {
      const next = ((current + 90) % 360) as VideoRotation;
      videoRotationRef.current = next;
      return next;
    });
  }

  async function retryPublisher() {
    setCapturePermissionBlocked(false);
    setCaptureIssue('');
    const stopped = stopPublisher();
    const generation = publishGenerationRef.current;
    await stopped;
    if (generation === publishGenerationRef.current) await startPublisher();
  }

  async function cancelLogin() {
    if (!sessionId && !loginRequestId) return clearSession();
    setBusy('cancel');
    try {
      await api.request('/api/client/login-request/cancel', {
        method: 'POST',
        body: JSON.stringify({ sessionId, loginRequestId })
      });
      await stopPublisher();
      clearSession();
      setMessage('登录请求已取消');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '取消登录请求失败');
    } finally {
      setBusy('');
    }
  }

  async function testMobileDisconnect() {
    if (!publicTest || !sessionId || testDisconnectingRef.current) return;
    testDisconnectingRef.current = true;
    connectionGenerationRef.current += 1;
    setBusy('disconnect-test');
    setMessage('正在断开第二机位连接，请稍候…');
    try {
      await api.request('/api/client/test-disconnect', { method: 'POST', body: JSON.stringify({ sessionId, deviceId, side: 'MINIPROGRAM' }) });
      await stopPublisher();
      clearSession();
      setRoomRequirements(null);
      setCredentialTicket('');
      setPairCode('');
      setForm({ ...EMPTY_FORM });
      setCaptureMode('qr');
      setMessage('断网重连测试：已退出登录，请扫描电脑端左下角更新后的第二机位二维码。');
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : '测试暂不可用，请重试'); }
    finally { testDisconnectingRef.current = false; setBusy(''); }
  }

  useEffect(() => {
    if (!publicTest || !sessionId || step !== 'monitor' || sessionFinished) return;
    async function check(signal: AbortSignal) {
      try {
        const result = await readWithDeadline(requestSignal => api.request<{ channels: Array<{ channel: string; ready: boolean; available: boolean }> }>(`/api/client/test-environment?sessionId=${encodeURIComponent(sessionId)}`, { signal: requestSignal }), signal, 10_000);
        const mobile = result.channels.find(item => item.channel === 'MOBILE_CAMERA');
        if (!signal.aborted) setTestMediaMessage(mobile?.ready ? '推流检测通过 · 不保存录像' : mobile?.available ? '等待媒体服务接收画面' : '推流检测服务暂不可用');
      } catch { if (!signal.aborted) setTestMediaMessage('推流检测暂不可用'); }
    }
    return startSerialPolling(check, () => 5000);
  }, [api, publicTest, sessionFinished, sessionId, step]);

  async function startVoiceReply() {
    if (!sessionId || sessionFinished || voiceStartingRef.current || voiceRecorderRef.current) return;
    voiceStartingRef.current = true;
    const generation = voiceGenerationRef.current;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (generation !== voiceGenerationRef.current) return stopStream(stream);
      voiceStreamRef.current = stream;
      const mime = supportedRecordingMime('audio');
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      const chunks: Blob[] = [];
      voiceRecorderRef.current = recorder;
      const startedAt = Date.now();
      recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
      recorder.onstop = async () => {
        if (voiceTimerRef.current) window.clearTimeout(voiceTimerRef.current);
        voiceRecorderRef.current = null;
        voiceStreamRef.current = null;
        stopStream(stream);
        setRecordingVoice(false);
        if (generation !== voiceGenerationRef.current) return;
        const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });
        if (!blob.size) return setVoiceState('没有录制到语音，请重试');
        try {
          await api.upload('/api/client/voice', blob, `voice-${Date.now()}.${extensionForMime(blob.type)}`, {
            sessionId,
            durationMs: String(Date.now() - startedAt)
          });
          setVoiceState('语音已发送给监考老师');
        } catch (cause) {
          setVoiceState(cause instanceof Error ? cause.message : '语音发送失败');
        }
      };
      recorder.start(500);
      setRecordingVoice(true);
      setVoiceState('正在录音，最长 60 秒');
      voiceTimerRef.current = window.setTimeout(() => recorder.state === 'recording' && recorder.stop(), 60_000);
    } catch (cause) {
      if (generation !== voiceGenerationRef.current) return;
      stopStream(voiceStreamRef.current);
      voiceStreamRef.current = null;
      voiceRecorderRef.current = null;
      setVoiceState(cause instanceof Error ? cause.message : '无法打开麦克风');
    } finally {
      if (generation === voiceGenerationRef.current) voiceStartingRef.current = false;
    }
  }

  if (!hydrated) {
    return <main className="app-loading"><LoaderCircle className="spin" />正在加载考生网页端</main>;
  }

  return (
    <main className={`candidate-app ${step === 'monitor' ? 'monitor-mode' : ''}`}>
      {step !== 'monitor' ? (
        <header className="brand-header">
          <div className="brand-mark"><img src="/candidate-assets/brand/logo.png" alt="程序设计算法协会 Logo" /></div>
          <div><strong>程序设计算法协会</strong><span>线上监考平台 · 考生网页端</span></div>
          <div className={`server-pill ${serverState}`}>
            <span />{serverState === 'connected' ? '服务器已连接' : serverState === 'checking' ? '正在连接' : '连接失败'}
          </div>
        </header>
      ) : null}

      {step === 'identity' && credentialTicket ? <section className="form-card"><h2>第二机位验证</h2><p>{message || '正在核对电脑端登录信息…'}</p></section> : null}
      {step === 'identity' && !credentialTicket ? (
        <div className="page-shell">
          <aside className="intro-panel">
            <span className="eyebrow">BROWSER CLIENT</span>
            <h1>考生身份验证</h1>
            <p>填写考试编号、姓名、考号和密码，通过核验后按考室要求完成验证。</p>
            <div className="feature-list">
              <span><ShieldCheck />身份信息安全核验</span>
              <span><QrCode />绑定电脑客户端</span>
              <span><Radio />WHIP 实时第二机位</span>
            </div>
          </aside>
          <section className="form-card">
            <div className="step-heading login-heading"><div><h2>考生登录</h2><p>首次登录填写信息；恢复第二机位请直接扫码，无需密码或重新拍摄材料</p></div><button className="login-reconnect-button" type="button" onClick={() => void openReconnectScanner()} disabled={busy !== ''}><QrCode size={17} />扫码恢复第二机位</button></div>
            <label className="field full"><span>考试编号</span><input inputMode="numeric" maxLength={10} pattern="[0-9]{10}" list="candidate-exam-codes" value={form.examCode} onChange={event => setForm(current => ({ ...current, examCode: event.target.value.replace(/\D/g, '').slice(0, 10), examId: '' }))} placeholder="请输入 10 位考试编号" /><datalist id="candidate-exam-codes">{exams.map(exam => <option key={exam.id} value={exam.examCode}>{exam.name}</option>)}</datalist></label>
            {selectedExam ? (
              <div className="exam-summary">
                <div><span>考试名称</span><strong>{selectedExam.name}</strong></div><div><span>考试时间</span><strong>{formatTime(selectedExam.startAt)} — {formatTime(selectedExam.endAt)}</strong></div>
                <div><span>考试时长</span><strong>{selectedExam.durationMinutes} 分钟</strong></div>
                <div><span>比赛类型</span><strong>{selectedExam.contestType === 'TEAM' ? `团队赛 · ${selectedExam.teamAccountMode === 'TEAM_ACCOUNT' ? '队伍账号' : '成员账号'}` : '个人赛'}</strong></div>
              </div>
            ) : null}
            <div className="form-grid">
              <label className="field"><span>姓名</span><input value={form.name} onChange={(event) => updateForm('name', event.target.value)} placeholder="请输入姓名" autoComplete="name" /></label>
              <label className="field"><span>考号</span><input value={form.examNumber} onChange={(event) => updateForm('examNumber', event.target.value)} placeholder="请输入考号" autoComplete="username" /></label>
              <label className="field full"><span>登录密码</span><input type="password" value={form.password} onChange={(event) => updateForm('password', event.target.value)} placeholder="请输入登录密码" autoComplete="current-password" /></label>
            </div>
            {message ? <div className="inline-message"><AlertTriangle size={17} />{message}</div> : null}
            <button className="primary next-button" type="button" onClick={() => void verifyIdentity()} disabled={busy !== '' || serverState !== 'connected'}>
              {busy === 'verify' ? <LoaderCircle className="spin" /> : null}{busy === 'verify' || busy === 'reconnect' ? '正在核对' : '核对信息并继续'}<ChevronRight size={19} />
            </button>
          </section>
        </div>
      ) : null}

      {step === 'materials' ? (
        <div className="materials-shell">
          {!credentialTicket ? <div className="return-only-row"><button className="back-link" type="button" onClick={() => setStep('identity')}><ArrowLeft size={17} />返回修改信息</button></div> : null}
          <div className="materials-title"><span className="eyebrow">IDENTITY MATERIALS</span><h1>提交登录材料</h1><p>完成身份照片和环境视频采集后登录。</p></div>
          <section className="confirm-strip">
            <div><span>考试</span><strong>{selectedExam?.name}</strong></div><div><span>姓名</span><strong>{form.name}</strong></div><div><span>考号</span><strong>{form.examNumber}</strong></div>
          </section>
          <div className="material-grid">
            {(roomRequirements?.requireSecondCamera ?? selectedExam?.requireMiniProgram) ? <article className={`material-card ${identityPhoto ? 'done' : ''}`}>
              <header><span className="material-number">01</span><div><h2>手持身份证明照片</h2><p>使用前置摄像头拍摄本人和证件正面</p></div>{identityPhoto ? <Check className="done-icon" /> : null}</header>
              <div className="material-preview">{photoUrl ? <img src={photoUrl} alt="身份照片预览" /> : <CameraIcon size={42} />}</div>
              <button className="secondary" type="button" onClick={() => setCaptureMode('photo')}><Camera size={18} />{identityPhoto ? '重新拍摄' : '打开摄像头拍摄'}</button>
            </article> : null}
            {(roomRequirements?.requireSecondCamera ?? selectedExam?.requireMiniProgram) ? <article className={`material-card ${roomVideo ? 'done' : ''}`}>
              <header><span className="material-number">02</span><div><h2>周围环境视频</h2><p>使用后置摄像头录制 3–15 秒环境视频</p></div>{roomVideo ? <Check className="done-icon" /> : null}</header>
              <div className="material-preview">{roomVideoUrl ? <video src={roomVideoUrl} controls playsInline /> : <Video size={42} />}</div>
              <button className="secondary" type="button" onClick={() => setCaptureMode('video')}><Video size={18} />{roomVideo ? '重新录制' : '录制环境视频'}</button>
            </article> : null}
            <article className={`material-card ${pairCode ? 'done' : ''}`}>
              <header><span className="material-number">03</span><div><h2>绑定电脑客户端</h2><p>{pairCode ? '客户端已绑定' : '请输入客户端显示的配对码'}</p></div>{pairCode ? <Check className="done-icon" /> : null}</header>
              <div className="material-preview qr-preview">{pairCode ? <><QrCode size={44} /><strong>{pairCode}</strong><span>电脑端已绑定</span></> : <QrCode size={48} />}</div>
              {!credentialTicket ? <label className="field full"><span>配对码</span><input inputMode="numeric" maxLength={6} pattern="[0-9]{6}" value={pairCode} onChange={event => { setPairCode(event.target.value.replace(/\D/g, '').slice(0, 6)); setScannedLoginProof(null); setTestPair(null); }} placeholder="请输入客户端显示的 6 位配对码" /></label> : null}
              {!credentialTicket ? <button className="secondary" type="button" onClick={() => setCaptureMode('qr')} disabled={busy !== ''}><QrCode size={18} />扫描二维码</button> : null}
            </article>
          </div>
          {message ? <div className="inline-message centered"><AlertTriangle size={17} />{message}</div> : null}
          <button className="primary submit-button" type="button" onClick={() => void submitLoginRequest()} disabled={busy !== ''}>
            {busy === 'submit' ? <LoaderCircle className="spin" /> : <Send size={19} />}{busy !== '' ? roomRequirements?.isPublicTest ? '正在登录…' : '正在上传并提交…' : roomRequirements?.isPublicTest ? '登录' : '提交登录请求'}
          </button>
        </div>
      ) : null}

      {step === 'monitor' ? (
        secondCameraRequired ? (
        <section className={`monitor-screen monitor-landscape${monitorControlsVisible ? '' : ' monitor-controls-collapsed'}`} aria-label="第二机位横屏监考">
          <div className="monitor-preview">
            <div className="monitor-video-frame"><video ref={previewRef} muted playsInline autoPlay onPlaying={() => setPreviewReady(true)} onEmptied={() => setPreviewReady(false)} /></div>
            {!previewReady ? <div className="monitor-empty-state">
              {streamState === 'connecting' ? <LoaderCircle className="spin" /> : sessionFinished ? <ShieldCheck /> : <Camera />}
              <strong>{sessionFinished ? '本场监考已结束' : streamState === 'connecting' ? '正在开启第二机位' : streamState === 'failed' ? '视频连接暂时中断' : '等待摄像头画面'}</strong>
              <span>{sessionFinished ? '可以关闭本页面' : streamState === 'connecting' ? '请保持页面打开，画面即将显示' : '连接恢复后，画面将在这里全屏显示'}</span>
            </div> : null}
          </div>
          <header className="monitor-header">
            <div className="monitor-heading">
              <div className="monitor-brand"><ShieldCheck /><span>PAA · 第二机位</span></div>
              <div className={`live-status ${streamState}`}><span />{streamState === 'connected' ? '直播中' : streamState === 'connecting' ? '正在连接' : streamState === 'failed' ? '连接异常' : '尚未连接'}</div>
            </div>
            <div className="monitor-header-actions">
              {publicTest ? <div className="voice-status">{testMediaMessage}</div> : <div className="voice-status"><Mic size={16} />{voiceState}</div>}
              <button className="monitor-panel-toggle" type="button" onClick={() => setMonitorControlsVisible(current => !current)} aria-expanded={monitorControlsVisible} aria-controls="monitor-toolbar" aria-label={monitorControlsVisible ? '隐藏操作' : '显示操作'}>
                {monitorControlsVisible ? <EyeOff size={16} /> : <Eye size={16} />}<span>{monitorControlsVisible ? '隐藏操作' : '显示操作'}</span>
              </button>
            </div>
          </header>
          <div className="monitor-bottom-panel">
          <details className="placement-guide">
            <summary><RotateCw size={14} />手机横放 · 画面上边即视频上方</summary>
            <p>请将手机逆时针旋转 90° 横放，对准桌面、键盘、显示器与本人侧后方。锁定竖屏也能使用；画面方向不正确时，点击“旋转画面”调整。</p>
          </details>
          {session?.lockdown ? <div className="lock-banner"><AlertTriangle />{session.lockdownReason || '当前会话已锁定，请等待管理员处理'}</div> : null}
          {session?.status === 'FINISHED' ? <div className="lock-banner finished"><Check />考试已结束，可以关闭本页面</div> : null}
          <footer className="monitor-controls" id="monitor-toolbar">
            {publicTest ? <button className="test-reconnect-control" type="button" onClick={() => void testMobileDisconnect()} disabled={busy !== '' || session?.status === 'FINISHED'}>{busy === 'disconnect-test' ? <LoaderCircle className="spin" /> : <RefreshCw />}<span>{busy === 'disconnect-test' ? '正在断开连接…' : '断网重连测试'}</span></button> : null}
            <button type="button" onClick={() => void flipCamera()} disabled={streamState === 'connecting' || session?.status === 'FINISHED'}><FlipHorizontal2 /><span>翻转摄像头</span></button>
            <button type="button" onClick={rotateVideo} disabled={streamState === 'connecting' || session?.status === 'FINISHED'} title={`当前画面旋转 ${videoRotation}°`}><RotateCw /><span>旋转画面</span></button>
            {streamState === 'failed' || streamState === 'idle' ? <button type="button" onClick={() => void retryPublisher()} disabled={session?.status === 'FINISHED'}><RefreshCw /><span>{capturePermissionBlocked ? '重新获取摄像头权限' : '重新推流'}</span></button> : null}
            <button className="reconnect-control" type="button" onClick={() => void openReconnectScanner()} disabled={busy === 'reconnect' || session?.status === 'FINISHED'}><QrCode /><span>{busy === 'reconnect' ? '正在重连' : '断网重连'}</span></button>
            {!publicTest ? (!recordingVoice ? <button type="button" onClick={() => void startVoiceReply()} disabled={session?.status === 'FINISHED'}><Mic /><span>语音回复</span></button> : <button className="recording-control" type="button" onClick={() => voiceRecorderRef.current?.stop()}><CircleStop /><span>停止并发送</span></button>) : null}
            <button type="button" onClick={() => { void reportAlert('MOBILE_CAMERA_LOST', '考生手动上报浏览器第二机位摄像头异常'); setMessage('摄像头异常已上报管理员'); }} disabled={session?.status === 'FINISHED'}><AlertTriangle /><span>异常上报</span></button>
          </footer>
          <div className="monitor-message" role={!sessionFinished && (recordingIssue || captureIssue) ? 'alert' : undefined}>{!sessionFinished && (recordingIssue || captureIssue) || message}</div>
          {session?.status === 'WAITING_REVIEW' ? <button className="cancel-login" type="button" onClick={() => void cancelLogin()} disabled={busy === 'cancel'}>{busy === 'cancel' ? '正在取消…' : '取消登录请求'}</button> : null}
          </div>
        </section>
        ) : (
          <section className="monitor-screen no-camera-required">
            <div className="placement-guide"><Check /><p>本考室不要求第二机位，无需开启手机摄像头或推流</p><Check /></div>
            <div className="monitor-message">{message || '电脑端将继续采集规定的监考画面'}</div>
            {session?.status === 'WAITING_REVIEW' ? <button className="cancel-login" type="button" onClick={() => void cancelLogin()} disabled={busy === 'cancel'}>{busy === 'cancel' ? '正在取消…' : '取消登录请求'}</button> : null}
          </section>
        )
      ) : null}

      {captureMode ? (
        <CaptureDialog
          mode={captureMode}
          reconnecting={reconnectScanRef.current}
          onClose={closeCaptureDialog}
          onPhoto={(blob) => { setIdentityPhoto(blob); setCaptureMode(null); setMessage('身份照片已拍摄'); }}
          onVideo={(blob) => { setRoomVideo(blob); setCaptureMode(null); setMessage('环境视频已录制'); }}
          onQr={acceptQr}
        />
      ) : null}
      {publisherCameraPrompt && step === 'monitor' && secondCameraRequired && !sessionFinished && !captureMode ? (
        <CameraAccessPrompt message={publisherCameraPrompt}
          onRetry={typeof window !== 'undefined' && window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function' ? () => void retryPublisher() : undefined}
          onDismiss={() => setPublisherCameraPrompt('')} />
      ) : null}
    </main>
  );
}
