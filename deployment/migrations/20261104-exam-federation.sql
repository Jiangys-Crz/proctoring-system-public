-- AlterTable
ALTER TABLE `ContestSubmission` ADD COLUMN `federationDirty` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `federationRevision` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `syncImported` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `syncOriginNodeId` VARCHAR(36) NULL;

-- CreateTable
CREATE TABLE `ExamFederation` (
    `examId` VARCHAR(191) NOT NULL,
    `role` VARCHAR(8) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT false,
    `generation` INTEGER NOT NULL DEFAULT 0,
    `nodeId` VARCHAR(36) NOT NULL,
    `apiKeyHash` VARCHAR(64) NULL,
    `apiKeyCiphertext` TEXT NULL,
    `remoteBaseUrl` VARCHAR(512) NULL,
    `boundHubId` VARCHAR(36) NULL,
    `contractHash` VARCHAR(64) NULL,
    `sequence` BIGINT NOT NULL DEFAULT 0,
    `pushCursor` BIGINT NOT NULL DEFAULT 0,
    `pullCursor` BIGINT NOT NULL DEFAULT 0,
    `leaseToken` VARCHAR(36) NULL,
    `leaseUntil` DATETIME(3) NULL,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `failures` INTEGER NOT NULL DEFAULT 0,
    `lastSuccessAt` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ExamFederation_nodeId_key`(`nodeId`),
    INDEX `ExamFederation_enabled_nextAttemptAt_idx`(`enabled`, `nextAttemptAt`),
    PRIMARY KEY (`examId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ExamFederationEntry` (
    `examId` VARCHAR(191) NOT NULL,
    `originNodeId` VARCHAR(36) NOT NULL,
    `submissionId` VARCHAR(191) NOT NULL,
    `writerNodeId` VARCHAR(36) NOT NULL,
    `revision` INTEGER NOT NULL,
    `sequence` BIGINT NOT NULL,
    `payloadHash` VARCHAR(64) NOT NULL,
    `snapshot` JSON NOT NULL,

    UNIQUE INDEX `ExamFederationEntry_submissionId_key`(`submissionId`),
    INDEX `ExamFederationEntry_examId_sequence_idx`(`examId`, `sequence`),
    INDEX `ExamFederationEntry_examId_writerNodeId_sequence_idx`(`examId`, `writerNodeId`, `sequence`),
    PRIMARY KEY (`examId`, `originNodeId`, `submissionId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ContestSubmission_examId_federationDirty_updatedAt_id_idx` ON `ContestSubmission`(`examId`, `federationDirty`, `updatedAt`, `id`);

-- AddForeignKey
ALTER TABLE `ExamFederation` ADD CONSTRAINT `ExamFederation_examId_fkey` FOREIGN KEY (`examId`) REFERENCES `Exam`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExamFederationEntry` ADD CONSTRAINT `ExamFederationEntry_examId_fkey` FOREIGN KEY (`examId`) REFERENCES `Exam`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ExamFederationEntry` ADD CONSTRAINT `ExamFederationEntry_submissionId_fkey` FOREIGN KEY (`submissionId`) REFERENCES `ContestSubmission`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
