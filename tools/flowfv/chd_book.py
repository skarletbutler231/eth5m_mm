# CryptoHFTData Binance order books (hourly parquet, untrusted input: read as plain numbers only) -> the best bid / ask
# rebuilt event by event -> DATA/bin_spot/<day>.npz and DATA/bin_um/<day>.npz in the pipeline's Binance format:
#   t ms (float64, Binance event time), p mid (float64), q, s zeros (no taker flow: bf*/uf* are dropped from the model)
# One row per change of the touch. The live bot's spot / perp inputs are bookTicker mids, so a rebuilt mid is closer to
# what it sees than the aggTrade prices BTC's pipeline used.
#
# Input layout (CHD_ROOT): <venue>/... or <day>/<venue>/<HH>/<SYMBOL>_orderbook.parquet, both accepted. Each hour opens
# with a full snapshot (event_type "snapshot", one last_update_id), then Binance's diff-depth updates ("update", quantity =
# the level's new size, 0 = gone, grouped by final_update_id). Updates at or before the snapshot's id are skipped (Binance's
# own resync rule).
# Usage: python3 -I chd_book.py FIRST_DAY LAST_DAY   (env CHD_ROOT, CHD_SPOT, CHD_PERP, SYMBOL, FLOWFV_DATA, NPROC, CHD_TICK)
import sys, os, glob
import numpy as np, pyarrow as pa, pyarrow.parquet as pq, pyarrow.compute as pc
from numba import njit
import multiprocessing as mp
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # python3 -I leaves the script's dir off sys.path
from lib import DATA, NPROC, CHD_SPOT, CHD_PERP, days, hour_file

TICK = float(os.environ.get("CHD_TICK", "0.01"))   # ETHUSDT's tick on both venues
KINDS = {"bin_spot": CHD_SPOT, "bin_um": CHD_PERP}


@njit(cache=True)
def walk(snap, side, pidx, qty, et, fid, sid, NL):
    """snap 1 = snapshot row (sid = its last_update_id), side 0 bid / 1 ask, pidx level index in [0, NL) or -1 = out of
    range. Returns (t, bb, ba) at the end of every message group where the touch changed and the book is not crossed."""
    n = len(et)
    bids = np.zeros(NL); asks = np.zeros(NL)
    bb = -1; ba = NL; cur = -1
    ot = np.empty(n, np.int64); ob = np.empty(n, np.int64); oa = np.empty(n, np.int64)
    k = 0; pb = -2; pa = -2
    for i in range(n):
        apply = True
        if snap[i] == 1:
            if sid[i] != cur:
                bids[:] = 0.0; asks[:] = 0.0; bb = -1; ba = NL; cur = sid[i]
        elif cur < 0 or fid[i] <= cur:
            apply = False
        p = pidx[i]
        if apply and p >= 0:
            q = qty[i]
            if side[i] == 0:
                bids[p] = q
                if q > 0 and p > bb: bb = p
                elif q <= 0 and p == bb:
                    j = bb - 1
                    while j >= 0 and bids[j] <= 0: j -= 1
                    bb = j
            else:
                asks[p] = q
                if q > 0 and p < ba: ba = p
                elif q <= 0 and p == ba:
                    j = ba + 1
                    while j < NL and asks[j] <= 0: j += 1
                    ba = j
        end = i == n - 1 or et[i + 1] != et[i] or fid[i + 1] != fid[i] or snap[i + 1] != snap[i]
        if end and cur >= 0 and bb >= 0 and ba < NL and bb < ba and (bb != pb or ba != pa):
            ot[k] = et[i]; ob[k] = bb; oa[k] = ba; k += 1; pb = bb; pa = ba
    return ot[:k], ob[:k], oa[:k]


def one_hour(args):
    venue, day, hh = args
    f = hour_file(venue, day, hh)
    if f is None: return args, None, "missing"
    tb = pq.read_table(f, columns=["event_time", "event_type", "final_update_id", "last_update_id", "side", "price", "quantity"])
    if tb.num_rows == 0: return args, None, "empty"
    snap = pc.equal(tb["event_type"], "snapshot").to_numpy(zero_copy_only=False).astype(np.int8)
    if not snap.any(): return args, None, "no snapshot"
    side = pc.equal(tb["side"], "ask").to_numpy(zero_copy_only=False).astype(np.int8)
    px = pc.cast(tb["price"], pa.float64()).to_numpy(zero_copy_only=False)
    qty = pc.cast(tb["quantity"], pa.float64()).to_numpy(zero_copy_only=False)
    et = tb["event_time"].to_numpy(zero_copy_only=False).astype(np.int64)
    fid = pc.fill_null(tb["final_update_id"], -1).to_numpy(zero_copy_only=False).astype(np.int64)
    sid = pc.fill_null(tb["last_update_id"], -1).to_numpy(zero_copy_only=False).astype(np.int64)
    # level grid: 0.5x .. 1.5x the first snapshot's touch (the best can't leave that band within an hour)
    s0 = snap.astype(bool)
    b0 = px[s0 & (side == 0) & (qty > 0)]; a0 = px[s0 & (side == 1) & (qty > 0)]
    if not len(b0) or not len(a0): return args, None, "one-sided snapshot"
    m0 = (b0.max() + a0.min()) / 2
    lo = int(np.floor(m0 * 0.5 / TICK)); NL = int(np.ceil(m0 * 1.5 / TICK)) - lo
    pidx = np.rint(px / TICK).astype(np.int64) - lo
    pidx = np.where((pidx >= 0) & (pidx < NL) & np.isfinite(px), pidx, -1)
    t, bb, ba = walk(snap, side, pidx, np.nan_to_num(qty), et, fid, sid, NL)
    mid = (bb + ba + 2 * lo) * TICK / 2
    return args, (t, mid), f"{len(t)} touch changes, mid {mid.min():.2f}-{mid.max():.2f}" if len(t) else "no touch"


if __name__ == "__main__":
    first, last = sys.argv[1], sys.argv[2]
    todo = []
    for kind, venue in KINDS.items():
        os.makedirs(os.path.join(DATA, kind), exist_ok=True)
        for d in days(first, last):
            dst = os.path.join(DATA, kind, f"{d}.npz")
            if os.path.exists(dst) and int(np.load(dst)["hours"]) == 24: continue
            todo.append((kind, venue, d))
    tasks = [(venue, d, f"{h:02d}") for _, venue, d in todo for h in range(24)]
    res = {}
    with mp.get_context("fork").Pool(int(os.environ.get("CHD_NPROC", min(NPROC, 8)))) as pool:   # ~1.5 GB a worker on a futures hour
        for (venue, d, hh), r, msg in pool.imap_unordered(one_hour, tasks):
            res[(venue, d, hh)] = r
            if r is None: print(f"  {venue} {d} {hh}h: {msg}", flush=True)
    for kind, venue, d in todo:
        parts = [res[(venue, d, f"{h:02d}")] for h in range(24) if res.get((venue, d, f"{h:02d}")) is not None]
        if not parts: print(f"{kind} {d}: no hours"); continue
        t = np.concatenate([p[0] for p in parts]).astype(np.float64); p = np.concatenate([p[1] for p in parts])
        o = np.argsort(t, kind="stable"); t, p = t[o], p[o]
        np.savez(os.path.join(DATA, kind, f"{d}.npz"), t=t, p=p, q=np.zeros(len(t), np.float32), s=np.zeros(len(t), np.int8),
                 hours=len(parts))
        print(f"{kind} {d}: {len(parts)}/24 hours, {len(t)} mids, {p.min():.2f}-{p.max():.2f}", flush=True)
