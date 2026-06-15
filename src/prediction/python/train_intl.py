#!/usr/bin/env python3
"""Weighted logistic trainer for INTERNATIONAL matches.

Reads {"rows":[...], "config":{...}} from stdin. Config:
  sport     "football_intl" (3-way w/ draw) | "rugby_intl" (2-way)
  features  predictor keys
  target    "target_outcome" (0=home,1=draw,2=away) | "target_home_win" (1/0)
  draw      bool
  artifact  output filename

Uses match_weight as the per-sample weight (friendly .3 / qualifier .7 /
final_tournament 1.0). Temporal holdout = last 10% chronologically (no shuffle).
Reports accuracy + Brier (multiclass for football, binary for rugby).
"""
import sys
import json

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline

import train_common as tc


def main():
    payload = json.loads(sys.stdin.read())
    rows = payload["rows"]
    cfg = payload["config"]
    sport = cfg["sport"]
    feats = cfg["features"]
    target = cfg["target"]
    draw = cfg["draw"]
    n_classes = 3 if draw else 2

    # Features that flip sign under a home<->away swap (orientation-dependent).
    # home_advantage is {0,1}; under a mirror it becomes -1 (modeled-home slot is
    # the visitor). Symmetric augmentation removes the home-slot bias that
    # otherwise squashes the away-win class to ~0 for strong visiting sides.
    SIGNED = {"elo_diff", "rest_diff", "h2h_last_5", "home_advantage"}

    def mirror_outcome(t):
        if draw:
            return {0: 2, 1: 1, 2: 0}[t]   # home<->away, draw unchanged
        return 1 - t

    X, y, w, kept = [], [], [], []
    for r in rows:
        f = r.get("features", {})
        t = f.get(target)
        valid = t in (0, 1, 2) if draw else t in (0, 1)
        if not valid:
            continue
        vec = [tc.finite(f.get(k)) for k in feats]
        weight = tc.finite(f.get("match_weight")) or 0.5
        X.append(vec); y.append(int(t)); w.append(weight); kept.append(r)
        # Mirrored copy (kept aligned to `kept` for the temporal split).
        mvec = []
        for k, v in zip(feats, vec):
            if v is None:
                mvec.append(None)
            elif k in SIGNED:
                mvec.append(-v)
            else:
                mvec.append(v)
        X.append(mvec); y.append(mirror_outcome(int(t))); w.append(weight); kept.append(r)

    if len(X) < 50:
        tc.emit_metrics({"sport": sport, "ok": False, "note": f"too few labelled rows ({len(X)})"})
        return

    Xa = np.array([[np.nan if v is None else v for v in row] for row in X], dtype=float)
    ya = np.array(y, dtype=int)
    wa = np.array(w, dtype=float)

    tr, va = tc.temporal_split(kept, 0.10)
    n_tr = len(tr)
    Xtr, ytr, wtr = Xa[:n_tr], ya[:n_tr], wa[:n_tr]
    Xva, yva = Xa[n_tr:], ya[n_tr:]

    if n_tr < 30 or len(Xva) < 1 or len(np.unique(ytr)) < 2:
        tc.emit_metrics({"sport": sport, "ok": False, "note": "split too small / single class"})
        return

    clf = Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
        # sklearn >=1.7 dropped multi_class; lbfgs defaults to multinomial for
        # >2 classes and binary logistic for 2, which is exactly what we want.
        # Symmetric augmentation (above) already balances home/away, so no
        # class_weight needed — that would double-correct.
        ("lr", LogisticRegression(max_iter=2000, C=1.0)),
    ])
    clf.fit(Xtr, ytr, lr__sample_weight=wtr)

    classes = list(clf.named_steps["lr"].classes_)
    proba = clf.predict_proba(Xva)
    preds = [int(classes[int(np.argmax(p))]) for p in proba]
    val_acc = tc.accuracy(preds, list(yva))

    if draw:
        # Align probability columns to class order 0,1,2.
        col = {c: i for i, c in enumerate(classes)}
        pv = [[float(p[col[k]]) if k in col else 0.0 for k in range(3)] for p in proba]
        val_brier = tc.brier_multiclass(pv, list(yva), 3)
    else:
        col1 = classes.index(1) if 1 in classes else 1
        pv = [float(p[col1]) for p in proba]
        val_brier = tc.brier_binary(pv, list(yva))

    artifact = {
        "sport": sport, "model_type": "logistic_weighted",
        "feature_keys": feats, "target": target, "draw": draw,
        "clf": clf, "classes": classes,
    }
    path = tc.save_artifact(cfg["artifact"], artifact)

    tc.emit_metrics({
        "sport": sport, "ok": True, "model_type": "logistic_weighted",
        "train_rows": int(n_tr), "val_rows": int(len(Xva)),
        "val_accuracy": val_acc, "val_brier": val_brier,
        "features": feats, "artifact_path": path,
    })
    tc.log(f"{sport}: trained {n_tr}, val {len(Xva)}, acc={val_acc}, brier={val_brier}")


if __name__ == "__main__":
    main()
