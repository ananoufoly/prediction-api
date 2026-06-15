-- CreateEnum
CREATE TYPE "SelectionStrategy" AS ENUM ('STANDARD', 'CONSENSUS');

-- AlterTable
ALTER TABLE "Selection" ADD COLUMN     "selectionStrategy" "SelectionStrategy" NOT NULL DEFAULT 'STANDARD';
