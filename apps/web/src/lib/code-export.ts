import { Readable } from 'node:stream';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { ZipFile } from 'yazl';
import { prisma } from './db';
import { problemLabel } from './contest-rules';
import { createRequestAdmission } from './request-admission';
import { nodeReadableBody } from './node-readable-body';

const shared = globalThis as typeof globalThis & { codeExportAdmission?: ReturnType<typeof createRequestAdmission> };
export const acquireCodeExport = shared.codeExportAdmission ??= createRequestAdmission(1, 2, 5000);
const PAGE_SIZE = 128;
const CODE_CHARACTERS = 32768;
function safeName(value: string) {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 80) || '未命名';
}
function codeExtension(lang: string) {
  const value = lang.toLowerCase();
  if (value === 'c' || value.startsWith('c.')) return 'c';
  if (value.includes('cpp') || value.startsWith('cc.') || value === 'cc') return 'cpp';
  if (value.includes('python') || value.startsWith('py.')) return 'py';
  if (value.startsWith('java')) return 'java';
  return 'txt';
}
const csvCell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`;
type Entry = { id: string; path: string; createdAt: Date };
type Prepared = { examId: string; entries: Entry[]; manifest: string[] };

/** Fixed creation-time ceiling and keyset pages; no code or judge details. */
export async function prepareCodeExport(examId: string, signal: AbortSignal): Promise<Prepared> {
  const prepared: Prepared = { examId, entries: [], manifest: [] };
  const until = new Date();
  let after: { createdAt: Date; id: string } | undefined;
  for (;;) {
    signal.throwIfAborted();
    const rows = await prisma.contestSubmission.findMany({
      where: { examId, createdAt: { lte: until }, problem: { problemType: { notIn: ['objective', 'submit_answer'] } },
        ...(after ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] } : {}),
      },
      select: { id: true, lang: true, status: true, statusText: true, score: true, createdAt: true,
        candidate: { select: { examNumber: true, name: true, teamName: true } },
        problem: { select: { order: true, title: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: PAGE_SIZE,
    });
    signal.throwIfAborted();
    for (const row of rows) {
      const owner = row.candidate.teamName || row.candidate.name || row.candidate.examNumber;
      const problem = `${problemLabel(row.problem.order)}-${row.problem.title}`;
      const stamp = row.createdAt.toISOString().replace(/[:.]/g, '-');
      // An ordinal prevents path collisions; the CSV keeps the complete ID.
      const path = `${safeName(`${row.candidate.examNumber}-${owner}`)}/${safeName(problem)}/${stamp}-${prepared.entries.length + 1}-${safeName(row.id.slice(-32))}.${codeExtension(row.lang)}`;
      prepared.entries.push({ id: row.id, path, createdAt: row.createdAt });
      prepared.manifest.push([row.id, row.candidate.examNumber, owner, problem, row.lang,
        row.statusText || row.status, row.score, row.createdAt.toISOString(), path].map(csvCell).join(','));
    }
    if (rows.length < PAGE_SIZE) break;
    const last = rows.at(-1)!;
    after = { createdAt: last.createdAt, id: last.id };
  }
  return prepared;
}

/** ZIP directory metadata/CSV still grow with record count. Code and the
 * compressed response are streamed; even old large code uses bounded slices. */
export function streamCodeExport(prepared: Prepared, exam: { name: string; examCode: string }, signal: AbortSignal, release: () => void) {
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  const active = new Set<Readable>();
  let stopped = false, closed = false, pendingReads = 0, released = false;
  const finish = () => {
    // Prisma reads cannot be canceled. Keep the slot until late reads settle.
    if (closed && !pendingReads && !released) { released = true; release(); }
  };
  const abort = () => output.destroy(new Error('代码导出已取消或超时'));
  const stop = () => {
    if (stopped) return;
    stopped = true; closed = true;
    signal.removeEventListener('abort', abort);
    for (const source of active) source.destroy();
    active.clear();
    prepared.entries.length = 0; prepared.manifest.length = 0;
    finish();
  };
  output.once('close', stop);
  zip.on('error', () => output.destroy(new Error('代码导出源数据读取失败，请重试')));
  const body = nodeReadableBody(output);
  signal.addEventListener('abort', abort, { once: true });

  async function* code(id: string) {
    let offset = 1;
    for (;;) {
      if (stopped) return;
      signal.throwIfAborted();
      pendingReads++;
      let rows: Array<{ part: string; charCount: number | bigint }>;
      try {
        rows = await prisma.$queryRaw<Array<{ part: string; charCount: number | bigint }>>`SELECT
          SUBSTRING(code, ${offset}, ${CODE_CHARACTERS}) AS part,
          CHAR_LENGTH(SUBSTRING(code, ${offset}, ${CODE_CHARACTERS})) AS charCount
          FROM ContestSubmission WHERE id = ${id} AND examId = ${prepared.examId}`;
      } finally { pendingReads--; finish(); }
      if (stopped) return;
      signal.throwIfAborted();
      if (!rows[0] || typeof rows[0].part !== 'string') throw new Error('导出期间记录已删除或改变，请重试');
      const characters = Number(rows[0].charCount);
      if (!Number.isSafeInteger(characters) || characters < 0 || characters > CODE_CHARACTERS) throw new Error('代码导出源数据无效');
      if (characters) yield Buffer.from(rows[0].part, 'utf8');
      if (characters < CODE_CHARACTERS) return;
      offset += characters;
    }
  }
  const addSource = (path: string, open: () => Readable, mtime?: Date) => {
    zip.addReadStreamLazy(path, { compressionLevel: 1, mtime }, callback => {
      const done = callback as (error: Error | null, source?: Readable) => void;
      if (stopped || signal.aborted) return done(new Error('代码导出已取消或超时'));
      try {
        const source = open();
        source.on('error', () => output.destroy(new Error('代码导出源数据读取失败，请重试')));
        source.once('end', () => active.delete(source));
        source.once('close', () => {
          active.delete(source);
          if (!stopped && !source.readableEnded) output.destroy(new Error('代码导出已中断，请重试'));
        });
        active.add(source);
        done(null, source);
      } catch { done(new Error('代码导出源数据读取失败，请重试')); }
    });
  };
  const enqueue = async () => {
    const count = prepared.entries.length;
    let added = 0;
    for (const entry of prepared.entries) {
      if (stopped) return;
      signal.throwIfAborted();
      addSource(entry.path, () => Readable.from(code(entry.id), { objectMode: false, highWaterMark: 64 * 1024 }), entry.createdAt);
      // Registration is CPU work too. Do not block login/heartbeat handling
      // while registering a large archive's directory in one synchronous loop.
      if (++added % PAGE_SIZE === 0) await yieldTurn();
    }
    if (stopped) return;
    signal.throwIfAborted();
    addSource('提交清单.csv', () => Readable.from((function* () {
      yield Buffer.from('\uFEFF' + ['提交编号', '考号', '考生或队伍', '题目', '语言', '状态', '分数', '提交时间', '文件'].map(csvCell).join(','));
      for (const line of prepared.manifest) {
        if (stopped) return;
        yield Buffer.from('\n' + line, 'utf8');
      }
    })(), { objectMode: false, highWaterMark: 64 * 1024 }));
    zip.addBuffer(Buffer.from(`${exam.name}\n考试编号：${exam.examCode}\n代码递交：${count} 份\n客观题答卷不会包含在代码导出中。`), '说明.txt', { compress: false });
    zip.end();
  };
  void enqueue().catch(() => output.destroy(new Error('代码导出源数据读取失败，请重试')));
  if (signal.aborted) abort();
  return body;
}
