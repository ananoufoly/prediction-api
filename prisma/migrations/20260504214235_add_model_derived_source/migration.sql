-- AlterEnum
ALTER TYPE "SelectionSource" ADD VALUE 'MODEL_DERIVED';

-- AlterTable
ALTER TABLE "Selection" ADD COLUMN     "derivedFromIds" TEXT[];
