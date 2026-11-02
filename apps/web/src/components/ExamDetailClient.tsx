'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { parentRoutePath } from '@cwnupaa/proctor-shared';
import { ArrowLeft, Bell, Check, ChevronLeft, ChevronRight, Download, FileText, LockOpen, Maximize2, Mic, Minimize2, Phone, Play, Printer, RefreshCw, Save, Search, Square, Trash2, Upload, UserPlus, X } from 'lucide-react';
import { api } from './api';
import { createProctorWebRtcReader, isProctorWebRtcPlaying } from '../../public/live-webrtc.js';
import { ExamLoginRestrictionsPanel } from './ExamLoginRestrictionsPanel';
import { ExamQAPanel } from './ExamQAPanel';
import { MarkdownContent } from './MarkdownComposer';
import { ExamScreenControlPanel } from './ExamScreenControlPanel';
import { ExternalBoardSettings } from './ExternalBoardSettings';
import { VoiceCallPanel } from './VoiceCallPanel';
import { AlertEvidencePlayer, type AlertEvidence } from './AlertEvidencePlayer';
import { parseCandidateCsv, parseCsvLine, mergeTeamCandidateRows } from '@/lib/candidate-import';
import { participationOptions, normalizeParticipationGroup, participationGroupLabel, isXcpcLeaderboard } from '@cwnupaa/proctor-shared/leaderboard';
import { readCandidateImportFile } from '@/lib/candidate-import-file';
import { datetimeLocalToIso, toDatetimeLocalValue } from '@/lib/datetime-local';
import { candidateStartDeadline, effectiveEnd } from '@/lib/contest-rules';
import { monitorCandidates, monitorCandidatePage, type MonitorSearchField } from './monitor-candidates';
import { normalizeContestFormat } from '@/lib/contest-format';
import { TeamSubmissionViewSetting } from './TeamSubmissionViewSetting';
import { createMonitorPoller } from './monitor-polling';
import { groupMonitorAlerts } from './monitor-alerts';
import { resolveRoomCandidateInput, type RoomCandidateInputType } from '@/lib/room-candidate-input';

type Role = 'ADMIN' | 'SUPER_ADMIN';
type DetailRoute = 'status' | 'login' | 'login-restrictions' | 'qa' | 'print' | 'monitor' | 'screen' | 'settings';
type SettingsRoute = 'base' | 'problems' | 'candidates' | 'rooms' | 'external-board';
type CandidateStatus =
  | 'NOT_REQUESTED'
  | 'REQUESTING'
  | 'REJECTED'
  | 'APPROVED'
  | 'ONLINE_NORMAL'
  | 'ONLINE_ABNORMAL'
  | 'OFFLINE'
  | 'FINISHED';

interface Exam {
  id: string;
  name: string;
  startAt: string;
  latestStartAt: string;
  endAt: string;
  durationMinutes: number;
  platform: 'HYDRO' | 'NOVAJUDGE';
  novaJudgeApiKey?: string;
  novaJudgeTimezone: string;
  platformBaseUrl: string;
  platformContestId: string;
  contestType: 'INDIVIDUAL' | 'TEAM';
  teamAccountMode: 'MEMBER_ACCOUNTS' | 'TEAM_ACCOUNT';
  contestRule: 'GPLT' | 'XCPC' | 'LANQIAO' | 'ACM' | 'OI' | 'IOI' | 'KS';
  flexible: boolean;
  published: boolean;
  showTestCaseCount: boolean;
  showObjectiveScore: boolean;
  allowPrint: boolean;
  printMode: 'DISABLED' | 'VIRTUAL' | 'PHYSICAL';
  allowTeamSubmissionView: boolean;
  leaderOnlySubmission: boolean;
  scoreboardFrozenAt: string | null;
  problems?: Array<{ id: string; order: number; hydroProblemId: string; title: string; problemType: string; hydroScore: number; scorePercent: number; score: number }>;
  rules: string;
  requireMiniProgram: boolean;
  requireFrontCamera: boolean;
  saveFullRecording: boolean;
  saveIncidentRecording: boolean;
}

interface Candidate {
  id: string;
  name: string | null;
  studentId: string | null;
  school: string | null;
  college: string | null;
  major: string | null;
  gender: string | null;
  gradeYear: string | null;
  className: string | null;
  advisor: string | null;
  groupName: string | null;
  teamName: string | null;
  teamMembers: string | null;
  teamMemberStudentIds: string | null;
  hydroAccount: string | null;
  examNumber: string;
  password: string;
  seatNo: string;
  isTeamLeader: boolean;
  ranked: boolean;
  status: CandidateStatus;
  startedAt: string | null;
  lateStartAllowedAt: string | null;
  abnormal: boolean;
}

interface LoginRequest {
  id: string;
  status: 'REQUESTING' | 'APPROVED' | 'REJECTED';
  memberStudentId: string | null;
  memberName: string | null;
  identityPhotoPath: string | null;
  roomVideoPath: string | null;
  candidate: Candidate;
  createdAt: string;
}

interface Session {
  id: string;
  candidateId: string;
  memberStudentId: string | null;
  memberName: string | null;
  status: string;
  lockdown: boolean;
  lockdownReason: string | null;
  startedAt: string | null;
  createdAt: string;
  lastDesktopSeenAt: string | null;
  lastMiniProgramSeenAt: string | null;
  desktopOfflineAt: string | null;
  miniProgramOfflineAt: string | null;
}

interface Alert {
  id: string;
  sessionId: string | null;
  type: string;
  severity: number;
  message: string;
  evidencePath: string | null;
  evidence?: AlertEvidence;
  acknowledgedAt: string | null;
  createdAt: string;
  candidate: Candidate | null;
}

interface CurrentUser {
  id: string;
  username: string | null;
  numberId: string | null;
  nickname: string | null;
  realName: string | null;
  email: string | null;
  role: Role;
}

interface CheatingRecord {
  id: string;
  candidateId: string;
  sessionId: string | null;
  reason: string;
  teamWide: boolean;
  teamName: string | null;
  canceledAt: string | null;
  canceledReason: string | null;
  finalizedAt: string | null;
  createdAt: string;
  markedBy: CurrentUser | null;
  canceledBy: CurrentUser | null;
  candidate: Candidate;
}

interface MediaSegment {
  id: string;
  candidateId: string | null;
  sessionId: string | null;
  channel: 'DESKTOP_SCREEN' | 'DESKTOP_CAMERA' | 'MOBILE_CAMERA';
  objectPath: string;
  startedAt: string;
}

interface LiveFrame {
  id: string;
  candidateId: string;
  sessionId: string;
  channel: 'DESKTOP_SCREEN' | 'DESKTOP_CAMERA' | 'MOBILE_CAMERA';
  objectPath: string;
  capturedAt: string;
}


interface Room {
  id: string;
  name: string;
  requireSecondCamera: boolean;
  requireFrontCamera: boolean;
  loginMode: 'CREDENTIALS' | 'SECOND_CAMERA_QR';
  loginReviewMode: 'MANUAL' | 'AUTO';
  proctors: Array<{ user: { id: string; numberId: string | null; realName: string | null; nickname: string | null; username: string | null } }>;
  candidates: Array<{ candidate: Candidate }>;
}

interface ExamState {
  exam: Exam;
  candidates: Candidate[];
  loginRequests: LoginRequest[];
  sessions: Session[];
  alerts: Alert[];
  mediaSegments: MediaSegment[];
  liveFrames: LiveFrame[];
  liveReadySessionIds?: string[];
  liveStatusAvailable?: boolean;
  rooms: Room[];
  cheatingRecords: CheatingRecord[];
  printJobs: PrintJob[];
}

interface PrintJob {
  id: string; title: string; content: string; mode: 'VIRTUAL' | 'PHYSICAL'; status: 'SAVED' | 'PENDING' | 'PRINTED' | 'REJECTED';
  teamName: string | null; candidateName: string | null; examNumber: string; teamMembers: string | null; roomName: string | null; seatNo: string | null;
  rejectedReason: string | null; createdAt: string;
}

type CandidateDraft = {
  id?: string;
  name: string;
  studentId: string;
  school: string;
  college: string;
  major: string;
  gender: string;
  gradeYear: string;
  className: string;
  advisor: string;
  groupName: string;
  teamName: string;
  teamMembers: string;
  teamMemberStudentIds: string;
  examNumber: string;
  password: string;
  seatNo: string;
  isTeamLeader: boolean;
  ranked: boolean;
};

function displayName(candidate: Candidate) {
  return candidate.teamName || candidate.name || candidate.examNumber;
}

function StreamingSegmentVideo({ segments, altFrame, alt }: { segments: MediaSegment[]; altFrame?: string; alt: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [currentId, setCurrentId] = useState('');
  const [ended, setEnded] = useState(false);
  const sortedSegments = useMemo(
    () => [...segments].sort((left, right) => new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime()),
    [segments]
  );
  const currentIndex = sortedSegments.findIndex((segment) => segment.id === currentId);
  const currentSegment = currentIndex >= 0 ? sortedSegments[currentIndex] : null;
  const nextSegment = currentIndex >= 0 ? sortedSegments[currentIndex + 1] : null;

  useEffect(() => {
    if (!sortedSegments.length) {
      setCurrentId('');
      return;
    }
    if (!currentId || !sortedSegments.some((segment) => segment.id === currentId)) {
      setCurrentId(sortedSegments[sortedSegments.length - 1].id);
      setEnded(false);
    }
  }, [currentId, sortedSegments]);

  useEffect(() => {
    if (ended && nextSegment) {
      setCurrentId(nextSegment.id);
      setEnded(false);
    }
  }, [ended, nextSegment]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.play().catch(() => {});
  }, [currentSegment?.objectPath]);

  if (currentSegment) {
    return (
      <video
        ref={videoRef}
        src={currentSegment.objectPath}
        autoPlay
        muted
        playsInline
        preload="auto"
        onCanPlay={(event) => {
          event.currentTarget.play().catch(() => {});
        }}
        onEnded={() => setEnded(true)}
      />
    );
  }

  if (altFrame) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={altFrame} alt={alt} />;
  }

  return <span>无信号</span>;
}

function WebRtcStreamVideo({ sessionId, channel, onPlayingChange, audible = false }: {
  sessionId: string; channel: LiveFrame['channel']; onPlayingChange?: (playing: boolean) => void; audible?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const stalledTimerRef = useRef(0);
  const readerRef = useRef<ReturnType<typeof createProctorWebRtcReader> | null>(null);
  const hadFramesRef = useRef(false);
  const restartRef = useRef<() => void>(() => {});
  const [status, setStatus] = useState('正在连接 WebRTC');
  const [soundBlocked, setSoundBlocked] = useState(false);
  const audibleRef = useRef(audible); audibleRef.current = audible;
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    video.muted = !audible; setSoundBlocked(false);
    if (audible) void video.play().catch(() => setSoundBlocked(true));
  }, [audible]);
  useEffect(() => {
    onPlayingChange?.(false); setStatus('正在连接 WebRTC'); hadFramesRef.current = false;
    const renderedVideo = videoRef.current;
    const reader = createProctorWebRtcReader({
      url: `/api/media/whep?sessionId=${encodeURIComponent(sessionId)}&channel=${encodeURIComponent(channel)}`,
      onTrack: event => {
        const video = videoRef.current; if (!video) return;
        const stream = video.srcObject as MediaStream | null || new MediaStream();
        if (!stream.getTracks().some(track => track.id === event.track.id)) stream.addTrack(event.track);
        video.srcObject = stream; video.muted = !audibleRef.current;
        void video.play().catch(() => { if (audibleRef.current) setSoundBlocked(true); });
      },
      onReset: () => { window.clearTimeout(stalledTimerRef.current); hadFramesRef.current = false; if (renderedVideo) renderedVideo.srcObject = null; },
      onError: () => { setStatus('等待推流'); onPlayingChange?.(false); },
      onConnectionState: state => { if (state === 'connected') { if (isProctorWebRtcPlaying(readerRef.current, videoRef.current)) { hadFramesRef.current = true; setStatus('WebRTC 直播中'); onPlayingChange?.(true); } else setStatus('等待 WebRTC 首帧'); } }
    });
    readerRef.current = reader;
    restartRef.current = () => reader.restart();
    return () => { window.clearTimeout(stalledTimerRef.current); restartRef.current = () => {}; readerRef.current = null; if (renderedVideo) { renderedVideo.muted = true; renderedVideo.pause(); renderedVideo.srcObject = null; } reader.close(); };
  }, [sessionId, channel, onPlayingChange]);
  return <>
    <video ref={videoRef} autoPlay muted={!audible} playsInline controls={false}
      onPlaying={() => { if (!isProctorWebRtcPlaying(readerRef.current, videoRef.current)) return; hadFramesRef.current = true; window.clearTimeout(stalledTimerRef.current); setStatus('WebRTC 直播中'); onPlayingChange?.(true); }}
      onWaiting={() => { setStatus('等待 WebRTC 首帧'); onPlayingChange?.(false); window.clearTimeout(stalledTimerRef.current); if (hadFramesRef.current) stalledTimerRef.current = window.setTimeout(() => restartRef.current(), 15000); }} />
    {status !== 'WebRTC 直播中' ? <span className="stream-status">{status}</span> : null}
    {audible && soundBlocked ? <button type="button" className="monitor-audio-unlock" onClick={() => { const video = videoRef.current; if (video) { video.muted = false; void video.play().then(() => setSoundBlocked(false)).catch(() => setSoundBlocked(true)); } }}>点击播放当前考生声音</button> : null}
  </>;
}

function LiveStreamVideo({
  sessionId,
  channel,
  onPlayingChange,
  audible = false
}: {
  sessionId: string;
  channel: LiveFrame['channel'];
  onPlayingChange?: (playing: boolean) => void;
  audible?: boolean;
}) {
  return <WebRtcStreamVideo sessionId={sessionId} channel={channel} onPlayingChange={onPlayingChange} audible={audible} />;
}

function MonitorFeed({
  label,
  sessionId,
  channel,
  hasSession,
  screenFeed,
  required = true,
  unavailableText,
  audible = false
}: {
  label: string;
  sessionId: string;
  channel: LiveFrame['channel'];
  hasSession: boolean;
  screenFeed?: boolean;
  required?: boolean;
  unavailableText?: string;
  audible?: boolean;
}) {
  const [playing, setPlaying] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false); };
    window.addEventListener('keydown', escape);
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', escape); };
  }, [expanded]);
  if (!required) {
    return (
      <div className={`feed live-feed feed-not-required ${screenFeed ? 'screen-feed' : ''}`}>
        <div className="feed-label">{label}</div>
        <span>{unavailableText || `考室不要求${label}`}</span>
      </div>
    );
  }
  const badgeClass = playing ? 'live-badge' : hasSession ? 'live-badge waiting' : 'live-badge stale';
  const badgeText = playing ? '实时' : hasSession ? '等待推流' : '无信号';

  return (
    <div className={`feed live-feed ${screenFeed ? 'screen-feed' : ''} ${expanded ? 'monitor-feed-expanded' : ''}`}
      role={expanded ? 'dialog' : undefined} aria-modal={expanded || undefined} aria-label={expanded ? `${label}放大画面` : undefined}>
      <div className={badgeClass}>{badgeText}</div>
      <div className="feed-label">{label}</div>
      {expanded ? <button className="monitor-feed-focus-close" type="button" onClick={() => setExpanded(false)} title="退出放大" aria-label="退出放大"><Minimize2 size={20} />退出放大</button>
        : <button className="feed-expand-button" type="button" onClick={() => setExpanded(true)} title={`放大${label}`} aria-label={`放大${label}`}><Maximize2 size={17} /></button>}
      {sessionId ? (
        <LiveStreamVideo sessionId={sessionId} channel={channel} onPlayingChange={setPlaying} audible={audible} />
      ) : (
        <span>{hasSession ? '等待推流' : '无信号'}</span>
      )}
    </div>
  );
}

function splitMemberText(value?: string | null) {
  return (value || '')
    .split(/[、,，;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function teamMemberRows(candidate: Candidate, roomNames: string[] = []) {
  const names = splitMemberText(candidate.teamMembers);
  const ids = splitMemberText(candidate.teamMemberStudentIds);
  const count = Math.max(names.length, ids.length, 1);
  return Array.from({ length: count }, (_, index) => ({
    teamName: candidate.teamName || '-',
    memberName: names[index] || '-',
    studentId: ids[index] || '-',
    school: candidate.school || '-',
    college: candidate.college || '-',
    examNumber: candidate.examNumber,
    seatNo: candidate.seatNo,
    roomName: roomNames.join('、') || '未分配'
  }));
}

function statusText(status: CandidateStatus) {
  const map: Record<CandidateStatus, string> = {
    NOT_REQUESTED: '未请求登录',
    REQUESTING: '请求登录中',
    REJECTED: '请求被拒绝',
    APPROVED: '已通过',
    ONLINE_NORMAL: '考试中',
    ONLINE_ABNORMAL: '异常',
    OFFLINE: '掉线',
    FINISHED: '已结束'
  };
  return map[status];
}

function connectionText(lastSeenAt: string | null, offlineAt: string | null, finished = false) {
  if (finished) return '已结束';
  if (offlineAt) return '掉线';
  if (!lastSeenAt) return '等待连接';
  return Date.now() - new Date(lastSeenAt).getTime() > 20_000 ? '掉线' : '在线';
}

function alertTypeText(type: string) {
  const labels: Record<string, string> = {
    CLIENT_OFFLINE: '客户端掉线',
    SECOND_CAMERA_OFFLINE: '第二机位掉线',
    SCREEN_SWITCH: '切屏',
    SCREEN_CAPTURE_LOST: '屏幕采集异常',
    CAMERA_CAPTURE_LOST: '电脑摄像头异常',
    MOBILE_CAMERA_LOST: '第二机位采集异常',
    PROCESS_POLICY: '进程异常',
    NETWORK_POLICY: '网络异常',
    PERIPHERAL_CHANGED: 'USB 外设异常',
    VIRTUAL_MACHINE: '虚拟机',
    MANUAL_NOTE: '人工记录',
    OJ_LOGIN_FAILED: '评测服务连接异常'
  };
  return labels[type] || type;
}

function splitProctorLines(value: string) {
  return value.split(/[\n,，;；]+/).flatMap(line => /[+＋]/.test(line) ? [line.trim()] : splitLines(line)).filter(Boolean);
}

function splitLines(value: string) {
  return value
    .split(/[\n,，;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function csvEscape(value: unknown) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function parseRoomCsv(text: string) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = cells[index] || '';
    });
    return {
      name: row['考室名称'] || row.roomName || row.name,
      proctorNumberIds: splitProctorLines(row['监考老师学号'] || row.proctorNumberIds || ''),
      candidateExamNumbers: splitLines(row['考生考号'] || row.candidateExamNumbers || ''),
      loginReviewMode: /^(自动通过|自动|auto)$/i.test((row['登录请求审核方式'] || row.loginReviewMode || '').trim()) ? 'AUTO' as const : 'MANUAL' as const
    };
  });
}

function candidateToDraft(candidate?: Candidate): CandidateDraft {
  return {
    id: candidate?.id,
    name: candidate?.name || '',
    studentId: candidate?.studentId || '',
    school: candidate?.school || '',
    college: candidate?.college || '',
    major: candidate?.major || '',
    gender: candidate?.gender || '',
    gradeYear: candidate?.gradeYear || '',
    className: candidate?.className || '',
    advisor: candidate?.advisor || '',
    groupName: candidate?.groupName || '',
    teamName: candidate?.teamName || '',
    teamMembers: candidate?.teamMembers || '',
    teamMemberStudentIds: candidate?.teamMemberStudentIds || '',
    examNumber: candidate?.examNumber || '',
    password: candidate?.password || '',
    seatNo: candidate?.seatNo || '',
    isTeamLeader: candidate?.isTeamLeader || false,
    ranked: candidate?.ranked ?? true
  };
}

export function ExamDetailClient({
  examId,
  canManage = false,
  initialTab = 'login',
  initialSettingsTab = 'base'
}: {
  examId: string;
  canManage?: boolean;
  initialTab?: DetailRoute;
  initialSettingsTab?: SettingsRoute;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [tab, setTab] = useState<DetailRoute>(initialTab);
  const [settingsTab, setSettingsTab] = useState<SettingsRoute>(initialSettingsTab);
  const [state, setState] = useState<ExamState | null>(null);
  const [error, setError] = useState('');
  const [layout, setLayout] = useState<1 | 4>(1);
  const [monitorSearch, setMonitorSearch] = useState('');
  const [monitorSearchField, setMonitorSearchField] = useState<MonitorSearchField>('name');
  const [monitorPageIndex, setMonitorPageIndex] = useState(0);
  const [knownLiveSessions, setKnownLiveSessions] = useState<ReadonlySet<string> | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState('');
  const [selectedRoomId, setSelectedRoomId] = useState('__all');
  const [selectedSettingsRoomId, setSelectedSettingsRoomId] = useState('');
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [candidateRoomFilter, setCandidateRoomFilter] = useState('__all');
  const [candidateSearch, setCandidateSearch] = useState('');
  const [candidateDraft, setCandidateDraft] = useState<CandidateDraft>(candidateToDraft());
  const [candidateEditorOpen, setCandidateEditorOpen] = useState(false);
  const [candidateDraftRoomId, setCandidateDraftRoomId] = useState('__none');
  const [candidateCsv, setCandidateCsv] = useState('');
  const [candidateImportRows, setCandidateImportRows] = useState<ReturnType<typeof parseCandidateCsv>>([]);
  const [candidateImportFileName, setCandidateImportFileName] = useState('');
  const [candidateImportReading, setCandidateImportReading] = useState(false);
  const [candidateImportError, setCandidateImportError] = useState('');
  const [roomName, setRoomName] = useState('第一考室');
  const [roomProctors, setRoomProctors] = useState('');
  const [roomCandidates, setRoomCandidates] = useState('');
  const [roomRequireSecondCamera, setRoomRequireSecondCamera] = useState(true);
  const [roomRequireFrontCamera, setRoomRequireFrontCamera] = useState(true);
  const [roomLoginMode, setRoomLoginMode] = useState<'CREDENTIALS' | 'SECOND_CAMERA_QR'>('CREDENTIALS');
  const [roomLoginReviewMode, setRoomLoginReviewMode] = useState<'MANUAL' | 'AUTO'>('MANUAL');
  const [roomDetail, setRoomDetail] = useState<Room | null>(null);
  const [problemPercents, setProblemPercents] = useState<Record<string, number>>({});
  const [roomCsv, setRoomCsv] = useState('');
  const [roomEditorOpen, setRoomEditorOpen] = useState(false);
  const [roomImportOpen, setRoomImportOpen] = useState(false);
  const [roomProctorAddOpen, setRoomProctorAddOpen] = useState(false);
  const [roomCandidateAddOpen, setRoomCandidateAddOpen] = useState(false);
  const [roomProctorInput, setRoomProctorInput] = useState('');
  const [roomCandidateInput, setRoomCandidateInput] = useState('');
  const [roomCandidateInputType, setRoomCandidateInputType] = useState<RoomCandidateInputType>('EXAM_NUMBER');
  const [roomCandidateInputError, setRoomCandidateInputError] = useState('');
  const [roomCandidateSearch, setRoomCandidateSearch] = useState('');
  const [voiceTarget, setVoiceTarget] = useState<{ candidate: Candidate; sessionId: string } | null>(null);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [monitorSound, setMonitorSound] = useState(true);
  const [examForm, setExamForm] = useState<Exam | null>(null);
  const [examFormDirty, setExamFormDirty] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [loadedAlertVideoIds, setLoadedAlertVideoIds] = useState<string[]>([]);
  const [alertFilter, setAlertFilter] = useState<'pending' | 'all'>('pending');
  const [expandedAlertGroups, setExpandedAlertGroups] = useState<string[]>([]);
  const statePollerRef = useRef<ReturnType<typeof createMonitorPoller> | null>(null);
  const [selectedLoginRequestIds, setSelectedLoginRequestIds] = useState<string[]>([]);
  const [selectedPrintJob, setSelectedPrintJob] = useState<PrintJob | null>(null);
  const [printRejectReason, setPrintRejectReason] = useState('');
  const [activeLoginRequestId, setActiveLoginRequestId] = useState('');
  const [usbHandling, setUsbHandling] = useState<{ candidate: Candidate; session: Session } | null>(null);
  const [usbReason, setUsbReason] = useState('');
  const [assignRoomId, setAssignRoomId] = useState('');
  const [busyAction, setBusyAction] = useState('');
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const allRoomsLabel = canManage ? '全部考室' : '全部负责考室';
  const proctorName = currentUser?.realName || currentUser?.nickname || currentUser?.username || currentUser?.numberId || '当前监考老师';
  const examStartMs = state ? new Date(state.exam.startAt).getTime() : Number.NaN;
  const examEndMs = state ? new Date(state.exam.endAt).getTime() : Number.NaN;
  const examInProgress = Boolean(state && Number.isFinite(examStartMs) && Number.isFinite(examEndMs) && Date.now() >= examStartMs && Date.now() < examEndMs);
  const examActionTitle = examInProgress ? undefined : '不在考试时间内，不能进行此操作';

  function routeTo(nextTab: DetailRoute, nextSettingsTab = settingsTab) {
    if (nextTab === 'status') router.push(`/dashboard/exams/${examId}/status`);
    if (nextTab === 'login') router.push(`/dashboard/exams/${examId}/login`);
    if (nextTab === 'login-restrictions') router.push(`/dashboard/exams/${examId}/login-restrictions`);
    if (nextTab === 'qa') router.push(`/dashboard/exams/${examId}/qa`);
    if (nextTab === 'print') router.push(`/dashboard/exams/${examId}/print`);
    if (nextTab === 'monitor') router.push(`/dashboard/exams/${examId}/monitor`);
    if (nextTab === 'screen') router.push(`/dashboard/exams/${examId}/screen`);
    if (nextTab === 'settings') router.push(`/dashboard/exams/${examId}/settings/${nextSettingsTab}`);
  }

  function routeToSettings(nextSettingsTab: SettingsRoute) {
    router.push(`/dashboard/exams/${examId}/settings/${nextSettingsTab}`);
  }

  async function readState(signal: AbortSignal) {
    try {
      const data = await api<ExamState>(`/api/exams/${examId}/state`, { signal });
      if (canManage && tab === 'settings' && settingsTab === 'candidates') {
        data.candidates = await api<Candidate[]>(`/api/exams/${examId}/candidates`, { signal });
      }
      if (signal.aborted) return;
      setError('');
      if (data.liveStatusAvailable === true) setKnownLiveSessions(new Set(data.liveReadySessionIds || []));
      setState(data);
      setProblemPercents(current => Object.keys(current).length ? current : Object.fromEntries((data.exam.problems || []).map(problem => [problem.id, problem.scorePercent])));
      if (!examFormDirtyRef.current) {
        setExamForm({
          ...data.exam,
          contestRule: data.exam.contestRule === 'ACM' ? 'XCPC' : data.exam.contestRule,
          startAt: toDatetimeLocalValue(data.exam.startAt),
          latestStartAt: toDatetimeLocalValue(data.exam.latestStartAt),
          endAt: toDatetimeLocalValue(data.exam.endAt)
        });
      }
      // The polling callback retains its initial render. Resolve initialization
      // against current selection so each media/status refresh keeps the page.
      // A blank editor ID means "add". Polling must never turn a new-room
      // draft into an edit of the first existing room.
      if (tab !== 'monitor') setSelectedCandidateId(current => data.candidates.some(candidate => candidate.id === current) ? current : data.candidates[0]?.id || '');
      setAssignRoomId(current => current || data.rooms[0]?.id || '');
    } catch (err) {
      if (!signal.aborted || signal.reason?.name === 'TimeoutError') setError(err instanceof Error ? err.message : '加载失败');
    }
  }

  const examFormDirtyRef = useRef(examFormDirty);
  examFormDirtyRef.current = examFormDirty;
  async function load() { await statePollerRef.current?.refresh(); }

  useEffect(() => {
    const poller = createMonitorPoller(readState, { intervalMs: tab === 'monitor' ? 2000 : 5000, visible: !document.hidden });
    statePollerRef.current = poller;
    const visibility = () => poller.setVisible(!document.hidden);
    document.addEventListener('visibilitychange', visibility);
    void poller.refresh();
    return () => { poller.stop(); document.removeEventListener('visibilitychange', visibility); if (statePollerRef.current === poller) statePollerRef.current = null; };
  }, [examId, tab, settingsTab, canManage]);

  useEffect(() => {
    api<CurrentUser | null>('/api/auth/me').then(setCurrentUser).catch(() => setCurrentUser(null));
  }, []);

  useEffect(() => {
    setTab(initialTab);
    setSettingsTab(initialSettingsTab);
  }, [initialTab, initialSettingsTab]);

  useEffect(() => { setVoiceTarget(null); setVoiceBusy(false); }, [examId, tab]);

  useEffect(() => {
    if (!canManage && (tab === 'settings' || tab === 'screen')) routeTo('login');
  }, [canManage, tab]);

  const sessionByCandidate = useMemo(() => {
    const map = new Map<string, Session>();
    // 按创建时间取每个考生的最新会话（updatedAt 会被迟到的孤儿会话心跳改动，不能作为主排序）
    const sorted = [...(state?.sessions || [])].sort(
      (left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
    );
    sorted.forEach((session) => {
      if (!map.has(session.candidateId)) map.set(session.candidateId, session);
    });
    return map;
  }, [state]);

  const mediaByCandidate = useMemo(() => {
    const map = new Map<string, Partial<Record<MediaSegment['channel'], MediaSegment>>>();
    state?.mediaSegments.forEach((segment) => {
      if (!segment.candidateId) return;
      const current = map.get(segment.candidateId) || {};
      if (!current[segment.channel]) current[segment.channel] = segment;
      map.set(segment.candidateId, current);
    });
    return map;
  }, [state]);

  const mediaSegmentsByCandidate = useMemo(() => {
    const map = new Map<string, Partial<Record<MediaSegment['channel'], MediaSegment[]>>>();
    state?.mediaSegments.forEach((segment) => {
      if (!segment.candidateId) return;
      const current = map.get(segment.candidateId) || {};
      current[segment.channel] = [...(current[segment.channel] || []), segment];
      map.set(segment.candidateId, current);
    });
    map.forEach((channels) => {
      (Object.keys(channels) as MediaSegment['channel'][]).forEach((channel) => {
        channels[channel]?.sort((left, right) => new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime());
      });
    });
    return map;
  }, [state]);

  const liveFrameByCandidate = useMemo(() => {
    const map = new Map<string, Partial<Record<LiveFrame['channel'], LiveFrame>>>();
    state?.liveFrames?.forEach((frame) => {
      if (!frame.candidateId) return;
      const current = map.get(frame.candidateId) || {};
      if (!current[frame.channel]) current[frame.channel] = frame;
      map.set(frame.candidateId, current);
    });
    return map;
  }, [state]);

  const recentMediaByCandidate = useMemo(() => {
    const map = new Map<string, MediaSegment[]>();
    state?.mediaSegments.forEach((segment) => {
      if (!segment.candidateId) return;
      const list = map.get(segment.candidateId) || [];
      if (list.length < 6) list.push(segment);
      map.set(segment.candidateId, list);
    });
    return map;
  }, [state]);

  const selectedRoom = useMemo(() => state?.rooms.find((room) => room.id === selectedRoomId) || null, [selectedRoomId, state]);
  const selectedCandidate = useMemo(() => state?.candidates.find((candidate) => candidate.id === selectedCandidateId) || null, [selectedCandidateId, state]);

  const assignedCandidateIds = useMemo(() => {
    const ids = new Set<string>();
    state?.rooms.forEach((room) => room.candidates.forEach(({ candidate }) => ids.add(candidate.id)));
    return ids;
  }, [state]);

  const unassignedCandidates = useMemo(
    () => state?.candidates.filter((candidate) => !assignedCandidateIds.has(candidate.id)) || [],
    [assignedCandidateIds, state]
  );

  const monitoredCandidates = useMemo(() => {
    if (!state) return [];
    if (selectedRoomId === '__unassigned') return unassignedCandidates;
    if (selectedRoomId === '__all') return state.candidates;
    if (!selectedRoom) return state.candidates;
    const ids = new Set(selectedRoom.candidates.map(({ candidate }) => candidate.id));
    return state.candidates.filter((candidate) => ids.has(candidate.id));
  }, [selectedRoom, selectedRoomId, state, unassignedCandidates]);

  const roomNamesByCandidateId = useMemo(() => {
    const map = new Map<string, string[]>();
    state?.rooms.forEach((room) => {
      room.candidates.forEach(({ candidate }) => {
        const names = map.get(candidate.id) || [];
        names.push(room.name);
        map.set(candidate.id, names);
      });
    });
    return map;
  }, [state]);

  const roomByCandidateId = useMemo(() => {
    const map = new Map<string, Room>();
    state?.rooms.forEach((room) => room.candidates.forEach(({ candidate }) => map.set(candidate.id, room)));
    return map;
  }, [state]);

  const filteredCandidates = useMemo(() => {
    if (!state) return [];
    const keyword = candidateSearch.trim().toLowerCase();
    const roomCandidateIds = candidateRoomFilter === '__all'
      ? null
      : candidateRoomFilter === '__unassigned'
        ? new Set(state.candidates.filter((candidate) => !(roomNamesByCandidateId.get(candidate.id)?.length)).map((candidate) => candidate.id))
        : new Set(state.rooms.find((room) => room.id === candidateRoomFilter)?.candidates.map(({ candidate }) => candidate.id) || []);

    return state.candidates.filter((candidate) => {
      if (roomCandidateIds && !roomCandidateIds.has(candidate.id)) return false;
      if (!keyword) return true;
      const searchable = [
        candidate.name,
        candidate.studentId,
        candidate.school,
        candidate.college,
        candidate.major,
        candidate.gender,
        candidate.gradeYear,
        candidate.className,
        candidate.advisor,
        candidate.groupName,
        candidate.teamName,
        candidate.teamMembers,
        candidate.teamMemberStudentIds,
        candidate.examNumber,
        candidate.hydroAccount
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return searchable.includes(keyword);
    });
  }, [candidateRoomFilter, candidateSearch, roomNamesByCandidateId, state]);

  const allFilteredCandidatesSelected = filteredCandidates.length > 0 && filteredCandidates.every((candidate) => selectedCandidateIds.includes(candidate.id));

  const monitoredCandidateIds = useMemo(() => new Set(monitoredCandidates.map((candidate) => candidate.id)), [monitoredCandidates]);

  const filteredLoginRequests = useMemo(
    () => state?.loginRequests.filter((request) => monitoredCandidateIds.has(request.candidate.id)) || [],
    [monitoredCandidateIds, state]
  );

  const selectedLoginRequests = useMemo(
    () => filteredLoginRequests.filter((request) => selectedLoginRequestIds.includes(request.id)),
    [filteredLoginRequests, selectedLoginRequestIds]
  );
  const allLoginRequestsSelected = filteredLoginRequests.length > 0 && filteredLoginRequests.every((request) => selectedLoginRequestIds.includes(request.id));
  const activeLoginRequest = filteredLoginRequests.find((request) => request.id === activeLoginRequestId) || null;
  const activeLoginLiveFrames: Partial<Record<LiveFrame['channel'], LiveFrame>> = activeLoginRequest ? liveFrameByCandidate.get(activeLoginRequest.candidate.id) || {} : {};
  const activeLoginSession = activeLoginRequest ? sessionByCandidate.get(activeLoginRequest.candidate.id) || null : null;
  const activeLoginRoom = activeLoginRequest ? roomByCandidateId.get(activeLoginRequest.candidate.id) : null;
  const activeLoginRequiresFrontCamera = activeLoginRoom?.requireFrontCamera ?? state?.exam.requireFrontCamera ?? true;
  const pendingLoginRequestCount = state?.loginRequests.length || 0;

  const statusCounts = useMemo(() => {
    const counts: Record<CandidateStatus, number> = {
      NOT_REQUESTED: 0,
      REQUESTING: 0,
      REJECTED: 0,
      APPROVED: 0,
      ONLINE_NORMAL: 0,
      ONLINE_ABNORMAL: 0,
      OFFLINE: 0,
      FINISHED: 0
    };
    monitoredCandidates.forEach((candidate) => {
      counts[candidate.status] += 1;
    });
    return counts;
  }, [monitoredCandidates]);

  const monitorDisplayCandidates = useMemo(
    () => monitorCandidates(monitoredCandidates, sessionByCandidate, knownLiveSessions, { field: monitorSearchField, query: monitorSearch }),
    [monitoredCandidates, sessionByCandidate, knownLiveSessions, monitorSearchField, monitorSearch]
  );
  const monitorPage = useMemo(
    () => monitorCandidatePage(monitorDisplayCandidates, monitorPageIndex, layout),
    [monitorDisplayCandidates, monitorPageIndex, layout]
  );
  const visibleCandidates = monitorPage.candidates;
  const monitorPageLabel = monitorPage.label;

  useEffect(() => {
    if (tab !== 'monitor') return;
    // Selection still drives voice/actions, while page position survives polls
    // and availability changes instead of following a moving array index.
    setMonitorPageIndex(monitorPage.index);
    if (!monitorPage.candidates.some(candidate => candidate.id === selectedCandidateId)) {
      setSelectedCandidateId(monitorPage.candidates[0]?.id || '');
    }
  }, [tab, monitorPage, selectedCandidateId]);

  const unreadAlerts = useMemo(() => state?.alerts.filter((alert) => !alert.acknowledgedAt) || [], [state]);
  const handledAlerts = useMemo(() => state?.alerts.filter((alert) => alert.acknowledgedAt) || [], [state]);
  const panelAlerts = useMemo(
    () => (alertFilter === 'pending' ? unreadAlerts : [...unreadAlerts, ...handledAlerts]),
    [alertFilter, unreadAlerts, handledAlerts]
  );
  const unreadAlertGroups = useMemo(() => groupMonitorAlerts(unreadAlerts), [unreadAlerts]);
  const panelAlertGroups = useMemo(() => groupMonitorAlerts(panelAlerts).sort((a, b) => Number(Boolean(a.alerts[0].acknowledgedAt)) - Number(Boolean(b.alerts[0].acknowledgedAt))), [panelAlerts]);
  const alertVideoSource = (alert: Alert) => alert.evidence?.segments[0]?.objectPath || alert.evidencePath || '';
  const activeCheatingByCandidate = useMemo(() => {
    const map = new Map<string, CheatingRecord>();
    state?.cheatingRecords.forEach((record) => {
      if (!record.canceledAt && !map.has(record.candidateId)) map.set(record.candidateId, record);
    });
    return map;
  }, [state]);
  const selectedSettingsRoom = useMemo(() => state?.rooms.find((room) => room.id === selectedSettingsRoomId) || null, [selectedSettingsRoomId, state]);
  const roomProctorRows = useMemo(() => {
    const existing = new Map(selectedSettingsRoom?.proctors.map(({ user }) => [user.realName && user.numberId ? `${user.realName}+${user.numberId}` : user.numberId || user.id, user]) || []);
    return splitProctorLines(roomProctors).map((numberId) => {
      const user = existing.get(numberId);
      return {
        numberId,
        name: user?.realName || user?.nickname || user?.username || '暂未更新'
      };
    });
  }, [roomProctors, selectedSettingsRoom]);
  const roomCandidateRows = useMemo(() => {
    const keyword = roomCandidateSearch.trim().toLowerCase();
    return splitLines(roomCandidates)
      .flatMap((examNumber) => {
        const matches = state?.candidates.filter((candidate) => candidate.examNumber === examNumber) || [];
        return matches.length ? matches : [{ id: '', examNumber, name: null, studentId: null, school: null, college: null, major: null, gender: null, gradeYear: null, className: null, advisor: null, groupName: null, teamName: null, teamMembers: null, teamMemberStudentIds: null, hydroAccount: null, password: '', seatNo: '', isTeamLeader: false, ranked: true, status: 'NOT_REQUESTED' as CandidateStatus, startedAt: null, lateStartAllowedAt: null, abnormal: false }];
      })
      .filter((candidate) => {
        if (!keyword) return true;
        const searchable = [
          'teamName' in candidate ? candidate.teamName : '',
          'name' in candidate ? candidate.name : '',
          'studentId' in candidate ? candidate.studentId : '',
          'examNumber' in candidate ? candidate.examNumber : ''
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return searchable.includes(keyword);
      });
  }, [roomCandidateSearch, roomCandidates, state]);

  function editCandidate(candidate?: Candidate) {
    setError('');
    setCandidateDraft(candidateToDraft(candidate));
    setCandidateDraftRoomId(candidate ? state?.rooms.find((room) => room.candidates.some(({ candidate: item }) => item.id === candidate.id))?.id || '__none' : '__none');
    if (!candidate) {
      setCandidateCsv('');
      setCandidateImportRows([]);
      setCandidateImportFileName('');
      setCandidateImportError('');
    }
    routeToSettings('candidates');
    setCandidateEditorOpen(true);
  }

  function toggleCandidateSelection(candidateId: string) {
    setSelectedCandidateIds((current) => (current.includes(candidateId) ? current.filter((id) => id !== candidateId) : [...current, candidateId]));
  }

  function editRoom(room: Room) {
    setSelectedSettingsRoomId(room.id);
    setRoomName(room.name);
    setRoomProctors(room.proctors.map(({ user }) => user.realName && user.numberId ? `${user.realName}+${user.numberId}` : user.numberId || '').filter(Boolean).join('\n'));
    setRoomCandidates(room.candidates.map(({ candidate }) => candidate.examNumber).join('\n'));
    setRoomRequireSecondCamera(room.requireSecondCamera);
    setRoomRequireFrontCamera(room.requireFrontCamera);
    setRoomLoginMode(room.loginMode);
    setRoomLoginReviewMode(room.loginReviewMode);
    setRoomCandidateSearch('');
    setRoomProctorAddOpen(false);
    setRoomCandidateAddOpen(false);
    routeToSettings('rooms');
    setRoomEditorOpen(true);
  }

  function addRoom() {
    setSelectedSettingsRoomId('');
    setRoomName('');
    setRoomProctors('');
    setRoomCandidates('');
    setRoomRequireSecondCamera(true);
    setRoomRequireFrontCamera(true);
    setRoomLoginMode('CREDENTIALS');
    setRoomLoginReviewMode('MANUAL');
    setRoomCandidateSearch('');
    setRoomProctorAddOpen(false);
    setRoomCandidateAddOpen(false);
    routeToSettings('rooms');
    setRoomEditorOpen(true);
  }

  function setUniqueLines(setter: (value: string) => void, current: string, additions: string[]) {
    setter(Array.from(new Set([...(setter === setRoomProctors ? splitProctorLines(current) : splitLines(current)), ...additions])).join('\n'));
  }

  function removeRoomProctor(numberId: string) {
    setRoomProctors(splitProctorLines(roomProctors).filter((item) => item !== numberId).join('\n'));
  }

  function removeRoomCandidate(examNumber: string) {
    setRoomCandidates(splitLines(roomCandidates).filter((item) => item !== examNumber).join('\n'));
  }

  function addRoomProctors() {
    setUniqueLines(setRoomProctors, roomProctors, splitProctorLines(roomProctorInput));
    setRoomProctorInput('');
    setRoomProctorAddOpen(false);
  }

  function addRoomCandidates() {
    try {
      const examNumbers = resolveRoomCandidateInput(roomCandidateInput, roomCandidateInputType, state?.candidates || []);
      setUniqueLines(setRoomCandidates, roomCandidates, examNumbers);
      setRoomCandidateInput('');
      setRoomCandidateInputError('');
      setRoomCandidateAddOpen(false);
    } catch (error) {
      setRoomCandidateInputError(error instanceof Error ? error.message : '无法匹配考生');
    }
  }

  function selectRoom(roomId: string) {
    setSelectedRoomId(roomId);
    setMonitorPageIndex(0);
    if (roomId === '__all') {
      if (state?.candidates[0]) setSelectedCandidateId(state.candidates[0].id);
      return;
    }
    if (roomId === '__unassigned') {
      if (unassignedCandidates[0]) setSelectedCandidateId(unassignedCandidates[0].id);
      return;
    }
    const room = state?.rooms.find((item) => item.id === roomId);
    const first = room?.candidates[0]?.candidate;
    if (first) setSelectedCandidateId(first.id);
  }

  function turnMonitorPage(direction: -1 | 1) {
    setMonitorPageIndex(Math.min(Math.max(0, monitorPage.index + direction), Math.max(0, monitorPage.total - 1)));
  }

  function focusMonitorCandidate(candidateId: string) {
    if (tab !== 'monitor') { setSelectedCandidateId(candidateId); return; }
    let candidates = monitorDisplayCandidates;
    if (!candidates.some(candidate => candidate.id === candidateId)) {
      // Opening an alert must still reveal its candidate when a search/room
      // filter hid them. The server-provided list remains permission-scoped.
      setMonitorSearch('');
      setSelectedRoomId('__all');
      candidates = monitorCandidates(state?.candidates || [], sessionByCandidate, knownLiveSessions, { field: monitorSearchField, query: '' });
    }
    const index = candidates.findIndex(candidate => candidate.id === candidateId);
    if (index >= 0) { setMonitorPageIndex(Math.floor(index / layout)); setSelectedCandidateId(candidateId); }
  }

  async function runBusy(label: string, action: () => Promise<void>) {
    setBusyAction(label);
    setError('');
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重试');
    } finally {
      setBusyAction('');
    }
  }

  async function review(id: string, approved: boolean) {
    const reason = approved ? '' : window.prompt('请输入拒绝原因') || '';
    if (!approved && !reason) return;
    await runBusy(`review-${id}`, async () => {
      await api(`/api/login-requests/${id}/review`, {
        method: 'POST',
        body: JSON.stringify({ approved, reason })
      });
      await load();
      setActiveLoginRequestId('');
      setSelectedLoginRequestIds((ids) => ids.filter((item) => item !== id));
    });
  }

  async function batchApprove() {
    if (!selectedLoginRequests.length) return;
    if (!window.confirm(`确认批量通过 ${selectedLoginRequests.length} 条登录请求？`)) return;
    await runBusy('batchApprove', async () => {
      await Promise.all(
        selectedLoginRequests.map((item) =>
          api(`/api/login-requests/${item.id}/review`, {
            method: 'POST',
            body: JSON.stringify({ approved: true })
          })
        )
      );
      await load();
      setSelectedLoginRequestIds([]);
    });
  }

  async function unlock(sessionId: string, candidate: Candidate, suppliedReason?: string) {
    const reason = suppliedReason ?? window.prompt(`请输入取消 ${displayName(candidate)} 同学客户端锁定的原因`);
    if (!reason?.trim()) return;
    if (!window.confirm(`确认取消 ${displayName(candidate)} 同学的客户端锁定？原因：${reason.trim()}`)) return;
    await runBusy(`unlock-${sessionId}`, async () => {
      await api(`/api/sessions/${sessionId}/unlock`, { method: 'POST', body: JSON.stringify({ reason: reason.trim() }) });
      await load();
      setUsbHandling(null);
      setUsbReason('');
    });
  }

  async function forceFinish(sessionId: string) {
    if (!window.confirm('确认由监考老师结束该考生考试？')) return;
    await api(`/api/sessions/${sessionId}/force-finish`, { method: 'POST' });
    await load();
  }

  async function resumeCandidate(candidate: Candidate) {
    if (!examInProgress) {
      window.alert('当前不在考试时间内，不能继续考试。');
      return;
    }
    if (!window.confirm(`确认允许 ${displayName(candidate)} 同学继续考试？未开始的考生可超过最晚开考时间登录并确认开始；已开始的考生保留原计时，考试结束时间不变。`)) return;
    await runBusy(`resume-${candidate.id}`, async () => {
      await api(`/api/candidates/${candidate.id}/resume`, { method: 'POST' });
      await load();
    });
  }

  async function retryOj(sessionId: string) {
    await api(`/api/sessions/${sessionId}/oj-retry`, { method: 'POST' });
    await load();
  }

  async function ackAlerts(alertIds: string[]) {
    if (!alertIds.length) return;
    await runBusy(`ackAlert-${alertIds[0]}`, async () => {
      try {
        // Only the explicitly reviewed snapshot is acknowledged. New alerts
        // arriving during this operation must stay pending.
        for (const alertId of alertIds) {
          const updated = await api<Alert>(`/api/alerts/${alertId}/ack`, { method: 'POST' });
          setState((current) => current ? {
            ...current,
            alerts: current.alerts.map((alert) => alert.id === alertId ? { ...alert, acknowledgedAt: updated.acknowledgedAt } : alert)
          } : current);
        }
      } finally { await load(); }
    });
  }

  async function sendWarning(candidate: Candidate, sessionId?: string) {
    if (!examInProgress) {
      window.alert('当前不在考试时间内，不能发送警告消息。');
      return;
    }
    const content = window.prompt(`发送给 ${displayName(candidate)} 同学（考号：${candidate.examNumber}），考生需确认已读：`, '监考老师提醒你：请遵守考试纪律并注意考试要求。');
    if (!content?.trim()) return;
    await runBusy(`warning-${candidate.id}`, async () => {
      await api('/api/alerts/warning', {
        method: 'POST',
        body: JSON.stringify({ candidateId: candidate.id, sessionId, content: content.trim() })
      });
      await load();
    });
  }

  async function markCheating(candidate: Candidate, sessionId?: string, suppliedReason?: string) {
    const reason = suppliedReason ?? window.prompt(`请输入 ${displayName(candidate)} 同学被标记作弊的原因`);
    if (!reason?.trim()) return;
    const teamWide = candidate.teamName ? window.confirm(`是否取消 ${candidate.teamName} 团队所有成员的成绩？`) : false;
    const confirmText = candidate.teamName
      ? `${candidate.teamName}团队${displayName(candidate)}同学因${reason.trim()}原因被${proctorName}记录为作弊`
      : `${displayName(candidate)}同学因${reason.trim()}原因被${proctorName}记录为作弊`;
    if (!window.confirm(confirmText)) return;
    await runBusy(`cheating-${candidate.id}`, async () => {
      await api(`/api/candidates/${candidate.id}/cheating`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason.trim(), sessionId, teamWide })
      });
      await load();
      setUsbHandling(null);
      setUsbReason('');
    });
  }

  async function cancelCheating(candidate: Candidate) {
    const reason = window.prompt(`请输入取消 ${displayName(candidate)} 同学作弊标记的原因`);
    if (!reason?.trim()) return;
    if (!window.confirm(`确认取消 ${displayName(candidate)} 同学的作弊标记？取消原因：${reason.trim()}`)) return;
    await runBusy(`cheating-${candidate.id}`, async () => {
      await api(`/api/candidates/${candidate.id}/cheating`, {
        method: 'DELETE',
        body: JSON.stringify({ reason: reason.trim() })
      });
      await load();
    });
  }

  function startVoiceForCandidate(candidate: Candidate, sessionId?: string) {
    if (!examInProgress || !sessionId || voiceBusy) return;
    setSelectedCandidateId(candidate.id);
    setVoiceTarget({ candidate, sessionId });
  }

  async function importCandidates() {
    if (candidateImportReading || !candidateImportRows.length) return;
    setCandidateImportError('');
    await runBusy('importCandidates', async () => {
      try {
        const parsedRows = parseCandidateCsv(candidateCsv);
        const rows = state?.exam.contestType === 'TEAM' && state.exam.teamAccountMode === 'TEAM_ACCOUNT'
          ? mergeTeamCandidateRows(parsedRows)
          : parsedRows;
        await api(`/api/exams/${examId}/candidates`, {
          method: 'POST',
          body: JSON.stringify({ rows })
        });
        setCandidateEditorOpen(false);
        await load();
      } catch (err) {
        setCandidateImportError(err instanceof Error ? err.message : '导入失败，请重试');
        throw err;
      }
    });
  }

  async function saveCandidate() {
    const previousCandidateId = candidateDraft.id;
    const previousExamNumber = state?.candidates.find((candidate) => candidate.id === previousCandidateId)?.examNumber;
    const method = candidateDraft.id ? 'PATCH' : 'POST';
    const body = candidateDraft.id
      ? candidateDraft
      : {
          rows: [
            {
              name: candidateDraft.name,
              studentId: candidateDraft.studentId,
              school: candidateDraft.school,
              college: candidateDraft.college,
              major: candidateDraft.major,
              gender: candidateDraft.gender,
              gradeYear: candidateDraft.gradeYear,
              className: candidateDraft.className,
              advisor: candidateDraft.advisor,
              groupName: candidateDraft.groupName,
              teamName: candidateDraft.teamName,
              teamMembers: candidateDraft.teamMembers,
              teamMemberStudentIds: candidateDraft.teamMemberStudentIds,
              examNumber: candidateDraft.examNumber,
              password: candidateDraft.password,
              seatNo: candidateDraft.seatNo,
              isTeamLeader: candidateDraft.isTeamLeader,
              ranked: candidateDraft.ranked
            }
          ]
        };
    await runBusy('saveCandidate', async () => {
      await api(`/api/exams/${examId}/candidates`, {
        method,
        body: JSON.stringify(body)
      });
      await saveCandidateRoomAssignment(candidateDraft.examNumber, previousCandidateId, previousExamNumber);
      setCandidateDraft(candidateToDraft());
      setCandidateEditorOpen(false);
      await load();
    });
  }

  async function saveCandidateRoomAssignment(examNumber: string, candidateId?: string, previousExamNumber?: string) {
    if (!state || candidateDraftRoomId === '') return;
    const targetRoomId = candidateDraftRoomId === '__none' ? '' : candidateDraftRoomId;
    const currentCandidate = state.candidates.find(candidate => candidate.id === candidateId);
    const teamMembers = state.exam.contestType === 'TEAM' && currentCandidate?.teamName
      ? state.candidates.filter(candidate => candidate.teamName === currentCandidate.teamName)
      : currentCandidate ? [currentCandidate] : [];
    const affectedCandidateIds = new Set(teamMembers.map(candidate => candidate.id));
    const targetExamNumbers = teamMembers.map(candidate => candidate.id === candidateId ? examNumber : candidate.examNumber);
    if (!targetExamNumbers.length) targetExamNumbers.push(examNumber);
    const affectedRooms = state.rooms.filter(
      (room) => room.id === targetRoomId || room.candidates.some(({ candidate }) => affectedCandidateIds.has(candidate.id) || candidate.id === candidateId || candidate.examNumber === previousExamNumber || candidate.examNumber === examNumber)
    );
    await Promise.all(
      affectedRooms.map((room) => {
        const candidateExamNumbers = room.candidates
          .filter(({ candidate }) => !affectedCandidateIds.has(candidate.id) && candidate.id !== candidateId && candidate.examNumber !== previousExamNumber && candidate.examNumber !== examNumber)
          .map(({ candidate }) => candidate.examNumber);
        if (room.id === targetRoomId) candidateExamNumbers.push(...targetExamNumbers);
        return api(`/api/exams/${examId}/rooms`, {
          method: 'POST',
          body: JSON.stringify({
            id: room.id,
            name: room.name,
            proctorNumberIds: room.proctors.map(({ user }) => user.realName && user.numberId ? `${user.realName}+${user.numberId}` : user.numberId).filter(Boolean),
            candidateExamNumbers
          })
        });
      })
    );
  }

  async function deleteCandidates(ids = selectedCandidateIds) {
    if (!ids.length) return;
    if (!window.confirm(`确认删除 ${ids.length} 名考生？该操作会同时删除该考生的登录请求、会话、告警和考室分配。`)) return;
    await runBusy('deleteCandidates', async () => {
      await api(`/api/exams/${examId}/candidates`, {
        method: 'DELETE',
        body: JSON.stringify({ ids })
      });
      setSelectedCandidateIds([]);
      if (ids.includes(selectedCandidateId)) setSelectedCandidateId('');
      await load();
    });
  }

  async function importRoom() {
    await runBusy('importRoom', async () => {
      await api(`/api/exams/${examId}/rooms`, {
        method: 'POST',
        body: JSON.stringify({
          id: selectedSettingsRoomId || undefined,
          name: roomName,
          requireSecondCamera: roomRequireSecondCamera,
          requireFrontCamera: roomRequireFrontCamera,
          loginMode: roomLoginMode,
          loginReviewMode: roomLoginReviewMode,
          proctorNumberIds: splitProctorLines(roomProctors),
          candidateExamNumbers: splitLines(roomCandidates)
        })
      });
      setRoomEditorOpen(false);
      await load();
    });
  }

  async function assignUnassignedToRoom() {
    const room = state?.rooms.find((item) => item.id === assignRoomId);
    if (!room || !unassignedCandidates.length) return;
    await runBusy('assignUnassigned', async () => {
      await api(`/api/exams/${examId}/rooms`, {
        method: 'POST',
        body: JSON.stringify({
          id: room.id,
          name: room.name,
          proctorNumberIds: room.proctors.map(({ user }) => user.realName && user.numberId ? `${user.realName}+${user.numberId}` : user.numberId).filter(Boolean),
          candidateExamNumbers: [...room.candidates.map(({ candidate }) => candidate.examNumber), ...unassignedCandidates.map((candidate) => candidate.examNumber)]
        })
      });
      await load();
    });
  }

  async function importRoomsBatch() {
    const rooms = parseRoomCsv(roomCsv).filter((room) => room.name && room.proctorNumberIds.length);
    if (!rooms.length) {
      setError('请填写至少一个考室，且每个考室至少有一个监考老师学号');
      return;
    }
    await runBusy('importRoomsBatch', async () => {
      await api(`/api/exams/${examId}/rooms`, {
        method: 'POST',
        body: JSON.stringify({ rooms })
      });
      setRoomImportOpen(false);
      setRoomCsv('');
      await load();
    });
  }

  async function deleteRoom(roomId: string, roomNameText: string) {
    if (!window.confirm(`确认删除考室“${roomNameText}”？该操作只删除考室分配，不删除考生和管理员。`)) return;
    await runBusy(`deleteRoom-${roomId}`, async () => {
      await api(`/api/exams/${examId}/rooms?roomId=${encodeURIComponent(roomId)}`, { method: 'DELETE' });
      setSelectedRoomId('__all');
      await load();
    });
  }

  async function saveExamSettings() {
    if (!examForm) return;
    await runBusy('saveExamSettings', async () => {
      await api(`/api/exams/${examId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: examForm.name,
          startAt: datetimeLocalToIso(examForm.startAt),
          latestStartAt: datetimeLocalToIso(examForm.latestStartAt),
          endAt: datetimeLocalToIso(examForm.endAt),
          durationMinutes: examForm.durationMinutes,
          platform: examForm.platform,
          ...(examForm.platform === 'NOVAJUDGE' ? { platformBaseUrl: examForm.platformBaseUrl, platformContestId: examForm.platformContestId, novaJudgeTimezone: examForm.novaJudgeTimezone, ...(examForm.novaJudgeApiKey?.trim() ? { novaJudgeApiKey: examForm.novaJudgeApiKey.trim() } : {}) } : {}),
          contestType: examForm.contestType,
          teamAccountMode: examForm.teamAccountMode,
          contestRule: examForm.contestRule,
          flexible: examForm.flexible,
          scoreboardFrozenAt: examForm.scoreboardFrozenAt,
          showTestCaseCount: examForm.showTestCaseCount,
          showObjectiveScore: examForm.showObjectiveScore,
          allowPrint: examForm.printMode !== 'DISABLED',
          printMode: examForm.printMode,
          allowTeamSubmissionView: examForm.allowTeamSubmissionView,
          leaderOnlySubmission: examForm.leaderOnlySubmission,
          rules: examForm.rules,
          requireMiniProgram: examForm.requireMiniProgram,
          requireFrontCamera: examForm.requireFrontCamera,
          saveFullRecording: examForm.saveFullRecording,
          saveIncidentRecording: examForm.saveIncidentRecording ?? false
        })
      });
      setExamFormDirty(false);
      await load();
    });
  }

  async function saveProblemScores() {
    const problems = state?.exam.problems || [];
    if (!problems.length) return;
    await runBusy('saveProblemScores', async () => {
      await api(`/api/exams/${examId}/problems`, {
        method: 'PATCH',
        body: JSON.stringify({ problems: problems.map(problem => ({ id: problem.id, scorePercent: problemPercents[problem.id] ?? 100 })) })
      });
      await load();
    });
  }

  async function processPrint(job: PrintJob, action: 'PRINTED' | 'REJECTED') {
    const reason = action === 'REJECTED' ? printRejectReason.trim() : undefined;
    if (action === 'REJECTED' && !reason) return;
    const nextJob = state?.printJobs.find(item => item.mode === 'PHYSICAL' && item.status === 'PENDING' && item.id !== job.id) || null;
    if (action === 'PRINTED') window.open(`/api/exams/${examId}/print-jobs/${job.id}/document?print=1`, '_blank', 'noopener,noreferrer');
    await api(`/api/exams/${examId}/print-jobs`, { method: 'PATCH', body: JSON.stringify({ id: job.id, action, reason }) });
    setPrintRejectReason('');
    setSelectedPrintJob(nextJob);
    await load();
  }

  function updateExamForm(next: Exam) {
    setExamForm(normalizeContestFormat(next));
    setExamFormDirty(true);
  }

  async function downloadTemplate() {
    const XLSX = await import('xlsx');
    const headers =
      state?.exam.contestType === 'TEAM'
        ? state.exam.teamAccountMode === 'TEAM_ACCOUNT'
          ? ['考号', '队伍名称', '队伍成员姓名', '密码', '学校', '队伍成员学号', '队伍类型', '指导老师', '座位号', '是否队长', '是否排名']
          : ['考号', '队伍名称', '姓名', '密码', '学校', '学院', '专业', '学号', '性别', '年级', '行政班级', '队伍类型', '指导老师', '座位号', '是否队长', '是否排名']
        : ['考号', '姓名', '密码', '学校', '学院', '专业', '学号', '性别', '年级', '行政班级', '参赛组别', '指导老师', '座位号', '是否排名'];
    const sample =
      state?.exam.contestType === 'TEAM'
        ? state.exam.teamAccountMode === 'TEAM_ACCOUNT'
          ? ['T1001', '一队', '张三、李四', 'pass001', '西华师范大学', '20240001、20240002', '正式队伍', '李老师', 'A01', '是', '是']
          : ['T1001', '一队', '张三', 'pass001', '西华师范大学', '计算机学院', '计算机科学与技术', '20240001', '男', '2024', '计科2401', '正式队伍', '李老师', 'A01', '是', '是']
        : ['1001', '张三', 'pass001', '西华师范大学', '计算机学院', '计算机科学与技术', '20240001', '男', '2024', '计科2401', '正式参赛', '李老师', 'A01', '是'];
    const groupIndex = headers.findIndex(header => header === '参赛组别' || header === '队伍类型');
    if (groupIndex >= 0) sample[groupIndex] = participationOptions(state?.exam.contestRule || '')[0]?.label || sample[groupIndex];
    headers.push('考室');
    sample.push('');
    const sheet = XLSX.utils.aoa_to_sheet([headers, sample]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, '考生导入模板');
    XLSX.writeFile(book, `${state?.exam.name || '考试'}-考生导入模板.xlsx`);
  }

  async function readCandidateFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    setCandidateImportReading(true);
    setCandidateImportFileName(file.name);
    setCandidateImportError('');
    setCandidateCsv('');
    setCandidateImportRows([]);
    try {
      const { text, rows } = await readCandidateImportFile(file);
      setCandidateCsv(text);
      setCandidateImportRows(rows);
    } catch (err) {
      input.value = '';
      setCandidateImportError(err instanceof Error ? err.message : '文件读取失败，请使用考生导入模板');
    } finally {
      setCandidateImportReading(false);
    }
  }

  async function downloadRoomTemplate() {
    const XLSX = await import('xlsx');
    const sheet = XLSX.utils.aoa_to_sheet([
      ['考室名称', '监考老师学号', '考生考号', '登录请求审核方式'],
      ['第一考室', '20240001、20240002', '1001、1002', '手动审核']
    ]);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, '考室导入模板');
    XLSX.writeFile(book, `${state?.exam.name || '考试'}-考室导入模板.xlsx`);
  }

  async function readRoomFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const XLSX = await import('xlsx');
    const buffer = await file.arrayBuffer();
    const book = XLSX.read(buffer, { type: 'array' });
    const sheet = book.Sheets[book.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json<Array<string | number>>(sheet, { header: 1, defval: '' });
    setRoomCsv(rows.map((row) => row.map(csvEscape).join(',')).join('\n'));
    event.target.value = '';
  }

  if (!state) {
    return (
      <div className="card">
        <div className="muted">正在加载考试信息</div>
        {error ? <div style={{ color: 'var(--danger)' }}>{error}</div> : null}
      </div>
    );
  }

  return (
    <div className={tab === 'monitor' ? 'grid monitor-page' : 'grid'}>
      {tab !== 'monitor' && tab !== 'print' ? <div className="return-only-row"><button type="button" className="exam-management-back" onClick={() => router.push(parentRoutePath(pathname || '/'))}><ArrowLeft size={16} /> 返回上级</button></div> : null}
      <div className="topbar exam-detail-topbar">
        <div>
          <h1>{state.exam.name}</h1>
          <div className="muted exam-detail-meta">
                  赛制：{state.exam.contestRule === 'ACM' ? 'XCPC' : state.exam.contestRule} / 题目：{state.exam.problems?.length || 0} 道
          </div>
        </div>
        <button className="button secondary" onClick={() => void load()}>
          <RefreshCw size={18} />
          刷新
        </button>
      </div>

      {error ? <div className="card" style={{ color: 'var(--danger)' }}>{error}</div> : null}

      {tab !== 'settings' && tab !== 'monitor' ? (
        <div className="exam-monitoring-layout">
          <main className="exam-monitoring-content">
          {tab === 'login-restrictions' ? <ExamLoginRestrictionsPanel examId={examId} /> : null}
          {tab === 'status' || tab === 'login' ? <div className="login-request-layout">
          {tab === 'status' ?
          <section className="card grid candidate-status-panel">
            <div className="login-section-head">
              <h2 style={{ margin: 0 }}>考生状态</h2>
              <div className="login-room-actions">
                <label className="compact-field login-room-select">
                  <span>考室</span>
                  <select value={selectedRoomId || '__all'} onChange={(event) => selectRoom(event.target.value)}>
                    <option value="__all">{allRoomsLabel} ({state.candidates.length})</option>
                    {state.rooms.map((room) => (
                      <option key={room.id} value={room.id}>{room.name} ({room.candidates.length})</option>
                    ))}
                    {canManage ? <option value="__unassigned">未分配 ({unassignedCandidates.length})</option> : null}
                  </select>
                </label>
              </div>
            </div>
            <div className="grid four">
              {monitoredCandidates.map((candidate) => (
                <button
                  key={candidate.id}
                  className={`status-cell status-${candidate.status}`}
                  onClick={() => setSelectedCandidateId(candidate.id)}
                  style={{ textAlign: 'left', cursor: 'pointer' }}
                >
                  {state.exam.contestType === 'TEAM' ? (
                    <div className="team-candidate-lines">
                      {teamMemberRows(candidate, roomNamesByCandidateId.get(candidate.id)).map((member, index) => (
                        <div key={`${candidate.id}-${index}`} className="team-member-line">
                          <strong>{member.teamName}</strong>
                          <span>学校：{member.school}</span>
                          <span>学院：{member.college}</span>
                          <span>成员姓名：{member.memberName}</span>
                          <span>考号：{member.examNumber}</span>
                          <span>座位号：{member.seatNo}</span>
                          <span>考室：{member.roomName}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <>
                      <strong>{displayName(candidate)}</strong>
                      <div className="muted">学校：{candidate.school || '-'}</div>
                      <div className="muted">学院：{candidate.college || '-'}</div>
                      {selectedRoomId === '__all' ? <div className="muted">考室：{roomNamesByCandidateId.get(candidate.id)?.join('、') || '未分配'}</div> : null}
                      <div className="muted">考号：{candidate.examNumber}</div>
                      <div className="muted">座位：{candidate.seatNo}</div>
                    </>
                  )}
                  <div>{statusText(candidate.status)}</div>
                  {candidate.abnormal ? <span className="blink-dot" /> : null}
                </button>
              ))}
              {!monitoredCandidates.length ? <div className="muted">当前筛选下暂无考生</div> : null}
            </div>
          </section> : null}

          {tab === 'login' ? <>
          <section className="card grid">
            <div className="request-list-head">
              <h2>登录请求</h2>
              <div className="request-head-actions">
                <label className="request-check-all">
                  <input
                    type="checkbox"
                    checked={allLoginRequestsSelected}
                    onChange={(event) => {
                      setSelectedLoginRequestIds(event.target.checked ? filteredLoginRequests.map((request) => request.id) : []);
                    }}
                    disabled={!filteredLoginRequests.length}
                  />
                  全选
                </label>
                <button className="button secondary request-batch-button" onClick={() => void batchApprove()} disabled={!selectedLoginRequests.length || busyAction === 'batchApprove'}>
                  <Check size={18} />
                  {busyAction === 'batchApprove' ? '处理中' : `批量通过 ${selectedLoginRequests.length || ''}`}
                </button>
              </div>
            </div>
            {filteredLoginRequests.map((request) => (
              <div key={request.id} className="request-row">
                <label className="request-row-check" title="选择此请求">
                  <input
                    type="checkbox"
                    checked={selectedLoginRequestIds.includes(request.id)}
                    onChange={(event) => {
                      setSelectedLoginRequestIds((ids) =>
                        event.target.checked ? Array.from(new Set([...ids, request.id])) : ids.filter((id) => id !== request.id)
                      );
                    }}
                  />
                </label>
                <div className="request-row-main">
                  <strong>{displayName(request.candidate)}同学请求登录</strong>
                  <span>
                    考号：{request.candidate.examNumber}
                    {selectedRoomId === '__all' ? ` / 考室：${roomNamesByCandidateId.get(request.candidate.id)?.join('、') || '未分配'}` : ''}
                  </span>
                </div>
                <button className="button request-handle-button" onClick={() => setActiveLoginRequestId(request.id)}>
                  处理
                </button>
              </div>
            ))}
            {!filteredLoginRequests.length ? <div className="muted">当前筛选下暂无待审核请求</div> : null}
          </section>

          {activeLoginRequest ? (
            <div className="modal-backdrop" role="presentation" onMouseDown={() => setActiveLoginRequestId('')}>
              <section className="modal-panel login-review-modal" onMouseDown={(event) => event.stopPropagation()}>
                <div className="modal-title">
                  <div>
                    <h2>{displayName(activeLoginRequest.candidate)}同学请求登录</h2>
                    <div className="muted">
                      学校：{activeLoginRequest.candidate.school || '-'} / 学院：{activeLoginRequest.candidate.college || '-'} / 考号：{activeLoginRequest.candidate.examNumber} / 座位：{activeLoginRequest.candidate.seatNo}
                    </div>
                  </div>
                  <button className="button secondary icon-button" onClick={() => setActiveLoginRequestId('')} title="关闭">
                    <X size={16} />
                  </button>
                </div>
                {state.exam.contestType === 'TEAM' ? (
                  <div className="team-request-lines">
                    {teamMemberRows(activeLoginRequest.candidate, roomNamesByCandidateId.get(activeLoginRequest.candidate.id)).map((member, index) => (
                      <div key={`${activeLoginRequest.id}-${index}`} className="team-member-line">
                        <strong>{member.teamName}</strong>
                        <span>学校：{member.school}</span>
                        <span>学院：{member.college}</span>
                        <span>成员姓名：{member.memberName}</span>
                        <span>考号：{member.examNumber}</span>
                        <span>座位号：{member.seatNo}</span>
                        <span>考室：{member.roomName}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                <div className="review-media">
                  {activeLoginRequest.identityPhotoPath ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={activeLoginRequest.identityPhotoPath} alt="提交的身份认证图片" />
                  ) : (
                    <div className="review-media-empty">身份认证图片未上传</div>
                  )}
                  {activeLoginRequest.roomVideoPath ? (
                    <video src={activeLoginRequest.roomVideoPath} controls muted playsInline />
                  ) : (
                    <div className="review-media-empty">环境视频未上传</div>
                  )}
                </div>
                <div className="review-live-title">请求登录实时画面</div>
                <div className="review-media review-live-media">
                  {activeLoginSession ? (
                    <div className="review-live-frame">
                      <span className="review-live-label">电脑屏幕 · 实时</span>
                      <LiveStreamVideo sessionId={activeLoginSession.id} channel="DESKTOP_SCREEN" />
                    </div>
                  ) : activeLoginLiveFrames.DESKTOP_SCREEN?.objectPath ? (
                    <div className="review-live-frame">
                      <span className="review-live-label">电脑屏幕</span>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={activeLoginLiveFrames.DESKTOP_SCREEN.objectPath} alt="请求登录电脑屏幕实时画面" />
                    </div>
                  ) : (
                    <div className="review-media-empty">电脑屏幕等待采集</div>
                  )}
                  {activeLoginSession && activeLoginRequiresFrontCamera ? (
                    <div className="review-live-frame">
                      <span className="review-live-label">电脑摄像头 · 实时</span>
                      <LiveStreamVideo sessionId={activeLoginSession.id} channel="DESKTOP_CAMERA" />
                    </div>
                  ) : activeLoginLiveFrames.DESKTOP_CAMERA?.objectPath ? (
                    <div className="review-live-frame">
                      <span className="review-live-label">电脑摄像头</span>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={activeLoginLiveFrames.DESKTOP_CAMERA.objectPath} alt="请求登录电脑摄像头实时画面" />
                    </div>
                  ) : (
                    <div className="review-media-empty">{activeLoginRequiresFrontCamera ? '电脑摄像头等待采集' : '所在考室不要求前置摄像头'}</div>
                  )}
                </div>
                <div className="modal-actions">
                  <button className="button" onClick={() => void review(activeLoginRequest.id, true)} disabled={busyAction === `review-${activeLoginRequest.id}`}>
                    <Check size={18} />
                    {busyAction === `review-${activeLoginRequest.id}` ? '处理中' : '通过登录'}
                  </button>
                  <button className="button danger" onClick={() => void review(activeLoginRequest.id, false)} disabled={busyAction === `review-${activeLoginRequest.id}`}>
                    <X size={18} />
                    拒绝登录
                  </button>
                </div>
              </section>
            </div>
          ) : null}
          </> : null}
        </div> : null}
        {tab === 'qa' ? <ExamQAPanel examId={examId} canManage={canManage} /> : null}
        {tab === 'screen' && canManage ? <ExamScreenControlPanel examId={examId} /> : null}
        {tab === 'print' ? <section className="print-admin-page">
          <div className="print-admin-hero">
            <div><span>PRINT QUEUE</span><h2>打印审核</h2><p>统一处理所有考室提交的实体打印任务</p></div>
            <div className="print-admin-stats"><div><strong>{state.printJobs.filter(job => job.status === 'PENDING').length}</strong><span>待打印</span></div><div><strong>{state.printJobs.filter(job => job.status === 'PRINTED').length}</strong><span>已打印</span></div><div><strong>{state.printJobs.filter(job => job.status === 'REJECTED').length}</strong><span>已驳回</span></div></div>
          </div>
          <div className="print-admin-list">
            {state.printJobs.map(job => <button type="button" className={`print-admin-row ${job.status.toLowerCase()}`} key={job.id} onClick={() => { setPrintRejectReason(''); setSelectedPrintJob(job); }}>
              <span className="print-admin-file"><FileText size={20} /></span>
              <span className="print-admin-primary"><strong>{job.title}</strong><small>{job.teamName || job.candidateName || job.examNumber}</small></span>
              <span><small>考室 / 座位</small><strong>{job.roomName || '-'} · {job.seatNo || '-'}</strong></span>
              <span><small>提交时间</small><strong>{new Date(job.createdAt).toLocaleString('zh-CN', { hour12: false })}</strong></span>
              <em>{job.status === 'PENDING' ? '待打印' : job.status === 'PRINTED' ? '已打印' : job.status === 'REJECTED' ? '已驳回' : '虚拟打印'}</em>
              <ChevronRight size={18} />
            </button>)}
            {!state.printJobs.length ? <div className="print-admin-empty"><Printer size={30} /><strong>暂无打印记录</strong><span>考生提交打印后会实时出现在这里</span></div> : null}
          </div>
          {selectedPrintJob ? <div className="print-review-overlay">
            <aside className="print-review-queue"><header><span>待处理队列</span><strong>{state.printJobs.filter(job => job.mode === 'PHYSICAL' && job.status === 'PENDING').length} 份</strong></header><div>{state.printJobs.filter(job => job.mode === 'PHYSICAL' && job.status === 'PENDING').map((job, index) => <button type="button" className={selectedPrintJob.id === job.id ? 'active' : ''} key={job.id} onClick={() => { setPrintRejectReason(''); setSelectedPrintJob(job); }}><b>{index + 1}</b><span><strong>{job.candidateName || job.examNumber}</strong><small>{job.roomName || '-'} · {job.seatNo || '-'}</small></span></button>)}</div></aside>
            <main className="print-review-main"><header><div><span>PRINT REVIEW</span><h2>{selectedPrintJob.title}</h2><p>{selectedPrintJob.teamName ? `${selectedPrintJob.teamName} · ${selectedPrintJob.teamMembers || selectedPrintJob.candidateName || ''}` : `${selectedPrintJob.candidateName || selectedPrintJob.examNumber} · ${selectedPrintJob.roomName || '-'} · ${selectedPrintJob.seatNo || '-'}`}</p></div><button type="button" className="print-review-close" onClick={() => setSelectedPrintJob(null)}><X size={20} />关闭预览</button></header><iframe title="打印内容预览" src={`/api/exams/${examId}/print-jobs/${selectedPrintJob.id}/document`} />
              <footer>{selectedPrintJob.mode === 'PHYSICAL' && selectedPrintJob.status === 'PENDING' ? <><label><span>驳回理由</span><input value={printRejectReason} onChange={event => setPrintRejectReason(event.target.value)} placeholder="驳回时填写原因" /></label><button className="button danger" disabled={!printRejectReason.trim()} onClick={() => void processPrint(selectedPrintJob, 'REJECTED')}>驳回</button><button className="button print-review-submit" onClick={() => void processPrint(selectedPrintJob, 'PRINTED')}><Printer size={17} />打印并查看下一份</button></> : <><span className="print-review-finished">该记录已处理</span><button className="button secondary" onClick={() => setSelectedPrintJob(null)}>关闭</button>{selectedPrintJob.mode === 'PHYSICAL' && selectedPrintJob.status === 'PRINTED' ? <button className="button print-review-submit" onClick={() => window.open(`/api/exams/${examId}/print-jobs/${selectedPrintJob.id}/document?print=1`, '_blank', 'noopener,noreferrer')}><Printer size={17} />重新打印</button> : null}</>}</footer>
            </main>
          </div> : null}
        </section> : null}
          </main>
          <nav className="subnav exam-monitoring-subnav card" aria-label="监考详情导航">
            <h2>监考详情</h2>
            <button className={`button ${tab === 'status' ? '' : 'secondary'}`} onClick={() => routeTo('status')}>考生状态</button>
            <button className={`button ${tab === 'login' ? '' : 'secondary'}`} onClick={() => routeTo('login')}>登录请求{pendingLoginRequestCount ? <span className="nav-badge">{pendingLoginRequestCount}</span> : null}</button>
            <button className={`button ${tab === 'login-restrictions' ? '' : 'secondary'}`} onClick={() => routeTo('login-restrictions')}>登录限制</button>
            <button className={`button ${tab === 'qa' ? '' : 'secondary'}`} onClick={() => routeTo('qa')}>赛时答疑</button>
            <button className={`button ${tab === 'print' ? '' : 'secondary'}`} onClick={() => routeTo('print')}>打印{state.printJobs.some(job => job.status === 'PENDING') ? <span className="nav-badge">{state.printJobs.filter(job => job.status === 'PENDING').length}</span> : null}</button>
            <button className="button secondary" onClick={() => routeTo('monitor')}>视频监考</button>
            {canManage ? <button className={`button ${tab === 'screen' ? '' : 'secondary'}`} onClick={() => routeTo('screen')}>屏幕控制</button> : null}
          </nav>
        </div>
      ) : null}

      {tab === 'monitor' ? (
        <>
          <section className="monitor-fullscreen-head">
            <div className="return-only-row"><button className="monitor-back-button" onClick={() => routeTo('status')}>
              <ArrowLeft size={16} />
              返回详情
            </button></div>
            <div className="monitor-fullscreen-title-row"><div className="monitor-title">
              <strong>{state.exam.name}</strong>
              <span>{new Date(state.exam.startAt).toLocaleString()} - {new Date(state.exam.endAt).toLocaleString()}</span>
            </div>
            <div className="monitor-head-actions">
              <div className="monitor-search" role="search" aria-label="搜索监考考生">
                <select aria-label="搜索方式" value={monitorSearchField} onChange={event => { setMonitorSearchField(event.target.value as MonitorSearchField); setMonitorPageIndex(0); }}>
                  <option value="name">姓名</option>
                  <option value="studentId">学号</option>
                </select>
                <label>
                  <Search size={15} aria-hidden="true" />
                  <input aria-label={monitorSearchField === 'name' ? '按姓名搜索' : '按学号搜索'} type="search" value={monitorSearch}
                    placeholder={monitorSearchField === 'name' ? '搜索姓名' : '搜索学号'}
                    onChange={event => { setMonitorSearch(event.target.value); setMonitorPageIndex(0); }} />
                </label>
              </div>
              {canManage ? <button className="button secondary" onClick={() => routeTo('screen')}>屏幕控制</button> : null}
              <button className="monitor-alert-button" onClick={() => setNotificationsOpen((open) => !open)} title="异常提醒">
                <Bell size={18} />
                <span>异常提醒</span>
                {unreadAlertGroups.length ? <b>{unreadAlertGroups.length}</b> : null}
              </button>
              <label className="monitor-layout-switch">
                <span>显示</span>
                <select value={layout} onChange={(event) => { setLayout(Number(event.target.value) as 1 | 4); setMonitorPageIndex(0); }}>
                  <option value={1}>1 人</option>
                  <option value={4}>4 人</option>
                </select>
              </label>
              {layout === 1 ? <button type="button" className={`button secondary monitor-sound-toggle ${monitorSound && !voiceBusy ? 'enabled' : ''}`} aria-pressed={monitorSound && !voiceBusy} disabled={voiceBusy}
                onClick={() => setMonitorSound(value => !value)}>{voiceBusy ? '通话中，监看声音已暂停' : monitorSound ? '当前考生声音：开' : '当前考生声音：关'}</button> : <span className="muted monitor-sound-hint">多人监看已静音</span>}
            </div></div>
          </section>

          <section className="monitor-stage">
            <div className={layout === 4 ? 'monitor-feed-grid four-feeds' : 'monitor-feed-grid one-feed'}>
              {visibleCandidates.map((candidate) => {
                const session = sessionByCandidate.get(candidate.id);
                const timing = { ...state.exam, startAt: new Date(state.exam.startAt), latestStartAt: new Date(state.exam.latestStartAt), endAt: new Date(state.exam.endAt) };
                const startedAt = candidate.startedAt || session?.startedAt;
                const missedStart = !startedAt && !candidate.lateStartAllowedAt && Date.now() > +candidateStartDeadline(timing);
                const showResume = session?.status === 'FINISHED' || candidate.status === 'FINISHED' || missedStart;
                const canResume = examInProgress && Date.now() < +effectiveEnd(timing, startedAt ? new Date(startedAt) : null);
                const resumeTitle = canResume ? '允许该考生登录并继续考试，保留原计时与结束时间' : examActionTitle || '该考生的考试时间已经结束';
                const cheatingRecord = activeCheatingByCandidate.get(candidate.id);
                const usbLocked = Boolean(session?.lockdown && /外设|USB/i.test(session.lockdownReason || '') && /接入|移除|拔|插|检测不可用|结果已过期/.test(session.lockdownReason || ''));
                const room = roomByCandidateId.get(candidate.id);
                const requiresFrontCamera = room?.requireFrontCamera ?? state.exam.requireFrontCamera;
                const requiresSecondCamera = room?.requireSecondCamera ?? state.exam.requireMiniProgram;
                const sessionFinished = session?.status === 'FINISHED';
                const desktopConnection = session
                  ? connectionText(session.lastDesktopSeenAt, session.desktopOfflineAt, sessionFinished)
                  : '未连接';
                const secondCameraConnection = !requiresSecondCamera
                  ? '不检测'
                  : session
                    ? connectionText(session.lastMiniProgramSeenAt, session.miniProgramOfflineAt, sessionFinished)
                    : '未连接';
                const feed = (label: string, channel: LiveFrame['channel'], required = true, unavailableText = '') => {
                  const hasSession = Boolean(session && session.status !== 'FINISHED');
                  const sessionId = hasSession && session ? session.id : '';
                  return <MonitorFeed
                    label={label}
                    sessionId={sessionId}
                    channel={channel}
                    hasSession={hasSession}
                    screenFeed={channel === 'DESKTOP_SCREEN'}
                    required={required}
                    unavailableText={unavailableText}
                    audible={layout === 1 && monitorSound && !voiceBusy && channel === 'DESKTOP_SCREEN'}
                  />;
                };
                const statusPanel = (
                  <div className="feed candidate-feed">
                    <strong>{displayName(candidate)}</strong>
                    <div className="candidate-info-row">
                      <span>学校：{candidate.school || '-'}</span>
                      <span>学院：{candidate.college || '-'}</span>
                    </div>
                    <div className="candidate-info-row">
                      <span>考号：{candidate.examNumber}</span>
                      <span>状态：{statusText(candidate.status)}</span>
                    </div>
                    <div className="candidate-info-row">
                      <span>考室：{roomNamesByCandidateId.get(candidate.id)?.join('、') || '未分配'}</span>
                      <span>座位：{candidate.seatNo}</span>
                    </div>
                    <div className="candidate-info-row">
                      <span>客户端：{desktopConnection}</span>
                      <span>第二机位：{secondCameraConnection}</span>
                    </div>
                    {session?.lockdown ? <em>{session.lockdownReason || '已锁定'}</em> : null}
                    {!startedAt && candidate.lateStartAllowedAt ? <small className="muted">已允许继续考试，可登录并确认开始</small> : missedStart ? <small className="muted">已过最晚开考时间，需监考老师允许继续考试</small> : null}
                    <div className="monitor-candidate-actions">
                      <div className="monitor-candidate-action-row">
                        <button className="button warn monitor-info-button" onClick={() => void sendWarning(candidate, session?.id)} disabled={!examInProgress || busyAction === `warning-${candidate.id}`} title={examActionTitle}>
                          {busyAction === `warning-${candidate.id}` ? '发送中' : '发送警告消息'}
                        </button>
                        <button className="button monitor-info-button" onClick={() => void startVoiceForCandidate(candidate, session?.id)} disabled={!examInProgress || voiceBusy || !session || session.status === 'FINISHED'} title={examActionTitle}>
                          <Phone size={16} />
                          语音通话
                        </button>
                      </div>
                      <div className="monitor-candidate-action-row">
                        {cheatingRecord ? (
                          <button className="button secondary monitor-info-button" onClick={() => void cancelCheating(candidate)} disabled={busyAction === `cheating-${candidate.id}`}>
                            {busyAction === `cheating-${candidate.id}` ? '处理中' : '取消作弊'}
                          </button>
                        ) : (
                          <button className="button danger monitor-info-button" onClick={() => void markCheating(candidate, session?.id)} disabled={busyAction === `cheating-${candidate.id}`}>
                            {busyAction === `cheating-${candidate.id}` ? '处理中' : '标记作弊'}
                          </button>
                        )}
                        {session && usbLocked && session.status !== 'FINISHED' ? (
                          <button className="button secondary monitor-info-button" onClick={() => { setUsbReason(''); setUsbHandling({ candidate, session }); }} disabled={Boolean(busyAction)}>
                            USB异常处理
                          </button>
                        ) : null}
                        {showResume ? (
                          <button className="button monitor-info-button" onClick={() => void resumeCandidate(candidate)} disabled={!canResume || busyAction === `resume-${candidate.id}`} title={resumeTitle}>
                            {busyAction === `resume-${candidate.id}` ? '处理中' : '继续考试'}
                          </button>
                        ) : (
                          <button className="button danger monitor-info-button" onClick={() => session && void forceFinish(session.id)} disabled={!session || !cheatingRecord}>
                            结束考试
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
                return (
                  <div className="monitor-card" key={candidate.id}>
                    <div className="monitor-tile">
                      <div className="monitor-cell desktop-camera-cell">{feed('电脑前置摄像头', 'DESKTOP_CAMERA', requiresFrontCamera, '所在考室不要求前置摄像头')}</div>
                      <div className="monitor-cell desktop-screen-cell">{feed('电脑屏幕', 'DESKTOP_SCREEN')}</div>
                      <div className="monitor-cell mobile-camera-cell">{feed('第二机位', 'MOBILE_CAMERA', requiresSecondCamera, '所在考室不要求第二机位')}</div>
                      <div className="monitor-cell candidate-info-cell">{statusPanel}</div>
                    </div>
                    {session ? (
                      <div className="monitor-actions">
                        {session.lockdown ? (
                          <button className="button" onClick={() => void unlock(session.id, candidate)} disabled={busyAction === `unlock-${session.id}`}>
                            <LockOpen size={18} />
                            {busyAction === `unlock-${session.id}` ? '处理中' : '管理解锁'}
                          </button>
                        ) : null}
                        <button className="button secondary" onClick={() => void retryOj(session.id)}>
                          {state.exam.platform === 'NOVAJUDGE' ? '重新登录 NovaJudge' : '重新连接评测服务'}
                        </button>
                        {showResume ? (
                          <button className="button" onClick={() => void resumeCandidate(candidate)} disabled={!canResume || busyAction === `resume-${candidate.id}`} title={resumeTitle}>
                            <Play size={18} />
                            {busyAction === `resume-${candidate.id}` ? '处理中' : '继续考试'}
                          </button>
                        ) : (
                          <button className="button danger" onClick={() => void forceFinish(session.id)}>
                            <Square size={18} />
                            结束考试
                          </button>
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {!visibleCandidates.length ? <div className="muted">当前筛选下暂无考生画面</div> : null}
            </div>
          </section>

          {usbHandling ? (
            <div className="modal-backdrop usb-handling-backdrop" role="presentation" onMouseDown={() => { if (!busyAction) setUsbHandling(null); }}>
              <section className="modal-panel usb-handling-modal" role="dialog" aria-modal="true" aria-labelledby="usb-handling-title" onMouseDown={(event) => event.stopPropagation()}>
                <div className="modal-title">
                  <h2 id="usb-handling-title">处理 {displayName(usbHandling.candidate)} 的 USB 外设异常</h2>
                  <button className="button secondary icon-button" type="button" onClick={() => setUsbHandling(null)} disabled={Boolean(busyAction)} aria-label="关闭"><X size={18} /></button>
                </div>
                <p className="muted">请选择标记作弊或取消锁定。两种处理都必须填写原因，操作会记录在异常日志中。</p>
                {error ? <div className="exam-editor-error" role="alert">{error}</div> : null}
                <label>处理原因（必填）
                  <textarea value={usbReason} onChange={(event) => setUsbReason(event.target.value)} maxLength={480} rows={4} placeholder="请写明核查经过和处理依据" />
                </label>
                <div className="usb-handling-actions">
                  <button className="button danger" type="button" onClick={() => void markCheating(usbHandling.candidate, usbHandling.session.id, `USB外设异常：${usbReason.trim()}`)} disabled={!usbReason.trim() || Boolean(busyAction) || Boolean(activeCheatingByCandidate.get(usbHandling.candidate.id))}>标记作弊</button>
                  <button className="button" type="button" onClick={() => void unlock(usbHandling.session.id, usbHandling.candidate, usbReason)} disabled={!usbReason.trim() || Boolean(busyAction)}>取消锁定</button>
                </div>
              </section>
            </div>
          ) : null}

          {monitorPage.total > 1 ? (
            <>
              <button className="monitor-page-button left" onClick={() => turnMonitorPage(-1)} disabled={monitorPage.index === 0} title="上一页">
                <ChevronLeft size={32} />
              </button>
              <button className="monitor-page-button right" onClick={() => turnMonitorPage(1)} disabled={monitorPage.index >= monitorPage.total - 1} title="下一页">
                <ChevronRight size={32} />
              </button>
            </>
          ) : null}

          <div className="monitor-page-count" aria-live="polite">{monitorPageLabel}</div>

          {notificationsOpen ? (
            <section className="notification-panel monitor-alert-panel">
              <div className="panel-head">
                <div>
                  <strong>异常提醒</strong>
                  <div className="muted">
                    待处理 {unreadAlertGroups.length} 组（{unreadAlerts.length} 条记录）{handledAlerts.length ? `，已处理 ${handledAlerts.length} 条` : ''}
                    <div>最多显示 80 条，待处理优先。同一考生 5 分钟内的相同异常折叠显示，记录与录像均保留。</div>
                  </div>
                </div>
                <div className="alert-filter-toggle">
                  <button className={alertFilter === 'all' ? 'active' : ''} onClick={() => setAlertFilter('all')}>全部</button>
                  <button className={alertFilter === 'pending' ? 'active' : ''} onClick={() => setAlertFilter('pending')}>待处理</button>
                </div>
                <button className="button secondary icon-button" onClick={() => setNotificationsOpen(false)} title="关闭">
                  <X size={16} />
                </button>
              </div>
              {panelAlertGroups.map((group) => (
                <div className="monitor-alert-group" key={group.id}>
                  {group.alerts.length > 1 ? <div className="monitor-alert-group-summary">
                    <span>相同异常 {group.alerts.length} 次</span>
                    {!group.alerts[0].acknowledgedAt ? <button className="button secondary compact-button" disabled={Boolean(busyAction)} onClick={() => void ackAlerts(group.alerts.map(alert => alert.id))}>本组全部标记已处理</button> : null}
                    <button className="button secondary compact-button" aria-expanded={expandedAlertGroups.includes(group.id)} onClick={() => setExpandedAlertGroups(ids => ids.includes(group.id) ? ids.filter(id => id !== group.id) : [...ids, group.id])}>
                      {expandedAlertGroups.includes(group.id) ? '收起重复记录' : `展开其余 ${group.alerts.length - 1} 条`}
                    </button>
                  </div> : null}
                  {(expandedAlertGroups.includes(group.id) ? group.alerts : group.alerts.slice(0, 1)).map((alert) => (
                <article
                  key={alert.id}
                  className={`notice-item alert-notice-item ${alert.acknowledgedAt ? 'handled' : ''}`}
                  onClick={() => {
                    if (alert.candidate) focusMonitorCandidate(alert.candidate.id);
                  }}
                >
                  <div className="alert-notice-text">
                    <strong>{alert.candidate ? `${displayName(alert.candidate)}同学` : '未绑定考生'}{alert.message || `${alert.type}异常`}</strong>
                    <div className="muted">{new Date(alert.createdAt).toLocaleString()}</div>
                    <div className="muted">类型：{alertTypeText(alert.type)} · 等级：{alert.severity}/5</div>
                    {alert.acknowledgedAt ? (
                      <div className="muted">已处理：{new Date(alert.acknowledgedAt).toLocaleString()}</div>
                    ) : (
                      <button className="button secondary compact-button" onClick={(event) => { event.stopPropagation(); void ackAlerts([alert.id]); }} disabled={Boolean(busyAction)}>
                        {busyAction === `ackAlert-${alert.id}` ? '处理中' : '标记已处理'}
                      </button>
                    )}
                  </div>
                  {alertVideoSource(alert) ? (
                    loadedAlertVideoIds.includes(alert.id) ? (
                      <AlertEvidencePlayer
                        key={alert.id}
                        className="alert-notice-video"
                        evidence={alert.evidence}
                        fallback={alertVideoSource(alert)}
                      />
                    ) : (
                      <button
                        type="button"
                        className="alert-video-empty alert-video-load-button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setLoadedAlertVideoIds((ids) => [...ids, alert.id]);
                        }}
                      >
                        点击加载录像
                      </button>
                    )
                  ) : (
                    <div className="alert-video-empty">暂无视频</div>
                  )}
                </article>
                  ))}
                </div>
              ))}
              {!panelAlerts.length ? <div className="muted">{alertFilter === 'pending' ? '暂无待处理异常提醒' : '暂无异常提醒'}</div> : null}
            </section>
          ) : null}

          {voiceTarget ? <VoiceCallPanel key={voiceTarget.sessionId} sessionId={voiceTarget.sessionId}
            name={displayName(voiceTarget.candidate)} examNumber={voiceTarget.candidate.examNumber}
            onClose={() => { setVoiceTarget(null); setVoiceBusy(false); }} onBusyChange={setVoiceBusy} /> : null}

        </>
      ) : null}

      {tab === 'settings' && canManage ? (
        <div className="grid exam-management-layout">
          <div className="subnav exam-management-subnav card">
            <h2>考试管理</h2>
            <button className={`button ${settingsTab === 'problems' ? '' : 'secondary'}`} onClick={() => routeToSettings('problems')}>题目管理</button>
            <button className={`button ${settingsTab === 'rooms' ? '' : 'secondary'}`} onClick={() => routeToSettings('rooms')}>考室管理</button>
            <button className={`button ${settingsTab === 'candidates' ? '' : 'secondary'}`} onClick={() => routeToSettings('candidates')}>考生管理</button>
            <button className={`button ${settingsTab === 'external-board' ? '' : 'secondary'}`} onClick={() => routeToSettings('external-board')}>外榜推送</button>
            {state.exam.platform !== 'NOVAJUDGE' ? <button className="button secondary" onClick={() => router.push(`/dashboard/exams/${examId}/code-check`)}>代码查重</button> : null}
          </div>

          {settingsTab === 'external-board' ? <ExternalBoardSettings key={examId} examId={examId} /> : null}

          {settingsTab === 'problems' && state.exam.platform === 'NOVAJUDGE' ? <section className="card"><h2>NovaJudge 题目管理</h2><p>本场考试的题目、提交、判题、排行榜、答疑和打印由 NovaJudge 管理。</p><a className="button secondary" href={`${state.exam.platformBaseUrl}/contest/${state.exam.platformContestId}`} target="_blank" rel="noreferrer">打开 NovaJudge 比赛</a></section> : null}
          {settingsTab === 'problems' && state.exam.platform !== 'NOVAJUDGE' ? (
            <section className="card grid exam-problem-management">
              <div className="table-toolbar">
                <div><h2 style={{ margin: 0 }}>题目管理</h2><div className="muted">先将 Hydro 得分按实际满分换算为百分制，再乘本场得分比，统一用于递交记录、递交详情和成绩表。</div></div>
                <button className="button" onClick={() => void saveProblemScores()} disabled={busyAction === 'saveProblemScores'}><Save size={18} />{busyAction === 'saveProblemScores' ? '保存中' : '保存题目分值'}</button>
              </div>
              <div className="table-scroll"><table className="table exam-problem-score-table"><thead><tr><th>题目编号</th><th>题目名称</th><th>题目分数</th><th>得分比 %</th><th>比赛分</th></tr></thead><tbody>
                {(state.exam.problems || []).map(problem => { const percent = problemPercents[problem.id] ?? problem.scorePercent; return <tr key={problem.id}><td><strong>{String.fromCharCode(65 + problem.order)}</strong></td><td>{problem.title}</td><td>{problem.hydroScore}</td><td><input aria-label={`${problem.title} 得分比`} type="number" min={0} max={100} step={1} value={percent} onChange={event => setProblemPercents(current => ({ ...current, [problem.id]: Math.min(100, Math.max(0, Number(event.target.value))) }))} /></td><td><strong>{percent}</strong></td></tr>; })}
                {!(state.exam.problems || []).length ? <tr><td colSpan={5} className="muted">当前考试暂无题目，请先在编辑考试中选择题目。</td></tr> : null}
              </tbody></table></div>
            </section>
          ) : null}

          {settingsTab === 'base' && examForm ? (
            <section className="card form exam-settings-card">
              <div className="settings-section-title">
                <h2>考试基础设置</h2>
                <span>修改考试基础信息和监考采集要求</span>
              </div>
              <div className="settings-form-grid">
                {examForm.platform === 'NOVAJUDGE' ? <>
                  <label>NovaJudge 平台域名<input value={examForm.platformBaseUrl} onChange={event => updateExamForm({ ...examForm, platformBaseUrl: event.target.value })} /></label>
                  <label>NovaJudge 比赛 ID<input inputMode="numeric" value={examForm.platformContestId} onChange={event => updateExamForm({ ...examForm, platformContestId: event.target.value })} /></label>
                  <label>NovaJudge 外榜 API Key<input type="password" autoComplete="new-password" placeholder="留空保留原密钥" value={examForm.novaJudgeApiKey || ''} onChange={event => updateExamForm({ ...examForm, novaJudgeApiKey: event.target.value })} /></label>
                  <label>NovaJudge 数据时区<input value={examForm.novaJudgeTimezone || 'Asia/Shanghai'} placeholder="Asia/Shanghai" onChange={event => updateExamForm({ ...examForm, novaJudgeTimezone: event.target.value })} /></label>
                  <p className="muted">监考、控屏和考生管理在本平台进行。答题设置由 NovaJudge 管理，请保持双方比赛时间及考生账号一致。</p>
                </> : null}
                <label>
                  考试名称
                  <input value={examForm.name} onChange={(event) => updateExamForm({ ...examForm, name: event.target.value })} />
                </label>
                <label>
                  比赛类型
                  <select value={examForm.contestType} disabled={examForm.contestRule === 'GPLT'} onChange={(event) => updateExamForm({ ...examForm, contestType: event.target.value as 'INDIVIDUAL' | 'TEAM' })}>
                    <option value="INDIVIDUAL">个人赛</option>
                    <option value="TEAM">团队赛</option>
                  </select>
                </label>
                <label>
                  赛制
                  <select value={examForm.contestRule} disabled={examForm.platform === 'NOVAJUDGE'} onChange={(event) => { const contestRule = event.target.value as Exam['contestRule']; updateExamForm({ ...examForm, contestRule, flexible: contestRule !== 'XCPC' && examForm.flexible, showTestCaseCount: contestRule === 'KS' || examForm.showTestCaseCount, showObjectiveScore: contestRule === 'KS' ? false : examForm.showObjectiveScore, ...(contestRule === 'GPLT' ? { contestType: 'TEAM', teamAccountMode: 'MEMBER_ACCOUNTS', leaderOnlySubmission: false } : {}) }); }}>
                    <option value="GPLT">GPLT</option>
                    <option value="XCPC">XCPC</option>
                    <option value="LANQIAO">LANQIAO</option>
                    <option value="OI">OI</option>
                    <option value="IOI">IOI</option>
                    <option value="KS">KS</option>
                  </select>
                </label>
                {examForm.contestType === 'TEAM' ? <label>团队账号方式<select value={examForm.teamAccountMode} disabled={examForm.contestRule === 'GPLT'} onChange={(event) => updateExamForm({ ...examForm, teamAccountMode: event.target.value as 'MEMBER_ACCOUNTS' | 'TEAM_ACCOUNT' })}><option value="MEMBER_ACCOUNTS">每名成员一个账号</option><option value="TEAM_ACCOUNT">全队共用一个账号</option></select></label> : null}
                <label>
                  开始时间
                  <input type="datetime-local" value={examForm.startAt} onChange={(event) => updateExamForm({ ...examForm, startAt: event.target.value })} />
                </label>
                {examForm.flexible ? <label>
                  最晚开始时间
                  <input type="datetime-local" value={examForm.latestStartAt} onChange={(event) => updateExamForm({ ...examForm, latestStartAt: event.target.value })} />
                </label> : null}
                <label>
                  最晚截止时间
                  <input type="datetime-local" value={examForm.endAt} onChange={(event) => updateExamForm({ ...examForm, endAt: event.target.value })} />
                </label>
                <label>
                  考试总时长（分钟）
                  <input type="number" min={1} value={examForm.durationMinutes} onChange={(event) => updateExamForm({ ...examForm, durationMinutes: Number(event.target.value) })} />
                </label>
                <label>
                  <span>灵活考试 <input type="checkbox" checked={examForm.flexible} disabled={examForm.contestRule === 'XCPC'} onChange={(event) => updateExamForm({ ...examForm, flexible: event.target.checked })} /></span>
                  <small className="muted">关闭时所有考生统一结束，未开始的考生仅可在开考后 15 分钟内登录并确认开始；开启后按设置的最晚开始时间和个人开考时刻计时。</small>
                </label>
              </div>
              <div className="settings-checks">
                {examForm.platform !== 'NOVAJUDGE' ? <TeamSubmissionViewSetting contestType={examForm.contestType} teamAccountMode={examForm.teamAccountMode} enabled={examForm.allowTeamSubmissionView} onChange={enabled => updateExamForm({ ...examForm, allowTeamSubmissionView: enabled })} helpClassName="muted" /> : null}
                <label><span>保存完整考试录像 <input type="checkbox" checked={examForm.saveFullRecording ?? false} onChange={(event) => updateExamForm({ ...examForm, saveFullRecording: event.target.checked })} /></span><small className="muted">勾选后保存完整监考过程。直播画质保持 1080p、30 帧。</small></label>
                <label><span>保存异常前后各 20 秒录像 <input type="checkbox" checked={examForm.saveIncidentRecording ?? false} onChange={(event) => updateExamForm({ ...examForm, saveIncidentRecording: event.target.checked })} /></span><small className="muted">默认不勾选。仅勾选此项时保存异常对应机位前后各 20 秒；两项均未勾选时不保存监考录像。</small></label>
                {examForm.platform !== 'NOVAJUDGE' ? <><label><span>展示通过测试点数目 <input type="checkbox" checked={examForm.contestRule === 'KS' || examForm.showTestCaseCount} disabled={examForm.contestRule === 'KS'} onChange={(event) => updateExamForm({ ...examForm, showTestCaseCount: event.target.checked })} />{examForm.contestRule === 'KS' ? '（KS 固定开启）' : ''}</span></label>
                <label><span>展示客观题成绩 <input type="checkbox" checked={examForm.contestRule !== 'KS' && examForm.showObjectiveScore} disabled={examForm.contestRule === 'KS'} onChange={(event) => updateExamForm({ ...examForm, showObjectiveScore: event.target.checked })} />{examForm.contestRule === 'KS' ? '（KS 不显示得分）' : ''}</span></label>
                <label><span>打印方式 <select value={examForm.printMode} onChange={(event) => updateExamForm({ ...examForm, printMode: event.target.value as Exam['printMode'], allowPrint: event.target.value !== 'DISABLED' })}><option value="DISABLED">不允许打印</option><option value="VIRTUAL">虚拟打印</option><option value="PHYSICAL">真实打印</option></select></span></label>
                {examForm.contestType === 'TEAM' ? <>
                  <label><span>只有队长可以提交 <input type="checkbox" checked={examForm.leaderOnlySubmission} onChange={(event) => updateExamForm({ ...examForm, leaderOnlySubmission: event.target.checked })} /></span></label>
                </> : null}
                </> : null}
                <label>
                  <span>
                    需要小程序第二机位 <input type="checkbox" checked={examForm.requireMiniProgram} onChange={(event) => updateExamForm({ ...examForm, requireMiniProgram: event.target.checked })} />
                  </span>
                </label>
                <label>
                  <span>
                    需要电脑前置摄像头 <input type="checkbox" checked={examForm.requireFrontCamera} onChange={(event) => updateExamForm({ ...examForm, requireFrontCamera: event.target.checked })} />
                  </span>
                </label>
              </div>
              <label>
                考试说明（Markdown）
                <textarea rows={7} value={examForm.rules} onChange={(event) => updateExamForm({ ...examForm, rules: event.target.value })} />
              </label>
              <div className="exam-markdown-preview hydro-markdown" aria-label="考试说明预览"><MarkdownContent content={examForm.rules || '暂无考试说明'} /></div>
              <div className="settings-actions">
                <button className="button" onClick={() => void saveExamSettings()} disabled={busyAction === 'saveExamSettings'}>
                  <Save size={18} />
                  {busyAction === 'saveExamSettings' ? '保存中' : '保存考试设置'}
                </button>
              </div>
            </section>
          ) : null}

          {settingsTab === 'candidates' ? (
            <div className="grid">
              <section className="card grid candidate-list-card" style={{ gridColumn: '1 / -1' }}>
                <div className="table-toolbar candidate-list-toolbar">
                  <div>
                    <h2 style={{ margin: 0 }}>考生列表</h2>
                    <div className="muted">共 {state.candidates.length} 名考生，当前显示 {filteredCandidates.length} 名，已选择 {selectedCandidateIds.length} 名</div>
                  </div>
                  <div className="candidate-list-actions">
                    <button className="button secondary" onClick={() => editCandidate()}>
                      <UserPlus size={18} />
                      新增考生
                    </button>
                    <button className="button danger" onClick={() => void deleteCandidates()} disabled={!selectedCandidateIds.length || busyAction === 'deleteCandidates'}>
                      <Trash2 size={18} />
                      {busyAction === 'deleteCandidates' ? '删除中' : '批量删除'}
                    </button>
                  </div>
                </div>
                <div className="candidate-filterbar">
                  <label className="candidate-filter-field">
                    <span>考室</span>
                    <select value={candidateRoomFilter} onChange={(event) => setCandidateRoomFilter(event.target.value)}>
                      <option value="__all">全部考室</option>
                      <option value="__unassigned">未分配考室</option>
                      {state.rooms.map((room) => (
                        <option key={room.id} value={room.id}>{room.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="candidate-search-field">
                    <Search size={17} />
                    <input
                      value={candidateSearch}
                      onChange={(event) => setCandidateSearch(event.target.value)}
                      placeholder={state.exam.contestType === 'TEAM' ? '搜索队伍名称、成员姓名或学号' : '搜索姓名、学号或考号'}
                    />
                  </label>
                </div>
                <div className="table-scroll">
                  <table className="table candidate-table">
                    <thead>
                      <tr>
                        <th className="check-col"><input type="checkbox" checked={allFilteredCandidatesSelected} onChange={(event) => setSelectedCandidateIds(event.target.checked ? Array.from(new Set([...selectedCandidateIds, ...filteredCandidates.map((candidate) => candidate.id)])) : selectedCandidateIds.filter((id) => !filteredCandidates.some((candidate) => candidate.id === id)))} /></th>
                        <th>考号</th>
                        {state.exam.contestType === 'TEAM' ? <th>队伍名</th> : null}
                        <th>组别</th>
                        <th>{state.exam.contestType === 'TEAM' && state.exam.teamAccountMode === 'TEAM_ACCOUNT' ? '队伍成员姓名' : '姓名'}</th>
                        <th>密码</th>
                        <th>学校</th>
                        {state.exam.contestType === 'TEAM' && state.exam.teamAccountMode === 'TEAM_ACCOUNT' ? null : <th>学院</th>}
                        {state.exam.contestType === 'TEAM' && state.exam.teamAccountMode === 'TEAM_ACCOUNT' ? null : <th>专业</th>}
                        {state.exam.contestType === 'TEAM' && state.exam.teamAccountMode === 'TEAM_ACCOUNT' ? null : <th>年级 / 班级</th>}
                        <th>{state.exam.contestType === 'TEAM' && state.exam.teamAccountMode === 'TEAM_ACCOUNT' ? '队伍成员学号' : '学号'}</th>
                        <th>考室</th>
                        <th>座位号</th>
                        {state.exam.contestType === 'TEAM' ? <th>是否队长</th> : null}
                        <th>是否排名</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredCandidates.map((candidate) => (
                        <tr key={candidate.id}>
                          <td className="check-col"><input type="checkbox" checked={selectedCandidateIds.includes(candidate.id)} onChange={() => toggleCandidateSelection(candidate.id)} /></td>
                          <td>{candidate.examNumber}</td>
                          {state.exam.contestType === 'TEAM' ? <td>{candidate.teamName || '-'}</td> : null}
                          <td>{participationGroupLabel(state.exam.contestRule, candidate.groupName)}</td>
                          <td><strong>{state.exam.contestType === 'TEAM' && state.exam.teamAccountMode === 'TEAM_ACCOUNT' ? splitMemberText(candidate.teamMembers).join('、') || '-' : candidate.name || '-'}</strong></td>
                          <td><code>{candidate.password}</code></td>
                          <td>{candidate.school || '-'}</td>
                          {state.exam.contestType === 'TEAM' && state.exam.teamAccountMode === 'TEAM_ACCOUNT' ? null : <td>{candidate.college || '-'}</td>}
                          {state.exam.contestType === 'TEAM' && state.exam.teamAccountMode === 'TEAM_ACCOUNT' ? null : <td>{candidate.major || '-'}</td>}
                          {state.exam.contestType === 'TEAM' && state.exam.teamAccountMode === 'TEAM_ACCOUNT' ? null : <td>{[candidate.gradeYear, candidate.className].filter(Boolean).join(' / ') || '-'}</td>}
                          <td>{state.exam.contestType === 'TEAM' && state.exam.teamAccountMode === 'TEAM_ACCOUNT' ? splitMemberText(candidate.teamMemberStudentIds).join('、') || '-' : candidate.studentId || '-'}</td>
                          <td>{roomNamesByCandidateId.get(candidate.id)?.join('、') || <span className="muted">未分配</span>}</td>
                          <td>{candidate.seatNo}</td>
                          {state.exam.contestType === 'TEAM' ? <td>{candidate.isTeamLeader ? '是' : '否'}</td> : null}
                          <td>{candidate.ranked ? '是' : '否'}</td>
                          <td>
                            <div className="row-actions">
                              <button className="button secondary compact-button" onClick={() => editCandidate(candidate)}>修改</button>
                              <button className="button danger compact-button" onClick={() => void deleteCandidates([candidate.id])} disabled={busyAction === 'deleteCandidates'}>{busyAction === 'deleteCandidates' ? '删除中' : '删除'}</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                      {!filteredCandidates.length ? (
                        <tr>
                          <td colSpan={18} className="muted">{state.candidates.length ? '当前筛选下没有匹配的考生。' : '暂无考生，请点击新增考生导入模板。'}</td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </section>
              {candidateEditorOpen ? (
                <div className="modal-backdrop" role="presentation" onMouseDown={() => { if (!candidateImportReading && busyAction !== 'importCandidates') setCandidateEditorOpen(false); }}>
                  <section className="modal-panel form" onMouseDown={(event) => event.stopPropagation()}>
                    <div className="modal-title">
                      <h2 style={{ margin: 0 }}>{candidateDraft.id ? '修改考生信息' : '添加考生'}</h2>
                      <button type="button" className="button secondary icon-button" disabled={candidateImportReading || busyAction === 'importCandidates'} onClick={() => setCandidateEditorOpen(false)} aria-label="关闭">
                        <X size={18} />
                      </button>
                    </div>
                    {error ? <div className="exam-editor-error" role="alert">{error}</div> : null}
                    <div className="grid two">
                      {state.exam.contestType === 'TEAM' ? (
                        <label>队伍名称<input value={candidateDraft.teamName} onChange={(event) => setCandidateDraft({ ...candidateDraft, teamName: event.target.value })} /></label>
                      ) : null}
                      <label>参赛组别{participationOptions(state.exam.contestRule).length ? <select aria-label="参赛组别" value={normalizeParticipationGroup(state.exam.contestRule, candidateDraft.groupName)} onChange={event => setCandidateDraft({ ...candidateDraft, groupName: event.target.value, ...(isXcpcLeaderboard(state.exam.contestRule) ? { ranked: event.target.value !== 'star' } : {}) })}><option value="" disabled>请选择参赛组别</option>{participationOptions(state.exam.contestRule).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select> : <input value={candidateDraft.groupName} onChange={event => setCandidateDraft({ ...candidateDraft, groupName: event.target.value })} />}</label>
                      {state.exam.contestType === 'TEAM' && state.exam.teamAccountMode === 'TEAM_ACCOUNT' ? <>
                        <label>队伍成员姓名<input value={candidateDraft.teamMembers} onChange={(event) => setCandidateDraft({ ...candidateDraft, teamMembers: event.target.value })} placeholder="用、隔开，并与成员学号逐一对应" /></label>
                        <label>队伍成员学号<input value={candidateDraft.teamMemberStudentIds} onChange={(event) => setCandidateDraft({ ...candidateDraft, teamMemberStudentIds: event.target.value })} placeholder="用、隔开，并与成员姓名逐一对应" /></label>
                      </> : <>
                        <label>姓名<input value={candidateDraft.name} onChange={(event) => setCandidateDraft({ ...candidateDraft, name: event.target.value })} /></label>
                        <label>学号<input value={candidateDraft.studentId} onChange={(event) => setCandidateDraft({ ...candidateDraft, studentId: event.target.value })} /></label>
                      </>}
                      <label>考号<input value={candidateDraft.examNumber} onChange={(event) => setCandidateDraft({ ...candidateDraft, examNumber: event.target.value })} /></label>
                      <label>密码<input value={candidateDraft.password} onChange={(event) => setCandidateDraft({ ...candidateDraft, password: event.target.value })} /></label>
                      <label>学校<input value={candidateDraft.school} onChange={(event) => setCandidateDraft({ ...candidateDraft, school: event.target.value })} /></label>
                      {state.exam.contestType === 'TEAM' && state.exam.teamAccountMode === 'TEAM_ACCOUNT' ? null : <label>学院<input value={candidateDraft.college} onChange={(event) => setCandidateDraft({ ...candidateDraft, college: event.target.value })} /> </label>}
                      {state.exam.contestType === 'TEAM' && state.exam.teamAccountMode === 'TEAM_ACCOUNT' ? null : <label>专业<input value={candidateDraft.major} onChange={(event) => setCandidateDraft({ ...candidateDraft, major: event.target.value })} /></label>}
                      {state.exam.contestType === 'TEAM' && state.exam.teamAccountMode === 'TEAM_ACCOUNT' ? null : <>
                        <label>性别<input value={candidateDraft.gender} onChange={(event) => setCandidateDraft({ ...candidateDraft, gender: event.target.value })} /></label>
                        <label>年级<input value={candidateDraft.gradeYear} onChange={(event) => setCandidateDraft({ ...candidateDraft, gradeYear: event.target.value })} /></label>
                        <label>行政班级<input value={candidateDraft.className} onChange={(event) => setCandidateDraft({ ...candidateDraft, className: event.target.value })} /></label>
                      </>}
                      <label>指导老师<input value={candidateDraft.advisor} onChange={(event) => setCandidateDraft({ ...candidateDraft, advisor: event.target.value })} /></label>
                      <label>座位号<input value={candidateDraft.seatNo} onChange={(event) => setCandidateDraft({ ...candidateDraft, seatNo: event.target.value })} /></label>
                      <label>
                        考室
                        <select aria-label="考室" value={candidateDraftRoomId} onChange={(event) => setCandidateDraftRoomId(event.target.value)}>
                          <option value="__none">未分配</option>
                          {state.rooms.map((room) => (
                            <option key={room.id} value={room.id}>{room.name}</option>
                          ))}
                        </select>
                      </label>
                      {state.exam.contestType === 'TEAM' ? <label className="exam-checkbox"><input type="checkbox" checked={candidateDraft.isTeamLeader} onChange={(event) => setCandidateDraft({ ...candidateDraft, isTeamLeader: event.target.checked })} /> 是否队长</label> : null}
                      <label className="exam-checkbox"><input type="checkbox" checked={candidateDraft.ranked && normalizeParticipationGroup(state.exam.contestRule, candidateDraft.groupName) !== 'star'} disabled={isXcpcLeaderboard(state.exam.contestRule) && normalizeParticipationGroup(state.exam.contestRule, candidateDraft.groupName) === 'star'} onChange={(event) => setCandidateDraft({ ...candidateDraft, ranked: event.target.checked })} /> 是否排名</label>
                    </div>
                    <button className="button" onClick={() => void saveCandidate()} disabled={busyAction === 'saveCandidate'}>
                      <Save size={18} />
                      {busyAction === 'saveCandidate' ? '保存中' : '保存考生'}
                    </button>
                    {!candidateDraft.id ? (
                      <section className="candidate-import-box form">
                        <div className="modal-title">
                          <h3 style={{ margin: 0 }}>批量导入</h3>
                          <button className="button secondary" type="button" onClick={() => void downloadTemplate()}>
                            <Download size={18} />
                            下载模板
                          </button>
                        </div>
                        <div className="muted">
                          {state.exam.contestType !== 'TEAM' ? '兼容 cwnupaaweb 报名导出字段，其中“比赛账号”自动作为考号、“比赛密码”自动作为密码。' : state.exam.teamAccountMode === 'TEAM_ACCOUNT' ? '一个队伍一行；考号就是全队共用的登录账号。' : '每名成员一行；兼容 cwnupaaweb 团队明细导出。“比赛账号”自动作为考号，同队首行在没有“是否队长”列时自动识别为队长。'}
                        </div>
                        <div className="muted">“考室”可选，填写本场考试已有的考室名称后自动分配；留空不分配，重复导入时保留已有分配。团队按整队分配，同队考室须一致。</div>
                        <label>
                          选择模板表格
                          <input type="file" accept=".xlsx,.xls,.csv" disabled={candidateImportReading || busyAction === 'importCandidates'} onChange={(event) => void readCandidateFile(event)} />
                        </label>
                        <div role="status" aria-live="polite">
                          {candidateImportReading ? `正在读取 ${candidateImportFileName}…` : candidateImportRows.length ? `${candidateImportFileName}：已识别 ${candidateImportRows.length} 条考生数据，请点击“批量导入考生”完成导入。` : candidateImportFileName || '请选择填写好的模板文件'}
                        </div>
                        {candidateImportError ? <div role="alert" style={{ color: 'var(--danger)' }}>{candidateImportError}</div> : null}
                        {candidateImportRows.length ? (
                          <div style={{ overflowX: 'auto' }}>
                            <table className="table">
                              <thead><tr><th>考号</th><th>姓名 / 队伍</th><th>学号</th><th>考室</th></tr></thead>
                              <tbody>
                                {candidateImportRows.slice(0, 5).map((row, index) => (
                                  <tr key={index}><td>{row.examNumber || '—'}</td><td>{row.teamName || row.name || '—'}</td><td>{row.teamMemberStudentIds || row.studentId || '—'}</td><td>{row.roomName || '未分配'}</td></tr>
                                ))}
                              </tbody>
                            </table>
                            {candidateImportRows.length > 5 ? <div className="muted">仅预览前 5 条，共 {candidateImportRows.length} 条。</div> : null}
                          </div>
                        ) : null}
                        <button className="button" onClick={() => void importCandidates()} disabled={candidateImportReading || busyAction === 'importCandidates' || !candidateImportRows.length}>
                          <Upload size={18} />
                          {busyAction === 'importCandidates' ? '导入中' : '批量导入考生'}
                        </button>
                      </section>
                    ) : null}
                  </section>
                </div>
              ) : null}
            </div>
          ) : null}

          {settingsTab === 'rooms' ? (
            <div className="grid">
              <section className="card grid room-management-card">
                <div className="table-toolbar">
                  <div>
                    <h2 style={{ margin: 0 }}>考室列表</h2>
                    <div className="muted">显示考室名称、考室监考、考室考生；团队赛按队伍考号分配考室。</div>
                  </div>
                  <div className="room-toolbar-actions">
                    <div className={unassignedCandidates.length ? 'coverage-badge warn' : 'coverage-badge ok'}>未分配考生 {unassignedCandidates.length}</div>
                    <button className="button secondary" onClick={() => { setRoomCsv(''); setRoomImportOpen(true); }}>
                      <Upload size={18} />
                      批量导入
                    </button>
                    <button className="button" onClick={addRoom}>
                      <UserPlus size={18} />
                      添加考室
                    </button>
                  </div>
                </div>
                <div className="room-list-grid">
                  {state.rooms.map((room) => (
                    <article className="room-card" key={room.id}>
                      <div className="room-card-head">
                        <div className="room-card-title">
                          <strong>{room.name}</strong>
                          <div className="muted">考室考生 {room.candidates.length} 人</div>
                        </div>
                        <div className="room-card-actions">
                          <button className="button secondary room-action-button" onClick={() => setRoomDetail(room)}>查看详情</button>
                          <button className="button secondary room-action-button" onClick={() => editRoom(room)}>编辑考室</button>
                          <button className="button danger room-action-button" onClick={() => void deleteRoom(room.id, room.name)} disabled={busyAction === `deleteRoom-${room.id}`}>
                            {busyAction === `deleteRoom-${room.id}` ? '删除中' : '删除考室'}
                          </button>
                        </div>
                      </div>
                      <div className="room-config-summary">
                        <span>第二机位：{room.requireSecondCamera ? '需要' : '不需要'}</span>
                        <span>前置摄像头：{room.requireFrontCamera ? '需要' : '不需要'}</span>
                        <span>登录方式：{room.loginMode === 'SECOND_CAMERA_QR' ? '第二机位扫码' : '考试编号＋姓名＋考号＋密码'}</span>
                        <span>登录请求审核：{room.loginReviewMode === 'AUTO' ? '自动通过' : '手动审核'}</span>
                      </div>
                      <div className="room-info-block">
                        <span>考室监考</span>
                        <div className="room-chip-list">
                          {room.proctors.map(({ user }) => (
                            <span key={user.id}>{user.realName || user.nickname || user.username || '暂未更新'} / {user.numberId || '-'}</span>
                          ))}
                          {!room.proctors.length ? <em>暂无监考</em> : null}
                        </div>
                      </div>
                      <div className="room-info-block">
                        <span>考室考生</span>
                        <div className="room-candidate-list">
                          {room.candidates.map(({ candidate }) => (
                          <span key={candidate.id}>{candidate.seatNo} {displayName(candidate)} / {candidate.examNumber}</span>
                          ))}
                          {!room.candidates.length ? <em>暂无考生</em> : null}
                        </div>
                      </div>
                    </article>
                  ))}
                  {!state.rooms.length ? <div className="muted">暂无考室，请点击添加考室。</div> : null}
                </div>
              </section>

              {roomEditorOpen ? (
                <div className="modal-backdrop" role="presentation" onMouseDown={() => setRoomEditorOpen(false)}>
                  <section className="modal-panel form" onMouseDown={(event) => event.stopPropagation()}>
                    <div className="modal-title">
                      <h2 style={{ margin: 0 }}>{selectedSettingsRoomId ? '修改考室' : '添加考室'}</h2>
                      <button type="button" className="button secondary icon-button" onClick={() => setRoomEditorOpen(false)} aria-label="关闭">
                        <X size={18} />
                      </button>
                    </div>
                    <label>
                      考室名称
                      <input value={roomName} onChange={(event) => setRoomName(event.target.value)} placeholder="本次考试唯一" />
                    </label>
                    <div className="grid two room-security-fields">
                      <label className="exam-checkbox"><input type="checkbox" checked={roomRequireSecondCamera} onChange={(event) => setRoomRequireSecondCamera(event.target.checked)} /> 需要第二机位</label>
                      <label className="exam-checkbox"><input type="checkbox" checked={roomRequireFrontCamera} onChange={(event) => setRoomRequireFrontCamera(event.target.checked)} /> 需要前置摄像头</label>
                      <label>登录方式<select value={roomLoginMode} onChange={(event) => setRoomLoginMode(event.target.value as 'CREDENTIALS' | 'SECOND_CAMERA_QR')}><option value="CREDENTIALS">考试编号＋姓名＋考号＋密码</option><option value="SECOND_CAMERA_QR">第二机位扫码</option></select></label>
                      <label>登录请求审核方式<select value={roomLoginReviewMode} onChange={(event) => setRoomLoginReviewMode(event.target.value as 'MANUAL' | 'AUTO')}><option value="MANUAL">手动审核</option><option value="AUTO">自动通过</option></select></label>
                    </div>
                    <section className="room-editor-section">
                      <div className="table-toolbar">
                        <div>
                          <h3 style={{ margin: 0 }}>监考名单</h3>
                          <div className="muted">至少一个监考，姓名未同步时显示暂未更新</div>
                        </div>
                        <button type="button" className="button secondary compact-button" onClick={() => setRoomProctorAddOpen(true)}>添加监考</button>
                      </div>
                      <div className="room-detail-list">
                        {roomProctorRows.map((proctor) => (
                          <div className="room-detail-row" key={proctor.numberId}>
                            <div>
                              <strong>{proctor.name}</strong>
                              <span>学号：{proctor.numberId}</span>
                            </div>
                            <button type="button" className="button danger compact-button" onClick={() => removeRoomProctor(proctor.numberId)}>移除</button>
                          </div>
                        ))}
                        {!roomProctorRows.length ? <div className="muted">暂无监考，请添加至少一个监考学号。</div> : null}
                      </div>
                    </section>
                    <section className="room-editor-section">
                      <div className="table-toolbar">
                        <div>
                          <h3 style={{ margin: 0 }}>考生名单</h3>
                          <div className="muted">团队赛按队伍考号添加和移除</div>
                        </div>
                        <button type="button" className="button secondary compact-button" onClick={() => { setRoomCandidateInputError(''); setRoomCandidateAddOpen(true); }}>添加考生</button>
                      </div>
                      <label className="candidate-search-field room-search-field">
                        <Search size={17} />
                        <input
                          value={roomCandidateSearch}
                          onChange={(event) => setRoomCandidateSearch(event.target.value)}
                          placeholder={state.exam.contestType === 'TEAM' ? '搜索队伍名称或考号' : '搜索姓名、学号或考号'}
                        />
                      </label>
                      <div className="table-scroll">
                        <table className="table room-candidate-table">
                          <thead>
                            <tr>
                              {state.exam.contestType === 'TEAM' ? <th>队伍名称</th> : <th>姓名</th>}
                              {state.exam.contestType === 'TEAM' ? <th>队伍成员</th> : <th>学号</th>}
                              <th>学校</th>
                              <th>学院</th>
                              <th>考号</th>
                              <th>座位号</th>
                              <th>状态</th>
                              <th>操作</th>
                            </tr>
                          </thead>
                          <tbody>
                            {roomCandidateRows.map((candidate) => {
                              const known = Boolean(candidate.id);
                              return (
                                <tr key={candidate.id || candidate.examNumber}>
                                  <td>{known ? (state.exam.contestType === 'TEAM' ? candidate.teamName || '-' : candidate.name || '-') : '未导入'}</td>
                                  <td>{known ? (state.exam.contestType === 'TEAM' ? state.exam.teamAccountMode === 'TEAM_ACCOUNT' ? splitMemberText(candidate.teamMembers).join('、') || '-' : `${candidate.name || '-'} / ${candidate.studentId || '-'}` : candidate.studentId || '-') : '-'}</td>
                                  <td>{known ? candidate.school || '-' : '-'}</td>
                                  <td>{known ? candidate.college || '-' : '-'}</td>
                                  <td>{candidate.examNumber}</td>
                                  <td>{known ? candidate.seatNo : '-'}</td>
                                  <td>{known ? <span className={`status-pill status-${candidate.status}`}>{statusText(candidate.status)}</span> : <span className="muted">未匹配</span>}</td>
                                  <td><button type="button" className="button danger compact-button" onClick={() => removeRoomCandidate(candidate.examNumber)}>移除</button></td>
                                </tr>
                              );
                            })}
                            {!roomCandidateRows.length ? (
                              <tr>
                                <td colSpan={8} className="muted">{splitLines(roomCandidates).length ? '当前搜索下没有匹配的考生。' : '暂无考生，可暂时为空。'}</td>
                              </tr>
                            ) : null}
                          </tbody>
                        </table>
                      </div>
                    </section>
                    <button className="button" onClick={() => void importRoom()} disabled={busyAction === 'importRoom'}>
                      <Save size={18} />
                      {busyAction === 'importRoom' ? '保存中' : '保存考室'}
                    </button>
                  </section>

                  {roomProctorAddOpen ? (
                    <section className="room-inline-dialog form" onMouseDown={(event) => event.stopPropagation()}>
                      <div className="modal-title">
                        <h3 style={{ margin: 0 }}>添加监考</h3>
                        <button type="button" className="button secondary icon-button" onClick={() => setRoomProctorAddOpen(false)} aria-label="关闭">
                          <X size={18} />
                        </button>
                      </div>
                      <label>
                        监考学号
                        <textarea rows={5} value={roomProctorInput} onChange={(event) => setRoomProctorInput(event.target.value)} placeholder="一行一个学号；重号请填写姓名+学号" />
                      </label>
                      <button type="button" className="button" onClick={addRoomProctors}>添加到名单</button>
                    </section>
                  ) : null}

                  {roomCandidateAddOpen ? (
                    <section className="room-inline-dialog form" onMouseDown={(event) => event.stopPropagation()}>
                      <div className="modal-title">
                        <h3 style={{ margin: 0 }}>添加考生</h3>
                        <button type="button" className="button secondary icon-button" onClick={() => setRoomCandidateAddOpen(false)} aria-label="关闭">
                          <X size={18} />
                        </button>
                      </div>
                      <label>
                        添加方式
                        <select aria-label="添加方式" value={roomCandidateInputType} onChange={event => { setRoomCandidateInputType(event.target.value as RoomCandidateInputType); setRoomCandidateInputError(''); }}>
                          <option value="EXAM_NUMBER">按考号添加</option>
                          <option value="STUDENT_ID">按学号添加</option>
                        </select>
                      </label>
                      <label>
                        {roomCandidateInputType === 'STUDENT_ID' ? '考生学号' : '考生考号'}
                        <textarea aria-label={roomCandidateInputType === 'STUDENT_ID' ? '考生学号' : '考生考号'} rows={5} value={roomCandidateInput} onChange={(event) => { setRoomCandidateInput(event.target.value); setRoomCandidateInputError(''); }} placeholder={roomCandidateInputType === 'STUDENT_ID' ? '一行一个学号' : '一行一个考号'} />
                      </label>
                      <p className="muted">考生须已导入本场考试。学号重复时请按考号添加；团队统一账号可填写成员学号。</p>
                      {roomCandidateInputError ? <div className="exam-editor-error" role="alert">{roomCandidateInputError}</div> : null}
                      <button type="button" className="button" onClick={addRoomCandidates}>添加到名单</button>
                    </section>
                  ) : null}
                </div>
              ) : null}

              {roomDetail ? (
                <div className="modal-backdrop" role="presentation" onMouseDown={() => setRoomDetail(null)}>
                  <section className="modal-panel form room-detail-modal" onMouseDown={(event) => event.stopPropagation()}>
                    <div className="modal-title"><div><h2 style={{ margin: 0 }}>{roomDetail.name}</h2><div className="muted">考室完整信息</div></div><button type="button" className="button secondary icon-button" onClick={() => setRoomDetail(null)} aria-label="关闭"><X size={18} /></button></div>
                    <dl className="room-detail-facts"><div><dt>第二机位</dt><dd>{roomDetail.requireSecondCamera ? '需要' : '不需要'}</dd></div><div><dt>前置摄像头</dt><dd>{roomDetail.requireFrontCamera ? '需要' : '不需要'}</dd></div><div><dt>登录方式</dt><dd>{roomDetail.loginMode === 'SECOND_CAMERA_QR' ? '第二机位扫码' : '考试编号＋姓名＋考号＋密码'}</dd></div><div><dt>登录请求审核</dt><dd>{roomDetail.loginReviewMode === 'AUTO' ? '自动通过' : '手动审核'}</dd></div></dl>
                    <section><h3>考室监考</h3><div className="room-detail-list">{roomDetail.proctors.map(({ user }) => <div className="room-detail-row" key={user.id}><strong>{user.realName || user.nickname || user.username || '暂未更新'}</strong><span>{user.numberId || '-'}</span></div>)}{!roomDetail.proctors.length ? <div className="muted">暂无监考</div> : null}</div></section>
                    <section><h3>考室考生</h3><div className="room-detail-list">{roomDetail.candidates.map(({ candidate }) => <div className="room-detail-row" key={candidate.id}><strong>{displayName(candidate)}</strong><span>{candidate.studentId || candidate.examNumber} · 座位 {candidate.seatNo || '-'}</span></div>)}{!roomDetail.candidates.length ? <div className="muted">暂无考生</div> : null}</div></section>
                    <button className="button" onClick={() => { const room = roomDetail; setRoomDetail(null); editRoom(room); }}>编辑考室</button>
                  </section>
                </div>
              ) : null}

              {roomImportOpen ? (
                <div className="modal-backdrop" role="presentation" onMouseDown={() => setRoomImportOpen(false)}>
                  <section className="modal-panel form" onMouseDown={(event) => event.stopPropagation()}>
                    <div className="modal-title">
                      <h2 style={{ margin: 0 }}>批量导入考室</h2>
                      <button type="button" className="button secondary icon-button" onClick={() => setRoomImportOpen(false)} aria-label="关闭">
                        <X size={18} />
                      </button>
                    </div>
                    <div className="muted">Excel 首行字段：考室名称、监考老师学号、考生考号、登录请求审核方式。审核方式填写“手动审核”或“自动通过”。多个学号或考号可用顿号、逗号、空格或换行分隔。</div>
                    <button className="button secondary" type="button" onClick={() => void downloadRoomTemplate()}>
                      <Download size={18} />
                      下载模板
                    </button>
                    <label>
                      选择模板表格
                      <input type="file" accept=".xlsx,.xls,.csv" onChange={(event) => void readRoomFile(event)} />
                    </label>
                    <button className="button" onClick={() => void importRoomsBatch()} disabled={busyAction === 'importRoomsBatch' || !roomCsv.trim()}>
                      <Upload size={18} />
                      {busyAction === 'importRoomsBatch' ? '导入中' : '批量导入考室'}
                    </button>
                  </section>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
