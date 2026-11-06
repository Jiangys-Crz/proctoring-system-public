/** Explicit historical reconstruction. NovaJudge proof is read-only input;
 * only missing/unavailable Reaction rankContext is updated with --apply.
 */
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { parseReactionRankContext, reconstructHistoricalReactionRankContext, type NovaJudgeHistoricalRankProof } from '../src/lib/reaction-ranking';

const [examId, proofFile, idsText, outputDirectory, flag] = process.argv.slice(2);
assert(examId && proofFile && idsText && outputDirectory && (!flag || flag === '--apply'), 'Usage: reaction-rank-backfill.ts examId proof.json submissionIdsCsv outputDirectory [--apply]');
assert(['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL || '').hostname), 'Local database only');
const ids = idsText.split(',');
try {
  const proof = JSON.parse(await fs.readFile(path.resolve(proofFile), 'utf8')) as NovaJudgeHistoricalRankProof;
  const exam = await prisma.exam.findUniqueOrThrow({ where: { id: examId } });
  assert(exam.platform === 'NOVAJUDGE' && exam.platformContestId === String(proof.contest.id), 'Exact contest mapping required');
  const rows = await prisma.reaction.findMany({ where: { examId }, orderBy: { sourceSubmittedAt: 'asc' } });
  assert(ids.every(id => rows.some(row => row.submissionId === id)), 'Every requested submission must belong to this exam');
  const results = [];
  for (const row of rows.filter(value => ids.includes(value.submissionId))) {
    const existing = parseReactionRankContext(row.rankContext);
    const context = existing?.status === 'AVAILABLE' ? existing : reconstructHistoricalReactionRankContext(proof, rows, row);
    if (flag === '--apply' && context.status === 'AVAILABLE' && existing?.status !== 'AVAILABLE') {
      await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${examId} FOR UPDATE`;
        const current = await tx.reaction.findUniqueOrThrow({ where: { id: row.id } });
        assert(current.originalVerdict === row.originalVerdict && +current.judgementObservedAt! === +row.judgementObservedAt!, 'Original recording changed while reconstructing');
        if (parseReactionRankContext(current.rankContext)?.status !== 'AVAILABLE') {
          await tx.reaction.update({ where: { id: row.id }, data: { rankContext: context as unknown as Prisma.InputJsonValue } });
        }
      });
    }
    results.push({ reactionId: row.id, submissionId: row.submissionId, originalVerdict: row.originalVerdict, applied: flag === '--apply' && context.status === 'AVAILABLE', rankContext: context });
  }
  const output = path.resolve(outputDirectory); await fs.mkdir(output, { recursive: true });
  await fs.writeFile(path.join(output, 'novajudge-rank-proof.json'), JSON.stringify(proof, null, 2));
  await fs.writeFile(path.join(output, 'rank-contexts.json'), JSON.stringify({ examId, reconstructionRunAt: new Date().toISOString(), results }, null, 2));
  console.log(JSON.stringify({ examId, output, results: results.map(result => ({ submissionId: result.submissionId, status: result.rankContext.status, beforeRank: result.rankContext.beforeRank, afterRank: result.rankContext.afterRank, source: result.rankContext.source, reason: result.rankContext.reason || null, applied: result.applied })) }, null, 2));
} finally { await prisma.$disconnect(); }
