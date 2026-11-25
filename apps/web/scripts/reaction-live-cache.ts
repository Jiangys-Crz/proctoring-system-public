// Bridge completed MediaMTX recordings into the existing Reaction capture queue.
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../src/lib/db';
import { runMedia } from '../src/lib/reaction-media';
import { reactionStoredBytes } from '../src/lib/reaction-storage-budget';
import { getStorageSettings } from '../src/lib/settings';
import { storeBuffer } from '../src/lib/storage';
import { withMediaSegmentWrite } from '../src/lib/media-segment-write';

const [examId, cacheRoot] = process.argv.slice(2);
if (!examId || !cacheRoot || !path.isAbsolute(cacheRoot)) throw new Error('Usage: reaction-live-cache <examId> <absolute MediaMTX live directory>');

function fragmentStart(filename: string) {
  const match = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-(\d{6})_Z\.mp4$/.exec(filename);
  if (!match) return NaN;
  return Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5].slice(0, 3)}Z`);
}

async function bridge() {
  const now = new Date();
  const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId }, include: { reactionConfig: true } });
  if (exam.recordingsDeletedAt || !exam.reactionEnabled || !exam.reactionConfig || +now > +exam.endAt + 15 * 60_000) return false;
  const config = exam.reactionConfig;
  const rows = await prisma.reaction.findMany({
    where: {
      examId, candidateId: { not: null }, desktopPath: null, cameraPath: null, reactionPath: null,
      windowEnd: { gt: new Date(+now - 25 * 60_000), lt: new Date(+now - Math.max(35, config.uploadGraceSeconds - 10) * 1000) },
      status: { in: ['TAIL', 'MISSING'] }, generationStatus: 'IDLE', expiresAt: { gt: now },
    },
    orderBy: { windowEnd: 'asc' },
  });
  if (!rows.length) return true;
  const sessions = await prisma.clientSession.findMany({ where: { examId }, select: { id: true, candidateId: true } });
  const storage = await getStorageSettings();
  if (storage.provider !== 'LOCAL') throw new Error('The live cache bridge requires local storage');
  let imported = 0;
  for (const row of rows) {
    if (!row.windowEnd || !row.candidateId) continue;
    const startedAt = row.windowStart, endedAt = row.windowEnd;
    const hasScreen = await prisma.mediaSegment.count({ where: {
      examId, candidateId: row.candidateId, channel: 'DESKTOP_SCREEN', deletedAt: null,
      startedAt: { lt: endedAt }, endedAt: { gt: startedAt },
    } });
    if (hasScreen) continue;
    for (const session of sessions.filter(s => s.candidateId === row.candidateId && /^c[a-z0-9]+$/.test(s.id))) {
      const directory = path.join(cacheRoot, `${session.id}_DESKTOP_SCREEN`);
      const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      });
      const files = entries.map(filename => ({ filename, start: fragmentStart(filename) }))
        .filter(file => Number.isFinite(file.start)).sort((a, b) => a.start - b.start);
      const fragments: { id: string; prefix: string; filename: string; buffer: Buffer; start: Date; end: Date; duration: number }[] = [];
      // A following fragment proves MediaMTX closed this one.
      for (const [index, file] of files.slice(0, -1).entries()) {
        if (file.start >= +endedAt || files[index + 1].start <= +startedAt || file.start < +startedAt - 120_000) continue;
        const sourcePath = path.join(directory, file.filename);
        const info = await stat(sourcePath).catch(() => null);
        if (!info?.isFile() || !info.size || info.size > 80 * 1024 * 1024) continue;
        // Probe by filename, so FFprobe can seek through all fMP4 fragments.
        const probe = JSON.parse(await runMedia(process.env.FFPROBE_PATH || 'ffprobe', [
          '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=start_time,duration,codec_type', '-of', 'json', sourcePath,
        ], 8000).catch(() => '{}'));
        const video = probe.streams?.[0];
        const duration = Number(video?.duration);
        if (video?.codec_type !== 'video' || !Number.isFinite(duration) || duration <= 0 || duration > 120) continue;
        const start = new Date(file.start + Math.max(0, Number(video.start_time) || 0) * 1000);
        const end = new Date(+start + duration * 1000);
        if (+start >= +endedAt || +end <= +startedAt) continue;
        const id = 'live_' + createHash('sha256').update(`${session.id}/${file.filename}`).digest('hex');
        const prefix = `${examId}/${row.candidateId}`;
        const filename = `${id}.mp4`;
        const buffer = await readFile(sourcePath).catch(() => null);
        if (!buffer || buffer.length !== info.size) continue;
        fragments.push({ id, prefix, filename, buffer, start, end, duration });
      }
      if (!fragments.length) continue;
      imported += await withMediaSegmentWrite(async tx => {
        await tx.$queryRaw`SELECT id FROM Exam WHERE id=${examId} FOR UPDATE`;
        const current = await tx.exam.findUniqueOrThrow({ where: { id: examId }, include: { reactionConfig: true } });
        const active = await tx.reaction.findUniqueOrThrow({ where: { id: row.id } });
        if (!current.reactionEnabled || current.recordingsDeletedAt || !current.reactionConfig || !active.expiresAt || active.expiresAt <= now
          || active.desktopPath || active.cameraPath || active.reactionPath || active.generationStatus !== 'IDLE'
          || !['TAIL', 'MISSING'].includes(active.status) || +active.windowEnd! !== +endedAt || +active.windowStart !== +startedAt) return 0;
        let used = await reactionStoredBytes(tx, examId);
        let count = 0;
        let links = 0;
        for (const { id, filename, prefix, buffer, start, end, duration } of fragments) {
          const previous = await tx.mediaSegment.findUnique({ where: { id } });
          if (previous?.deletedAt) continue;
          if (!previous) {
            if (used + BigInt(buffer.length) > current.reactionConfig.maxStorageBytes) break;
            const object = await storeBuffer(buffer, { filename, prefix, contentType: 'video/mp4', stableName: true, immutable: true }, storage);
            await tx.mediaSegment.create({ data: {
              id, examId, candidateId: row.candidateId, sessionId: session.id, channel: 'DESKTOP_SCREEN',
              objectPath: object.objectPath, startedAt: start, endedAt: end, durationSeconds: duration, byteSize: buffer.length,
              reactionCache: true,
              // The filename is the stream's wall clock. Keep uncertainty explicit.
              clockOffsetMs: null, clockUncertaintyMs: null,
            } });
            used += BigInt(buffer.length);
            count++;
          }
          links += (await tx.reactionSegment.createMany({ data: [{ reactionId: row.id, segmentId: id }], skipDuplicates: true })).count;
        }
        if (links && active.status === 'MISSING') {
          await tx.reaction.updateMany({ where: { id: row.id, status: 'MISSING' }, data: { status: 'TAIL', error: null } });
        }
        return count;
      });
    }
  }
  if (imported) console.log(`[reaction live cache] imported ${imported} desktop fragments`);
  return true;
}

try {
  for (;;) {
    try { if (!await bridge()) break; }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : 'ERROR';
      console.error('[reaction live cache] will retry', code);
    }
    await new Promise(resolve => setTimeout(resolve, 6000));
  }
} finally {
  await prisma.$disconnect();
}
