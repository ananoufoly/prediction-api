#!/usr/bin/env python3
"""Inference for logistic models (tennis / NBA / NFL / MLB).

Reads {"artifact": "<file>", "rows": [{matchKey, features}, ...]} from stdin.
Loads the serialised artifact and emits one NDJSON line per row:
  {"matchKey", "pHome", "pAway", "expectedMargin"}
For tennis, pHome == P(player A wins), pAway == 1 - pHome.
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
    artifact = joblib.load(os.path.join(MODELS_DIR, payload["artifact"]))
    rows = payload["rows"]

    clf = artifact["clf"]
    feature_keys = artifact["feature_keys"]
    margin_reg = artifact.get("margin_reg")

    for r in rows:
        f = r.get("features", {})
        x = np.array([[np.nan if tc.finite(f.get(k)) is None else tc.finite(f.get(k)) for k in feature_keys]], dtype=float)
        p_home = float(clf.predict_proba(x)[0, 1])
        margin = None
        if margin_reg is not None:
            margin = float(margin_reg.predict(x)[0])
        print(json.dumps({
            "matchKey": r["matchKey"],
            "pHome": p_home,
            "pAway": 1.0 - p_home,
            "expectedMargin": margin,
        }), flush=True)


if __name__ == "__main__":
    main()
