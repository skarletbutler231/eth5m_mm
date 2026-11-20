# Shared settings of the ETH flow-FV pipeline. Every knob is an env var so the driver (retrain.sh) and a manual run agree.
import os, datetime
DATA = os.environ.get("FLOWFV_DATA", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data"))   # working data (several GB)
NPROC = int(os.environ.get("NPROC", os.cpu_count() or 4))
# The pricer's TWAP-rebuild error. The ETH paper bot fits ~0.34 bp (median epsBps of its windows, 2026-11-18..20);
# BTC's pipeline used 0.085.
EPS2 = (float(os.environ.get("FLOWFV_EPS_BPS", "0.34")) * 1e-4) ** 2
# Binance book event stamp -> the bot's receipt of the same mid (ms), spot (LAT_B) and perp (LAT_U). Fitted 2026-11-20:
# chd_book.py's mids shifted by these match the ETH paper bot's recorded bookTicker mids (bmid / umid, 36 windows on
# 11-18..20) exactly 95% (spot) and 96% (perp) of the frames, the best of 0-300 ms. BTC's pipeline used 135 for both
# (Helsinki, aggTrades).
LAT_B = int(os.environ.get("LAT_B", "50"))
LAT_U = int(os.environ.get("LAT_U", "100"))
# The Chainlink observation stamp's lag behind Binance's exchange clock (ms). The ETH paper bot fits ~400 (median lagMs);
# BTC's was 650.
LX = int(os.environ.get("LX", "400"))
# Inputs on the Helsinki box
L2_ROOT = os.environ.get("L2_ROOT", "/work/david/PolyMarket/database/l2_events/eth-5m")      # pmqb's L2 recorder, ETH
CHD_ROOT = os.environ.get("CHD_ROOT", "/work/david/PolyMarket/database/chd")                  # CryptoHFTData Binance books
CHD_SPOT = os.environ.get("CHD_SPOT", "binance_spot")
CHD_PERP = os.environ.get("CHD_PERP", "binance_futures")
SYMBOL = os.environ.get("SYMBOL", "ETHUSDT")
SLUG = os.environ.get("SLUG", "eth-updown-5m")


def ts(d):
    return datetime.datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=datetime.timezone.utc).timestamp()


def day_of(t_s):
    return datetime.datetime.fromtimestamp(t_s, datetime.timezone.utc).strftime("%Y-%m-%d")


def days(first, last):
    """Every UTC day from first to last, both included."""
    out, t = [], ts(first)
    while t <= ts(last):
        out.append(day_of(t)); t += 86400
    return out


def hour_file(venue, day, hh):
    """One hour of CryptoHFTData books: <day>/<venue>/<HH>/ or <venue>/<day>/<HH>/<SYMBOL>_orderbook.parquet."""
    for p in (os.path.join(CHD_ROOT, day, venue, hh, f"{SYMBOL}_orderbook.parquet"),
              os.path.join(CHD_ROOT, venue, day, hh, f"{SYMBOL}_orderbook.parquet")):
        if os.path.exists(p): return p
    return None
