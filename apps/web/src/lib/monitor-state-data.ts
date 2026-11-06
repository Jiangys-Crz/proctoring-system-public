import { prisma } from './db';
import { PUBLIC_USER_SELECT } from './public-dto';
import { settleReads } from './request-admission';

type MonitorExam = Awaited<ReturnType<typeof readMonitorExam>>;
type MonitorData = Awaited<ReturnType<typeof readMonitorData>>;
const state = globalThis as typeof globalThis & {
  monitorExamReads?: Map<string, Promise<MonitorExam>>;
  monitorDataReads?: Map<string, Promise<MonitorData>>;
};
const examReads = state.monitorExamReads ??= new Map<string, Promise<MonitorExam>>();
const dataReads = state.monitorDataReads ??= new Map<string, Promise<MonitorData>>();
const MAX_PENDING_SCOPES = 256;

async function shareRead<T>(reads: Map<string, Promise<T>>, key: string, read: () => PromiseLike<T>) {
  const current = reads.get(key);
  if (current) return current;
  // Share only ongoing reads, never completed data or permission decisions.
  // A burst of unrelated scopes must not create an unbounded sharing map.
  if (reads.size >= MAX_PENDING_SCOPES) return read();
  const pending = Promise.resolve(read());
  reads.set(key, pending);
  try { return await pending; }
  finally { if (reads.get(key) === pending) reads.delete(key); }
}

// The monitor uses problem titles/scores. Statements, private judge config and
// attachment lists belong to the problem endpoints, not every two-second poll.
export function loadMonitorExam(examId: string) {
  return shareRead(examReads, examId, () => readMonitorExam(examId));
}

function readMonitorExam(examId: string) {
  return prisma.exam.findUnique({
    where: { id: examId },
    omit: { externalBoardApiKey: true, novaJudgeApiKey: true },
    include: { problems: {
      orderBy: { order: 'asc' },
      select: { id: true, order: true, hydroProblemId: true, title: true,
        problemType: true, hydroScore: true, scorePercent: true, score: true },
    } },
  });
}

// Keep room predicates on every query: these are fresh reads, never a cached
// authorization snapshot. Printing still loads the full body via /document.
export function loadMonitorData(examId: string, userId: string, manageable: boolean) {
  // Every manager is authorized for the whole exam before reaching this read.
  // Proctor room assignments can be partially revoked while an older request
  // is pending, so even the same proctor must get a new scoped database read.
  if (!manageable) return readMonitorData(examId, userId, false);
  return shareRead(dataReads, examId, () => readMonitorData(examId, userId, true));
}

async function readMonitorData(examId: string, userId: string, manageable: boolean) {
  const candidateScope =
    manageable
      ? {}
      : {
          rooms: {
            some: {
              room: {
                proctors: { some: { userId } }
              }
            }
          }
        };

  const [candidates, loginRequests, sessions, alerts, mediaSegments, rooms, cheatingRecords, printJobs] = await settleReads([
    prisma.candidate.findMany({ where: { examId, ...candidateScope }, orderBy: [{ seatNo: 'asc' }, { examNumber: 'asc' }], omit: { password: true } }),
    prisma.loginRequest.findMany({
      where: { examId, status: 'REQUESTING', candidate: candidateScope },
      include: { candidate: { omit: { password: true } } },
      orderBy: { createdAt: 'asc' }
    }),
    prisma.clientSession.findMany({ where: { examId, candidate: candidateScope }, orderBy: { updatedAt: 'desc' }, omit: { desktopTokenHash: true, miniProgramTokenHash: true, monitoringAlertState: true } }),
    prisma.alert.findMany({
      where: { examId, candidate: candidateScope },
      include: { candidate: { omit: { password: true } } },
      // MySQL sorts NULL first, so old unresolved incidents remain actionable.
      orderBy: [{ acknowledgedAt: 'asc' }, { createdAt: 'desc' }],
      take: 80
    }),
    prisma.mediaSegment.findMany({
      where: {
        examId,
        candidate: candidateScope,
        deletedAt: null, channel: { in: ['DESKTOP_SCREEN', 'DESKTOP_CAMERA', 'MOBILE_CAMERA'] }
      },
      orderBy: { startedAt: 'desc' },
      take: 300
    }),
    manageable
      ? prisma.examRoom.findMany({
          where: { examId },
          include: {
            proctors: { include: { user: { select: PUBLIC_USER_SELECT } } },
            candidates: { include: { candidate: { omit: { password: true } } } }
          },
          orderBy: { createdAt: 'asc' }
        })
      : prisma.examRoom.findMany({
          where: { examId, proctors: { some: { userId } } },
          include: {
            proctors: { include: { user: { select: PUBLIC_USER_SELECT } } },
            candidates: { include: { candidate: { omit: { password: true } } } }
          },
          orderBy: { createdAt: 'asc' }
        }),
    prisma.cheatingRecord.findMany({
      where: { examId, candidate: candidateScope },
      include: {
        markedBy: { select: PUBLIC_USER_SELECT },
        canceledBy: { select: PUBLIC_USER_SELECT },
        candidate: { omit: { password: true } }
      },
      orderBy: { createdAt: 'desc' }
    }),
    prisma.printJob.findMany({ where: { examId, candidate: candidateScope }, orderBy: { createdAt: 'desc' }, omit: { content: true } })
  ]);
  const candidateIds = candidates.map((candidate) => candidate.id);
  const liveFrames = candidateIds.length
    ? await prisma.liveFrame.findMany({
        where: {
          examId,
          candidateId: { in: candidateIds },
          channel: { in: ['DESKTOP_SCREEN', 'DESKTOP_CAMERA', 'MOBILE_CAMERA'] }
        },
        orderBy: { capturedAt: 'desc' }
      })
    : [];

  return { candidates, loginRequests, sessions, alerts, mediaSegments, rooms, cheatingRecords, printJobs, liveFrames };
}
