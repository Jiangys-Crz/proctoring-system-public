-- Execute once after backup, before deploying the WebRTC relay backend.
ALTER TABLE `LiveApiKey` ADD COLUMN `keyCiphertext` TEXT NULL;
-- Preserve legacy relay registrations/credentials for rollback; new streams
-- use system-wide LiveApiKey credentials and no legacy relay-key owner.
ALTER TABLE `LiveRelayStream` MODIFY `keyId` VARCHAR(191) NULL;
CREATE TABLE `LiveRelayWebRtcConnection` (
  `id` VARCHAR(36) NOT NULL,
  `streamId` VARCHAR(64) NOT NULL,
  `keyId` VARCHAR(191) NOT NULL,
  `mode` VARCHAR(8) NOT NULL,
  `ownerHash` VARCHAR(64) NOT NULL,
  `adminId` VARCHAR(191) NULL,
  `mediaId` VARCHAR(36) NULL,
  `resourceSecret` VARCHAR(36) NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `LiveRelayWebRtcConnection_streamId_expiresAt_idx` (`streamId`, `expiresAt`),
  INDEX `LiveRelayWebRtcConnection_keyId_idx` (`keyId`),
  INDEX `LiveRelayWebRtcConnection_expiresAt_idx` (`expiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
