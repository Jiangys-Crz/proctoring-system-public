export { languageFamily, languageFamilyName, groupJudgeLanguages, resolveJudgeLanguage } from './languages';
export { problemTypeLabel } from './problem-types';
export { statementDownloadTarget, statementAttachmentHref } from './statement-download';
export { ROOM_VIDEO_MIN_SECONDS, ROOM_VIDEO_MAX_SECONDS, isValidRoomVideoDuration } from './room-video';
import { z } from 'zod';

export const ExamPlatformSchema = z.enum(['HYDRO', 'NOVAJUDGE']);
export type ExamPlatform = z.infer<typeof ExamPlatformSchema>;

export const ContestTypeSchema = z.enum(['INDIVIDUAL', 'TEAM']);
export type ContestType = z.infer<typeof ContestTypeSchema>;
export const TeamAccountModeSchema = z.enum(['MEMBER_ACCOUNTS', 'TEAM_ACCOUNT']);
export type TeamAccountMode = z.infer<typeof TeamAccountModeSchema>;

// LANQIAO is a distinct scoring rule; ACM is accepted as a legacy XCPC alias.
export const ContestRuleSchema = z.enum(['GPLT', 'XCPC', 'LANQIAO', 'ACM', 'OI', 'IOI', 'KS']);
export type ContestRule = z.infer<typeof ContestRuleSchema>;

export const CandidateStatusSchema = z.enum([
  'NOT_REQUESTED',
  'REQUESTING',
  'REJECTED',
  'APPROVED',
  'ONLINE_NORMAL',
  'ONLINE_ABNORMAL',
  'OFFLINE',
  'FINISHED'
]);
export type CandidateStatus = z.infer<typeof CandidateStatusSchema>;

export const AlertTypeSchema = z.enum([
  'SCREEN_SWITCH',
  'SCREEN_CAPTURE_LOST',
  'CAMERA_CAPTURE_LOST',
  'MOBILE_CAMERA_LOST',
  'PROCESS_POLICY',
  'NETWORK_POLICY',
  'PERIPHERAL_CHANGED',
  'VIRTUAL_MACHINE',
  'CLIENT_OFFLINE',
  'SECOND_CAMERA_OFFLINE',
  'MANUAL_NOTE',
  'OJ_LOGIN_FAILED'
]);
export type AlertType = z.infer<typeof AlertTypeSchema>;

export const MediaChannelSchema = z.enum([
  'DESKTOP_SCREEN',
  'DESKTOP_CAMERA',
  'MOBILE_CAMERA',
  'IDENTITY_PHOTO',
  'ROOM_VIDEO',
  'EVIDENCE_CLIP'
]);
export type MediaChannel = z.infer<typeof MediaChannelSchema>;

export const VoiceSenderSchema = z.enum(['ADMIN', 'MINIPROGRAM']);
export type VoiceSender = z.infer<typeof VoiceSenderSchema>;

export const CreateExamSchema = z.object({
  name: z.string().trim().min(1).max(200),
  startAt: z.coerce.date(),
  latestStartAt: z.coerce.date(),
  endAt: z.coerce.date(),
  durationMinutes: z.coerce.number().int().positive().max(525600),
  platform: ExamPlatformSchema,
  platformBaseUrl: z.string().trim().max(512).default('http://localhost'),
  platformContestId: z.string().min(1).default('local'),
  novaJudgeApiKey: z.string().trim().max(2000).nullable().optional(),
  novaJudgeTimezone: z.string().trim().max(100).default('Asia/Shanghai').refine(value => {
    try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
  }, 'NovaJudge 数据时区必须是有效的 IANA 时区'),
  contestType: ContestTypeSchema,
  teamAccountMode: TeamAccountModeSchema.default('MEMBER_ACCOUNTS'),
  contestRule: ContestRuleSchema.default('IOI'),
  flexible: z.boolean().default(false),
  scoreboardFrozenAt: z.coerce.date().nullable().optional(),
  freezeMinutes: z.coerce.number().int().min(0).nullable().optional(),
  administratorIds: z.array(z.string().min(1)).max(100).optional(),
  problemIds: z.array(z.string().trim().min(1)).max(200).optional(),
  allowedLanguages: z.array(z.string().trim().min(1).max(64).regex(/^[a-z][a-z0-9_+-]*$/)).max(100).default([]),
  showTestCaseCount: z.boolean().default(false),
  showObjectiveScore: z.boolean().default(false),
  allowPrint: z.boolean().default(false),
  printMode: z.enum(['DISABLED', 'VIRTUAL', 'PHYSICAL']).default('DISABLED'),
  allowTeamSubmissionView: z.boolean().default(false),
  leaderOnlySubmission: z.boolean().default(false),
  rules: z.string().optional().default(''),
  requireMiniProgram: z.coerce.boolean().default(true),
  requireFrontCamera: z.coerce.boolean().default(true),
  saveFullRecording: z.boolean().default(false),
  saveIncidentRecording: z.boolean().default(false),
  externalBoardEnabled: z.boolean().default(false),
  externalBoardIntervalSeconds: z.number().int().min(1).max(86400).default(10),
  externalBoardBaseUrl: z.string().trim().max(512).transform((value, ctx) => {
    if (!value) return '';
    try {
      const url = new URL(value.includes('://') ? value : `https://${value}`);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
        || !['/', '/api', '/api/'].includes(url.pathname) || /[\\\s]/.test(value)) throw new Error();
      return `${url.origin}/api`;
    } catch {
      ctx.addIssue({ code: 'custom', message: '外榜域名必须是有效的 HTTP/HTTPS 地址，可包含 /api，不能包含账号或查询参数' });
      return z.NEVER;
    }
  }).nullable().optional().default('https://www.example.org/api'),
  externalBoardApiKey: z.string().trim().max(2000).nullable().optional(),
  externalBoardEventId: z.string().trim().max(19).refine(value => !value || (/^[1-9]\d*$/.test(value) && BigInt(value) <= 9223372036854775807n), '官网赛事 ID 必须是有效的正整数').nullable().optional()
});

export const CandidateImportRowSchema = z.object({
  name: z.string().optional(),
  studentId: z.string().optional(),
  school: z.string().optional(),
  college: z.string().optional(),
  major: z.string().optional(),
  gender: z.string().optional(),
  gradeYear: z.string().optional(),
  className: z.string().optional(),
  advisor: z.string().optional(),
  groupName: z.string().optional(),
  teamName: z.string().optional(),
  teamMembers: z.string().optional(),
  teamMemberStudentIds: z.string().optional(),
  hydroAccount: z.string().optional(),
  examNumber: z.string().min(1),
  password: z.string().min(1),
  seatNo: z.string().min(1),
  roomName: z.string().trim().max(191).optional(),
  isTeamLeader: z.coerce.boolean().optional().default(false),
  ranked: z.coerce.boolean().optional().default(true)
});

export const DesktopPairRequestSchema = z.object({
  publicTest: z.boolean().optional().default(false),
  deviceId: z.string().min(8).max(200),
  sessionId: z.string().min(1).max(200).optional(),
  hostname: z.string().optional(),
  os: z.string().optional(),
  clientVersion: z.string().optional(),
  screenOk: z.boolean().optional().default(false),
  desktopCameraOk: z.boolean().optional().default(false),
  peripheralsFingerprint: z.string().optional()
});

export const ClientReconnectSchema = z.object({
  side: z.enum(['DESKTOP', 'MINIPROGRAM']).optional().default('MINIPROGRAM'),
  pairCode: z.string().regex(/^\d{6}$/, '配对码必须是 6 位数字'),
  recoverySecret: z.string().regex(/^[A-Za-z0-9_-]{43}$/, '请扫描电脑端完整的恢复二维码'),
  deviceId: z.string().min(8).max(200),
  sessionId: z.string().min(1).max(200).optional(),
});

export const LoginRequestCreateSchema = z.object({
  examCode: z.string().trim().regex(/^\d{10}$/, '考试编号必须是 10 位数字'),
  examId: z.string().min(1).optional(),
  studentId: z.string().optional(),
  examNumber: z.string().min(1),
  password: z.string().min(1),
  pairCode: z.string().min(6),
  miniProgramDeviceId: z.string().min(4).optional(),
  uploadTicket: z.string().max(128).optional(),
  identityPhotoPath: z.string().optional(),
  roomVideoPath: z.string().optional(),
  name: z.string().optional(),
  school: z.string().optional(),
  college: z.string().optional(),
  teamName: z.string().optional()
});

export const ClientHeartbeatSchema = z.object({
  sessionId: z.string().optional(),
  deviceId: z.string().min(4),
  side: z.enum(['DESKTOP', 'MINIPROGRAM']),
  capture: z.object({
    screenOk: z.boolean().optional(),
    desktopCameraOk: z.boolean().optional(),
    mobileCameraOk: z.boolean().optional()
  }).optional(),
  system: z.object({
    activeWindow: z.string().optional(),
    processes: z.array(z.string()).optional(),
    networkRemotes: z.array(z.string()).optional(),
    peripheralsFingerprint: z.string().optional(),
    peripheralScanOk: z.boolean().optional(),
    peripheralEvents: z.array(z.object({
      id: z.uuid(), action: z.enum(['INSERT', 'REMOVE']),
      deviceId: z.string().max(2048).regex(/^USB\\VID_[0-9A-F]{4}&PID_[0-9A-F]{4}[^\\]*\\[^\\]+$/i)
    })).max(64).optional(),
    vmSignals: z.array(z.string()).optional()
  }).optional()
});

export const AlertCreateSchema = z.object({
  sessionId: z.string().optional(),
  candidateId: z.string().optional(),
  type: AlertTypeSchema,
  severity: z.coerce.number().int().min(1).max(5).default(3),
  message: z.string().min(1),
  evidencePath: z.string().optional()
});

export type CreateExamInput = z.infer<typeof CreateExamSchema>;
export type LoginRequestCreateInput = z.infer<typeof LoginRequestCreateSchema>;
export type DesktopPairRequestInput = z.infer<typeof DesktopPairRequestSchema>;
export type ClientHeartbeatInput = z.infer<typeof ClientHeartbeatSchema>;
export type AlertCreateInput = z.infer<typeof AlertCreateSchema>;

export { sanitizeStatementHtml, type StatementHtmlOptions } from './html-safety';
export * from './desktop-release';

/** Return the containing route without relying on browser visit history. */
export function parentRoutePath(pathname: string) {
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return '/';
  const path = pathname.split(/[?#]/, 1)[0].replace(/\/+$/, '');
  return path.slice(0, path.lastIndexOf('/')) || '/';
}
