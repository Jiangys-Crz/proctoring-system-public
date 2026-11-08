import { Prisma } from '@prisma/client';
import { prisma } from './db';

const prefixes = ['platform-image-error:', 'platform-bank-error:', 'bank-push:', 'platform-code-error:', 'platform-problem-error:', 'platform-capture-error:'];
export const platformPendingSettings = { OR: prefixes.map(prefix => ({ key: { startsWith: prefix } })) } satisfies Prisma.SystemSettingWhereInput;
export async function countPlatformPending(db: Pick<Prisma.TransactionClient, 'platformSyncInbox' | 'systemSetting'> = prisma) {
  const [inbox, tasks] = await Promise.all([db.platformSyncInbox.count(), db.systemSetting.count({ where: platformPendingSettings })]);
  return inbox + tasks;
}
export async function platformPendingReasons() {
  // Aggregate only metadata inside MySQL: never load statements, answers,
  // images or test data merely to describe the queue.
  const [inbox, tasks] = await Promise.all([
    prisma.$queryRaw<Array<{ reason: string; amount: bigint }>>`SELECT COALESCE(lastError, '等待自动处理') AS reason, COUNT(*) AS amount
      FROM PlatformSyncInbox GROUP BY lastError ORDER BY amount DESC LIMIT 8`,
    prisma.$queryRaw<Array<{ reason: string; amount: bigint }>>`SELECT CASE
      WHEN \`key\` LIKE 'bank-push:%' THEN '题目文件排队上传，完成后等待公网确认'
      WHEN \`key\` LIKE 'platform-bank-error:%' THEN '原题或文件暂不可读取，等待自动重试'
      WHEN \`key\` LIKE 'platform-image-error:%' THEN '图片暂不可读取，等待自动重试'
      WHEN \`key\` LIKE 'platform-code-error:%' THEN '查重资料等待补齐'
      WHEN \`key\` LIKE 'platform-problem-error:%' THEN '考试题目等待题库映射'
      ELSE '资料捕获失败，等待自动重试' END AS reason, COUNT(*) AS amount
      FROM SystemSetting WHERE \`key\` LIKE 'bank-push:%' OR \`key\` LIKE 'platform-bank-error:%'
      OR \`key\` LIKE 'platform-image-error:%' OR \`key\` LIKE 'platform-code-error:%'
      OR \`key\` LIKE 'platform-problem-error:%' OR \`key\` LIKE 'platform-capture-error:%'
      GROUP BY reason ORDER BY amount DESC LIMIT 8`,
  ]);
  return [...inbox, ...tasks].map(row => ({ reason: row.reason, count: Number(row.amount) }));
}
