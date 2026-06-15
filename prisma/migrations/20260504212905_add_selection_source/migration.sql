-- CreateEnum
CREATE TYPE "SelectionSource" AS ENUM ('MODEL', 'MANUAL_EXPLORATORY', 'MANUAL_CONVICTION');

-- AlterTable
ALTER TABLE "BankrollEvent" ADD COLUMN     "selectionSource" "SelectionSource";

-- AlterTable
ALTER TABLE "Selection" ADD COLUMN     "manualNote" TEXT,
ADD COLUMN     "source" "SelectionSource" NOT NULL DEFAULT 'MODEL';
