/*
  Warnings:

  - You are about to drop the column `filePath` on the `Video` table. All the data in the column will be lost.
  - You are about to drop the column `thumbPath` on the `Video` table. All the data in the column will be lost.
  - Added the required column `updatedAt` to the `Video` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Video" DROP COLUMN "filePath",
DROP COLUMN "thumbPath",
ADD COLUMN     "errorMessage" TEXT,
ADD COLUMN     "rawKey" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'processing',
ADD COLUMN     "thumbnailKey" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "videoKey" TEXT,
ALTER COLUMN "fileSizeBytes" DROP NOT NULL;
