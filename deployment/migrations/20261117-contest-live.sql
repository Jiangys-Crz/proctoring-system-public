-- CreateTable
CREATE TABLE `ContestLiveSettings` (
    `examId` VARCHAR(191) NOT NULL,
    `settings` JSON NOT NULL,
    `presets` JSON NOT NULL,
    `obsKeyHash` VARCHAR(64) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`examId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ContestLivePhoto` (
    `id` VARCHAR(191) NOT NULL,
    `examId` VARCHAR(191) NOT NULL,
    `accountHash` VARCHAR(64) NOT NULL,
    `image` MEDIUMBLOB NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ContestLivePhoto_examId_accountHash_key`(`examId`, `accountHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ContestLiveConnection` (
    `id` VARCHAR(36) NOT NULL,
    `examId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `channel` VARCHAR(32) NOT NULL,
    `access` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ContestLiveConnection_examId_access_idx`(`examId`, `access`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ContestLiveSettings` ADD CONSTRAINT `ContestLiveSettings_examId_fkey` FOREIGN KEY (`examId`) REFERENCES `Exam`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ContestLivePhoto` ADD CONSTRAINT `ContestLivePhoto_examId_fkey` FOREIGN KEY (`examId`) REFERENCES `Exam`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ContestLiveConnection` ADD CONSTRAINT `ContestLiveConnection_examId_fkey` FOREIGN KEY (`examId`) REFERENCES `ContestLiveSettings`(`examId`) ON DELETE CASCADE ON UPDATE CASCADE;
