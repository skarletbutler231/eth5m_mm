# 100 ms feature / target panel from pmqb's L2 recorder (eth-5m): the Up book rebuilt event by event in the bot's
# receive clock, the full tape, Binance spot + perp (chd_book.py's mids), Chainlink and the bot's anchored pricer
# (Binance-only nowcast). Frames t = start + 50 ms + k*100 ms (the bot's frame clock), el 0.05 .. 299.95.
# BTC's l2panel.py with the ETH inputs (lib.py) and one output file per day, so a rerun builds only the new days.
# Usage: python3 -I l2panel.py OUT_DIR FIRST_DAY LAST_DAY   (env L2_ROOT, L2_MIN_EVENTS (per-window event floor, default 1000),
#        LAT_B, LAT_U, LX, NPROC, FLOWFV_DATA)
import sys, os, json, glob
import numpy as np, pyarrow.parquet as pq
from numba import njit
import multiprocessing as mp
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # python3 -I leaves the script's dir off sys.path
from lib import DATA, NPROC, L2_ROOT as L2, LAT_B, LAT_U, LX, days, day_of

OUT, D0, D1 = sys.argv[1], sys.argv[2], sys.argv[3]
MIN_EVENTS = int(os.environ.get("L2_MIN_EVENTS", "1000"))
D, GOOD = 60.0, 0.03 + 1e-9
COLS = ["asset", "local_timestamp", "event_type", "pc_price", "pc_size", "pc_side", "bid_prices", "bid_sizes", "ask_prices", "ask_sizes"]
META = json.load(open(os.path.join(DATA, "meta.json")))
CL = np.load(os.path.join(DATA, "cl.npz")); CLO, CLR, CLP = CL["obs"], CL["rcv"], CL["px"]
G = np.load(os.path.join(DATA, "global.npz")); GS0, GSIG = int(G["S0"]), G["sig"]
_bin = {}

@njit(cache=True)
def run_book(et, ek, ep, es, esg, frames, NF):
    """ek: 0 clear book, 1 set bid level, 2 set ask level, 3 trade (ep = Up price idx, es size, esg taker sign).
    Per frame: bb, ba (idx, -1/1001 if empty), bs1, as1, bd2, ad2, bd5, ad5, cumulative OFI, cumulative signed trade
    flow, trade count, last trade px idx / sign / time, min bid and max ask seen during the frame interval, and the
    cumulative count of touch changes."""
    bids = np.zeros(1002); asks = np.zeros(1002)
    bb = -1; ba = 1001
    out = np.full((NF, 18), np.nan)
    cofi = 0.0; cflow = 0.0; cn = 0.0; ltp = -1.0; lts = 0.0; ltt = -1.0
    pbb = -1; pba = 1001; pbs = 0.0; pas = 0.0
    mn = 1e9; mx = -1e9; nch = 0.0
    j = 0; n = len(et)
    for f in range(NF):
        tf = frames[f]
        while j < n and et[j] <= tf:
            k = ek[j]; p = ep[j]
            if k == 0:
                bids[:] = 0.0; asks[:] = 0.0; bb = -1; ba = 1001
            elif k == 1:
                bids[p] = es[j]
                if es[j] > 0 and p > bb: bb = p
                elif es[j] <= 0 and p == bb:
                    q = bb - 1
                    while q >= 0 and bids[q] <= 0: q -= 1
                    bb = q
            elif k == 2:
                asks[p] = es[j]
                if es[j] > 0 and p < ba: ba = p
                elif es[j] <= 0 and p == ba:
                    q = ba + 1
                    while q <= 1000 and asks[q] <= 0: q += 1
                    ba = q
            else:
                cflow += esg[j] * es[j]; cn += 1.0; ltp = p; lts = esg[j]; ltt = et[j]
            if k != 3 and (j + 1 >= n or et[j + 1] != et[j] or ek[j + 1] == 3):
                # one OFI step per timestamp (a snapshot = a burst of level sets at one time)
                cbs = bids[bb] if bb >= 0 else 0.0; cas = asks[ba] if ba <= 1000 else 0.0
                if pbb >= 0 and pba <= 1000 and bb >= 0 and ba <= 1000:
                    e = 0.0
                    if bb >= pbb: e += cbs
                    if bb <= pbb: e -= pbs
                    if ba <= pba: e -= cas
                    if ba >= pba: e += pas
                    cofi += e
                if bb != pbb or ba != pba: nch += 1.0
                pbb = bb; pba = ba; pbs = cbs; pas = cas
                if bb >= 0 and bb < mn: mn = bb
                if ba <= 1000 and ba > mx: mx = ba
            j += 1
        out[f, 0] = bb; out[f, 1] = ba
        out[f, 2] = bids[bb] if bb >= 0 else 0.0; out[f, 3] = asks[ba] if ba <= 1000 else 0.0
        s2b = 0.0; s5b = 0.0; s2a = 0.0; s5a = 0.0
        if bb >= 0:
            for q in range(max(0, bb - 50), bb + 1):
                if q >= bb - 19: s2b += bids[q]
                s5b += bids[q]
        if ba <= 1000:
            for q in range(ba, min(1001, ba + 51)):
                if q <= ba + 19: s2a += asks[q]
                s5a += asks[q]
        out[f, 4] = s2b; out[f, 5] = s2a; out[f, 6] = s5b; out[f, 7] = s5a
        out[f, 8] = cofi; out[f, 9] = cflow; out[f, 10] = cn; out[f, 11] = ltp; out[f, 12] = lts; out[f, 13] = ltt
        out[f, 14] = mn if mn < 1e9 else (bb if bb >= 0 else np.nan)
        out[f, 15] = mx if mx > -1e9 else (ba if ba <= 1000 else np.nan)
        out[f, 16] = nch
        mn = bb if bb >= 0 else 1e9; mx = ba if ba <= 1000 else -1e9
    return out

def bin_day(kind, day):
    k = (kind, day)
    if k not in _bin:
        f = os.path.join(DATA, kind, f"{day}.npz")
        if not os.path.exists(f): _bin[k] = None
        else:
            z = np.load(f); _bin[k] = (z["t"], z["p"], np.cumsum(z["s"].astype(np.float64) * z["q"]))
        if len(_bin) > 6:
            for kk in list(_bin)[:len(_bin) - 6]: del _bin[kk]
    return _bin[k]

def bin_slice(kind, a, b):
    ds = sorted({day_of(x / 1000) for x in (a, b)})
    parts = []
    for d in ds:
        z = bin_day(kind, d)
        if z is None: return None
        t, p, cs = z
        i0, i1 = np.searchsorted(t, a), np.searchsorted(t, b, side="right")
        parts.append((t[i0:i1], p[i0:i1], cs[i0:i1] - (cs[i0 - 1] if i0 > 0 else 0)))
    if len(parts) == 1: return parts[0]
    (t1, p1, s1), (t2, p2, s2) = parts
    return np.concatenate([t1, t2]), np.concatenate([p1, p2]), np.concatenate([s1, s2 + (s1[-1] if len(s1) else 0)])

def last_at(t, v, x):
    j = np.searchsorted(t, x, side="right") - 1
    return np.where(j >= 0, v[np.maximum(j, 0)], np.nan)

def build(f):
    st = int(f.rsplit("-", 1)[1].split(".")[0])
    w = META.get(str(st))
    if not w or w.get("out") is None: return st, None, "no label"
    K = w.get("K") or w.get("K_rec")
    if K is None: return st, None, "no K"
    T0 = st * 1000; TE = T0 + 300000
    df = pq.read_table(f, columns=COLS).to_pandas()
    if len(df) < MIN_EVENTS: return st, None, "few events"
    t = (df.local_timestamp.astype("int64") // 1000).to_numpy()
    et, ek, ep, es, esg = [], [], [], [], []
    for i, r in enumerate(df.itertuples(index=False)):
        e = r.event_type
        if e == "price_change" and r.asset == "Up":
            et.append(t[i]); ek.append(1 if r.pc_side == "BUY" else 2); ep.append(int(round(r.pc_price * 1000))); es.append(r.pc_size); esg.append(0)
        elif e == "book" and r.asset == "Up":
            et.append(t[i]); ek.append(0); ep.append(0); es.append(0.0); esg.append(0)
            if r.bid_prices is not None:
                for p, s in zip(r.bid_prices, r.bid_sizes): et.append(t[i]); ek.append(1); ep.append(int(round(p * 1000))); es.append(s); esg.append(0)
            if r.ask_prices is not None:
                for p, s in zip(r.ask_prices, r.ask_sizes): et.append(t[i]); ek.append(2); ep.append(int(round(p * 1000))); es.append(s); esg.append(0)
        elif e == "last_trade_price":
            up = r.asset == "Up"; p = r.pc_price if up else 1 - r.pc_price
            sg = (1 if r.pc_side == "BUY" else -1) * (1 if up else -1)
            et.append(t[i]); ek.append(3); ep.append(int(round(p * 1000))); es.append(r.pc_size); esg.append(sg)
    et = np.array(et, np.int64); o = np.argsort(et, kind="stable")
    et = et[o]; ek = np.array(ek, np.int8)[o]; ep = np.clip(np.array(ep, np.int64)[o], 0, 1000); es = np.array(es, np.float64)[o]; esg = np.array(esg, np.float64)[o]
    frames = T0 + 50 + 100 * np.arange(3000, dtype=np.int64)
    B = run_book(et, ek, ep, es, esg, frames, len(frames))
    sp = bin_slice("bin_spot", T0 - 120000, TE + 60000); um = bin_slice("bin_um", T0 - 120000, TE + 60000)
    if sp is None or len(sp[0]) < 100: return st, None, "no binance"
    n = len(frames); gr = frames.astype(np.float64)
    R = {"el": (gr - T0) / 1000.0}
    bb = np.where(B[:, 0] >= 0, B[:, 0] / 1000, np.nan); ba = np.where(B[:, 1] <= 1000, B[:, 1] / 1000, np.nan)
    mid = (bb + ba) / 2; spr = ba - bb
    good = (spr <= GOOD) & (mid > 0.005) & (mid < 0.995)
    R.update(bb=bb, ba=ba, bs1=B[:, 2], as1=B[:, 3], bd2=B[:, 4], ad2=B[:, 5], bd5=B[:, 6], ad5=B[:, 7], mid=mid, spr=spr, good=good.astype(float))
    R["mp"] = (bb * B[:, 3] + ba * B[:, 2]) / (B[:, 2] + B[:, 3])
    lag = lambda a, k: np.r_[np.full(k, np.nan), a[:-k]]
    for k, nm in ((1, "100"), (5, "500"), (10, "1000"), (30, "3000"), (100, "10000")):
        R[f"ofi{nm}"] = B[:, 8] - lag(B[:, 8], k); R[f"tf{nm}"] = B[:, 9] - lag(B[:, 9], k); R[f"tn{nm}"] = B[:, 10] - lag(B[:, 10], k)
        R[f"dmid{nm}"] = mid - lag(mid, k); R[f"nch{nm}"] = B[:, 16] - lag(B[:, 16], k)
    R["lastd"] = np.where(B[:, 11] >= 0, B[:, 11] / 1000 - mid, np.nan); R["lastsg"] = B[:, 12]; R["lastage"] = gr - B[:, 13]
    # time since the mid last changed
    chg = np.r_[True, mid[1:] != mid[:-1]]
    idx = np.maximum.accumulate(np.where(chg, np.arange(n), 0)); R["midage"] = (np.arange(n) - idx) * 0.1
    # targets: mid / microprice at t + h, and run-over of the touch within h (min bid / max ask over the interval)
    for k, nm in ((5, "05"), (10, "1"), (20, "2"), (50, "5"), (100, "10"), (300, "30")):
        fut = np.r_[mid[k:], np.full(k, np.nan)]; fg = np.r_[good[k:], np.zeros(k, bool)]
        tt = gr + k * 100
        R[f"y_mid{nm}"] = np.where(fg & (tt < TE), fut, np.nan)
    mnb = np.where(np.isfinite(B[:, 14]), B[:, 14] / 1000, np.nan); mxa = np.where(np.isfinite(B[:, 15]), B[:, 15] / 1000, np.nan)
    for k, nm in ((3, "03"), (5, "05"), (10, "1"), (20, "2")):
        fmn = np.full(n, np.inf); fmx = np.full(n, -np.inf)
        for s in range(1, k + 1):
            fmn[:-s] = np.minimum(fmn[:-s], np.nan_to_num(mnb[s:], nan=np.inf)); fmx[:-s] = np.maximum(fmx[:-s], np.nan_to_num(mxa[s:], nan=-np.inf))
        R[f"y_bthru{nm}"] = np.where(np.isfinite(bb) & (gr + k * 100 < TE), (fmn < bb - 1e-9).astype(float), np.nan)
        R[f"y_athru{nm}"] = np.where(np.isfinite(ba) & (gr + k * 100 < TE), (fmx > ba + 1e-9).astype(float), np.nan)
    R["y"] = np.full(n, float(w["out"]))
    # ---------------- Binance ----------------
    bt, bp, bcs = sp
    tb = gr - LAT_B
    Bn = last_at(bt, bp, tb)
    for h in (100, 250, 500, 1000, 2000, 5000, 10000, 30000):
        R[f"br{h}"] = (np.log(Bn) - np.log(last_at(bt, bp, tb - h))) * 1e4
    cs = lambda tt_, c, x: np.where(np.searchsorted(tt_, x, side="right") > 0, c[np.maximum(np.searchsorted(tt_, x, side="right") - 1, 0)], 0.0)
    for h in (250, 1000, 5000):
        R[f"bf{h}"] = cs(bt, bcs, tb) - cs(bt, bcs, tb - h)
    if um is not None and len(um[0]) > 100:
        ut, up_, ucs = um; tu = gr - LAT_U; Un = last_at(ut, up_, tu)
        for h in (100, 250, 500, 1000, 5000): R[f"ur{h}"] = (np.log(Un) - np.log(last_at(ut, up_, tu - h))) * 1e4
        for h in (250, 1000, 5000): R[f"uf{h}"] = cs(ut, ucs, tu) - cs(ut, ucs, tu - h)
    else:
        for h in (100, 250, 500, 1000, 5000): R[f"ur{h}"] = np.full(n, np.nan)
        for h in (250, 1000, 5000): R[f"uf{h}"] = np.full(n, np.nan)
    sec = (gr // 1000).astype(int) - GS0
    R["sig"] = np.where((sec >= 0) & (sec < len(GSIG)), GSIG[np.clip(sec, 0, len(GSIG) - 1)], np.nan) * 1e4   # NaN past the last Binance second
    # ---------------- Chainlink + the anchored pricer (kappa applied later) ----------------
    i0, i1 = np.searchsorted(CLO, T0 - 130000), np.searchsorted(CLO, TE + 5000)
    o, r, p = CLO[i0:i1], CLR[i0:i1], CLP[i0:i1]
    if len(o) < 200: return st, None, "few chainlink"
    ordr = np.argsort(r, kind="stable"); rs = r[ordr]; om = np.maximum.accumulate(o[ordr])
    j = np.searchsorted(rs, gr, side="right") - 1
    if (j < 0).any(): return st, None, "chainlink late"
    tc = om[j]; pc = p[np.searchsorted(o, tc)]
    R["clage"] = gr - tc
    a = TE - D * 1000
    seg_t = np.clip(np.append(o, TE + 5000), a, None)
    cumI = np.concatenate([[0.0], np.cumsum(p * np.diff(seg_t) / 1000.0)])
    def cl_int(x):
        x = np.maximum(x, a); k = np.searchsorted(o, x, side="right") - 1; k0 = np.maximum(k, 0)
        return np.where(k >= 0, cumI[k0] + p[k0] * (x - np.maximum(o[k0], a)) / 1000.0, 0.0)
    Bc = last_at(bt, bp, tc - LX); kk = pc / Bc; Sh = kk * Bn
    tk = tb + LX; tau = (TE - tk) / 1000.0
    known = np.zeros(n); inwin = tk > a
    if inwin.any():
        known = cl_int(np.minimum(tc, TE)) * (np.minimum(tc, TE) > a)
        for q in np.where(inwin)[0]:
            lo, hi = max(tc[q], a), min(tk[q], TE)
            if hi <= lo: continue
            i_lo = np.searchsorted(bt, lo - LX, side="right") - 1; i_hi = np.searchsorted(bt, hi - LX, side="right")
            ts_ = np.concatenate([[lo - LX], bt[i_lo + 1:i_hi], [hi - LX]])
            known[q] += kk[q] * np.sum(bp[i_lo:i_hi] * np.diff(ts_)) / 1000.0
    ea = np.where(tau >= D, Sh, np.where(tau > 0, (known + np.maximum(tau, 0) * Sh) / D, known / D))
    te = np.where(tau >= D, tau - 2 * D / 3, np.where(tau > 0, np.maximum(tau, 0) ** 3 / (3 * D * D) * (Sh / ea) ** 2, 0.0))
    R["m"] = np.log(ea / K) * 1e4; R["te"] = te; R["tau"] = tau; R["nc_gap"] = np.log(Sh / pc) * 1e4
    R["st"] = np.full(n, float(st))
    keep = (R["el"] >= 2) & (R["el"] <= 298)
    return st, {k: np.asarray(v)[keep].astype(np.float64 if k == "st" else np.float32) for k, v in R.items()}, None

def run_one(f):
    try: return build(f)
    except Exception as e: return 0, None, f"exc {type(e).__name__}: {e}"

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    todo = [d for d in days(D0, D1) if os.path.isdir(os.path.join(L2, d)) and not os.path.exists(os.path.join(OUT, f"{d}.npz"))]
    tot, E = 0, {}
    with mp.get_context("fork").Pool(NPROC) as pool:
        for d in todo:
            files = sorted(glob.glob(os.path.join(L2, d, "*.parquet")))
            res, errs = [], {}
            for st, R, err in pool.imap(run_one, files, chunksize=4):
                if R is None: errs[err] = errs.get(err, 0) + 1
                else: res.append(R)
            if res: np.savez(os.path.join(OUT, f"{d}.npz"), **{k: np.concatenate([r[k] for r in res]) for k in res[0]})
            print(f"{d}: {len(res)} windows, skipped {errs}", flush=True)
            tot += len(res)
            for k, v in errs.items(): E[k] = E.get(k, 0) + v
    print("built", len(todo), "days,", tot, "windows; skipped", E,
          f"({len([f for f in os.listdir(OUT) if f.endswith('.npz')])} days in {OUT})")
