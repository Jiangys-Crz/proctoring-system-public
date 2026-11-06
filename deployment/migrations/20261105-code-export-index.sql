-- Apply once after a backup, or use the current project's schema upgrade.
-- Index creation can load a large submission table; schedule a release window.
CREATE INDEX `ContestSubmission_examId_createdAt_id_idx`
ON `ContestSubmission` (`examId`, `createdAt`, `id`);
