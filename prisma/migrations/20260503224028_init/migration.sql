-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('SCHEDULED', 'LIVE', 'FINAL', 'POSTPONED');

-- CreateEnum
CREATE TYPE "Confidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "SelectionStatus" AS ENUM ('PAPER', 'PLACED', 'SETTLED', 'VOID');

-- CreateEnum
CREATE TYPE "Result" AS ENUM ('WIN', 'LOSS', 'PUSH');

-- CreateTable
CREATE TABLE "Match" (
    "id" TEXT NOT NULL,
    "league" TEXT NOT NULL,
    "homeTeam" TEXT NOT NULL,
    "awayTeam" TEXT NOT NULL,
    "kickoffUtc" TIMESTAMP(3) NOT NULL,
    "status" "MatchStatus" NOT NULL DEFAULT 'SCHEDULED',
    "homeGoals" INTEGER,
    "awayGoals" INTEGER,
    "homeXg" DOUBLE PRECISION,
    "awayXg" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Match_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OddsSnapshot" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "bookmaker" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "decimalOdds" DOUBLE PRECISION NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "isClosing" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "OddsSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Prediction" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "modelVersion" TEXT NOT NULL,
    "scoreMatrix" JSONB NOT NULL,
    "pHome" DOUBLE PRECISION NOT NULL,
    "pDraw" DOUBLE PRECISION NOT NULL,
    "pAway" DOUBLE PRECISION NOT NULL,
    "pOver25" DOUBLE PRECISION NOT NULL,
    "pBtts" DOUBLE PRECISION NOT NULL,
    "calibrationApplied" BOOLEAN NOT NULL DEFAULT false,
    "calibrationVersion" TEXT,

    CONSTRAINT "Prediction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Selection" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "modelProb" DOUBLE PRECISION NOT NULL,
    "pinnacleFairProb" DOUBLE PRECISION,
    "bookieFairProb" DOUBLE PRECISION NOT NULL,
    "bookmaker" TEXT NOT NULL,
    "oddsAtSelection" DOUBLE PRECISION NOT NULL,
    "edgePct" DOUBLE PRECISION NOT NULL,
    "kellyFraction" DOUBLE PRECISION NOT NULL,
    "recommendedStake" DOUBLE PRECISION NOT NULL,
    "confidence" "Confidence" NOT NULL,
    "selectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closingOdds" DOUBLE PRECISION,
    "clv" DOUBLE PRECISION,
    "status" "SelectionStatus" NOT NULL DEFAULT 'PAPER',
    "betPlaced" BOOLEAN NOT NULL DEFAULT false,
    "stakeActual" DOUBLE PRECISION,
    "result" "Result",
    "pnl" DOUBLE PRECISION,

    CONSTRAINT "Selection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiBudget" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "requests" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ApiBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalibrationPoint" (
    "id" TEXT NOT NULL,
    "matchId" TEXT NOT NULL,
    "market" TEXT NOT NULL,
    "predictedProb" DOUBLE PRECISION NOT NULL,
    "actualOutcome" INTEGER NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "matchDate" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalibrationPoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Match_kickoffUtc_idx" ON "Match"("kickoffUtc");

-- CreateIndex
CREATE INDEX "Match_league_kickoffUtc_idx" ON "Match"("league", "kickoffUtc");

-- CreateIndex
CREATE INDEX "Match_status_idx" ON "Match"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Match_league_homeTeam_awayTeam_kickoffUtc_key" ON "Match"("league", "homeTeam", "awayTeam", "kickoffUtc");

-- CreateIndex
CREATE INDEX "OddsSnapshot_matchId_bookmaker_market_fetchedAt_idx" ON "OddsSnapshot"("matchId", "bookmaker", "market", "fetchedAt");

-- CreateIndex
CREATE INDEX "OddsSnapshot_matchId_isClosing_idx" ON "OddsSnapshot"("matchId", "isClosing");

-- CreateIndex
CREATE INDEX "OddsSnapshot_fetchedAt_idx" ON "OddsSnapshot"("fetchedAt");

-- CreateIndex
CREATE INDEX "Prediction_matchId_generatedAt_idx" ON "Prediction"("matchId", "generatedAt");

-- CreateIndex
CREATE INDEX "Prediction_modelVersion_idx" ON "Prediction"("modelVersion");

-- CreateIndex
CREATE INDEX "Selection_status_selectedAt_idx" ON "Selection"("status", "selectedAt");

-- CreateIndex
CREATE INDEX "Selection_matchId_idx" ON "Selection"("matchId");

-- CreateIndex
CREATE INDEX "Selection_selectedAt_idx" ON "Selection"("selectedAt");

-- CreateIndex
CREATE INDEX "Selection_confidence_status_idx" ON "Selection"("confidence", "status");

-- CreateIndex
CREATE INDEX "ApiBudget_provider_date_idx" ON "ApiBudget"("provider", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ApiBudget_provider_date_key" ON "ApiBudget"("provider", "date");

-- CreateIndex
CREATE INDEX "CalibrationPoint_market_matchDate_idx" ON "CalibrationPoint"("market", "matchDate");

-- CreateIndex
CREATE INDEX "CalibrationPoint_modelVersion_idx" ON "CalibrationPoint"("modelVersion");

-- AddForeignKey
ALTER TABLE "OddsSnapshot" ADD CONSTRAINT "OddsSnapshot_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Prediction" ADD CONSTRAINT "Prediction_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Selection" ADD CONSTRAINT "Selection_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalibrationPoint" ADD CONSTRAINT "CalibrationPoint_matchId_fkey" FOREIGN KEY ("matchId") REFERENCES "Match"("id") ON DELETE CASCADE ON UPDATE CASCADE;
