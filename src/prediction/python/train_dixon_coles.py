#!/usr/bin/env python3
"""Dixon-Coles Poisson trainer for football.

Reads {"rows":[...], "config":{...}} from stdin. Rows are prediction_features
records carrying actual_home_goals / actual_away_goals / target_outcome plus the
rolling features. Fits per-team attack & defence strengths, a global home
advantage, and the Dixon-Coles low-score dependence parameter rho via MLE on the
actual scorelines (scipy.optimize.minimize, scipy.stats.poisson).

Protocol: fit on the first 90% chronologically, validate on the LAST 10% by
predicting P(home/draw/away) from the score matrix and scoring accuracy +
multiclass Brier. No shuffle.

Outputs one metrics JSON to stdout.
"""
import sys
import json

import numpy as np
from scipy.optimize import minimize
from scipy.stats import poisson

import train_common as tc

MAX_GOALS = 10  # truncate the score matrix at 10-10


def tau(h, a, lam, mu, rho):
    """Dixon-Coles low-score correction factor."""
    if h == 0 and a == 0:
        return 1.0 - lam * mu * rho
    if h == 0 and a == 1:
        return 1.0 + lam * rho
    if h == 1 and a == 0:
        return 1.0 + mu * rho
    if h == 1 and a == 1:
        return 1.0 - rho
    return 1.0


def neg_log_likelihood(params, hg, ag, hi, ai, n_teams):
    attack = params[:n_teams]
    defence = params[n_teams:2 * n_teams]
    home_adv = params[2 * n_teams]
    rho = params[2 * n_teams + 1]

    lam = np.exp(home_adv + attack[hi] - defence[ai])     # home expected goals
    mu = np.exp(attack[ai] - defence[hi])                  # away expected goals
    lam = np.clip(lam, 1e-5, 25)
    mu = np.clip(mu, 1e-5, 25)

    ll = poisson.logpmf(hg, lam) + poisson.logpmf(ag, mu)
    # Dixon-Coles correction (only affects 0/1 goal cells).
    t = np.ones_like(lam)
    for idx in range(len(hg)):
        if hg[idx] <= 1 and ag[idx] <= 1:
            tv = tau(hg[idx], ag[idx], lam[idx], mu[idx], rho)
            t[idx] = max(tv, 1e-5)
    ll = ll + np.log(t)
    return -np.sum(ll)


def score_matrix(lam, mu, rho):
    m = np.outer(poisson.pmf(np.arange(MAX_GOALS + 1), lam),
                 poisson.pmf(np.arange(MAX_GOALS + 1), mu))
    # Apply DC correction to the 2x2 low-score block.
    for h in range(2):
        for a in range(2):
            m[h, a] *= tau(h, a, lam, mu, rho)
    s = m.sum()
    return m / s if s > 0 else m


def outcome_probs(m):
    p_home = np.tril(m, -1).sum()   # home goals > away goals
    p_draw = np.trace(m)
    p_away = np.triu(m, 1).sum()
    return float(p_home), float(p_draw), float(p_away)


def main():
    payload = json.loads(sys.stdin.read())
    rows = payload["rows"]
    cfg = payload["config"]

    # Keep rows with a real scoreline.
    labelled = []
    for r in rows:
        f = r.get("features", {})
        hg, ag = f.get("actual_home_goals"), f.get("actual_away_goals")
        if isinstance(hg, int) and isinstance(ag, int):
            labelled.append((r, hg, ag))

    if len(labelled) < 100:
        tc.emit_metrics({"sport": "football", "ok": False, "note": f"too few scorelines ({len(labelled)})"})
        return

    train, val = tc.temporal_split([x[0] for x in labelled], 0.10)
    n_train = len(train)
    train_set = labelled[:n_train]
    val_set = labelled[n_train:]

    # Team index from TRAIN only (avoid leaking val-only teams into the fit).
    teams = sorted({r["homeTeam"] for r, _, _ in train_set} | {r["awayTeam"] for r, _, _ in train_set})
    tindex = {t: i for i, t in enumerate(teams)}
    n_teams = len(teams)

    hi, ai, hg, ag = [], [], [], []
    for r, h, a in train_set:
        if r["homeTeam"] not in tindex or r["awayTeam"] not in tindex:
            continue
        hi.append(tindex[r["homeTeam"]])
        ai.append(tindex[r["awayTeam"]])
        hg.append(h)
        ag.append(a)
    hi, ai = np.array(hi), np.array(ai)
    hg, ag = np.array(hg), np.array(ag)

    # Initial params: attack=0, defence=0, home_adv=0.25, rho=-0.1
    x0 = np.concatenate([np.zeros(n_teams), np.zeros(n_teams), [0.25, -0.1]])
    # Sum-to-zero constraint on attack keeps the model identifiable.
    cons = [{"type": "eq", "fun": lambda p: np.sum(p[:n_teams])}]
    tc.log(f"football: fitting DC on {len(hg)} matches, {n_teams} teams...")
    res = minimize(
        neg_log_likelihood, x0, args=(hg, ag, hi, ai, n_teams),
        method="SLSQP", constraints=cons,
        options={"maxiter": 200, "ftol": 1e-6},
    )
    params = res.x
    attack = params[:n_teams]
    defence = params[n_teams:2 * n_teams]
    home_adv = float(params[2 * n_teams])
    rho = float(params[2 * n_teams + 1])

    # Validation: predict 1X2 on held-out matches.
    prob_vecs, outcomes, expected = [], [], []
    for r, h, a in val_set:
        ht, at = r["homeTeam"], r["awayTeam"]
        if ht not in tindex or at not in tindex:
            continue  # unseen team — cannot predict from fitted strengths
        lam = float(np.exp(home_adv + attack[tindex[ht]] - defence[tindex[at]]))
        mu = float(np.exp(attack[tindex[at]] - defence[tindex[ht]]))
        lam, mu = min(max(lam, 1e-5), 25), min(max(mu, 1e-5), 25)
        m = score_matrix(lam, mu, rho)
        ph, pd, pa = outcome_probs(m)
        prob_vecs.append([ph, pd, pa])           # class order: 0=home,1=draw,2=away
        out = 0 if h > a else (1 if h == a else 2)
        outcomes.append(out)
        expected.append((lam, mu))

    val_acc = val_brier = None
    if prob_vecs:
        preds = [int(np.argmax(v)) for v in prob_vecs]
        val_acc = tc.accuracy(preds, outcomes)
        val_brier = tc.brier_multiclass(prob_vecs, outcomes, 3)

    artifact = {
        "sport": "football",
        "model_type": "dixon_coles",
        "teams": teams,
        "attack": attack.tolist(),
        "defence": defence.tolist(),
        "home_adv": home_adv,
        "rho": rho,
        "max_goals": MAX_GOALS,
    }
    path = tc.save_artifact(cfg["artifact"], artifact)

    tc.emit_metrics({
        "sport": "football",
        "ok": True,
        "model_type": "dixon_coles",
        "train_rows": int(n_train),
        "val_rows": int(len(prob_vecs)),
        "val_accuracy": val_acc,
        "val_brier": val_brier,        # multiclass (3-outcome) Brier
        "features": ["attack", "defence", "home_adv", "rho"],
        "home_adv": home_adv,
        "rho": rho,
        "n_teams": n_teams,
        "converged": bool(res.success),
        "artifact_path": path,
    })
    tc.log(f"football: DC fit success={res.success} acc={val_acc} brier={val_brier}")


if __name__ == "__main__":
    main()
