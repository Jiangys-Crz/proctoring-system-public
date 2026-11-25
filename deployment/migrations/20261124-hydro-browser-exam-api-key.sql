-- Apply only if prisma db push has not already added this column.
ALTER TABLE `Exam` ADD COLUMN `hydroBrowserApiKey` TEXT NULL;
