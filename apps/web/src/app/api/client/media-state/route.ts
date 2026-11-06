import { prisma } from '@/lib/db';
import { verifyClientTokenForSession } from '@/lib/client-auth';
import { publicObjectUrl } from '@/lib/storage';
import { options, fail, ok, toErrorMessage } from '@/lib/http';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const sessionId = searchParams.get('sessionId');
    const summaryOnly = searchParams.get('summaryOnly') === 'true';
    if (!sessionId) return fail('缺少 sessionId', 400);

    const session = await prisma.clientSession.findUnique({
      where: { id: sessionId },
      select: {
        id: true,
        examId: true,
        candidateId: true,
        desktopTokenHash: true,
        miniProgramTokenHash: true,
        revokedAt: true,
        status: true,
        lastDesktopSeenAt: true,
        lastMiniProgramSeenAt: true,
        miniProgramOfflineAt: true,
        exam: { select: { requireMiniProgram: true } }
      }
    });
    if (!session) return fail('未找到有效客户端会话', 404);
    if (!verifyClientTokenForSession(request, session, 'DESKTOP')) return fail('客户端会话令牌无效或已过期', 401);

    const recoveryPairCode = searchParams.get('recoveryPairCode');
    const [room, recoveryPair, segments, frames] = await Promise.all([prisma.examRoom.findFirst({
      where: { examId: session.examId, candidates: { some: { candidateId: session.candidateId } } },
      select: { requireSecondCamera: true }
    }),
    // Only disclose whether this desktop's displayed recovery QR is usable.
    // The phone and desktop credentials never leave their own login responses.
    recoveryPairCode ? prisma.pairingSession.findFirst({
      where: { pairCode: recoveryPairCode, recoverySessionId: session.id, purpose: 'RECOVERY' },
      select: { pairCode: true, claimedAt: true, expiresAt: true }
    }) : Promise.resolve(null),
    summaryOnly ? Promise.resolve([]) : prisma.mediaSegment.findMany({
      where: { sessionId: session.id, deletedAt: null, channel: { in: ['DESKTOP_SCREEN', 'DESKTOP_CAMERA', 'MOBILE_CAMERA'] } },
      orderBy: { startedAt: 'desc' }, take: 12,
    }),
    summaryOnly ? Promise.resolve([]) : prisma.liveFrame.findMany({
      where: { sessionId: session.id, channel: { in: ['DESKTOP_SCREEN', 'DESKTOP_CAMERA', 'MOBILE_CAMERA'] } },
      orderBy: { capturedAt: 'desc' }, take: 3,
    })]);

    const latest: Record<string, unknown> = {};
    const live: Record<string, unknown> = {};
    const urls: Promise<void>[] = [];
    for (const segment of segments) {
      if (latest[segment.channel]) continue;
      latest[segment.channel] = segment;
      urls.push(publicObjectUrl(segment.objectPath).then(url => {
        latest[segment.channel] = { ...segment, objectPath: url || segment.objectPath };
      }));
    }
    for (const frame of frames) {
      if (live[frame.channel]) continue;
      live[frame.channel] = frame;
      urls.push(publicObjectUrl(frame.objectPath).then(url => {
        live[frame.channel] = { ...frame, objectPath: url || frame.objectPath };
      }));
    }
    await Promise.all(urls);

    return ok({
      serverNow: new Date().toISOString(),
      session: {
        id: session.id,
        status: session.status,
        lastDesktopSeenAt: session.lastDesktopSeenAt,
        lastMiniProgramSeenAt: session.lastMiniProgramSeenAt,
        miniProgramOfflineAt: session.miniProgramOfflineAt,
        requireSecondCamera: room?.requireSecondCamera ?? session.exam.requireMiniProgram
      },
      recoveryPair,
      latest,
      live
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
