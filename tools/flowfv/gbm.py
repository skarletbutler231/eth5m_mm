# The compact model (export_model.py's output) evaluated in numpy, by src/model/gbm.ts's rules: NaN counts as 0 unless
# the split's missing type is NaN (2); a missing value (NaN for type 2, |x| <= 1e-35 for type Zero 1) goes to the default side.
# Used to score the model in use on the new days next to the retrained one.
import json
import numpy as np


def predict(model, X):
    """model: a gbm-compact-1 dict; X: rows x model["features"] (float, NaN = missing)."""
    X = np.asarray(X, np.float64); n = len(X); out = np.zeros(n)
    for t in model["trees"]:
        if t["root"] < 0: out += t["v"][~t["root"]]; continue
        f = np.array(t["f"]); th = np.array(t["t"]); d = np.array(t["d"]); mt = np.array(t["m"])
        L = np.array(t["l"]); R = np.array(t["r"]); V = np.array(t["v"])
        k = np.full(n, t["root"]); rows = np.arange(n); act = k >= 0
        while act.any():
            r = rows[act]; kk = k[r]
            v = X[r, f[kk]]; m = mt[kk]
            v = np.where(np.isnan(v) & (m != 2), 0.0, v)
            miss = ((m == 1) & (np.abs(v) <= 1e-35)) | ((m == 2) & np.isnan(v))
            left = np.where(miss, d[kk] == 1, v <= th[kk])
            k[r] = np.where(left, L[kk], R[kk])
            act = k >= 0
        out += V[~k]
    return out


def load(path):
    return json.load(open(path))
