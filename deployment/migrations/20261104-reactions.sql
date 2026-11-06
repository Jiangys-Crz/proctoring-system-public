-- AlterTable
ALTER TABLE `Exam` ADD COLUMN `reactionEnabled` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `MediaSegment` ADD COLUMN `clockOffsetMs` DOUBLE NULL,
    ADD COLUMN `clockUncertaintyMs` DOUBLE NULL,
    ADD COLUMN `reactionCache` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- CreateTable
CREATE TABLE `ReactionLogo` (
    `id` VARCHAR(191) NOT NULL,
    `label` VARCHAR(200) NOT NULL,
    `schoolName` VARCHAR(200) NULL,
    `objectPath` VARCHAR(512) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ReactionLogo_objectPath_key`(`objectPath`),
    INDEX `ReactionLogo_archivedAt_schoolName_idx`(`archivedAt`, `schoolName`),
    INDEX `ReactionLogo_createdById_idx`(`createdById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReactionConfig` (
    `examId` VARCHAR(191) NOT NULL,
    `bufferSeconds` INTEGER NOT NULL DEFAULT 60,
    `beforeSeconds` INTEGER NOT NULL DEFAULT 3,
    `afterSeconds` INTEGER NOT NULL DEFAULT 10,
    `maxPendingSeconds` INTEGER NOT NULL DEFAULT 1800,
    `maxStorageBytes` BIGINT NOT NULL DEFAULT 21474836480,
    `retentionDays` INTEGER NOT NULL DEFAULT 30,
    `uploadGraceSeconds` INTEGER NOT NULL DEFAULT 30,
    `autoGenerate` BOOLEAN NOT NULL DEFAULT false,
    `presentation` JSON NULL,
    `initializedAt` DATETIME(3) NULL,
    `feedStatus` VARCHAR(191) NOT NULL DEFAULT 'STOPPED',
    `lastEventAt` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `leaseToken` VARCHAR(191) NULL,
    `leaseUntil` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`examId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Reaction` (
    `id` VARCHAR(191) NOT NULL,
    `examId` VARCHAR(191) NOT NULL,
    `contestId` VARCHAR(191) NOT NULL,
    `submissionId` VARCHAR(191) NOT NULL,
    -- Retained for upgrade compatibility; ignored by Prisma Client.
    `displayId` INTEGER NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `candidateId` VARCHAR(191) NULL,
    `teamName` VARCHAR(191) NOT NULL,
    `schoolName` VARCHAR(191) NULL,
    `problemId` VARCHAR(191) NOT NULL,
    `problemLabel` VARCHAR(191) NOT NULL,
    `sourceSubmittedAt` DATETIME(3) NOT NULL,
    `submissionObservedAt` DATETIME(3) NOT NULL,
    `judgementObservedAt` DATETIME(3) NULL,
    `sourceJudgementEndAt` DATETIME(3) NULL,
    `eventOffsetMs` DOUBLE NOT NULL DEFAULT 0,
    `windowStart` DATETIME(3) NOT NULL,
    `windowEnd` DATETIME(3) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'PENDING',
    `verdict` VARCHAR(191) NULL,
    `originalVerdict` VARCHAR(191) NULL,
    `judgementId` VARCHAR(191) NULL,
    `verdictHistory` JSON NOT NULL,
    `rankContext` JSON NULL,
    `renderMetadata` JSON NULL,
    `error` TEXT NULL,
    `cameraPath` VARCHAR(191) NULL,
    `desktopPath` VARCHAR(191) NULL,
    `metadataPath` VARCHAR(191) NULL,
    `reactionPath` VARCHAR(191) NULL,
    `outputBytes` BIGINT NOT NULL DEFAULT 0,
    `reservedBytes` BIGINT NOT NULL DEFAULT 0,
    `durationSeconds` DOUBLE NULL,
    `generationStatus` VARCHAR(191) NOT NULL DEFAULT 'IDLE',
    `generationError` TEXT NULL,
    `finalizedAt` DATETIME(3) NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Reaction_examId_status_windowStart_idx`(`examId`, `status`, `windowStart`),
    INDEX `Reaction_generationStatus_idx`(`generationStatus`),
    UNIQUE INDEX `Reaction_examId_submissionId_key`(`examId`, `submissionId`),
    UNIQUE INDEX `Reaction_examId_displayId_key`(`examId`, `displayId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReactionSegment` (
    `reactionId` VARCHAR(191) NOT NULL,
    `segmentId` VARCHAR(191) NOT NULL,

    INDEX `ReactionSegment_segmentId_idx`(`segmentId`),
    PRIMARY KEY (`reactionId`, `segmentId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReactionEvent` (
    `examId` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `remoteId` VARCHAR(191) NOT NULL,
    `payloadHash` VARCHAR(64) NOT NULL,
    `payload` JSON NULL,
    `observedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`examId`, `type`, `remoteId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ReactionConfig` ADD CONSTRAINT `ReactionConfig_examId_fkey` FOREIGN KEY (`examId`) REFERENCES `Exam`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Reaction` ADD CONSTRAINT `Reaction_examId_fkey` FOREIGN KEY (`examId`) REFERENCES `Exam`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReactionSegment` ADD CONSTRAINT `ReactionSegment_reactionId_fkey` FOREIGN KEY (`reactionId`) REFERENCES `Reaction`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReactionSegment` ADD CONSTRAINT `ReactionSegment_segmentId_fkey` FOREIGN KEY (`segmentId`) REFERENCES `MediaSegment`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
