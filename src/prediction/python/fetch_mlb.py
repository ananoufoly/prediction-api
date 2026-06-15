#!/usr/bin/env python3
"""MLB fetcher. Stateless: prints NDJSON to stdout.

Usage: fetch_mlb.py <season1> [season2 ...]   e.g. fetch_mlb.py 2024 2023

DATA SOURCE NOTE (verified 2026-06-15):
  pybaseball's FanGraphs and Baseball-Reference backends return HTTP 403 from
  this network (FIP/xFIP/wRC+/OPS unavailable). We therefore use MLB's own free
  StatsAPI (statsapi.mlb.com) for schedule, results, ballpark, starting pitcher,
  and per-pitcher ERA. FIP/xFIP and team wRC+/OPS are emitted as null and the
  gap is flagged on the TypeScript side.

Emits records keyed by "kind":
  {"kind":"team_game", ...}    per-team-game result + ballpark + starting pitcher
  {"kind":"pitcher_stat", ...} season-to-date ERA per starting pitcher (FIP/xFIP null)
"""
import sys
import os
import json
import time

import certifi
os.environ.setdefault("SSL_CERT_FILE", certifi.where())
import requests

API = "https://statsapi.mlb.com/api/v1"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "prediction-engine/1.0"})


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def get(url):
    for attempt in range(3):
        try:
            r = SESSION.get(url, timeout=25)
            if r.status_code == 200:
                return r.json()
            log(f"HTTP {r.status_code} {url[:80]}")
        except Exception as e:
            log(f"req err {type(e).__name__} {url[:60]}")
        time.sleep(1.0 + attempt)
    return None


def fetch_season(season):
    sched = get(
        f"{API}/schedule?sportId=1&startDate={season}-03-01&endDate={season}-11-30"
        f"&hydrate=probablePitcher,linescore,venue"
    )
    if not sched:
        log(f"season {season}: no schedule")
        return 0, 0

    pitchers_seen = {}  # id -> name (for ERA pass)
    games = 0
    for day in sched.get("dates", []):
        for g in day.get("games", []):
            status = g.get("status", {}).get("detailedState", "")
            is_final = status == "Final"
            t = g["teams"]
            gid = str(g["gamePk"])
            venue = g.get("venue", {}).get("name")
            game_date = g.get("gameDate", "")[:10]

            for side, opp_side, is_home in (("home", "away", True), ("away", "home", False)):
                tm = t[side]
                opp = t[opp_side]
                rf = tm.get("score")
                ra = opp.get("score")
                won = (rf > ra) if (is_final and rf is not None and ra is not None) else None
                pitcher = tm.get("probablePitcher", {})
                pname = pitcher.get("fullName")
                if pitcher.get("id"):
                    pitchers_seen[pitcher["id"]] = pname
                row = {
                    "kind": "team_game",
                    "season": int(season),
                    "gameDate": game_date,
                    "gameId": gid,
                    "team": tm["team"]["name"],
                    "opponent": opp["team"]["name"],
                    "isHome": is_home,
                    "won": won,
                    "runsFor": rf if rf is not None else None,
                    "runsAgainst": ra if ra is not None else None,
                    "startingPitcher": pname,
                    "ballpark": venue,
                }
                print(json.dumps(row, allow_nan=False), flush=True)
                games += 1

    # Pitcher ERA pass (season-to-date) via people endpoint. Batched to be polite.
    pstats = 0
    ids = list(pitchers_seen.keys())
    for i in range(0, len(ids), 25):
        batch = ids[i : i + 25]
        data = get(
            f"{API}/people?personIds={','.join(map(str, batch))}"
            f"&hydrate=stats(group=pitching,type=season,season={season})"
        )
        if not data:
            continue
        for person in data.get("people", []):
            era = None
            team = None
            for sgroup in person.get("stats", []):
                for split in sgroup.get("splits", []):
                    stat = split.get("stat", {})
                    if stat.get("era") not in (None, "-", ".---"):
                        try:
                            era = float(stat["era"])
                        except ValueError:
                            era = None
                    team = (split.get("team") or {}).get("name")
            row = {
                "kind": "pitcher_stat",
                "season": int(season),
                "asOfDate": f"{season}-11-30",
                "pitcherName": person.get("fullName"),
                "pitcherId": person.get("id"),
                "team": team,
                "era": era,
                "fip": None,   # FanGraphs blocked — gap flagged downstream
                "xfip": None,
                "ip": None,
            }
            if row["pitcherName"]:
                print(json.dumps(row, allow_nan=False), flush=True)
                pstats += 1
        time.sleep(0.3)

    log(f"season {season}: {games} team-games, {pstats} pitcher-stats")
    return games, pstats


def fetch_window(start_date, end_date):
    """Emit team_game rows for a date window (used for UPCOMING fixtures).
    Non-final games carry won=null; runs are null until played."""
    sched = get(
        f"{API}/schedule?sportId=1&startDate={start_date}&endDate={end_date}"
        f"&hydrate=probablePitcher,linescore,venue"
    )
    if not sched:
        log(f"window {start_date}..{end_date}: no schedule")
        return 0
    season = int(start_date[:4])
    games = 0
    for day in sched.get("dates", []):
        for g in day.get("games", []):
            status = g.get("status", {}).get("detailedState", "")
            is_final = status == "Final"
            t = g["teams"]
            gid = str(g["gamePk"])
            venue = g.get("venue", {}).get("name")
            game_date = g.get("gameDate", "")[:10]
            for side, opp_side, is_home in (("home", "away", True), ("away", "home", False)):
                tm = t[side]; opp = t[opp_side]
                rf = tm.get("score"); ra = opp.get("score")
                won = (rf > ra) if (is_final and rf is not None and ra is not None) else None
                row = {
                    "kind": "team_game", "season": season, "gameDate": game_date, "gameId": gid,
                    "team": tm["team"]["name"], "opponent": opp["team"]["name"], "isHome": is_home,
                    "won": won, "runsFor": rf, "runsAgainst": ra,
                    "startingPitcher": tm.get("probablePitcher", {}).get("fullName"), "ballpark": venue,
                }
                print(json.dumps(row, allow_nan=False), flush=True)
                games += 1
    log(f"window {start_date}..{end_date}: {games} team-games")
    return games


def main():
    args = sys.argv[1:]
    # Upcoming mode: fetch_mlb.py --upcoming <start YYYY-MM-DD> <end YYYY-MM-DD>
    if args and args[0] == "--upcoming":
        start, end = args[1], args[2]
        n = fetch_window(start, end)
        log(f"total upcoming team_games={n}")
        return
    seasons = args
    if not seasons:
        log("no seasons given")
        sys.exit(2)
    tg = ps = 0
    for s in seasons:
        try:
            a, b = fetch_season(s)
            tg += a
            ps += b
        except Exception as e:
            log(f"season {s} ERROR: {type(e).__name__}: {e}")
    log(f"total team_games={tg} pitcher_stats={ps} | NOTE: FIP/xFIP/wRC+/OPS unavailable (FanGraphs 403)")


if __name__ == "__main__":
    main()
