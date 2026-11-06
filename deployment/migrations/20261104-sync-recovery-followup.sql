-- AlterTable
ALTER TABLE `ExamFederation` ADD COLUMN `submissionNextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- CreateIndex
CREATE INDEX `ExamQuestionMessage_questionId_sender_acknowledgedAt_idx` ON `ExamQuestionMessage`(`questionId`, `sender`, `acknowledgedAt`);
