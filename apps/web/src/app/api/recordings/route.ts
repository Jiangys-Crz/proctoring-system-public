import { UploadSecurityError } from '@/lib/upload-security';
import { DeleteRecordingsSchema, deleteRecordings, RECORDING_CHANNELS } from '@/lib/recording-deletion';
import { assertReleaseRequestOrigin } from '@/lib/desktop-releases';
import { publicTestExamId } from '@/lib/public-test';
import { prisma } from '@/lib/db';
import { AuthError, requireUser } from '@/lib/auth';
import { canAccessCandidate } from '@/lib/permissions';
import { publicObjectUrl } from '@/lib/storage';
import { options, fail, ok, toErrorMessage, parseBody, RequestParseError } from '@/lib/http';
import { evidenceForAlerts } from '@/lib/alert-evidence';

type CandidateRow = {
  id: string;
  name: string | null;
  teamName: string | null;
  examNumber: string;
  seatNo: string;
};

const candidateSelect = { id: true, name: true, teamName: true, examNumber: true, seatNo: true } as const;

function candidateName(candidate: CandidateRow) {
  return candidate.teamName || candidate.name || candidate.examNumber;
}

function alertKind(message: string, type: string) {
  if (message) return message.endsWith('异常') || message.endsWith('掉线') ? message : `${message}异常`;
  const map: Record<string, string> = {
    SCREEN_SWITCH: '切屏异常',
    SCREEN_CAPTURE_LOST: '电脑屏幕异常',
    CAMERA_CAPTURE_LOST: '电脑前置摄像头异常',
    MOBILE_CAMERA_LOST: '第二机位异常',
    PROCESS_POLICY: '进程异常',
    NETWORK_POLICY: '网络异常',
    PERIPHERAL_CHANGED: '外设异常',
    VIRTUAL_MACHINE: '虚拟机异常',
    CLIENT_OFFLINE: '客户端掉线',
    SECOND_CAMERA_OFFLINE: '第二机位掉线',
    MANUAL_NOTE: '人工记录异常',
    OJ_LOGIN_FAILED: '评测服务连接异常'
  };
  return map[type] || `${type}异常`;
}

function recordingName(candidate: CandidateRow, memberName: string | null, message: string, type: string) {
  const kind = alertKind(message, type);
  if (candidate.teamName) return `${candidate.teamName}队伍${memberName || candidate.name || '成员'}${kind}`;
  return `${candidateName(candidate)}同学${kind}`;
}

async function candidateRecordings(candidate: CandidateRow, page: number, pageSize: number, loadAll: boolean) {
  const [total, alerts] = await Promise.all([
    prisma.alert.count({ where: { candidateId: candidate.id, evidenceDeletedAt: null } }),
    prisma.alert.findMany({
      where: { candidateId: candidate.id, evidenceDeletedAt: null },
      select: {
        id: true, sessionId: true, message: true, type: true, evidencePath: true,
        evidenceDeletedAt: true, createdAt: true, acknowledgedAt: true,
        session: { select: { memberName: true } }
      },
      orderBy: { createdAt: 'desc' },
      ...(loadAll ? {} : { skip: (page - 1) * pageSize, take: pageSize })
    })
  ]);
  const evidenceByAlert = await evidenceForAlerts(alerts);
  const items = await Promise.all(alerts.map(async (alert) => {
    const evidence = evidenceByAlert.get(alert.id);
    const evidencePath = alert.evidencePath || evidence?.segments[0]?.objectPath;
    return {
      id: alert.id,
      name: recordingName(candidate, alert.session?.memberName || null, alert.message, alert.type),
      message: alert.message,
      type: alert.type,
      objectPath: evidencePath ? (await publicObjectUrl(evidencePath)) || evidencePath : null,
      evidence,
      createdAt: alert.createdAt,
      acknowledgedAt: alert.acknowledgedAt
    };
  }));
  return { items, total, page, pageSize: loadAll ? total : pageSize };
}

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const searchParams = new URL(request.url).searchParams;
    const candidateId = searchParams.get('candidateId');
    if (candidateId) {
      if (!(await canAccessCandidate(user, candidateId))) return fail('无权查看该考生录像', 403);
      const candidate = await prisma.candidate.findUnique({ where: { id: candidateId }, select: candidateSelect });
      if (!candidate) return fail('考生不存在', 404);
      const loadAll = searchParams.get('all') === '1';
      const page = Math.max(1, Number.parseInt(searchParams.get('page') || '1', 10) || 1);
      const pageSize = Math.min(50, Math.max(10, Number.parseInt(searchParams.get('pageSize') || '20', 10) || 20));
      return ok(await candidateRecordings(candidate, page, pageSize, loadAll));
    }

    const candidateScope = user.role === 'SUPER_ADMIN'
      ? {}
      : { OR: [
          { exam: { createdById: user.id } },
          { exam: { administrators: { some: { userId: user.id } } } },
          { rooms: { some: { room: { proctors: { some: { userId: user.id } } } } } }
        ] };
    const examScope = user.role === 'SUPER_ADMIN'
      ? {}
      : { OR: [
          { createdById: user.id }, { administrators: { some: { userId: user.id } } },
          { rooms: { some: { proctors: { some: { userId: user.id } } } } }
        ] };
    const exams = await prisma.exam.findMany({
      where: { AND: [examScope, { id: { not: await publicTestExamId() } }] },
      select: {
        id: true, name: true, startAt: true, endAt: true, createdById: true,
        administrators: { where: { userId: user.id }, select: { userId: true } },
        rooms: {
          select: {
            id: true, name: true,
            candidates: {
              where: { candidate: candidateScope },
              select: { candidateId: true }, orderBy: { candidate: { examNumber: 'asc' } }
            }
          },
          orderBy: { name: 'asc' }
        },
        candidates: { where: candidateScope, select: candidateSelect, orderBy: [{ examNumber: 'asc' }] }
      },
      orderBy: { startAt: 'desc' }
    });
    const candidateIds = exams.flatMap((exam) => exam.candidates.map((candidate) => candidate.id));
    const countRows = candidateIds.length
      ? await prisma.alert.groupBy({
          by: ['candidateId'],
          where: { candidateId: { in: candidateIds }, evidenceDeletedAt: null },
          _count: { _all: true }
        })
      : [];
    const counts = new Map(countRows.map((row) => [row.candidateId || '', row._count._all]));

    const [mediaCounts, cleanupCounts, failedCounts] = await Promise.all([
      prisma.mediaSegment.groupBy({ by: ['examId'], where: { examId: { in: exams.map(e => e.id) }, candidate: candidateScope, deletedAt: null, channel: { in: [...RECORDING_CHANNELS] } }, _count: { _all: true }, _sum: { byteSize: true } }),
      prisma.fileDeletionJob.groupBy({ by: ['examId'], where: { examId: { in: exams.map(e => e.id) }, kind: 'MEDIA', completedAt: null }, _count: { _all: true } }),
      prisma.fileDeletionJob.groupBy({ by: ['examId'], where: { examId: { in: exams.map(e => e.id) }, kind: 'MEDIA', completedAt: null, lastError: { not: null } }, _count: { _all: true } })
    ]);
    const mediaByExam = new Map(mediaCounts.map(row => [row.examId, row]));
    const cleanupByExam = new Map(cleanupCounts.map(row => [row.examId, row._count._all]));
    const failedByExam = new Map(failedCounts.map(row => [row.examId, row._count._all]));
    const now = new Date();
    return ok(exams.map((exam) => {
      const allowedCandidates = new Map(exam.candidates.map((candidate) => [candidate.id, candidate]));
      const roomCandidateIds = new Set<string>();
      const rooms = exam.rooms.map((room) => {
        const candidates = room.candidates
          .flatMap(({ candidateId }) => {
            const candidate = allowedCandidates.get(candidateId);
            if (!candidate) return [];
            roomCandidateIds.add(candidate.id);
            return [{
              id: candidate.id,
              name: candidate.name,
              teamName: candidate.teamName,
              examNumber: candidate.examNumber,
              seatNo: candidate.seatNo,
              recordingCount: counts.get(candidate.id) || 0,
              recordings: []
            }];
          })
          .filter((candidate) => candidate.recordingCount > 0);
        return {
          id: room.id,
          name: room.name,
          recordingCount: candidates.reduce((total, candidate) => total + candidate.recordingCount, 0),
          candidates
        };
      }).filter((room) => room.recordingCount > 0);
      const unassignedCandidates = exam.candidates
        .filter((candidate) => !roomCandidateIds.has(candidate.id))
        .map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          teamName: candidate.teamName,
          examNumber: candidate.examNumber,
          seatNo: candidate.seatNo,
          recordingCount: counts.get(candidate.id) || 0,
          recordings: []
        }))
        .filter((candidate) => candidate.recordingCount > 0);
      if (unassignedCandidates.length) {
        rooms.push({
          id: '__unassigned',
          name: '未分配考室',
          recordingCount: unassignedCandidates.reduce((total, candidate) => total + candidate.recordingCount, 0),
          candidates: unassignedCandidates
        });
      }
      return {
        id: exam.id,
        name: exam.name,
        startAt: exam.startAt,
        endAt: exam.endAt,
        canDelete: (user.role === 'SUPER_ADMIN' || exam.createdById === user.id || exam.administrators.length > 0) && exam.endAt <= now,
        mediaCount: mediaByExam.get(exam.id)?._count._all || 0,
        bytes: mediaByExam.get(exam.id)?._sum.byteSize || 0,
        cleanupPending: cleanupByExam.get(exam.id) || 0,
        cleanupFailed: failedByExam.get(exam.id) || 0,
        recordingCount: rooms.reduce((total, room) => total + room.recordingCount, 0),
        rooms
      };
    }).filter((exam) => exam.recordingCount > 0 || exam.mediaCount > 0 || exam.cleanupPending > 0));
  } catch (error) {
    if (error instanceof AuthError || error instanceof UploadSecurityError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;

export async function DELETE(request: Request) {
  try {
    const user = await requireUser(request); assertReleaseRequestOrigin(request);
    return ok(await deleteRecordings(user, await parseBody(request, DeleteRecordingsSchema)));
  } catch (error) {
    if (error instanceof AuthError || error instanceof UploadSecurityError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail('请选择录像或考试', 400);
    return fail(toErrorMessage(error), 500);
  }
}
