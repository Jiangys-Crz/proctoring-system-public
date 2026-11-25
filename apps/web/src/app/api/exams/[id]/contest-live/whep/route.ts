import { AuthError, requireTrustedMutation } from '@/lib/auth';
import { browserIceAnswer } from '@/lib/browser-ice';
import { contestLiveHeaders, contestLiveViewer } from '@/lib/contest-live-access';
import { readContestLiveBody } from '@/lib/contest-live-body';
import { allowContestLiveMediaGrant, allowContestLiveMediaSession, contestLiveActiveTeams, contestLiveTeamChannelAllowed } from '@/lib/contest-live-media';
import { assertContestLiveTarget, contestLiveChannels, createContestLiveMediaToken, type ContestLiveChannel } from '@/lib/contest-live-media-token';
import { prisma } from '@/lib/db';
import { fail, toErrorMessage } from '@/lib/http';
import { deleteLiveWebRtcResource, liveWebRtcResource } from '@/lib/live-webrtc';
import { mediaStreamPath } from '@/lib/media-read-token';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };
const resourcePattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

async function handle(request: Request, { params }: Context) {
  let created: { id: string; sessionId: string; channel: ContestLiveChannel } | undefined;
  try {
    requireTrustedMutation(request);
    const { id: examId } = await params;
    const url = new URL(request.url);
    const sessionId = url.searchParams.get('sessionId') || '';
    const channel = url.searchParams.get('channel') as ContestLiveChannel;
    const teamId = url.searchParams.get('teamId') || '';
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId) || !contestLiveChannels.includes(channel) || !teamId || teamId.length > 255) {
      throw new AuthError('赛事直播画面参数无效', 400);
    }
    const viewer = await contestLiveViewer(request, examId);
    const access = viewer.access;
    if (!access || !viewer.mediaAllowed || !contestLiveActiveTeams(viewer.settings).has(teamId)) throw new AuthError('赛事直播画面未开放', 403);
    assertContestLiveTarget(url.searchParams.get('target') || '', examId, teamId, sessionId, channel, access);
    if (request.method !== 'DELETE' && !contestLiveTeamChannelAllowed(viewer.settings, teamId, channel)) {
      throw new AuthError('该队伍机位未开放', 403);
    }

    const base = (process.env.MEDIA_WHIP_INTERNAL_BASE || 'http://127.0.0.1:8889').replace(/\/+$/, '');
    const stream = mediaStreamPath(sessionId, channel);
    if (request.method === 'POST') {
      if (!request.headers.get('content-type')?.startsWith('application/sdp')) throw new AuthError('直播协商必须使用 application/sdp', 415);
      const body = (await readContestLiveBody(request, 65536)).toString('utf8');
      if (!body.trim().startsWith('v=0')) throw new AuthError('无效的直播协商数据', 400);
      if (!await allowContestLiveMediaSession(examId, teamId, sessionId, channel)) throw new AuthError('该机位暂无可用画面', 404);
      if (!await allowContestLiveMediaGrant(examId, access, teamId, channel)) throw new AuthError('观看授权已失效', 403);
      const upstream = await fetch(`${base}${stream}/whep`, {
        method: 'POST',
        headers: { authorization: `Bearer ${createContestLiveMediaToken({ examId, teamId, sessionId, channel, access })}`, 'content-type': 'application/sdp' },
        body, cache: 'no-store', redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(15_000)]),
      });
      if (!upstream.ok) {
        await upstream.body?.cancel();
        return new Response(null, { status: upstream.status, headers: contestLiveHeaders });
      }
      const id = liveWebRtcResource(upstream.headers.get('location') || '', base, stream);
      created = { id, sessionId, channel };
      const answer = browserIceAnswer(await upstream.text());
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${examId} FOR UPDATE`;
        if (!await allowContestLiveMediaGrant(examId, access, teamId, channel, tx)
          || !await allowContestLiveMediaSession(examId, teamId, sessionId, channel, tx)) {
          throw new AuthError('观看授权已失效', 403);
        }
        await tx.contestLiveConnection.create({ data: { id, examId, teamId, sessionId, channel, access } });
      });
      url.searchParams.set('resource', id);
      return new Response(answer, { status: 201, headers: {
        ...contestLiveHeaders, 'content-type': 'application/sdp', location: url.pathname + url.search, etag: upstream.headers.get('etag') || '*',
      } });
    }
    const resource = url.searchParams.get('resource') || '';
    if (!resourcePattern.test(resource)) throw new AuthError('无效的直播连接', 400);
    const row = await prisma.contestLiveConnection.findUnique({ where: { id: resource, examId, sessionId, channel, teamId, access } });
    if (!row) throw new AuthError('直播连接已失效', 404);
    if (request.method === 'DELETE') {
      await deleteLiveWebRtcResource(resource, sessionId, channel);
      await prisma.contestLiveConnection.deleteMany({ where: { id: resource } });
      return new Response(null, { status: 204, headers: contestLiveHeaders });
    }
    if (!request.headers.get('content-type')?.startsWith('application/trickle-ice-sdpfrag')) throw new AuthError('候选地址格式不正确', 415);
    const body = (await readContestLiveBody(request, 65536)).toString('utf8');
    if (!await allowContestLiveMediaSession(examId, teamId, sessionId, channel)
      || !await allowContestLiveMediaGrant(examId, access, teamId, channel)) throw new AuthError('观看授权已失效', 403);
    const upstream = await fetch(`${base}${stream}/whep/${resource}`, {
      method: 'PATCH', headers: { 'content-type': 'application/trickle-ice-sdpfrag', 'if-match': request.headers.get('if-match') || '*' },
      body, cache: 'no-store', redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(8000)]),
    });
    await upstream.body?.cancel();
    return new Response(null, { status: upstream.status, headers: contestLiveHeaders });
  } catch (error) {
    if (created) {
      await deleteLiveWebRtcResource(created.id, created.sessionId, created.channel).catch(() => {});
      await prisma.contestLiveConnection.deleteMany({ where: { id: created.id } }).catch(() => {});
    }
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 502);
  }
}

export { handle as POST, handle as PATCH, handle as DELETE };
