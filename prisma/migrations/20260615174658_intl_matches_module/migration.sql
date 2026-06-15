-- CreateTable
CREATE TABLE "intl_football_elo" (
    "id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "eloRating" DOUBLE PRECISION NOT NULL,
    "date" DATE NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intl_football_elo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intl_football_fixtures" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceMatchId" TEXT NOT NULL,
    "homeCountry" TEXT NOT NULL,
    "awayCountry" TEXT NOT NULL,
    "competition" TEXT NOT NULL,
    "matchType" TEXT NOT NULL,
    "kickoffUtc" TIMESTAMP(3) NOT NULL,
    "neutralVenue" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "homeScore" INTEGER,
    "awayScore" INTEGER,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intl_football_fixtures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intl_rugby_elo" (
    "id" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "rating" DOUBLE PRECISION NOT NULL,
    "date" DATE NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intl_rugby_elo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intl_rugby_fixtures" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceMatchId" TEXT NOT NULL,
    "homeCountry" TEXT NOT NULL,
    "awayCountry" TEXT NOT NULL,
    "competition" TEXT NOT NULL,
    "matchType" TEXT NOT NULL,
    "kickoffUtc" TIMESTAMP(3) NOT NULL,
    "neutralVenue" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "homeScore" INTEGER,
    "awayScore" INTEGER,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "intl_rugby_fixtures_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "intl_football_elo_country_date_idx" ON "intl_football_elo"("country", "date");

-- CreateIndex
CREATE UNIQUE INDEX "intl_football_elo_country_date_key" ON "intl_football_elo"("country", "date");

-- CreateIndex
CREATE INDEX "intl_football_fixtures_kickoffUtc_idx" ON "intl_football_fixtures"("kickoffUtc");

-- CreateIndex
CREATE INDEX "intl_football_fixtures_homeCountry_awayCountry_kickoffUtc_idx" ON "intl_football_fixtures"("homeCountry", "awayCountry", "kickoffUtc");

-- CreateIndex
CREATE UNIQUE INDEX "intl_football_fixtures_source_sourceMatchId_key" ON "intl_football_fixtures"("source", "sourceMatchId");

-- CreateIndex
CREATE INDEX "intl_rugby_elo_country_date_idx" ON "intl_rugby_elo"("country", "date");

-- CreateIndex
CREATE UNIQUE INDEX "intl_rugby_elo_country_date_key" ON "intl_rugby_elo"("country", "date");

-- CreateIndex
CREATE INDEX "intl_rugby_fixtures_kickoffUtc_idx" ON "intl_rugby_fixtures"("kickoffUtc");

-- CreateIndex
CREATE INDEX "intl_rugby_fixtures_homeCountry_awayCountry_kickoffUtc_idx" ON "intl_rugby_fixtures"("homeCountry", "awayCountry", "kickoffUtc");

-- CreateIndex
CREATE UNIQUE INDEX "intl_rugby_fixtures_source_sourceMatchId_key" ON "intl_rugby_fixtures"("source", "sourceMatchId");
