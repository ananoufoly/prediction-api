#!/usr/bin/env python3
"""NBA fetcher (nba_api). Stateless: prints NDJSON game-log rows to stdout.

Usage: fetch_nba.py <season1> [season2 ...]   e.g. fetch_nba.py 2024-25 2023-24

Each stdout line is one team-game with merged basic + advanced ratings. All DB
writes happen on the TypeScript side; this script only fetches and normalises.
Diagnostics go to stderr.
"""
import sys
import json
import time

from nba_api.stats.endpoints import teamgamelogs


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def fetch_season(season):
    base = teamgamelogs.TeamGameLogs(
        season_nullable=season, season_type_nullable="Regular Season"
    ).get_data_frames()[0]
    time.sleep(0.6)
    adv = teamgamelogs.TeamGameLogs(
        season_nullable=season,
        season_type_nullable="Regular Season",
        measure_type_player_game_logs_nullable="Advanced",
    ).get_data_frames()[0]

    adv_idx = {
        (r["GAME_ID"], r["TEAM_ID"]): r
        for _, r in adv[["GAME_ID", "TEAM_ID", "OFF_RATING", "DEF_RATING", "NET_RATING", "PACE"]].iterrows()
    }

    count = 0
    for _, r in base.iterrows():
        matchup = r.get("MATCHUP", "") or ""
        is_home = "vs." in matchup
        opp = matchup.split()[-1] if matchup else None
        a = adv_idx.get((r["GAME_ID"], r["TEAM_ID"]), {})
        wl = r.get("WL")
        row = {
            "season": season,
            "gameId": str(r["GAME_ID"]),
            "gameDate": str(r["GAME_DATE"]),
            "teamId": int(r["TEAM_ID"]),
            "teamAbbrev": r.get("TEAM_ABBREVIATION"),
            "opponentAbbrev": opp,
            "isHome": bool(is_home),
            "won": (wl == "W") if wl in ("W", "L") else None,
            "pts": int(r["PTS"]) if r.get("PTS") == r.get("PTS") else None,
            "offRating": float(a["OFF_RATING"]) if "OFF_RATING" in a and a["OFF_RATING"] == a["OFF_RATING"] else None,
            "defRating": float(a["DEF_RATING"]) if "DEF_RATING" in a and a["DEF_RATING"] == a["DEF_RATING"] else None,
            "netRating": float(a["NET_RATING"]) if "NET_RATING" in a and a["NET_RATING"] == a["NET_RATING"] else None,
            "pace": float(a["PACE"]) if "PACE" in a and a["PACE"] == a["PACE"] else None,
        }
        print(json.dumps(row, allow_nan=False), flush=True)
        count += 1
    return count


def main():
    seasons = sys.argv[1:]
    if not seasons:
        log("no seasons given")
        sys.exit(2)
    total = 0
    for s in seasons:
        try:
            n = fetch_season(s)
            log(f"season {s}: {n} team-games")
            total += n
            time.sleep(0.8)
        except Exception as e:
            log(f"season {s} ERROR: {type(e).__name__}: {e}")
    log(f"total {total}")


if __name__ == "__main__":
    main()
