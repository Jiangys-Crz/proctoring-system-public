-- Apply only if prisma db push has not added this column.
-- NULL keeps the rendering behavior of pushes created before this upgrade.
ALTER TABLE `ScreenControlDisplay` ADD COLUMN `showParticipantCard` BOOLEAN NULL;
