#!/usr/bin/env python3
"""Inference for the football Dixon-Coles model.

Reads {"artifact": "<file>", "rows": [{matchKey, homeTeam, awayTeam, features}, ...]}
from stdin. Emits one NDJSON line per row:
  {"matchKey","pHome","pDraw","pAway","expectedHomeGoals","expectedAwayGoals","flag"}
flag="unknown_team" when a team was not in the training set (no fitted strength).
"""
import sys
import os
import json

import numpy as np
import joblib
from scipy.stats import poisson

MODELS_DIR = os.path.join(os.path.dirname(__file__), "..", "models")


def tau(h, a, lam, mu, rho):
    if h == 0 and a == 0:
        return 1.0 - lam * mu * rho
    if h == 0 and a == 1:
        return 1.0 + lam * rho
    if h == 1 and a == 0:
        return 1.0 + mu * rho
    if h == 1 and a == 1:
        return 1.0 - rho
    return 1.0


def score_matrix(lam, mu, rho, max_goals):
    m = np.outer(poisson.pmf(np.arange(max_goals + 1), lam),
                 poisson.pmf(np.arange(max_goals + 1), mu))
    for h in range(2):
        for a in range(2):
            m[h, a] *= tau(h, a, lam, mu, rho)
    s = m.sum()
    return m / s if s > 0 else m


def main():
    payload = json.loads(sys.stdin.read())
    art = joblib.load(os.path.join(MODELS_DIR, payload["artifact"]))
    rows = payload["rows"]

    teams = art["teams"]
    tindex = {t: i for i, t in enumerate(teams)}
    attack = np.array(art["attack"])
    defence = np.array(art["defence"])
    home_adv = art["home_adv"]
    rho = art["rho"]
    max_goals = art["max_goals"]

    for r in rows:
        ht, at = r.get("homeTeam"), r.get("awayTeam")
        if ht not in tindex or at not in tindex:
            print(json.dumps({"matchKey": r["matchKey"], "flag": "unknown_team"}), flush=True)
            continue
        lam = float(np.exp(home_adv + attack[tindex[ht]] - defence[tindex[at]]))
        mu = float(np.exp(attack[tindex[at]] - defence[tindex[ht]]))
        lam, mu = min(max(lam, 1e-5), 25), min(max(mu, 1e-5), 25)
        m = score_matrix(lam, mu, rho, max_goals)
        p_home = float(np.tril(m, -1).sum())
        p_draw = float(np.trace(m))
        p_away = float(np.triu(m, 1).sum())
        print(json.dumps({
            "matchKey": r["matchKey"],
            "pHome": p_home, "pDraw": p_draw, "pAway": p_away,
            "expectedHomeGoals": lam, "expectedAwayGoals": mu,
        }), flush=True)


if __name__ == "__main__":
    main()
