-- Additive upgrade; execute once, before deploying either backend.
-- Existing connections, snapshots, sequence numbers and cursors stay intact.
ALTER TABLE `ExamFederation`
    ADD COLUMN `localContractHash` VARCHAR(64) NULL,
    ADD COLUMN `problemMapping` JSON NULL;
