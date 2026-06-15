-- CreateTable
CREATE TABLE "prediction_features" (
    "id" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "matchKey" TEXT NOT NULL,
    "league" TEXT,
    "kickoffUtc" TIMESTAMP(3) NOT NULL,
    "homeTeam" TEXT NOT NULL,
    "awayTeam" TEXT NOT NULL,
    "features" JSONB NOT NULL,
    "featureVersion" TEXT NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prediction_features_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prediction_features_sport_kickoffUtc_idx" ON "prediction_features"("sport", "kickoffUtc");

-- CreateIndex
CREATE INDEX "prediction_features_sport_featureVersion_idx" ON "prediction_features"("sport", "featureVersion");

-- CreateIndex
CREATE UNIQUE INDEX "prediction_features_sport_matchKey_featureVersion_key" ON "prediction_features"("sport", "matchKey", "featureVersion");
