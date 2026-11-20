# Chainlink ETH/USD prints -> DATA/cl.npz (obs stamp ms, local receive ms, price), one row per observation stamp (first
# receipt). Then K_rec = the time-weighted mean of the prints over [st-60 s, st) per window, checked against Gamma's strike.
# Sources, first that is set:
#   CL_FILE   a .csv or .parquet with columns obs_ms, rcv_ms, price (or observed_at_ms, received_at_ms, price)
#   CL_SQL    a query on CL_DB returning (obs_ms, rcv_ms, price) rows, ordered or not
#   otherwise CL_DB is searched for a table with observed_at_ms / received_at_ms / price columns: one whose name has "eth",
#             or one with a symbol / asset / feed column, filtered to ETH. BTC's pipeline read btc_ticks there.
# The prints' level is checked against the Binance mids (chd_book.py's output), so a BTC table can't slip through.
# Usage: python3 -I cl.py FIRST_DAY LAST_DAY   (env CL_FILE / CL_DB / CL_SQL, FLOWFV_DATA)
import sys, os, glob, json, sqlite3
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # python3 -I leaves the script's dir off sys.path
from lib import DATA, ts

CL_DB = os.environ.get("CL_DB", "/work/alex_work/Bot_work/database/polymarket_5m_multi.db")


def discover(con):
    """(query taking the first stamp as its one parameter, label) for the ETH prints table in CL_DB."""
    tabs = [r[0] for r in con.execute("select name from sqlite_master where type in ('table', 'view')")]
    cand = []
    for t in tabs:
        cols = {r[1].lower(): r[1] for r in con.execute(f'pragma table_info("{t}")')}
        if not {"observed_at_ms", "received_at_ms", "price"} <= set(cols): continue
        q = f'select observed_at_ms, received_at_ms, price from "{t}" where observed_at_ms >= ?'
        if "eth" in t.lower(): cand.append((0, t, q))
        else:
            for c in ("symbol", "asset", "feed", "pair"):
                if c in cols: cand.append((1, t, q + f' and lower("{cols[c]}") like \'%eth%\'')); break
    if not cand:
        raise SystemExit(f"no ETH Chainlink table in {CL_DB}. Tables: {', '.join(tabs)}.\n"
                         "Set CL_SQL (a query returning obs_ms, rcv_ms, price) or CL_FILE (csv/parquet with those columns).")
    _, t, q = sorted(cand)[0]
    return q + " order by observed_at_ms, received_at_ms", f"{CL_DB}:{t}"


def from_db(t0):
    if not os.path.exists(CL_DB): raise SystemExit(f"CL_DB {CL_DB} not found: set CL_DB, CL_SQL or CL_FILE")
    con = sqlite3.connect(f"file:{CL_DB}?mode=ro", uri=True)
    if os.environ.get("CL_SQL"):
        return np.array(con.execute(os.environ["CL_SQL"]).fetchall(), dtype=np.float64), "CL_SQL"
    q, label = discover(con)
    return np.array(con.execute(q, (int(t0),)).fetchall(), dtype=np.float64), label


def from_file(f):
    if f.endswith(".parquet"):
        import pyarrow.parquet as pq
        d = pq.read_table(f).to_pandas()
    else:
        import pandas as pd
        d = pd.read_csv(f)
    d = d.rename(columns={"observed_at_ms": "obs_ms", "received_at_ms": "rcv_ms"})
    return d[["obs_ms", "rcv_ms", "price"]].to_numpy(np.float64), f


if __name__ == "__main__":
    first, last = sys.argv[1], sys.argv[2]
    t0 = (ts(first) - 86400) * 1000; t1 = (ts(last) + 2 * 86400) * 1000
    a, src = from_file(os.environ["CL_FILE"]) if os.environ.get("CL_FILE") else from_db(t0)
    a = a[np.isfinite(a).all(axis=1) & (a[:, 0] >= t0) & (a[:, 0] < t1) & (a[:, 2] > 0)]
    if len(a) < 1000: raise SystemExit(f"{src}: only {len(a)} prints between {first} and {last}")
    a = a[np.lexsort((a[:, 1], a[:, 0]))]
    _, idx = np.unique(a[:, 0], return_index=True)
    a = a[np.sort(idx)]
    # level check against Binance spot: a print and the mid at its stamp agree within 1%
    sp = sorted(glob.glob(os.path.join(DATA, "bin_spot", "*.npz")))
    if sp:
        z = [np.load(f) for f in sp]; bt = np.concatenate([x["t"] for x in z]); bp = np.concatenate([x["p"] for x in z])
        j = np.searchsorted(bt, a[:, 0], side="right") - 1; ok = j >= 0
        if ok.sum() > 100:
            r = np.median(a[ok, 2] / bp[np.maximum(j[ok], 0)])
            print(f"prints / Binance spot mid: median ratio {r:.5f}")
            if abs(r - 1) > 0.01: raise SystemExit(f"{src} does not look like ETH/USD (ratio {r:.3f} to Binance {os.path.basename(sp[0])[:10]}..)")
    print(f"{src}: {len(a)} prints, receive lag ms p10/50/90/99", np.percentile(a[:, 1] - a[:, 0], [10, 50, 90, 99]))
    g = np.diff(a[:, 0]); print("stamp gaps: >1s", (g > 1000).sum(), ">5s", (g > 5000).sum(), ">60s", (g > 60000).sum())
    np.savez(os.path.join(DATA, "cl.npz"), obs=a[:, 0], rcv=a[:, 1], px=a[:, 2])
    mp = os.path.join(DATA, "meta.json")
    W = json.load(open(mp))
    obs, px = a[:, 0], a[:, 2]

    def twmean(x0, x1):
        i0 = np.searchsorted(obs, x0, side="right") - 1
        i1 = np.searchsorted(obs, x1, side="left")
        if i0 < 0 or i1 - i0 < 30: return None
        tt = np.clip(obs[i0:i1], x0, x1); tt = np.append(tt, x1)
        return float(np.sum(px[i0:i1] * np.diff(tt)) / (x1 - x0))

    d = []
    for st, w in W.items():
        st = int(st)
        w["K_rec"] = twmean((st - 60) * 1000, st * 1000)
        w["A_rec"] = twmean((st + 240) * 1000, (st + 300) * 1000)
        if w["K_rec"] and w.get("K"): d.append(1e4 * np.log(w["K_rec"] / w["K"]))
        if w["K_rec"] and w["A_rec"] and w.get("out") is not None: w["rec_up"] = int(w["A_rec"] >= w["K_rec"])
    d = np.array(d)
    if len(d): print("K_rec vs Gamma K (bp): n", len(d), "median", np.median(d), "p99 |d|", np.percentile(np.abs(d), 99))
    ok = [w for w in W.values() if "rec_up" in w]
    print("rebuilt label agreement", sum(w["rec_up"] == w["out"] for w in ok), "/", len(ok))
    json.dump(W, open(mp, "w"))
