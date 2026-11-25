import type { Exam, Prisma, ReactionConfig } from '@prisma/client';
import { prisma } from './db';
import { eventHash, readNdjson, type CcsEvent } from './reaction-domain';
import { acceptReactionEvent } from './reaction-events';
import { sameReactionSource } from './reaction-source';
import { hydroCcsConnection } from './reaction-hydro-credentials';

type ConfiguredExam = Exam & { reactionConfig: ReactionConfig | null };
// The independent addon has its own log. Keep embedded-addon cursors for audit,
// but bootstrap this source separately; recording IDs still deduplicate replay.
const cursorKey = { type: 'hydro-ccs-cursor', remoteId: 'standalone-v1' };

export function normalizeHydroCcsEvent(event: CcsEvent, contestId: string): CcsEvent | null {
  if (!event || typeof event.type !== 'string' || typeof event.token !== 'string' || !/^[a-f\d]{24}\.[1-9]\d*\.\d+$/.test(event.token)) throw new Error('HYDRO_CCS_INVALID_EVENT');
  const type = event.type === 'contest' ? 'contests' : event.type;
  if (!['contests', 'teams', 'problems', 'submissions', 'judgements'].includes(type)) return null;
  if (event.data === null) {
    if (type !== 'contests' && (typeof event.id !== 'string' || !event.id)) throw new Error('HYDRO_CCS_INVALID_EVENT');
    return { type, op: 'delete', data: { id: event.id || contestId } };
  }
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.id !== 'string') throw new Error('HYDRO_CCS_INVALID_EVENT');
  if (type !== 'contests' && event.id !== data.id) throw new Error('HYDRO_CCS_INVALID_EVENT');
  if (type === 'contests' && data.id.toLowerCase() !== contestId.toLowerCase()) throw new Error('REACTION_SOURCE_CHANGED');
  if (type === 'teams') {
    if (typeof data.x_hydro_username !== 'string' || !data.x_hydro_username) return null;
    return { type, data: { ...data, id: data.x_hydro_username, x_hydro_team_id: data.id } };
  }
  if (type === 'submissions') {
    if (typeof data.x_hydro_username !== 'string') throw new Error('HYDRO_CCS_INVALID_EVENT');
    return { type, data: { ...data, team_id: data.x_hydro_username || `unmapped-${data.team_id}`, x_hydro_team_id: data.team_id } };
  }
  if (type === 'judgements' && data.x_hydro_rank) {
    const context = data.x_hydro_rank as { provenance?: { eventToken?: string } };
    if (context.provenance?.eventToken !== event.token) throw new Error('HYDRO_CCS_INVALID_EVENT');
  }
  return { type, data };
}

export async function consumeHydroCcsFeed(exam: ConfiguredExam, signal: AbortSignal, connected: () => Promise<void>) {
  const { base, contestId, apiKey } = hydroCcsConnection(exam);
  const cursor = await prisma.reactionEvent.findUnique({ where: { examId_type_remoteId: { examId: exam.id, ...cursorKey } } });
  const source = eventHash({ base, contestId, protocol: 'hydro-ccs-api-v1' });
  const payload = cursor?.payload as { token?: string; source?: string } | null;
  const token = payload?.source === source ? payload.token : null;
  const query = new URLSearchParams({ stream: 'true', ...(token ? { since_token: token } : {}) });
  const request = () => fetch(`${base}/api/ccs/contests/${contestId}/event-feed?${query}`, {
    headers: { accept: 'application/x-ndjson', 'x-ccs-api-key': apiKey }, cache: 'no-store', redirect: 'error', credentials: 'omit',
    signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
  });
  let response = await request();
  if (response.status === 400 && token) {
    // CCS specifies 400 for an expired/invalid resume token. Rebootstrap via
    // the authenticated feed; existing business checkpoints still deduplicate.
    await response.body?.cancel();
    query.delete('since_token');
    response = await request();
  }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`HYDRO_HTTP_${response.status}`); }
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) { await response.body.cancel(); throw new Error('HYDRO_CCS_INVALID_EVENT'); }
  try { await connected(); } catch (error) { await response.body.cancel(); throw error; }
  for await (const event of readNdjson(response.body)) {
    signal.throwIfAborted();
    const normalized = normalizeHydroCcsEvent(event, exam.platformContestId);
    if (event.type === 'teams') {
      // Retire aliases for this CCS team only. A member may already have moved
      // to another team; username renames arrive as an old-ID delete + new ID.
      const aliases = await prisma.reactionEvent.findMany({ where: { examId: exam.id, type: 'teams',
        payload: { path: '$.x_hydro_team_id', equals: event.id! } } });
      const usernames = event.data ? [...new Set([event.data.x_hydro_username,
        ...(Array.isArray(event.data.x_hydro_usernames) ? event.data.x_hydro_usernames : [])]
        .filter((name): name is string => typeof name === 'string' && Boolean(name)))] : [];
      for (const alias of aliases) if (!usernames.includes(alias.remoteId)) {
        await acceptReactionEvent(exam, { type: 'teams', op: 'delete', data: { id: alias.remoteId, x_hydro_team_id: event.id } });
      }
      for (const username of usernames) await acceptReactionEvent(exam, { type: 'teams', data: { ...event.data!, id: username, x_hydro_team_id: event.id } });
    } else if (normalized) await acceptReactionEvent(exam, normalized);
    // Check the cutover under the exam lock before advancing. A stale feed
    // cannot swallow submissions from a disable/re-enable or lease takeover.
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${exam.id} FOR UPDATE`;
      const current = await tx.exam.findUniqueOrThrow({ where: { id: exam.id }, include: { reactionConfig: true } });
      if (!current.reactionEnabled || !sameReactionSource(current, exam)
        || +current.reactionConfig?.initializedAt! !== +exam.reactionConfig?.initializedAt!
        || current.reactionConfig?.leaseToken !== exam.reactionConfig?.leaseToken) throw new Error('REACTION_SOURCE_CHANGED');
      const data = { token: event.token, source } as Prisma.InputJsonValue;
      await tx.reactionEvent.upsert({ where: { examId_type_remoteId: { examId: exam.id, ...cursorKey } },
        create: { examId: exam.id, ...cursorKey, payload: data, payloadHash: eventHash(data) }, update: { payload: data, payloadHash: eventHash(data), observedAt: new Date() } });
    });
  }
  if (!signal.aborted) throw new Error('HYDRO_CCS_STREAM_CLOSED');
}
