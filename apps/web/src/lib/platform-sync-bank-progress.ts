import { prisma } from './db';
import { platformTransaction } from './platform-sync-lock';
import type { PlatformItem } from './platform-sync-protocol';
import type { BankPayload } from './platform-sync-bank';

/** Diagnostic only. Native checks, never an upload marker, decide file readiness. */
export async function recordBankFileProgress(item: PlatformItem, missingFiles: number) {
  const payload = item.payload as unknown as BankPayload;
  const totalFiles = payload.data.length + payload.files.length;
  const key = `bank-progress:${item.id}`;
  const value = { hash: item.hash, revision: item.revision, writer: item.writer, totalFiles, missingFiles };
  await platformTransaction(tx => tx.systemSetting.upsert({ where: { key }, create: { key, value }, update: { value } }));
}

export async function readBankFileProgress() {
  const [row] = await prisma.$queryRaw<Array<{ pending: bigint; checked: bigint | null; files: bigint | null; missing: bigint | null }>>`
    SELECT COUNT(*) AS pending, SUM(p.\`key\` IS NOT NULL) AS checked,
      SUM(CASE WHEN p.\`key\` IS NOT NULL THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(p.value, '$.totalFiles')) AS UNSIGNED) ELSE 0 END) AS files,
      SUM(CASE WHEN p.\`key\` IS NOT NULL THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(p.value, '$.missingFiles')) AS UNSIGNED) ELSE 0 END) AS missing
    FROM PlatformSyncInbox i LEFT JOIN SystemSetting p ON p.\`key\` = CONCAT('bank-progress:', i.id)
      AND JSON_EXTRACT(p.value, '$.hash') = JSON_EXTRACT(i.snapshot, '$.hash')
      AND JSON_EXTRACT(p.value, '$.revision') = JSON_EXTRACT(i.snapshot, '$.revision')
      AND JSON_EXTRACT(p.value, '$.writer') = JSON_EXTRACT(i.snapshot, '$.writer')
    WHERE JSON_UNQUOTE(JSON_EXTRACT(i.snapshot, '$.kind')) = 'BANK'
      AND JSON_UNQUOTE(JSON_EXTRACT(i.snapshot, '$.deleted')) = 'false'`;
  const totalFiles = Number(row?.files ?? 0), missingFiles = Number(row?.missing ?? 0);
  return { pendingProblems: Number(row?.pending ?? 0), checkedProblems: Number(row?.checked ?? 0), totalFiles,
    readyFiles: Math.max(0, totalFiles - missingFiles) };
}
