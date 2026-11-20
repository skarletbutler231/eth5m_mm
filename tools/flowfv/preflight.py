# What the retrain will read, checked before any long step: Python modules, the L2 recorder's ETH days and schema, the
# Binance hours per venue, a Chainlink ETH source, Gamma, disk. Exits 1 on anything that would stop the pipeline.
# Usage: python3 -I preflight.py FIRST_DAY LAST_DAY
import sys, os, glob, shutil, importlib, sqlite3, json, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # python3 -I leaves the script's dir off sys.path
from lib import DATA, L2_ROOT, CHD_ROOT, CHD_SPOT, CHD_PERP, SYMBOL, SLUG, LAT_B, LAT_U, LX, EPS2, NPROC, days, ts, hour_file

first, last = sys.argv[1], sys.argv[2]
bad = []
def fail(m): bad.append(m); print("  FAIL", m)
def okm(m): print("  ok  ", m)

print(f"settings: DATA={DATA} LAT_B={LAT_B} LAT_U={LAT_U} LX={LX} EPS={EPS2 ** 0.5 * 1e4:.3f}bp NPROC={NPROC}")
print("python modules")
for mod in ("numpy", "pandas", "scipy", "pyarrow", "numba", "lightgbm"):
    try: m = importlib.import_module(mod); okm(f"{mod} {getattr(m, '__version__', '')}")
    except Exception as e: fail(f"{mod}: {e} (pip install -r tools/flowfv/requirements.txt)")

D = days(first, last)
print(f"L2 recorder {L2_ROOT}, {first} .. {last} ({len(D)} days)")
if not os.path.isdir(L2_ROOT): fail(f"{L2_ROOT} missing (set L2_ROOT)")
else:
    n = {d: len(glob.glob(os.path.join(L2_ROOT, d, "*.parquet"))) for d in D}
    have = [d for d in D if n[d]]
    print("  windows a day:", " ".join(f"{d[5:]}:{n[d]}" for d in D))
    if len(have) < 3: fail(f"{len(have)} days with L2 files: need 3+")
    elif have:
        f = sorted(glob.glob(os.path.join(L2_ROOT, have[-1], "*.parquet")))[0]
        try:
            st = int(os.path.basename(f).rsplit("-", 1)[1].split(".")[0]); assert st % 300 == 0
            okm(f"file name -> window start ({os.path.basename(f)})")
        except Exception: fail(f"can't read the window start from {os.path.basename(f)} (expected ...-<start>.parquet)")
        try:
            import pyarrow.parquet as pq
            names = pq.read_schema(f).names
            COLS = ["asset", "local_timestamp", "event_type", "pc_price", "pc_size", "pc_side", "bid_prices", "bid_sizes", "ask_prices", "ask_sizes"]   # l2panel.py's
            miss = [c for c in COLS if c not in names]
            if miss: fail(f"L2 schema lacks {miss} (has {names})")
            else:
                t = pq.read_table(f, columns=["asset", "event_type"]).to_pandas()
                okm(f"L2 schema; assets {sorted(t.asset.astype(str).unique())[:4]}, events {sorted(t.event_type.astype(str).unique())}")
                if "Up" not in set(t.asset.astype(str)): fail("no 'Up' rows in the L2 file (asset column)")
        except ImportError: pass

print(f"Binance books {CHD_ROOT} ({SYMBOL}: {CHD_SPOT}, {CHD_PERP})")
for venue in (CHD_SPOT, CHD_PERP):
    hrs = {d: sum(hour_file(venue, d, f"{h:02d}") is not None for h in range(24)) for d in D}
    print(f"  {venue} hours a day:", " ".join(f"{d[5:]}:{hrs[d]}" for d in D))
    if not any(hrs.values()): fail(f"no {venue} {SYMBOL}_orderbook.parquet under {CHD_ROOT} (set CHD_ROOT / CHD_SPOT / CHD_PERP)")
    else:
        part = [d for d in D if 0 < hrs[d] < 24]
        if part: print(f"  note: {venue} incomplete days {part}: windows in the missing hours are skipped ('no binance')")
        d = next(d for d in D if hrs[d]); f = next(hour_file(venue, d, f"{h:02d}") for h in range(24) if hour_file(venue, d, f"{h:02d}"))
        try:
            import pyarrow.parquet as pq
            names = pq.read_schema(f).names
            need = ["event_time", "event_type", "final_update_id", "last_update_id", "side", "price", "quantity"]
            miss = [c for c in need if c not in names]
            if miss: fail(f"{venue} schema lacks {miss} (has {names})")
            else: okm(f"{venue} schema")
        except ImportError: pass

print("Chainlink ETH/USD prints")
if os.environ.get("CL_FILE"):
    (okm if os.path.exists(os.environ["CL_FILE"]) else fail)(f"CL_FILE {os.environ['CL_FILE']}")
else:
    from cl import CL_DB, discover
    if not os.path.exists(CL_DB): fail(f"CL_DB {CL_DB} not found (set CL_DB, CL_SQL or CL_FILE)")
    elif os.environ.get("CL_SQL"): okm(f"CL_SQL on {CL_DB}")
    else:
        try:
            q, label = discover(sqlite3.connect(f"file:{CL_DB}?mode=ro", uri=True)); okm(f"{label}")
        except SystemExit as e: fail(str(e))

print("Gamma")
try:
    with urllib.request.urlopen(f"https://gamma-api.polymarket.com/events?slug={SLUG}-{int(ts(first)) + 36000}", timeout=15) as r:
        ev = json.loads(r.read())
    (okm if ev else fail)(f"{SLUG} events answer ({len(ev)})")
except Exception as e: fail(f"gamma-api.polymarket.com: {e}")

os.makedirs(DATA, exist_ok=True)
free = shutil.disk_usage(DATA).free / 1e9
(okm if free > 3 * len(D) else fail)(f"{free:.0f} GB free in {DATA} (about 1-2 GB a day of data)")
print("preflight:", "OK" if not bad else f"{len(bad)} problem(s)")
sys.exit(1 if bad else 0)
