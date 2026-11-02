import { z } from 'zod';
import type { Prisma, User, VoiceCall } from '@prisma/client';
import { prisma } from './db';
import { AuthError, requireUser } from './auth';
import { canAccessCandidate } from './permissions';
import { verifyClientTokenForSession } from './client-auth';
import { isPublicTestExam } from './public-test';
import { effectiveEnd } from './contest-rules';
import { browserIceAnswer } from './browser-ice';
import { kickLiveWebRtc } from './live-webrtc';
import { createVoiceMediaToken, voiceStreamPath, type VoiceSide, type VoiceMode } from './voice-call-token';
import { fail, ok, parseBody, RequestParseError, toErrorMessage } from './http';

const Id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const Reason = z.enum(['HUNG_UP', 'CANCELLED', 'DECLINED', 'MICROPHONE', 'NETWORK', 'CLOSED']);
const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('START'), sessionId: Id, target: z.literal('DESKTOP').default('DESKTOP') }),
  z.object({ action: z.literal('POLL'), sessionId: Id.optional(), callId: Id.optional(), connected: z.boolean().default(false) }),
  z.object({ action: z.literal('ACCEPT'), callId: Id }),
  z.object({ action: z.literal('END'), callId: Id, reason: Reason.default('HUNG_UP') }),
  z.object({ action: z.literal('MEDIA_OPEN'), callId: Id, mode: z.enum(['publish', 'read']), sdp: z.string().max(65536) }),
  z.object({ action: z.literal('MEDIA_CLOSE'), callId: Id, resource: z.string().uuid() })
]);
type CallWithSession = Prisma.VoiceCallGetPayload<{ include: { session: { include: { exam: true; candidate: true } }; caller: true } }>;
type Actor = { side: VoiceSide; user?: User; request: Request };
const include = { session: { include: { exam: true, candidate: true } }, caller: true } as const;
const liveStatuses = ['APPROVED', 'IN_EXAM', 'LOCKED', 'OFFLINE'];
export const VOICE_RING_MS = 45_000;
export const VOICE_LEASE_MS = 20_000;

export function voiceCallEndReason(call: Pick<VoiceCall, 'status' | 'createdAt' | 'adminSeenAt' | 'desktopSeenAt' | 'acceptedAt'>, now = Date.now()) {
  if (call.status === 'ENDED') return null;
  if (now - +call.adminSeenAt > VOICE_LEASE_MS) return 'NETWORK';
  if (call.status === 'RINGING') return now - +call.createdAt > VOICE_RING_MS ? 'UNANSWERED' : null;
  if (!call.desktopSeenAt || now - +call.desktopSeenAt > VOICE_LEASE_MS) return 'NETWORK';
  if (call.status === 'CONNECTING' && (!call.acceptedAt || now - +call.acceptedAt > 30_000)) return 'NETWORK';
  return null;
}
function sessionEnded(call: CallWithSession, now = Date.now()) {
  const { session } = call;
  return Boolean(session.revokedAt || !liveStatuses.includes(session.status) || now > +effectiveEnd(session.exam, session.candidate.startedAt || session.startedAt));
}
function publicCall(call: CallWithSession | null) {
  if (!call) return null;
  return { id: call.id, sessionId: call.sessionId, target: 'DESKTOP' as const, status: call.status,
    callerName: call.caller.realName || call.caller.nickname || call.caller.username || '监考老师',
    createdAt: call.createdAt, acceptedAt: call.acceptedAt, startedAt: call.startedAt, endedAt: call.endedAt, endReason: call.endReason };
}
async function authorize(actor: Actor, call: CallWithSession) {
  if (actor.side === 'ADMIN') {
    if (actor.user?.id !== call.callerId || !await canAccessCandidate(actor.user, call.session.candidateId)) throw new AuthError('无权操作这次语音通话', 403);
  } else if (!verifyClientTokenForSession(actor.request, call.session, 'DESKTOP')) throw new AuthError('电脑客户端会话令牌无效或已过期', 401);
}
async function callWrite<T>(callId: string, operation: (tx: Prisma.TransactionClient, call: CallWithSession) => Promise<T>) {
  return prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM VoiceCall WHERE id = ${callId} FOR UPDATE`;
    const call = await tx.voiceCall.findUnique({ where: { id: callId }, include });
    if (!call) throw new AuthError('语音通话不存在', 404);
    return operation(tx, call);
  }, { isolationLevel: 'ReadCommitted' });
}
function endedData(reason: string) {
  return { status: 'ENDED' as const, endedAt: new Date(), endReason: reason, activeSessionId: null, activeCallerId: null };
}
async function cleanup(callId: string) {
  const rows = await prisma.voiceCallConnection.findMany({ where: { callId } });
  // Keep failed deletions in the database: the next poll/close retries them.
  await Promise.allSettled(rows.map(async row => {
    await kickLiveWebRtc(row.id);
    await prisma.voiceCallConnection.deleteMany({ where: { id: row.id, callId } });
  }));
}
async function expire(call: CallWithSession) {
  if (call.status === 'ENDED') return call;
  const reason = sessionEnded(call) ? 'SESSION_ENDED' : call.caller.status !== 'ACTIVE' ? 'CLOSED' : voiceCallEndReason(call);
  if (!reason) return call;
  const ended = await callWrite(call.id, async (tx, fresh) => {
    const current = sessionEnded(fresh) ? 'SESSION_ENDED' : fresh.caller.status !== 'ACTIVE' ? 'CLOSED' : voiceCallEndReason(fresh);
    return current && fresh.status !== 'ENDED' ? tx.voiceCall.update({ where: { id: call.id }, data: endedData(current), include }) : fresh;
  });
  if (ended.status === 'ENDED') await cleanup(call.id);
  return ended;
}
async function start(actor: Actor, sessionId: string) {
  if (actor.side !== 'ADMIN' || !actor.user) throw new AuthError('只有监考老师可以发起通话', 403);
  const user = actor.user;
  const session = await prisma.clientSession.findUnique({ where: { id: sessionId }, include: { exam: true, candidate: true } });
  if (!session || !await canAccessCandidate(user, session.candidateId)) throw new AuthError('无权呼叫该考生', 403);
  if (session.revokedAt || !liveStatuses.includes(session.status) || !session.desktopTokenHash) throw new AuthError('电脑客户端未登录或考试已结束', 409);
  const now = Date.now();
  if (now < +session.exam.startAt || now > +effectiveEnd(session.exam, session.candidate.startedAt || session.startedAt)) throw new AuthError('当前不在考试时间内，不能进行语音通话', 409);
  if (await isPublicTestExam(session.examId)) throw new AuthError('环境测试不支持语音通话', 403);
  const previous = await prisma.voiceCall.findMany({ where: { OR: [{ activeCallerId: user.id }, { activeSessionId: sessionId }] }, include });
  for (const call of previous) if ((await expire(call)).status !== 'ENDED') throw new AuthError('你或该考生正在另一通电话中，请先挂断', 409);
  try {
    return await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM User WHERE id = ${user.id} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM ClientSession WHERE id = ${sessionId} FOR UPDATE`;
      const fresh = await tx.clientSession.findUnique({ where: { id: sessionId } });
      if (!fresh || fresh.revokedAt || !liveStatuses.includes(fresh.status) || fresh.desktopTokenHash !== session.desktopTokenHash) throw new AuthError('电脑客户端会话已改变，请刷新后重试', 409);
      if (await tx.voiceCall.count({ where: { OR: [{ activeCallerId: user.id }, { activeSessionId: sessionId }] } })) throw new AuthError('你或该考生正在另一通电话中，请先挂断', 409);
      return tx.voiceCall.create({ data: { sessionId, callerId: user.id, activeCallerId: user.id, activeSessionId: sessionId }, include });
    }, { isolationLevel: 'ReadCommitted' });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') throw new AuthError('你或该考生正在另一通电话中，请先挂断', 409);
    throw error;
  }
}
async function poll(actor: Actor, input: Extract<z.infer<typeof Input>, { action: 'POLL' }>) {
  let call: CallWithSession | null;
  if (input.callId) call = await prisma.voiceCall.findUnique({ where: { id: input.callId }, include });
  else if (actor.side === 'DESKTOP' && input.sessionId) {
    const session = await prisma.clientSession.findUnique({ where: { id: input.sessionId } });
    if (!session || !verifyClientTokenForSession(actor.request, session, 'DESKTOP')) throw new AuthError('电脑客户端会话令牌无效或已过期', 401);
    call = await prisma.voiceCall.findUnique({ where: { activeSessionId: session.id }, include });
  } else throw new AuthError('缺少语音通话编号', 400);
  if (!call) return null;
  await authorize(actor, call);
  call = await expire(call);
  if (call.status === 'ENDED') { await cleanup(call.id); return call; }
  return callWrite(call.id, async (tx, fresh) => {
    if (fresh.status === 'ENDED') return fresh;
    const side = actor.side;
    const adminConnected = fresh.adminConnected || side === 'ADMIN' && input.connected && fresh.status !== 'RINGING';
    const desktopConnected = fresh.desktopConnected || side === 'DESKTOP' && input.connected && fresh.status !== 'RINGING';
    const active = adminConnected && desktopConnected;
    return tx.voiceCall.update({ where: { id: call!.id }, data: {
      ...(side === 'ADMIN' ? { adminSeenAt: new Date() } : { desktopSeenAt: new Date() }), adminConnected, desktopConnected,
      ...(active && fresh.status !== 'ACTIVE' ? { status: 'ACTIVE', startedAt: new Date() } : {})
    }, include });
  });
}
function mediaBase() { return (process.env.MEDIA_WHIP_INTERNAL_BASE || 'http://127.0.0.1:8889').replace(/\/+$/, ''); }
export function voiceResource(location: string, base: string, path: string, mode: VoiceMode) {
  const url = new URL(location, base), prefix = `${path}/${mode === 'publish' ? 'whip' : 'whep'}/`;
  const resource = url.pathname.slice(prefix.length);
  if (url.origin !== new URL(base).origin || !url.pathname.startsWith(prefix) || !z.string().uuid().safeParse(resource).success || url.search || url.hash || url.username || url.password) throw new Error('媒体服务返回无效语音连接');
  return resource;
}
async function openMedia(actor: Actor, call: CallWithSession, mode: VoiceMode, sdp: string) {
  if (!['CONNECTING', 'ACTIVE'].includes(call.status)) throw new AuthError('对方尚未接听或通话已经结束', 409);
  if (!sdp.startsWith('v=0') || !/^m=audio\s/m.test(sdp) || /^m=video\s/m.test(sdp)) throw new AuthError('语音通话只允许音频协商', 400);
  if (await prisma.voiceCallConnection.findUnique({ where: { callId_side_mode: { callId: call.id, side: actor.side, mode } } })) throw new AuthError('该语音连接已建立，请重新拨号', 409);
  const path = voiceStreamPath(call.id, actor.side, mode), base = mediaBase();
  const credential = actor.side === 'ADMIN' ? call.callerId : call.session.desktopTokenHash!;
  const token = createVoiceMediaToken(call.id, actor.side, mode, credential);
  const upstream = await fetch(`${base}${path}/${mode === 'publish' ? 'whip' : 'whep'}`, { method: 'POST',
    headers: { 'content-type': 'application/sdp', authorization: `Bearer ${token}` }, body: sdp, cache: 'no-store', signal: AbortSignal.timeout(12_000) });
  if (!upstream.ok) {
    if (mode === 'read' && [404, 503].includes(upstream.status)) return { ready: false };
    throw new AuthError('实时语音连接失败，请检查媒体服务后重新拨号', 502);
  }
  let resource: string | undefined, secret: string | undefined;
  try {
    secret = voiceResource(upstream.headers.get('location') || '', base, path, mode);
    // Location contains the WHIP/WHEP session secret. The control API uses a
    // different UUID returned in ID; confusing them silently fails to hang up.
    const id = upstream.headers.get('id');
    if (!z.string().uuid().safeParse(id).success) throw new Error('媒体服务未返回有效的语音会话编号');
    resource = id!;
    const answer = browserIceAnswer(await upstream.text());
    await callWrite(call.id, async (tx, fresh) => {
      if (!['CONNECTING', 'ACTIVE'].includes(fresh.status) || sessionEnded(fresh) || voiceCallEndReason(fresh)) throw new AuthError('通话已经结束', 409);
      if (actor.side === 'DESKTOP' && fresh.session.desktopTokenHash !== call.session.desktopTokenHash) throw new AuthError('电脑客户端会话已改变', 401);
      await tx.voiceCallConnection.create({ data: { id: resource!, callId: call.id, side: actor.side, mode } });
    });
    return { ready: true, sdp: answer, resource };
  } catch (error) {
    if (resource) await kickLiveWebRtc(resource).catch(() => {});
    else if (secret) await fetch(`${base}${path}/${mode === 'publish' ? 'whip' : 'whep'}/${secret}`, { method: 'DELETE', signal: AbortSignal.timeout(8000) }).catch(() => {});
    throw error;
  }
}
export async function serveVoiceCall(request: Request, side: VoiceSide) {
  try {
    const actor: Actor = { request, side, ...(side === 'ADMIN' ? { user: await requireUser(request) } : {}) };
    const input = await parseBody(request, Input, 96 * 1024);
    if (input.action === 'START') return ok({ call: publicCall(await start(actor, input.sessionId)) }, { status: 201 });
    if (input.action === 'POLL') return ok({ call: publicCall(await poll(actor, input)) }, { headers: { 'cache-control': 'private, no-store' } });
    let call = await prisma.voiceCall.findUnique({ where: { id: input.callId }, include });
    if (!call) throw new AuthError('语音通话不存在', 404);
    await authorize(actor, call);
    call = await expire(call);
    if (input.action === 'MEDIA_CLOSE') {
      const connection = await prisma.voiceCallConnection.findUnique({ where: { id: input.resource } });
      if (connection && (connection.callId !== call.id || connection.side !== side)) throw new AuthError('无权关闭该语音连接', 403);
      if (connection) { await kickLiveWebRtc(connection.id); await prisma.voiceCallConnection.deleteMany({ where: { id: connection.id, callId: call.id } }); }
      return ok({ closed: true });
    }
    if (input.action === 'MEDIA_OPEN') return ok(await openMedia(actor, call, input.mode, input.sdp));
    call = await callWrite(call.id, async (tx, fresh) => {
      if (input.action === 'END') return fresh.status === 'ENDED' ? fresh : tx.voiceCall.update({ where: { id: fresh.id }, data: endedData(input.reason), include });
      if (side !== 'DESKTOP') throw new AuthError('只有电脑客户端可以接听', 403);
      if (fresh.status !== 'RINGING') throw new AuthError('来电已经结束或已经接听', 409);
      return tx.voiceCall.update({ where: { id: fresh.id }, data: { status: 'CONNECTING', acceptedAt: new Date(), desktopSeenAt: new Date() }, include });
    });
    if (call.status === 'ENDED') await cleanup(call.id);
    return ok({ call: publicCall(call) });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

const cleanupState = globalThis as typeof globalThis & { voiceCallCleanupTimer?: ReturnType<typeof setInterval>; voiceCallCleanupBusy?: boolean };
export function startVoiceCallCleanup() {
  if (cleanupState.voiceCallCleanupTimer) return;
  cleanupState.voiceCallCleanupTimer = setInterval(() => {
    if (cleanupState.voiceCallCleanupBusy) return;
    cleanupState.voiceCallCleanupBusy = true;
    void (async () => {
      const now = Date.now();
      const rows = await prisma.voiceCall.findMany({ where: { OR: [
        { status: { in: ['RINGING', 'CONNECTING', 'ACTIVE'] }, adminSeenAt: { lt: new Date(now - VOICE_LEASE_MS) } },
        { status: { in: ['CONNECTING', 'ACTIVE'] }, desktopSeenAt: { lt: new Date(now - VOICE_LEASE_MS) } },
        { status: 'RINGING', createdAt: { lt: new Date(now - VOICE_RING_MS) } },
        { status: 'CONNECTING', acceptedAt: { lt: new Date(now - 30000) } },
        { status: 'ENDED', connections: { some: {} } }
      ] }, include, take: 32, orderBy: { updatedAt: 'asc' } });
      for (let offset = 0; offset < rows.length; offset += 4) await Promise.allSettled(rows.slice(offset, offset + 4).map(async call => {
        const fresh = await expire(call);
        if (fresh.status === 'ENDED') await cleanup(call.id);
      }));
    })().catch(error => console.error('Voice call cleanup failed', error)).finally(() => { cleanupState.voiceCallCleanupBusy = false; });
  }, 5000);
  cleanupState.voiceCallCleanupTimer.unref?.();
}
