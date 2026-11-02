import { prisma } from '../src/lib/db';

// Stage only additive columns and the identity indexes. Do not accept unrelated data-loss warnings.
async function main() {
  const tables = await prisma.$queryRaw<Array<{ TABLE_NAME: string }>>`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User'`;
  if (!tables.length) return;
  const columns = await prisma.$queryRaw<Array<{ COLUMN_NAME: string }>>`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User'`;
  const names = new Set(columns.map(row => row.COLUMN_NAME));
  const additions = [
    ['associationImported', 'BOOLEAN NOT NULL DEFAULT false'],
    ['associationUserId', 'VARCHAR(191) NULL'],
    ['associationVerifiedAt', 'DATETIME(3) NULL']
  ];
  for (const [name, type] of additions) if (!names.has(name)) await prisma.$executeRawUnsafe(`ALTER TABLE \`User\` ADD COLUMN \`${name}\` ${type}`);
  const indexes = await prisma.$queryRaw<Array<{ INDEX_NAME: string }>>`SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User'`;
  const existing = new Set(indexes.map(row => row.INDEX_NAME));
  if (!existing.has('User_associationUserId_key')) await prisma.$executeRawUnsafe('ALTER TABLE `User` ADD UNIQUE INDEX `User_associationUserId_key` (`associationUserId`)');
  if (!existing.has('User_realName_numberId_key')) await prisma.$executeRawUnsafe('ALTER TABLE `User` ADD UNIQUE INDEX `User_realName_numberId_key` (`realName`, `numberId`)');
  if (!existing.has('User_numberId_idx')) await prisma.$executeRawUnsafe('ALTER TABLE `User` ADD INDEX `User_numberId_idx` (`numberId`)');
  // Install the replacement constraint first; a failed index addition leaves the old one intact.
  if (existing.has('User_numberId_key')) await prisma.$executeRawUnsafe('ALTER TABLE `User` DROP INDEX `User_numberId_key`');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
