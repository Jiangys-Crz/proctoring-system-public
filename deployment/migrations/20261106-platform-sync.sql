-- AlterTable
ALTER TABLE `ExamProblem` ADD COLUMN `label` VARCHAR(6) NULL,
    ADD COLUMN `sourceDeleted` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `syncKey` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `ExamFederation` ADD COLUMN `managedGlobally` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `Candidate` ADD COLUMN `memberOrder` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `syncKey` VARCHAR(191) NULL,
    ADD COLUMN `teamRoster` JSON NULL;

-- AlterTable
ALTER TABLE `LoginRequest` ADD COLUMN `syncMaterialsVerified` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `ClientSession` ADD COLUMN `syncImported` BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE `CodeCheckJob` ADD COLUMN `syncImported` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `PlatformSyncState` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'peer',
    `sequence` BIGINT NOT NULL DEFAULT 0,
    `pushCursor` BIGINT NOT NULL DEFAULT 0,
    `pullCursor` BIGINT NOT NULL DEFAULT 0,
    `leaseToken` VARCHAR(36) NULL,
    `leaseUntil` DATETIME(3) NULL,
    `lastSuccessAt` DATETIME(3) NULL,
    `lastError` TEXT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlatformSyncItem` (
    `id` VARCHAR(191) NOT NULL,
    `scope` VARCHAR(64) NOT NULL,
    `kind` VARCHAR(32) NOT NULL,
    `localId` VARCHAR(191) NULL,
    `revision` INTEGER NOT NULL,
    `writer` VARCHAR(36) NOT NULL,
    `sequence` BIGINT NOT NULL,
    `hash` VARCHAR(64) NOT NULL,
    `appliedHash` VARCHAR(64) NULL,
    `deleted` BOOLEAN NOT NULL DEFAULT false,
    `payload` JSON NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `PlatformSyncItem_sequence_idx`(`sequence`),
    INDEX `PlatformSyncItem_scope_kind_idx`(`scope`, `kind`),
    UNIQUE INDEX `PlatformSyncItem_scope_kind_localId_key`(`scope`, `kind`, `localId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PlatformSyncInbox` (
    `id` VARCHAR(191) NOT NULL,
    `snapshot` JSON NOT NULL,
    `lastAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PlatformSyncInbox_lastAttemptAt_idx`(`lastAttemptAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `ExamProblem_syncKey_key` ON `ExamProblem`(`syncKey`);

-- CreateIndex
CREATE UNIQUE INDEX `Candidate_syncKey_key` ON `Candidate`(`syncKey`);


-- Recover legacy per-member team ordering from the original captain flag.
UPDATE Candidate AS candidate
JOIN (SELECT c.id, ROW_NUMBER() OVER (PARTITION BY c.examId, c.teamName ORDER BY c.isTeamLeader DESC, c.createdAt, c.id) AS memberPosition
      FROM Candidate AS c JOIN Exam AS exam ON exam.id = c.examId
      WHERE c.teamName IS NOT NULL AND c.teamName <> '' AND exam.contestType = 'TEAM' AND exam.teamAccountMode = 'MEMBER_ACCOUNTS') AS ordered
ON candidate.id = ordered.id
SET candidate.memberOrder = ordered.memberPosition, candidate.isTeamLeader = (ordered.memberPosition = 1);
