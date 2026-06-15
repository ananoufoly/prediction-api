#!/usr/bin/env python3
"""NFL fetcher (nfl_data_py). Stateless: prints NDJSON to stdout.

Usage: fetch_nfl.py <year1> [year2 ...]   e.g. fetch_nfl.py 2023 2022

Emits two record kinds, distinguished by "kind":
  {"kind":"team_game", ...}  per-team-game result + rolled-up offense/defense EPA
  {"kind":"injury", ...}     weekly injury report rows

All DB writes are on the TypeScript side.
"""
import sys
import os
import json
import contextlib

import certifi
# Several nfl_data_py data hosts require the certifi CA bundle on macOS.
os.environ.setdefault("SSL_CERT_FILE", certifi.where())
os.environ.setdefault("REQUESTS_CA_BUNDLE", certifi.where())

import nfl_data_py as nfl


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def num(v):
    try:
        f = float(v)
        return f if f == f else None  # drop NaN
    except (TypeError, ValueError):
        return None


def text(v):
    """Coerce pandas values to a clean str or None (NaN -> None)."""
    if v is None:
        return None
    # pandas float NaN: v != v is True only for NaN.
    if isinstance(v, float) and v != v:
        return None
    s = str(v).strip()
    return s if s and s.lower() != "nan" else None


def fetch_year(year):
    # nfl_data_py prints progress to stdout ("Downcasting floats.", "<year> done.")
    # which would corrupt our NDJSON stream — redirect it to stderr.
    with contextlib.redirect_stdout(sys.stderr):
        sched = nfl.import_schedules([year])
        pbp = nfl.import_pbp_data([year], downcast=True, cache=False)

    # Roll up offensive EPA/play per (game, team) from pbp.
    pbp = pbp.dropna(subset=["epa", "posteam"])
    off = pbp.groupby(["game_id", "posteam"])["epa"].mean().to_dict()
    # Defensive EPA/play = EPA allowed = mean epa where team is defteam.
    deff = pbp.groupby(["game_id", "defteam"])["epa"].mean().to_dict()

    count = 0
    for _, g in sched.iterrows():
        gid = g["game_id"]
        hs, as_ = num(g.get("home_score")), num(g.get("away_score"))
        played = hs is not None and as_ is not None
        for team, opp, is_home, pf, pa in (
            (g["home_team"], g["away_team"], True, hs, as_),
            (g["away_team"], g["home_team"], False, as_, hs),
        ):
            won = None
            if played:
                won = pf > pa
            row = {
                "kind": "team_game",
                "season": int(year),
                "week": int(g["week"]),
                "gameId": gid,
                "gameDate": str(g.get("gameday")) if g.get("gameday") == g.get("gameday") else None,
                "team": team,
                "opponent": opp,
                "isHome": bool(is_home),
                "won": won,
                "pointsFor": int(pf) if pf is not None else None,
                "pointsAgainst": int(pa) if pa is not None else None,
                "offEpaPerPlay": num(off.get((gid, team))),
                "defEpaPerPlay": num(deff.get((gid, team))),
            }
            print(json.dumps(row, allow_nan=False), flush=True)
            count += 1

    # Injuries
    inj_count = 0
    try:
        with contextlib.redirect_stdout(sys.stderr):
            inj = nfl.import_injuries([year])
        for _, r in inj.iterrows():
            row = {
                "kind": "injury",
                "season": int(year),
                "week": int(r["week"]) if r.get("week") == r.get("week") else 0,
                "team": text(r.get("team")),
                "playerName": text(r.get("full_name")),
                "position": text(r.get("position")),
                "status": text(r.get("report_status")),
                "reason": text(r.get("report_primary_injury")),
            }
            if not row["team"] or not row["playerName"]:
                continue
            print(json.dumps(row, allow_nan=False), flush=True)
            inj_count += 1
    except Exception as e:
        log(f"injuries {year} ERROR: {type(e).__name__}: {e}")

    return count, inj_count


def fetch_upcoming(year):
    """Schedule-only pull for UPCOMING games (no pbp/injuries). Emits unplayed
    team_game rows with won=null and null EPA (no plays yet)."""
    with contextlib.redirect_stdout(sys.stderr):
        sched = nfl.import_schedules([year])
    count = 0
    for _, g in sched.iterrows():
        hs, as_ = num(g.get("home_score")), num(g.get("away_score"))
        if hs is not None and as_ is not None:
            continue  # already played
        gd = str(g.get("gameday")) if g.get("gameday") == g.get("gameday") else None
        for team, opp, is_home in ((g["home_team"], g["away_team"], True),
                                   (g["away_team"], g["home_team"], False)):
            row = {
                "kind": "team_game", "season": int(year), "week": int(g["week"]),
                "gameId": g["game_id"], "gameDate": gd, "team": team, "opponent": opp,
                "isHome": bool(is_home), "won": None, "pointsFor": None, "pointsAgainst": None,
                "offEpaPerPlay": None, "defEpaPerPlay": None,
            }
            print(json.dumps(row, allow_nan=False), flush=True)
            count += 1
    log(f"upcoming {year}: {count} team-games")
    return count


def main():
    years = sys.argv[1:]
    if years and years[0] == "--upcoming":
        fetch_upcoming(int(years[1]))
        return
    if not years:
        log("no years given")
        sys.exit(2)
    tg = ij = 0
    for y in years:
        try:
            a, b = fetch_year(int(y))
            tg += a
            ij += b
            log(f"year {y}: {a} team-games, {b} injuries")
        except Exception as e:
            log(f"year {y} ERROR: {type(e).__name__}: {e}")
    log(f"total team_games={tg} injuries={ij}")


if __name__ == "__main__":
    main()
