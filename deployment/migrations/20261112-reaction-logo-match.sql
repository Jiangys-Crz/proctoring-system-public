-- Apply only if these columns have not already been added by prisma db push.
ALTER TABLE `Exam`
    ADD COLUMN `reactionLogoMatchBy` ENUM('SCHOOL', 'COLLEGE') NOT NULL DEFAULT 'SCHOOL';

ALTER TABLE `Reaction`
    ADD COLUMN `collegeName` VARCHAR(191) NULL;
