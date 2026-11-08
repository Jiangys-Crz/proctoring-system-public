import type { Prisma } from '@prisma/client';

export async function lockRelayCapacity(tx: Prisma.TransactionClient) {
  // Prisma's empty-update upsert may use read-then-insert. Use one atomic
  // statement so simultaneous first connections cannot race on the primary key.
  const key = 'live-relay-capacity-v1';
  await tx.$executeRaw`INSERT INTO SystemSetting (\`key\`, value, updatedAt)
    VALUES (${key}, JSON_OBJECT(), NOW(3))
    ON DUPLICATE KEY UPDATE updatedAt = SystemSetting.updatedAt`;
  await tx.$queryRaw`SELECT \`key\` FROM SystemSetting WHERE \`key\` = ${key} FOR UPDATE`;
}
