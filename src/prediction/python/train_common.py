"""Shared training utilities for the prediction-engine models.

All trainers read feature rows as JSON from stdin (exported by the TypeScript
layer from prediction_features — the ONLY training input, no raw re-fetch),
train, serialise an artifact to src/prediction/models/, and print a single JSON
metrics object to stdout. Diagnostics go to stderr.

Training protocol (per spec):
  - train on all historical rows with KNOWN outcomes
  - hold out the LAST 10% chronologically (no shuffle) as validation
  - report validation accuracy + Brier score
"""
import sys
import os
import json
import math

MODELS_DIR = os.path.join(os.path.dirname(__file__), "..", "models")


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def read_rows():
    """Read the feature payload from stdin: {"rows": [...]} sorted by caller."""
    raw = sys.stdin.read()
    payload = json.loads(raw)
    return payload.get("rows", [])


def temporal_split(rows, holdout_frac=0.10):
    """Last `holdout_frac` (chronological) as validation. Rows must arrive
    already sorted ascending by kickoff. No shuffling — temporal integrity."""
    n = len(rows)
    n_val = max(1, int(round(n * holdout_frac))) if n > 0 else 0
    n_train = n - n_val
    return rows[:n_train], rows[n_train:]


def brier_binary(probs, outcomes):
    """Mean squared error between P(positive) and binary outcome."""
    if not probs:
        return None
    return sum((p - y) ** 2 for p, y in zip(probs, outcomes)) / len(probs)


def brier_multiclass(prob_vectors, outcomes, n_classes):
    """Multiclass Brier: mean over samples of sum_k (p_k - 1{y==k})^2."""
    if not prob_vectors:
        return None
    total = 0.0
    for probs, y in zip(prob_vectors, outcomes):
        total += sum((probs[k] - (1.0 if y == k else 0.0)) ** 2 for k in range(n_classes))
    return total / len(prob_vectors)


def accuracy(preds, outcomes):
    if not preds:
        return None
    return sum(1 for p, y in zip(preds, outcomes) if p == y) / len(preds)


def save_artifact(name, obj):
    """Serialise a model artifact (joblib) and return its path."""
    import joblib
    os.makedirs(MODELS_DIR, exist_ok=True)
    path = os.path.join(MODELS_DIR, name)
    joblib.dump(obj, path)
    return os.path.abspath(path)


def emit_metrics(metrics):
    """Print the single metrics JSON object to stdout."""
    print(json.dumps(metrics), flush=True)


def finite(x):
    """Return float(x) if finite, else None."""
    try:
        f = float(x)
        return f if math.isfinite(f) else None
    except (TypeError, ValueError):
        return None
