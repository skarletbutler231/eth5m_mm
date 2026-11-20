# Window labels and strikes from Gamma, for every window the L2 recorder has: DATA/meta.json {st: {st, out, K}}.
#   out  Polymarket's own payout (1 = Up), K  eventMetadata.priceToBeat (the TWAP60 strike; it appears after the close).
# The same reads as the bot's src/feeds/gamma.ts fetchOutcome. Incremental: windows already labelled are not fetched again.
# BTC's pipeline read these from the tracker DB and market.db, which have no ETH windows.
# Usage: python3 -I meta.py FIRST_DAY LAST_DAY   (env L2_ROOT, SLUG, FLOWFV_DATA)
import sys, os, json, glob, time, urllib.request, collections
from concurrent.futures import ThreadPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # python3 -I leaves the script's dir off sys.path
from lib import DATA, L2_ROOT, SLUG, days

GAMMA = "https://gamma-api.polymarket.com"


def fetch(st):
    for k in range(4):
        try:
            with urllib.request.urlopen(f"{GAMMA}/events?slug={SLUG}-{st}", timeout=15) as r:
                ev = json.loads(r.read())
            break
        except Exception as e:
            if k == 3: return st, None, f"{type(e).__name__}"
            time.sleep(1 + 2 * k)
    e = ev[0] if isinstance(ev, list) and ev else None
    m = (e or {}).get("markets", [None])[0]
    if not m: return st, None, "no market"
    if not m.get("closed"): return st, None, "open"
    op = json.loads(m["outcomePrices"]) if isinstance(m.get("outcomePrices"), str) else m.get("outcomePrices")
    outs = json.loads(m["outcomes"]) if isinstance(m.get("outcomes"), str) else m.get("outcomes")
    if not isinstance(op, list) or len(op) != 2: return st, None, "no prices"
    ui = 1 if isinstance(outs, list) and str(outs[1]).lower() == "up" else 0
    if str(op[ui]) != "1" and str(op[1 - ui]) != "1": return st, None, "not final"
    try: K = float((e.get("eventMetadata") or {}).get("priceToBeat"))
    except (TypeError, ValueError): K = None
    return st, {"st": st, "out": int(str(op[ui]) == "1"), "K": K if K and K > 0 else None}, None


if __name__ == "__main__":
    first, last = sys.argv[1], sys.argv[2]
    dst = os.path.join(DATA, "meta.json")
    W = json.load(open(dst)) if os.path.exists(dst) else {}
    sts = sorted({int(os.path.basename(f).rsplit("-", 1)[1].split(".")[0])
                  for d in days(first, last) for f in glob.glob(os.path.join(L2_ROOT, d, "*.parquet"))})
    todo = [s for s in sts if W.get(str(s), {}).get("out") is None or W[str(s)].get("K") is None]
    print(f"{len(sts)} recorded windows, {len(todo)} to fetch from Gamma", flush=True)
    E = collections.Counter()
    with ThreadPoolExecutor(8) as ex:
        for i, (st, w, err) in enumerate(ex.map(fetch, todo)):
            if w: W[str(st)] = {**W.get(str(st), {}), **w}
            else: E[err] += 1
            if i % 500 == 499: json.dump(W, open(dst, "w")); print(f"  {i + 1}/{len(todo)}", flush=True)
    json.dump(W, open(dst, "w"))
    c = collections.Counter(("labelled" if w.get("out") is not None else "unlabelled") + ("" if w.get("K") else ", no K") for w in W.values())
    print(dict(c), "not fetched:", dict(E))
