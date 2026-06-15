-- CreateEnum
CREATE TYPE "BankrollEventType" AS ENUM ('DEPOSIT', 'WITHDRAWAL', 'BET_PLACED', 'BET_SETTLED', 'ADJUSTMENT');

-- AlterTable
ALTER TABLE "Selection" ADD COLUMN     "oddsAtPlacement" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "BankrollEvent" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "type" "BankrollEventType" NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "balanceAfter" DOUBLE PRECISION NOT NULL,
    "selectionId" TEXT,
    "note" TEXT,
    "modelVersion" TEXT,

    CONSTRAINT "BankrollEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "BankrollEvent_occurredAt_idx" ON "BankrollEvent"("occurredAt");
