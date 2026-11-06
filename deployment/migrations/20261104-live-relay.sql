-- CreateTable
CREATE TABLE `LiveRelayKey` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `keyHash` VARCHAR(64) NOT NULL,
    `readKeyHash` VARCHAR(64) NOT NULL,
    `keyPrefix` VARCHAR(20) NOT NULL,
    `readKeyPrefix` VARCHAR(24) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `maxStreams` INTEGER NOT NULL DEFAULT 4,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `LiveRelayKey_keyHash_key`(`keyHash`),
    UNIQUE INDEX `LiveRelayKey_readKeyHash_key`(`readKeyHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `LiveRelayStream` (
    `id` VARCHAR(64) NOT NULL,
    `keyId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `archived` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `LiveRelayStream_keyId_archived_idx`(`keyId`, `archived`),
    INDEX `LiveRelayStream_archived_createdAt_idx`(`archived`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `LiveRelayStream` ADD CONSTRAINT `LiveRelayStream_keyId_fkey` FOREIGN KEY (`keyId`) REFERENCES `LiveRelayKey`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
