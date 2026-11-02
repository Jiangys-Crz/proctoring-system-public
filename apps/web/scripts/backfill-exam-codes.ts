import { prisma } from '../src/lib/db';
import { nextExamCode } from '../src/lib/exam-code';

// Add the nullable column first so existing exams can be numbered without deleting data.
async function main() {
  const tables = await prisma.$queryRaw<Array<{ TABLE_NAME: string }>>`SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Exam'`;
  if (!tables.length) return;
  const columns = await prisma.$queryRaw<Array<{ COLUMN_NAME: string }>>`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Exam' AND COLUMN_NAME = 'examCode'`;
  if (!columns.length) await prisma.$executeRawUnsafe('ALTER TABLE `Exam` ADD COLUMN `examCode` VARCHAR(10) NULL, ADD UNIQUE INDEX `Exam_examCode_key` (`examCode`)');
  const accountModeColumns = await prisma.$queryRaw<Array<{ COLUMN_NAME: string }>>`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Exam' AND COLUMN_NAME = 'teamAccountMode'`;
  if (!accountModeColumns.length) {
    await prisma.$executeRawUnsafe("ALTER TABLE `Exam` ADD COLUMN `teamAccountMode` ENUM('MEMBER_ACCOUNTS','TEAM_ACCOUNT') NOT NULL DEFAULT 'MEMBER_ACCOUNTS'");
  }
  const normalizedRules = await prisma.exam.updateMany({ where: { contestRule: 'ACM' }, data: { contestRule: 'XCPC' } });
  await prisma.$executeRawUnsafe("UPDATE `Exam` e SET e.`teamAccountMode` = 'TEAM_ACCOUNT' WHERE e.`contestType` = 'TEAM' AND EXISTS (SELECT 1 FROM `Candidate` c WHERE c.`examId` = e.`id` AND c.`studentId` IS NULL AND c.`teamMemberStudentIds` IS NOT NULL AND c.`teamMemberStudentIds` <> '')");
  await prisma.$executeRawUnsafe('CREATE TABLE IF NOT EXISTS `ExamCodeSequence` (`date` VARCHAR(8) NOT NULL, `value` INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (`date`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  const exams = await prisma.$queryRaw<Array<{ id: string; startAt: Date }>>`SELECT id, startAt FROM Exam WHERE examCode IS NULL ORDER BY startAt ASC, createdAt ASC`;
  for (const exam of exams) {
    await prisma.$transaction(async tx => {
      const code = await nextExamCode(tx, exam.startAt);
      await tx.exam.update({ where: { id: exam.id }, data: { examCode: code } });
    });
  }
  console.log(`Backfilled ${exams.length} exam codes and normalized ${normalizedRules.count} legacy ACM exams to XCPC.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
