-- CreateTable
CREATE TABLE "engine_predictions" (
    "id" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "league" TEXT,
    "matchKey" TEXT NOT NULL,
    "kickoffUtc" TIMESTAMP(3) NOT NULL,
    "homeTeam" TEXT NOT NULL,
    "awayTeam" TEXT NOT NULL,
    "predictedOutcome" TEXT,
    "pHome" DOUBLE PRECISION,
    "pDraw" DOUBLE PRECISION,
    "pAway" DOUBLE PRECISION,
    "expectedMargin" DOUBLE PRECISION,
    "confidenceTier" TEXT,
    "flag" TEXT,
    "featuresUsed" JSONB NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "engine_predictions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "engine_predictions_sport_kickoffUtc_idx" ON "engine_predictions"("sport", "kickoffUtc");

-- CreateIndex
CREATE INDEX "engine_predictions_generatedAt_idx" ON "engine_predictions"("generatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "engine_predictions_sport_matchKey_modelVersion_key" ON "engine_predictions"("sport", "matchKey", "modelVersion");
