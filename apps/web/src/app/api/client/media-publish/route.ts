import { prisma } from '@/lib/db';
import { verifyClientTokenForSession } from '@/lib/client-auth';
import { createMediaPublishToken } from '@/lib/media-publish-token';
import { canPublishChannel } from '@/lib/media-publish-access';
import { liveChannels, mediaStreamPath, type LiveChannel } from '@/lib/media-read-token';
import { fail, ok, options, toErrorMessage } from '@/lib/http';

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const sessionId = params.get('sessionId') || '', channel = params.get('channel') || '';
    if (!liveChannels.includes(channel as LiveChannel) || !/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) return fail('推流参数不正确', 400);
    const session = await prisma.clientSession.findUnique({ where: { id: sessionId }, select: {
      id: true, examId: true, candidateId: true, status: true, revokedAt: true, desktopTokenHash: true, miniProgramTokenHash: true
    } });
    if (!session || !verifyClientTokenForSession(request, session, channel === 'MOBILE_CAMERA' ? 'MINIPROGRAM' : 'DESKTOP')) return fail('客户端会话令牌无效或已注销', 401);
    if (!await canPublishChannel(session, channel)) return fail('当前会话不允许该画面推流', 403);
    const base = process.env.MEDIA_RTMPS_PUBLIC_BASE;
    if (!base) return fail('管理员尚未配置加密媒体服务地址', 503);
    const url = new URL(base);
    if (url.protocol !== 'rtmps:' || url.username || url.password || url.search || url.hash || url.pathname !== '') {
      // URL normalizes an empty hierarchical path to '/', depending on the scheme.
      if (url.protocol !== 'rtmps:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) return fail('加密媒体服务地址配置不正确', 503);
    }
    const credential = createMediaPublishToken(session, channel as LiveChannel);
    url.pathname = mediaStreamPath(sessionId, channel);
    url.searchParams.set('token', credential.token);
    return ok({ ...credential, url: url.toString() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) { return fail(toErrorMessage(error), 500); }
}
export const OPTIONS = options;
