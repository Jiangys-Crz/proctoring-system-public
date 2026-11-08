import { Prisma } from '@prisma/client';
import { appendItem, wireItem } from './platform-sync-store';
import { FederationError } from './exam-federation-protocol';

type Kind = 'CODE_SOURCE' | 'CODE_PAIR';
const table = (kind: Kind) => Prisma.raw(kind === 'CODE_SOURCE' ? 'CodeCheckSource' : 'CodeCheckPair');
export const codeReportErrorKey = (scope: string, kind: Kind, id: string) => `platform-code-error:${scope}:${kind}:${id}`;

/** Bodies are immutable, but associations may become available after an earlier capture. */
export async function changedCodeReportIds(tx: Prisma.TransactionClient, examId: string, scope: string, kind: Kind, target?: string) {
  const version = kind === 'CODE_PAIR' ? Prisma.sql` OR (item.deleted = false AND COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(item.payload, '$.versions')) AS UNSIGNED), 0) <> entry.versions)` : Prisma.empty;
  const candidateJoin = kind === 'CODE_SOURCE' ? Prisma.sql`LEFT JOIN Candidate candidate ON candidate.id = entry.candidateId` : Prisma.empty;
  // MySQL's JSON null unquotes to the text "null", not SQL NULL. Normalize
  // it before comparing optional keys or unchanged rows would fill every batch.
  const problemKey = Prisma.sql`IF(JSON_TYPE(JSON_EXTRACT(item.payload, '$.problemKey')) = 'NULL', NULL, JSON_UNQUOTE(JSON_EXTRACT(item.payload, '$.problemKey')))`;
  const candidateKey = Prisma.sql`IF(JSON_TYPE(JSON_EXTRACT(item.payload, '$.candidateKey')) = 'NULL', NULL, JSON_UNQUOTE(JSON_EXTRACT(item.payload, '$.candidateKey')))`;
  const candidateChanged = kind === 'CODE_SOURCE' ? Prisma.sql` OR NOT (${candidateKey} <=> candidate.syncKey)` : Prisma.empty;
  const associations = Prisma.sql` OR (item.deleted = false AND (NOT (${problemKey} <=> problem.syncKey) ${candidateChanged}))`;
  const size = kind === 'CODE_PAIR' ? Prisma.sql`OCTET_LENGTH(CAST(entry.matches AS CHAR CHARACTER SET utf8mb4))` : Prisma.sql`OCTET_LENGTH(entry.code)`;
  const delta = target ? Prisma.sql`entry.id = ${target}` : Prisma.sql`(item.id IS NULL ${version} ${associations})`;
  const lock = kind === 'CODE_PAIR' ? Prisma.sql`FOR UPDATE` : Prisma.empty;
  return tx.$queryRaw<Array<{ id: string; bytes: number | bigint }>>(Prisma.sql`SELECT entry.id, ${size} AS bytes FROM (
    SELECT entry.id, item.sequence, issue.updatedAt AS issueAt FROM ${table(kind)} AS entry
    JOIN CodeCheckJob AS job ON job.id = entry.jobId
    LEFT JOIN ExamProblem problem ON problem.id = entry.problemId ${candidateJoin}
    LEFT JOIN PlatformSyncItem AS item ON item.scope = ${scope} AND item.kind = ${kind} AND item.localId = entry.id
    LEFT JOIN SystemSetting AS issue ON issue.key = CONCAT('platform-code-error:', ${scope}, ':', ${kind}, ':', entry.id)
    WHERE job.examId = ${examId} AND ${delta}
    ORDER BY issue.updatedAt ASC, item.sequence ASC, entry.id ASC LIMIT 32
    ) selected JOIN ${table(kind)} entry ON entry.id = selected.id
    ORDER BY selected.issueAt ASC, selected.sequence ASC, selected.id ASC ${lock}`);
}
/** Read code/match bodies only after their aggregate allocation has been bounded. */
export async function boundedCodeReportIds(tx: Prisma.TransactionClient, scope: string, kind: Kind, rows: Array<{id:string;bytes:number|bigint}>, incoming = false) {
  const ids: string[] = []; let bytes = 0;
  for (const row of rows) {
    const size = Number(row.bytes) + 8192;
    // MySQL's text JSON contains structural whitespace. Admit one bounded
    // large row, then check its actual compact wire payload before publishing.
    if (!Number.isSafeInteger(size) || size > 32 * 1024 * 1024) {
      if (incoming) throw new FederationError('本机查重内容超过同步容量，已保留本机与远端记录等待处理');
      const key = codeReportErrorKey(scope, kind, row.id), value = { id: row.id, kind, error: '单条查重内容超过同步容量，原始报告已保留' };
      await tx.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
      continue;
    }
    if (ids.length && bytes + size > 16 * 1024 * 1024) break;
    bytes += size; ids.push(row.id);
  }
  return ids;
}
export async function captureCodeReportDeletions(tx: Prisma.TransactionClient, scope: string, kind: Kind, nodeId: string) {
  await tx.$executeRaw(Prisma.sql`DELETE issue FROM SystemSetting issue LEFT JOIN ${table(kind)} entry ON entry.id = JSON_UNQUOTE(JSON_EXTRACT(issue.value, '$.id'))
    WHERE issue.key LIKE ${`platform-code-error:${scope}:${kind}:%`} AND entry.id IS NULL`);
  const missing = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT item.id FROM PlatformSyncItem AS item
    LEFT JOIN ${table(kind)} AS entry ON entry.id = item.localId
    WHERE item.scope = ${scope} AND item.kind = ${kind} AND item.deleted = false AND item.localId IS NOT NULL AND entry.id IS NULL
    ORDER BY item.id ASC LIMIT 32`);
  let bytes = 0;
  for (const row of missing) {
    const old = await tx.platformSyncItem.findUniqueOrThrow({ where: { id: row.id } });
    const size = Buffer.byteLength(JSON.stringify(old.payload));
    if (bytes && bytes + size > 16 * 1024 * 1024) break;
    bytes += size;
    await appendItem(tx, { ...wireItem(old), deleted: true, writer: nodeId, revision: old.revision + 1 }, old.localId);
  }
}
