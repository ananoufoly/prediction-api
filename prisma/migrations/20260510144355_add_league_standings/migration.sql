-- CreateTable
CREATE TABLE "LeagueStanding" (
    "id" TEXT NOT NULL,
    "league" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "team" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "points" INTEGER NOT NULL,
    "played" INTEGER NOT NULL,
    "matchesTotal" INTEGER NOT NULL,
    "description" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeagueStanding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeagueStanding_league_season_idx" ON "LeagueStanding"("league", "season");

-- CreateIndex
CREATE INDEX "LeagueStanding_fetchedAt_idx" ON "LeagueStanding"("fetchedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeagueStanding_league_season_team_key" ON "LeagueStanding"("league", "season", "team");
