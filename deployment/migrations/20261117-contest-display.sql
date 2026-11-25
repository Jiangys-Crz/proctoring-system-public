CREATE TABLE `ContestDisplay` (
    `examId` VARCHAR(191) NOT NULL,
    `settings` JSON NOT NULL,
    `keyHash` VARCHAR(64) NULL,
    `revision` INTEGER NOT NULL DEFAULT 1,
    `startedAt` DATETIME(3) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`examId`),
    CONSTRAINT `ContestDisplay_examId_fkey` FOREIGN KEY (`examId`) REFERENCES `Exam`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
