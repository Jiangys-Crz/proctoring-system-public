-- Apply once to installations that already have the federation tables.
-- If prisma db push has added these fields/index, do not run this SQL again.
ALTER TABLE `ContestSubmission`
    ADD COLUMN `federationAttemptAt` DATETIME(3) NULL,
    ADD COLUMN `federationError` VARCHAR(500) NULL;

CREATE INDEX `ContestSubmission_federation_retry_idx`
    ON `ContestSubmission`(`examId`, `federationDirty`, `federationAttemptAt`, `updatedAt`, `id`);
