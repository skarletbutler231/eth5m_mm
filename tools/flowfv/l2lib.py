# Load the 100 ms L2 panel, add the bot's FV (rolling kappa per window) and the anchored FV (anchor = the frame where
# the good mid last changed, as engine.ts does every frame), and build the feature matrix.
# BTC's l2lib.py, with the kappa rebuilt from the L2 panel itself (BTC's took it from the tracker DB's 1 Hz panel, which
# has no ETH) and a default train / val / test split by day.
import numpy as np, glob, os
from scipy.special import ndtr, ndtri
from lib import DATA, EPS2, ts, day_of
from numba import njit

KAPPA_PRIOR = float(os.environ.get("KAPPA_PRIOR", "1.10")); KAPPA_WINDOWS = int(os.environ.get("KAPPA_WINDOWS", "20"))


@njit(cache=True)
def _anchor(st, mid, good):
    n = len(mid); anc = np.full(n, -1, np.int64); cur = -1
    for i in range(n):
        if i > 0 and st[i] != st[i - 1]: cur = -1
        if good[i] and (cur < 0 or mid[i] != mid[cur]): cur = i
        anc[i] = cur
    return anc


def rolling_kappa(P):
    """The bot's kappa rule (BTC assemble.py) on the whole-second frames: per window the median implied/base sigma ratio,
    measured 90-290 s before the close on good books; a window's kappa = the median of the last KAPPA_WINDOWS completed
    windows' ratios, the prior padded to 3."""
    st = P["st"].astype(np.int64); el = P["el"].astype(np.float64)
    sec = np.abs((el - 0.05) - np.round(el - 0.05)) < 1e-3          # frames sit at k/10 + 0.05 s; keep the x.05 ones
    m = P["m"].astype(np.float64) * 1e-4; sig = P["sig"].astype(np.float64) * 1e-4; te = P["te"].astype(np.float64)
    mid = P["mid"].astype(np.float64); left = 300 - el
    sel = sec & (P["good"] > 0) & (P["tau"] >= 60) & (left >= 90) & (left <= 290) & (te > 0)
    zm = ndtri(np.clip(mid, 1e-6, 1 - 1e-6))
    ok = sel & (np.abs(zm) >= 0.25) & (m != 0) & (np.sign(zm) == np.sign(m))
    with np.errstate(invalid="ignore", divide="ignore"):
        s2 = np.where(ok, ((m / np.where(ok, zm, 1)) ** 2 - EPS2) / np.where(te > 0, te, 1), np.nan)
        ratio = np.where(ok & (s2 > 0), np.sqrt(np.maximum(s2, 0)) / sig, np.nan)
    sts, start, inv = np.unique(st, return_index=True, return_inverse=True)   # rows are sorted by st
    ends = np.append(start[1:], len(st))
    wmed = np.array([np.nanmedian(ratio[a:b]) if np.isfinite(ratio[a:b]).sum() >= 10 else np.nan for a, b in zip(start, ends)])
    kap = np.empty(len(sts)); hist = []
    for i in range(len(sts)):
        h = hist[-KAPPA_WINDOWS:]
        while len(h) < 3: h = h + [KAPPA_PRIOR]
        kap[i] = np.median(h)
        if np.isfinite(wmed[i]): hist.append(wmed[i])
    return kap[inv].astype(np.float32), sts, kap


def load_l2(cols=None):
    fs = sorted(glob.glob(os.path.join(DATA, os.environ.get("L2_DIR", "l2"), "*.npz")))
    if not fs: raise SystemExit(f"no panel in {os.path.join(DATA, os.environ.get('L2_DIR', 'l2'))} (run l2panel.py)")
    Z = [np.load(f) for f in fs]
    keys = cols or Z[0].files
    P = {k: np.concatenate([z[k] for z in Z]) for k in keys}
    o = np.lexsort((P["el"], P["st"]))
    P = {k: v[o] for k, v in P.items()}
    st = P["st"].astype(np.int64)
    P["kappa"], sts, kap = rolling_kappa(P)
    print(f"{len(sts)} windows, {len(fs)} days, kappa p10/50/90 {np.round(np.percentile(kap, [10, 50, 90]), 3)}", flush=True)
    m = P["m"].astype(np.float64) * 1e-4
    sd = np.sqrt(P["kappa"].astype(np.float64) ** 2 * (P["sig"].astype(np.float64) * 1e-4) ** 2 * P["te"] + EPS2)
    P["sd"] = sd.astype(np.float32)
    P["fv"] = ndtr(m / sd).astype(np.float32)
    mid = P["mid"].astype(np.float64); good = P["good"] > 0
    n = len(mid)
    anc = _anchor(st, mid, good)
    aa = np.maximum(anc, 0)
    fva = ndtr((ndtri(np.clip(mid[aa], 1e-6, 1 - 1e-6)) * sd[aa] + (m - m[aa])) / sd)
    P["fva"] = np.where(anc >= 0, fva, np.nan).astype(np.float32)
    P["anc_age"] = np.where(anc >= 0, (np.arange(n) - anc) * 0.1, np.nan).astype(np.float32)
    return P


def features(P):
    F = {}
    mid = P["mid"].astype(np.float64)
    F["mid"] = mid; F["el"] = P["el"]; F["tau"] = P["tau"]; F["spr"] = P["spr"] * 100
    F["lead_a"] = (P["fva"] - mid) * 100; F["lead"] = (P["fv"] - mid) * 100; F["anc_age"] = P["anc_age"]
    zm = ndtri(np.clip(mid, 1e-4, 1 - 1e-4)); F["zmid"] = zm
    F["z"] = ndtri(np.clip(P["fv"].astype(np.float64), 1e-9, 1 - 1e-9))
    F["delta"] = np.exp(-0.5 * zm ** 2) / np.sqrt(2 * np.pi) / P["sd"] * 1e-2     # c of Up per bp of ETH
    F["mpd"] = (P["mp"] - mid) * 100
    s = lambda a, b: (a - b) / np.maximum(a + b, 1e-9)
    F["imb1"] = s(P["bs1"], P["as1"]); F["imb2"] = s(P["bd2"], P["ad2"]); F["imb5"] = s(P["bd5"], P["ad5"])
    F["lbs1"] = np.log1p(P["bs1"]); F["las1"] = np.log1p(P["as1"]); F["lbd5"] = np.log1p(P["bd5"]); F["lad5"] = np.log1p(P["ad5"])
    for h in ("100", "500", "1000", "3000", "10000"):
        F[f"ofi{h}"] = P[f"ofi{h}"]; F[f"tf{h}"] = P[f"tf{h}"]; F[f"tn{h}"] = P[f"tn{h}"]; F[f"dmid{h}"] = P[f"dmid{h}"] * 100; F[f"nch{h}"] = P[f"nch{h}"]
    F["lastd"] = P["lastd"] * 100; F["lastsg"] = P["lastsg"]; F["lastage"] = P["lastage"]; F["midage"] = P["midage"]
    for h in (100, 250, 500, 1000, 2000, 5000, 10000, 30000): F[f"br{h}"] = P[f"br{h}"]
    for h in (100, 250, 500, 1000, 5000): F[f"ur{h}"] = P[f"ur{h}"]
    for h in (250, 1000, 5000): F[f"bf{h}"] = P[f"bf{h}"]; F[f"uf{h}"] = P[f"uf{h}"]
    for h in (250, 500, 1000, 2000, 5000): F[f"bdc{h}"] = F["delta"] * P[f"br{h}"]
    for h in (250, 500, 1000): F[f"udc{h}"] = F["delta"] * P[f"ur{h}"]
    F["ncdc"] = F["delta"] * P["nc_gap"]; F["nc_gap"] = P["nc_gap"]; F["clage"] = P["clage"]
    F["sig"] = P["sig"]; F["m"] = P["m"]; F["kappa"] = P["kappa"]
    names = list(F)
    return np.column_stack([np.asarray(F[k], np.float32) for k in names]), names


def split(st):
    """train < FLOWFV_TRAIN_END <= val < FLOWFV_VAL_END <= test. Unset: by day, the last ~20% of the days (at least 1) test,
    the ~15% before them (at least 1) val, the rest train."""
    if os.environ.get("FLOWFV_TRAIN_END") and os.environ.get("FLOWFV_VAL_END"):
        a, b = ts(os.environ["FLOWFV_TRAIN_END"]), ts(os.environ["FLOWFV_VAL_END"])
    else:
        ds = sorted({day_of(s) for s in np.unique(st)})
        if len(ds) < 3: raise SystemExit(f"{len(ds)} days in the panel: need at least 3 (train, val, test)")
        nt = max(1, round(0.2 * len(ds))); nv = max(1, round(0.15 * len(ds)))
        a, b = ts(ds[-nt - nv]), ts(ds[-nt])
    print(f"split: train < {day_of(a)} <= val < {day_of(b)} <= test", flush=True)
    return st < a, (st >= a) & (st < b), st >= b
