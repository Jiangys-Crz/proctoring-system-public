-- AlterTable
ALTER TABLE `ContestSubmission` ADD COLUMN `federationWriteToken` VARCHAR(36) NOT NULL DEFAULT '',
    ADD COLUMN `judgeForced` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `ExamFederation` ADD COLUMN `communicationError` TEXT NULL,
    ADD COLUMN `communicationFailures` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `communicationNextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `communicationSuccessAt` DATETIME(3) NULL,
    ADD COLUMN `contentPullCursor` BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN `contentPushCursor` BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN `contentSequence` BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `ExamQuestion` ADD COLUMN `answeredByLabel` VARCHAR(200) NULL,
    ADD COLUMN `federationAttemptAt` DATETIME(3) NULL,
    ADD COLUMN `federationDirty` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `federationRevision` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `initialMessageId` VARCHAR(191) NULL,
    ADD COLUMN `messageClock` BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN `publicationId` VARCHAR(36) NULL,
    ADD COLUMN `syncOriginNodeId` VARCHAR(36) NULL;

-- AlterTable
ALTER TABLE `ExamQuestionMessage` ADD COLUMN `creatorLabel` VARCHAR(200) NULL,
    ADD COLUMN `deliveredAt` DATETIME(3) NULL,
    ADD COLUMN `federationAttemptAt` DATETIME(3) NULL,
    ADD COLUMN `federationDirty` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `syncOriginNodeId` VARCHAR(36) NULL,
    ADD COLUMN `threadOrder` BIGINT NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `ExamAnnouncement` ADD COLUMN `creatorLabel` VARCHAR(200) NULL,
    ADD COLUMN `deliveredAt` DATETIME(3) NULL,
    ADD COLUMN `federationAttemptAt` DATETIME(3) NULL,
    ADD COLUMN `federationDirty` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `sourcePublicationId` VARCHAR(36) NULL,
    ADD COLUMN `sourceQuestionId` VARCHAR(191) NULL,
    ADD COLUMN `syncOriginNodeId` VARCHAR(36) NULL,
    ADD COLUMN `withdrawn` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `ExamFederationContent` (
    `examId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `entityId` VARCHAR(191) NOT NULL,
    `originNodeId` VARCHAR(36) NOT NULL,
    `writerNodeId` VARCHAR(36) NOT NULL,
    `revision` INTEGER NOT NULL,
    `sequence` BIGINT NOT NULL,
    `payloadHash` VARCHAR(64) NOT NULL,
    `snapshot` JSON NOT NULL,

    INDEX `ExamFederationContent_examId_sequence_idx`(`examId`, `sequence`),
    INDEX `ExamFederationContent_examId_writerNodeId_sequence_idx`(`examId`, `writerNodeId`, `sequence`),
    PRIMARY KEY (`examId`, `kind`, `entityId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ExamFederationAsset` (
    `id` VARCHAR(36) NOT NULL,
    `examId` VARCHAR(191) NOT NULL,
    `originNodeId` VARCHAR(36) NOT NULL,
    `sha256` VARCHAR(64) NOT NULL,
    `accessKeyHash` VARCHAR(64) NOT NULL,
    `accessKeyCiphertext` TEXT NOT NULL,
    `bytes` MEDIUMBLOB NOT NULL,
    `byteSize` INTEGER NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `sourceObjectKey` VARCHAR(512) NULL,

    INDEX `ExamFederationAsset_examId_sha256_idx`(`examId`, `sha256`),
    UNIQUE INDEX `ExamFederationAsset_examId_sourceObjectKey_key`(`examId`, `sourceObjectKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ExamQuestion_examId_federationDirty_federationAttemptAt_idx` ON `ExamQuestion`(`examId`, `federationDirty`, `federationAttemptAt`);

-- CreateIndex
CREATE INDEX `ExamQuestionMessage_questionId_federationDirty_createdAt_idx` ON `ExamQuestionMessage`(`questionId`, `federationDirty`, `createdAt`);

-- CreateIndex
CREATE INDEX `ExamQuestionMessage_questionId_deliveredAt_idx` ON `ExamQuestionMessage`(`questionId`, `deliveredAt`);

-- CreateIndex
CREATE INDEX `ExamQuestionMessage_deliveredAt_idx` ON `ExamQuestionMessage`(`deliveredAt`);

-- CreateIndex
CREATE INDEX `ExamQuestionMessage_questionId_threadOrder_createdAt_idx` ON `ExamQuestionMessage`(`questionId`, `threadOrder`, `createdAt`);

-- CreateIndex
CREATE INDEX `ExamAnnouncement_examId_federationDirty_federationAttemptAt_idx` ON `ExamAnnouncement`(`examId`, `federationDirty`, `federationAttemptAt`);

-- CreateIndex
CREATE INDEX `ExamAnnouncement_examId_withdrawn_deliveredAt_idx` ON `ExamAnnouncement`(`examId`, `withdrawn`, `deliveredAt`);

-- AddForeignKey
ALTER TABLE `ExamAnnouncement` ADD CONSTRAINT `ExamAnnouncement_sourceQuestionId_fkey` FOREIGN KEY (`sourceQuestionId`) REFERENCES `ExamQuestion`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExamFederationContent` ADD CONSTRAINT `ExamFederationContent_examId_fkey` FOREIGN KEY (`examId`) REFERENCES `Exam`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExamFederationAsset` ADD CONSTRAINT `ExamFederationAsset_examId_fkey` FOREIGN KEY (`examId`) REFERENCES `Exam`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
