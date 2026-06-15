-- CreateTable
CREATE TABLE "football_fixtures" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceMatchId" TEXT NOT NULL,
    "league" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "kickoffUtc" TIMESTAMP(3) NOT NULL,
    "homeTeam" TEXT NOT NULL,
    "awayTeam" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "homeGoals" INTEGER,
    "awayGoals" INTEGER,
    "homeXg" DOUBLE PRECISION,
    "awayXg" DOUBLE PRECISION,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "football_fixtures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "football_lineups" (
    "id" TEXT NOT NULL,
    "fixtureId" TEXT NOT NULL,
    "apiFixtureId" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "playerName" TEXT NOT NULL,
    "playerId" INTEGER,
    "role" TEXT NOT NULL,
    "position" TEXT,
    "reason" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "football_lineups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tennis_matches" (
    "id" TEXT NOT NULL,
    "tour" TEXT NOT NULL,
    "sourceFile" TEXT NOT NULL,
    "tourneyId" TEXT NOT NULL,
    "tourneyName" TEXT NOT NULL,
    "tourneyDate" TIMESTAMP(3) NOT NULL,
    "surface" TEXT,
    "round" TEXT,
    "bestOf" INTEGER,
    "winnerName" TEXT NOT NULL,
    "winnerId" INTEGER,
    "winnerRank" INTEGER,
    "loserName" TEXT NOT NULL,
    "loserId" INTEGER,
    "loserRank" INTEGER,
    "score" TEXT,

    CONSTRAINT "tennis_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nba_game_logs" (
    "id" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "gameDate" TIMESTAMP(3) NOT NULL,
    "teamId" INTEGER NOT NULL,
    "teamAbbrev" TEXT NOT NULL,
    "opponentAbbrev" TEXT,
    "isHome" BOOLEAN NOT NULL,
    "won" BOOLEAN,
    "pts" INTEGER,
    "oppPts" INTEGER,
    "offRating" DOUBLE PRECISION,
    "defRating" DOUBLE PRECISION,
    "netRating" DOUBLE PRECISION,
    "pace" DOUBLE PRECISION,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nba_game_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nba_injuries" (
    "id" TEXT NOT NULL,
    "reportDate" TIMESTAMP(3) NOT NULL,
    "teamAbbrev" TEXT NOT NULL,
    "playerName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nba_injuries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nfl_team_games" (
    "id" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "gameId" TEXT NOT NULL,
    "gameDate" TIMESTAMP(3),
    "team" TEXT NOT NULL,
    "opponent" TEXT NOT NULL,
    "isHome" BOOLEAN NOT NULL,
    "won" BOOLEAN,
    "pointsFor" INTEGER,
    "pointsAgainst" INTEGER,
    "offEpaPerPlay" DOUBLE PRECISION,
    "defEpaPerPlay" DOUBLE PRECISION,
    "startingQb" TEXT,
    "byeWeekFlag" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nfl_team_games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "nfl_injuries" (
    "id" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "week" INTEGER NOT NULL,
    "team" TEXT NOT NULL,
    "playerName" TEXT NOT NULL,
    "position" TEXT,
    "status" TEXT,
    "reason" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "nfl_injuries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mlb_team_games" (
    "id" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "gameDate" TIMESTAMP(3) NOT NULL,
    "gameId" TEXT NOT NULL,
    "team" TEXT NOT NULL,
    "opponent" TEXT NOT NULL,
    "isHome" BOOLEAN NOT NULL,
    "won" BOOLEAN,
    "runsFor" INTEGER,
    "runsAgainst" INTEGER,
    "startingPitcher" TEXT,
    "ballpark" TEXT,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mlb_team_games_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mlb_pitcher_stats" (
    "id" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "asOfDate" TIMESTAMP(3) NOT NULL,
    "pitcherName" TEXT NOT NULL,
    "pitcherId" INTEGER,
    "team" TEXT,
    "era" DOUBLE PRECISION,
    "fip" DOUBLE PRECISION,
    "xfip" DOUBLE PRECISION,
    "ip" DOUBLE PRECISION,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mlb_pitcher_stats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mlb_team_batting" (
    "id" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "asOfDate" TIMESTAMP(3) NOT NULL,
    "team" TEXT NOT NULL,
    "ops" DOUBLE PRECISION,
    "wrcPlus" DOUBLE PRECISION,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mlb_team_batting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rugby_matches" (
    "id" TEXT NOT NULL,
    "competition" TEXT NOT NULL,
    "espnEventId" TEXT NOT NULL,
    "kickoffUtc" TIMESTAMP(3) NOT NULL,
    "homeTeam" TEXT NOT NULL,
    "awayTeam" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "homeScore" INTEGER,
    "awayScore" INTEGER,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rugby_matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rugby_standings" (
    "id" TEXT NOT NULL,
    "competition" TEXT NOT NULL,
    "season" INTEGER NOT NULL,
    "team" TEXT NOT NULL,
    "rank" INTEGER,
    "points" INTEGER,
    "played" INTEGER,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rugby_standings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prediction_ingestion_runs" (
    "id" TEXT NOT NULL,
    "sport" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "rowsWritten" INTEGER NOT NULL DEFAULT 0,
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,

    CONSTRAINT "prediction_ingestion_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "football_fixtures_league_season_idx" ON "football_fixtures"("league", "season");

-- CreateIndex
CREATE INDEX "football_fixtures_kickoffUtc_idx" ON "football_fixtures"("kickoffUtc");

-- CreateIndex
CREATE INDEX "football_fixtures_homeTeam_awayTeam_kickoffUtc_idx" ON "football_fixtures"("homeTeam", "awayTeam", "kickoffUtc");

-- CreateIndex
CREATE UNIQUE INDEX "football_fixtures_source_sourceMatchId_key" ON "football_fixtures"("source", "sourceMatchId");

-- CreateIndex
CREATE INDEX "football_lineups_apiFixtureId_idx" ON "football_lineups"("apiFixtureId");

-- CreateIndex
CREATE UNIQUE INDEX "football_lineups_fixtureId_team_playerName_role_key" ON "football_lineups"("fixtureId", "team", "playerName", "role");

-- CreateIndex
CREATE INDEX "tennis_matches_tour_tourneyDate_idx" ON "tennis_matches"("tour", "tourneyDate");

-- CreateIndex
CREATE INDEX "tennis_matches_surface_idx" ON "tennis_matches"("surface");

-- CreateIndex
CREATE INDEX "tennis_matches_winnerName_idx" ON "tennis_matches"("winnerName");

-- CreateIndex
CREATE INDEX "tennis_matches_loserName_idx" ON "tennis_matches"("loserName");

-- CreateIndex
CREATE UNIQUE INDEX "tennis_matches_tour_tourneyId_winnerId_loserId_round_key" ON "tennis_matches"("tour", "tourneyId", "winnerId", "loserId", "round");

-- CreateIndex
CREATE INDEX "nba_game_logs_season_teamAbbrev_idx" ON "nba_game_logs"("season", "teamAbbrev");

-- CreateIndex
CREATE INDEX "nba_game_logs_gameDate_idx" ON "nba_game_logs"("gameDate");

-- CreateIndex
CREATE UNIQUE INDEX "nba_game_logs_gameId_teamId_key" ON "nba_game_logs"("gameId", "teamId");

-- CreateIndex
CREATE INDEX "nba_injuries_teamAbbrev_reportDate_idx" ON "nba_injuries"("teamAbbrev", "reportDate");

-- CreateIndex
CREATE UNIQUE INDEX "nba_injuries_reportDate_teamAbbrev_playerName_key" ON "nba_injuries"("reportDate", "teamAbbrev", "playerName");

-- CreateIndex
CREATE INDEX "nfl_team_games_season_team_idx" ON "nfl_team_games"("season", "team");

-- CreateIndex
CREATE INDEX "nfl_team_games_season_week_idx" ON "nfl_team_games"("season", "week");

-- CreateIndex
CREATE UNIQUE INDEX "nfl_team_games_gameId_team_key" ON "nfl_team_games"("gameId", "team");

-- CreateIndex
CREATE INDEX "nfl_injuries_season_week_team_idx" ON "nfl_injuries"("season", "week", "team");

-- CreateIndex
CREATE UNIQUE INDEX "nfl_injuries_season_week_team_playerName_key" ON "nfl_injuries"("season", "week", "team", "playerName");

-- CreateIndex
CREATE INDEX "mlb_team_games_season_team_idx" ON "mlb_team_games"("season", "team");

-- CreateIndex
CREATE INDEX "mlb_team_games_gameDate_idx" ON "mlb_team_games"("gameDate");

-- CreateIndex
CREATE UNIQUE INDEX "mlb_team_games_gameId_team_key" ON "mlb_team_games"("gameId", "team");

-- CreateIndex
CREATE INDEX "mlb_pitcher_stats_season_pitcherName_idx" ON "mlb_pitcher_stats"("season", "pitcherName");

-- CreateIndex
CREATE UNIQUE INDEX "mlb_pitcher_stats_asOfDate_pitcherName_key" ON "mlb_pitcher_stats"("asOfDate", "pitcherName");

-- CreateIndex
CREATE INDEX "mlb_team_batting_season_team_idx" ON "mlb_team_batting"("season", "team");

-- CreateIndex
CREATE UNIQUE INDEX "mlb_team_batting_asOfDate_team_key" ON "mlb_team_batting"("asOfDate", "team");

-- CreateIndex
CREATE INDEX "rugby_matches_competition_kickoffUtc_idx" ON "rugby_matches"("competition", "kickoffUtc");

-- CreateIndex
CREATE INDEX "rugby_matches_kickoffUtc_idx" ON "rugby_matches"("kickoffUtc");

-- CreateIndex
CREATE UNIQUE INDEX "rugby_matches_espnEventId_key" ON "rugby_matches"("espnEventId");

-- CreateIndex
CREATE INDEX "rugby_standings_competition_season_idx" ON "rugby_standings"("competition", "season");

-- CreateIndex
CREATE UNIQUE INDEX "rugby_standings_competition_season_team_key" ON "rugby_standings"("competition", "season", "team");

-- CreateIndex
CREATE INDEX "prediction_ingestion_runs_sport_startedAt_idx" ON "prediction_ingestion_runs"("sport", "startedAt");

-- AddForeignKey
ALTER TABLE "football_lineups" ADD CONSTRAINT "football_lineups_fixtureId_fkey" FOREIGN KEY ("fixtureId") REFERENCES "football_fixtures"("id") ON DELETE CASCADE ON UPDATE CASCADE;
