#!/usr/bin/env python3
"""Inference for international weighted-logistic models (football_intl / rugby_intl).

Reads {"artifact": "<file>", "rows": [{matchKey, features}, ...]} from stdin.
Emits one NDJSON line per row. For football_intl (3-way):
  {"matchKey","pHome","pDraw","pAway"}
For rugby_intl (2-way):
  {"matchKey","pHome","pAway"}
"""
import sys
import os
import json

import numpy as np
import joblib

import train_common as tc

MODELS_DIR = os.path.join(os.path.dirname(__file__), "..", "models")


def main():
    payload = json.loads(sys.stdin.read())
    art = joblib.load(os.path.join(MODELS_DIR, payload["artifact"]))
    rows = payload["rows"]
    clf = art["clf"]
    feats = art["feature_keys"]
    draw = art["draw"]
    classes = list(art["classes"])

    for r in rows:
        f = r.get("features", {})
        x = np.array([[np.nan if tc.finite(f.get(k)) is None else tc.finite(f.get(k)) for k in feats]], dtype=float)
        proba = clf.predict_proba(x)[0]
        col = {c: i for i, c in enumerate(classes)}
        if draw:
            print(json.dumps({
                "matchKey": r["matchKey"],
                "pHome": float(proba[col[0]]) if 0 in col else 0.0,
                "pDraw": float(proba[col[1]]) if 1 in col else 0.0,
                "pAway": float(proba[col[2]]) if 2 in col else 0.0,
            }), flush=True)
        else:
            p_home = float(proba[col[1]]) if 1 in col else 0.0
            print(json.dumps({
                "matchKey": r["matchKey"], "pHome": p_home, "pAway": 1.0 - p_home,
            }), flush=True)


if __name__ == "__main__":
    main()
