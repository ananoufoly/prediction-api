#!/usr/bin/env python3
"""Generic logistic-regression trainer for tennis / NBA / NFL / MLB.

Reads {"rows":[...], "config":{...}} from stdin. Each row is a prediction_features
record: {"matchKey","kickoffUtc","features":{...}}. Config specifies:
  sport          str
  target         str   feature key holding the binary outcome (1/0)
  features       [str] feature keys used as predictors (order fixed)
  margin_target  str?  feature key for an expected-margin regressor (optional)
  artifact       str   filename to write under models/

Protocol: train on rows with a known target, hold out the LAST 10%
chronologically (rows arrive pre-sorted ascending), report val accuracy + Brier.

Outputs one metrics JSON to stdout.
"""
import sys
import json

import numpy as np
from sklearn.linear_model import LogisticRegression, LinearRegression
from sklearn.preprocessing import StandardScaler
from sklearn.impute import SimpleImputer
from sklearn.pipeline import Pipeline
from sklearn.calibration import CalibratedClassifierCV
from sklearn.frozen import FrozenEstimator

import train_common as tc


def build_xy(rows, feature_keys, target_key, symmetrize=None):
    """Build the design matrix. When `symmetrize` is given (a dict mapping a
    feature key to its swapped/negated counterpart), every other row is mirrored
    to the loser's perspective with target=0 — needed for tennis, where A is
    always the recorded winner (single-class without mirroring). The mirror is
    deterministic (even index) so the temporal split stays reproducible."""
    X, y, kept = [], [], []
    for i, r in enumerate(rows):
        f = r.get("features", {})
        t = f.get(target_key)
        if t not in (0, 1):
            continue
        vec = [tc.finite(f.get(k)) for k in feature_keys]
        if symmetrize and i % 2 == 1:
            # Mirror to B's perspective: apply the swap/negate map, target -> 1-t.
            mirrored = []
            for k in feature_keys:
                op = symmetrize.get(k)
                v = tc.finite(f.get(k))
                if op == "negate":
                    mirrored.append(-v if v is not None else None)
                elif op and op in f:  # swap with counterpart key
                    mirrored.append(tc.finite(f.get(op)))
                else:
                    mirrored.append(v)
            X.append(mirrored)
            y.append(1 - int(t))
        else:
            X.append(vec)
            y.append(int(t))
        kept.append(r)
    return X, y, kept


def main():
    payload = json.loads(sys.stdin.read())
    rows = payload["rows"]
    cfg = payload["config"]
    sport = cfg["sport"]
    feature_keys = cfg["features"]
    target_key = cfg["target"]

    X, y, kept = build_xy(rows, feature_keys, target_key, cfg.get("symmetrize"))
    if len(X) < 30:
        tc.emit_metrics({"sport": sport, "ok": False, "note": f"too few labelled rows ({len(X)})"})
        return

    # numpy with NaN for missing; pipeline imputes + scales.
    Xa = np.array([[np.nan if v is None else v for v in row] for row in X], dtype=float)
    ya = np.array(y, dtype=int)

    train_rows, val_rows = tc.temporal_split(kept, 0.10)
    n_train = len(train_rows)
    Xtr, ytr = Xa[:n_train], ya[:n_train]
    Xva, yva = Xa[n_train:], ya[n_train:]

    if n_train < 20 or len(Xva) < 1:
        tc.emit_metrics({"sport": sport, "ok": False, "note": "split too small"})
        return

    base = Pipeline([
        ("impute", SimpleImputer(strategy="median")),
        ("scale", StandardScaler()),
        ("lr", LogisticRegression(max_iter=1000, C=1.0)),
    ])

    # --- Platt scaling (sigmoid calibration) with temporal integrity ---
    # Split the TRAIN portion chronologically: fit the base model on the earlier
    # part, calibrate the sigmoid link on the later part. The temporal validation
    # holdout (Xva) is never seen during fit OR calibration.
    n_cal = max(20, int(round(n_train * 0.20)))
    n_base = n_train - n_cal
    can_calibrate = n_base >= 20 and n_cal >= 10 and len(np.unique(ytr[n_base:])) == 2

    # Uncalibrated model (fit on full train) — the baseline to beat.
    base.fit(Xtr, ytr)
    raw_brier = raw_acc = None
    if len(Xva) > 0:
        raw_proba = base.predict_proba(Xva)[:, 1]
        raw_acc = tc.accuracy(list((raw_proba >= 0.5).astype(int)), list(yva))
        raw_brier = tc.brier_binary(list(raw_proba), list(yva))

    cal_clf = None
    cal_brier = None
    if can_calibrate:
        base_cal = Pipeline([
            ("impute", SimpleImputer(strategy="median")),
            ("scale", StandardScaler()),
            ("lr", LogisticRegression(max_iter=1000, C=1.0)),
        ])
        base_cal.fit(Xtr[:n_base], ytr[:n_base])
        # sklearn >=1.6: wrap the prefit estimator in FrozenEstimator (replaces
        # the removed cv='prefit'); CalibratedClassifierCV then fits ONLY the
        # sigmoid (Platt) link on the held-out calibration slice.
        cal_clf = CalibratedClassifierCV(FrozenEstimator(base_cal), method="sigmoid")
        cal_clf.fit(Xtr[n_base:], ytr[n_base:])
        if len(Xva) > 0:
            cal_brier = tc.brier_binary(list(cal_clf.predict_proba(Xva)[:, 1]), list(yva))

    # Choose the model with the better (lower) validation Brier. Logistic outputs
    # are often already near-calibrated, so Platt only helps for some sports;
    # adopting it blindly would ship worse probabilities. Pick per-model.
    if cal_clf is not None and cal_brier is not None and raw_brier is not None and cal_brier <= raw_brier:
        clf, calibrated = cal_clf, True
    else:
        clf, calibrated = base, False
        if can_calibrate:
            tc.log(f"{sport}: calibration did not improve Brier "
                   f"(cal={cal_brier} vs raw={raw_brier}) — keeping uncalibrated")
        else:
            tc.log(f"{sport}: calibration skipped (n_base={n_base}, n_cal={n_cal})")

    # Validation metrics for the CHOSEN model.
    val_acc = val_brier = None
    if len(Xva) > 0:
        proba = clf.predict_proba(Xva)[:, 1]
        preds = (proba >= 0.5).astype(int)
        val_acc = tc.accuracy(list(preds), list(yva))
        val_brier = tc.brier_binary(list(proba), list(yva))

    # Optional expected-margin regressor (e.g. NBA point margin, MLB run line).
    margin_info = None
    margin_key = cfg.get("margin_target")
    if margin_key:
        mX, mY = [], []
        for r in train_rows:
            f = r.get("features", {})
            m = tc.finite(f.get(margin_key))
            if m is None:
                continue
            mX.append([tc.finite(f.get(k)) for k in feature_keys])
            mY.append(m)
        if len(mX) >= 30:
            mXa = np.array([[np.nan if v is None else v for v in row] for row in mX], dtype=float)
            reg = Pipeline([
                ("impute", SimpleImputer(strategy="median")),
                ("scale", StandardScaler()),
                ("lin", LinearRegression()),
            ])
            reg.fit(mXa, np.array(mY, dtype=float))
            margin_info = {"trained": True, "n": len(mX)}
        else:
            reg = None
            margin_info = {"trained": False, "n": len(mX)}
    else:
        reg = None

    # Coefficients summary (on scaled inputs) from the underlying logistic model.
    # The uncalibrated `base` pipeline always exposes named_steps; the calibrated
    # wrapper only changes how probabilities are mapped, not the coefficients.
    lr = base.named_steps["lr"]
    coefs = {k: float(c) for k, c in zip(feature_keys, lr.coef_[0])}

    artifact = {
        "sport": sport,
        "model_type": "logistic",
        "feature_keys": feature_keys,
        "target": target_key,
        "clf": clf,                 # calibrated when available
        "calibrated": calibrated,
        "margin_reg": reg,
        "margin_target": margin_key,
    }
    path = tc.save_artifact(cfg["artifact"], artifact)

    tc.emit_metrics({
        "sport": sport,
        "ok": True,
        "model_type": "logistic",
        "calibrated": calibrated,
        "calibration": "platt_sigmoid" if calibrated else "none",
        "train_rows": int(n_train),
        "val_rows": int(len(Xva)),
        "val_accuracy": val_acc,
        "val_brier": val_brier,                 # chosen model's Brier
        "val_brier_uncalibrated": raw_brier,    # always the raw baseline
        "val_brier_calibrated": cal_brier,      # Platt-scaled (None if not computed)
        "val_accuracy_uncalibrated": raw_acc,
        "brier_improvement": (raw_brier - cal_brier) if (raw_brier is not None and cal_brier is not None) else None,
        "features": feature_keys,
        "coefficients": coefs,
        "margin": margin_info,
        "artifact_path": path,
    })
    tc.log(f"{sport}: trained on {n_train}, val {len(Xva)}, acc={val_acc}, "
           f"brier={val_brier} (uncal {raw_brier}), calibrated={calibrated}")


if __name__ == "__main__":
    main()
