import { parseBody } from '@/lib/http';
import { admittedRelay } from '@/lib/live-relay-http';
import { RelayMediaAuthSchema, authorizeRelayMedia } from '@/lib/live-relay-media-auth';
import { prisma } from '@/lib/db';
import { verifyMediaPublishToken } from '@/lib/media-publish-token';
import { canPublishChannel } from '@/lib/media-publish-access';
import { verifyMediaReadToken } from '@/lib/media-read-token';
import { authorizeMediaRead } from '@/lib/media-read-access';
import { verifyMediaApiToken } from '@/lib/media-api-auth';
import { verifyLiveApiReadToken } from '@/lib/live-api-token';
import { verifyVoiceMediaToken } from '@/lib/voice-call-token';
import { voiceCallEndReason } from '@/lib/voice-call';
import { canAccessCandidate } from '@/lib/permissions';
import { authorizeContestLiveMediaToken } from '@/lib/contest-live-media';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const publishPathPattern = /^live\/([^/]+)_(DESKTOP_SCREEN|DESKTOP_CAMERA|MOBILE_CAMERA)$/;

function unauthorized() {
  return new Response(null, { status: 401 });
}

export async function POST(request: Request) {
  const parsed = await parseBody(request, RelayMediaAuthSchema, 8192).then(data => ({ data })).catch(() => null);
  if (!parsed) return unauthorized();
  const input = parsed.data;
  // API callbacks must never queue behind publisher transactions: media
  // inventory and cleanup use this API while publisher authentication waits.
  if (input.action === 'api') return new Response(null, { status: verifyMediaApiToken(input.token) ? 204 : 401 });
  if (input.path.startsWith('relay/')) return admittedRelay(request, async () => {
    await authorizeRelayMedia(input);
    return new Response(null, { status: 204 });
  });

  if (parsed.data.path.replace(/^\/+/, '').startsWith('voice/')) {
    if (parsed.data.protocol !== 'webrtc') return unauthorized();
    const claims = verifyVoiceMediaToken(parsed.data.token, parsed.data.path, parsed.data.action);
    if (!claims) return unauthorized();
    const call = await prisma.voiceCall.findUnique({ where: { id: claims.callId }, include: { session: true, caller: true } });
    if (!call || !['CONNECTING', 'ACTIVE'].includes(call.status) || voiceCallEndReason(call) || call.session.revokedAt
      || call.session.status === 'FINISHED' || call.caller.status !== 'ACTIVE'
      || (claims.side === 'ADMIN' ? claims.credential !== call.callerId : claims.credential !== call.session.desktopTokenHash)
      || !await canAccessCandidate(call.caller, call.session.candidateId)) return unauthorized();
    return new Response(null, { status: 204 });
  }

  const match = parsed.data.path.replace(/^\/+/, '').match(publishPathPattern);
  if (!match) return unauthorized();
  const [, sessionId, channel] = match;
  if (parsed.data.action === 'read' && ['hls', 'webrtc'].includes(parsed.data.protocol)) {
    if (parsed.data.token.startsWith('contest-live.')) {
      if (parsed.data.protocol !== 'webrtc' || !await authorizeContestLiveMediaToken(parsed.data.token, sessionId, channel)) return unauthorized();
      return new Response(null, { status: 204 });
    }
    const liveClaims = verifyLiveApiReadToken(parsed.data.token, sessionId, channel);
    if (liveClaims) {
      const key = await prisma.liveApiKey.findUnique({ where: { id: liveClaims.keyId }, select: { enabled: true } });
      if (!key?.enabled) return unauthorized();
      const session = await prisma.clientSession.findUnique({ where: { id: sessionId }, select: { examId: true, candidateId: true, startedAt: true, status: true, revokedAt: true } });
      if (!session || !['APPROVED', 'IN_EXAM', 'LOCKED', 'OFFLINE'].includes(session.status) || !await canPublishChannel(session, channel)) return unauthorized();
      return new Response(null, { status: 204 });
    }
    const claims = verifyMediaReadToken(parsed.data.token, sessionId, channel);
    if (!claims) return unauthorized();
    const user = await prisma.user.findUnique({ where: { id: claims.userId } });
    if (!user || user.status !== 'ACTIVE') return unauthorized();
    try { await authorizeMediaRead(user, sessionId, channel); }
    catch { return unauthorized(); }
    return new Response(null, { status: 204 });
  }
  if (parsed.data.action !== 'publish' || !['rtmp', 'webrtc'].includes(parsed.data.protocol)) return unauthorized();
  const session = await prisma.clientSession.findUnique({
    where: { id: sessionId },
    select: { id: true, examId: true, candidateId: true, startedAt: true, status: true, revokedAt: true, desktopTokenHash: true, miniProgramTokenHash: true }
  });
  if (!session || session.status === 'FINISHED') return unauthorized();
  if (!verifyMediaPublishToken(parsed.data.token, session, channel) || !await canPublishChannel(session, channel)) return unauthorized();

  return new Response(null, { status: 204 });
}
