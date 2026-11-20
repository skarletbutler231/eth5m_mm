# The deployable flow-FV model: LightGBM on the Up mid's move over H s, features the bot computes live (Binance taker
# flows dropped: the live feeds are bookTickers). BTC's train_ffv.py, on the ETH panel. Two fits:
#   val   train split, early stop on the val split  -> its test R2 is the out-of-sample number
#   prod  every day, with the val fit's rounds x 1.2 -> the model the bot runs
# The model in use (FLOWFV_BASE, default models/flowfv-h<H>.json) is scored on the same test days for comparison.
# Writes <DATA>/ffv_h<H>_{val,prod}.json (LightGBM dump_model + our feature list), ffv_h<H>_prod_vectors.json (the
# self-test's reference predictions) and ffv_h<H>_report.json.
# Usage: python3 -I train_ffv.py [H]   (env FLOWFV_TRAIN_END / FLOWFV_VAL_END, FLOWFV_TAG, NPROC, FLOWFV_DATA)
import numpy as np, sys, os, json, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # python3 -I leaves the script's dir off sys.path
from lib import DATA, NPROC, day_of
from l2lib import load_l2, features, split
import gbm
import lightgbm as lgb

H = sys.argv[1] if len(sys.argv) > 1 else "2"
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
BASE = os.environ.get("FLOWFV_BASE", os.path.join(ROOT, "models", f"flowfv-h{H}.json"))
DROP = {"bf250", "bf1000", "bf5000", "uf250", "uf1000", "uf5000"}
P = load_l2(); X, names = features(P)
keep = [i for i, n in enumerate(names) if n not in DROP]
X = X[:, keep]; names = [names[i] for i in keep]
st, el = P["st"], P["el"]; mid = P["mid"].astype(np.float64)
tr, va, te = split(st)
base = (P["good"] > 0) & (el >= 5) & (el < 290) & np.isfinite(P["fva"])
d = (P[f"y_mid{H}"].astype(np.float64) - mid) * 100; ok = base & np.isfinite(d)
sub = (np.arange(len(st)) % 3) == 0
for nm, m in (("train", tr), ("val", va), ("test", te)):
    print(f"  {nm}: {len(np.unique(st[m]))} windows, {(m & ok).sum()} frames", flush=True)
if not (tr & ok).any() or not (va & ok).any() or not (te & ok).any(): raise SystemExit("an empty split")
prm = dict(objective="regression", learning_rate=0.05, num_leaves=127, min_data_in_leaf=1000, feature_fraction=0.7, bagging_fraction=0.7,
           bagging_freq=1, lambda_l2=10, verbose=-1, num_threads=NPROC, seed=1)
r2 = lambda p, m: 1 - np.mean((d[m] - p[m]) ** 2) / np.mean(d[m] ** 2)
g = lgb.train(prm, lgb.Dataset(X[tr & ok & sub], d[tr & ok & sub], feature_name=names), 3000,
              valid_sets=[lgb.Dataset(X[va & ok & sub], d[va & ok & sub])], callbacks=[lgb.early_stopping(100, verbose=False)])
p = g.predict(X, num_threads=NPROC)
rep = {"H": float(H), "features": len(names), "days": sorted({day_of(s) for s in np.unique(st)}),
       "test_days": sorted({day_of(s) for s in np.unique(st[te])}), "val_rounds": g.best_iteration,
       "val_fit_test_r2": r2(p, te & ok), "val_fit_val_r2": r2(p, va & ok)}
print(f"val fit h={H}: {len(names)} features, {g.best_iteration} rounds, test R2 {100*rep['val_fit_test_r2']:.1f}% "
      f"(val {100*rep['val_fit_val_r2']:.1f}%)", flush=True)
# the model in use, on the same test frames (a sample: the numpy walk is slow)
if os.path.exists(BASE):
    bm = gbm.load(BASE)
    if all(f in names for f in bm["features"]):
        ix = np.where(te & ok)[0]; ix = np.random.default_rng(5).choice(ix, min(len(ix), 300_000), replace=False)
        pb = gbm.predict(bm, X[ix][:, [names.index(f) for f in bm["features"]]])
        rep["base_model"] = {"file": BASE, "tag": bm.get("tag"), "test_r2": float(1 - np.mean((d[ix] - pb) ** 2) / np.mean(d[ix] ** 2)),
                             "new_val_fit_test_r2_same_sample": float(1 - np.mean((d[ix] - p[ix]) ** 2) / np.mean(d[ix] ** 2))}
        print(f"model in use ({bm.get('tag')}) on the same test frames: R2 {100*rep['base_model']['test_r2']:.1f}% "
              f"vs the new val fit {100*rep['base_model']['new_val_fit_test_r2_same_sample']:.1f}%", flush=True)
    else: print(f"model in use ({BASE}) needs features the panel lacks: not scored")
TAG = os.environ.get("FLOWFV_TAG", f"h{H}_eth_{datetime.datetime.now(datetime.timezone.utc):%Y%m%d}")


def save(model, kind, tag, pred):
    j = model.dump_model(num_iteration=model.best_iteration if model.best_iteration > 0 else None)
    j["ffv"] = {"horizon_s": float(H), "features": names, "target": f"mid(t+{H}s) - mid(t), cents", "tag": tag}
    json.dump(j, open(os.path.join(DATA, f"ffv_h{H}_{kind}.json"), "w"))
    np.savez(os.path.join(DATA, f"ffv_h{H}_{kind}_preds.npz"), st=st, el=el, pred=pred.astype(np.float32))


def vectors(model, path):
    """A few hundred feature vectors (incl. NaN) with the model's own predictions, for the TS evaluator's self-test."""
    rng = np.random.default_rng(3)
    a, b = np.where(te & ok)[0], np.where(te & ~ok)[0]
    ix = np.r_[rng.choice(a, min(300, len(a)), replace=False), rng.choice(b, min(50, len(b)), replace=False)]
    json.dump({"features": names, "x": [[None if not np.isfinite(v) else float(v) for v in X[i]] for i in ix],
               "y": [float(v) for v in model.predict(X[ix], num_threads=1)]}, open(path, "w"))


save(g, "val", f"{TAG}_val", p)
rounds = max(1, int(round(g.best_iteration * 1.2)))
g2 = lgb.train(prm, lgb.Dataset(X[ok & sub], d[ok & sub], feature_name=names), rounds)
p2 = g2.predict(X, num_threads=NPROC)
rep["prod_rounds"] = rounds; rep["prod_in_sample_test_r2"] = r2(p2, te & ok); rep["tag"] = TAG
print(f"prod fit h={H}: {rounds} rounds on every day (in-sample test R2 {100*rep['prod_in_sample_test_r2']:.1f}%), tag {TAG}", flush=True)
save(g2, "prod", TAG, p2)
vectors(g2, os.path.join(DATA, f"ffv_h{H}_prod_vectors.json"))
json.dump(rep, open(os.path.join(DATA, f"ffv_h{H}_report.json"), "w"), indent=1)
