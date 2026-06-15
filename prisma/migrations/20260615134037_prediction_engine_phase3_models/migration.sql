-- CreateTable
CREATE TABLE "prediction_models" (
    "id" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "modelType" TEXT NOT NULL,
    "modelVersion" TEXT NOT NULL,
    "artifactPath" TEXT NOT NULL,
    "featureVersion" TEXT NOT NULL,
    "trainRows" INTEGER NOT NULL,
    "valRows" INTEGER NOT NULL,
    "valAccuracy" DOUBLE PRECISION,
    "valBrier" DOUBLE PRECISION,
    "features" JSONB NOT NULL,
    "trainedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,

    CONSTRAINT "prediction_models_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prediction_models_sport_trainedAt_idx" ON "prediction_models"("sport", "trainedAt");
