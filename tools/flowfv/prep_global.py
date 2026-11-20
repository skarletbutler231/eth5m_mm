# Global per-second series over the Binance days in DATA:
#   bpx[sec]   Binance spot mid as the bot would have it at the whole second (last mid <= sec*1000 - LAT_B)
#   sig[sec]   the bot's sigma_base: EWMA blend (half-lives 120 s / 1800 s, 50/50) of 1 s log-return variance of bpx
#   clpx[sec]  Chainlink price on its stamp clock (last print stamped <= sec*1000)
#   sigcl[sec] the same EWMA blend on Chainlink 1 s returns
#   upx[sec]   Binance USD-M perp mid as received (LAT_U)
# Usage: python3 -I prep_global.py
import sys, os, glob
import numpy as np
from scipy.signal import lfilter
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # python3 -I leaves the script's dir off sys.path
from lib import DATA, LAT_B, LAT_U


def load(kind):
    fs = sorted(glob.glob(os.path.join(DATA, kind, "*.npz")))
    t = np.concatenate([np.load(f)["t"] for f in fs]); p = np.concatenate([np.load(f)["p"] for f in fs])
    return t, p, fs


t, p, fs = load("bin_spot")
tu, pu, fsu = load("bin_um")
S0 = int(t[0] // 1000) + 1; S1 = int(t[-1] // 1000)
secs = np.arange(S0, S1 + 1)


def at(tt, pp, ms):
    j = np.searchsorted(tt, ms, side="right") - 1
    return np.where(j >= 0, pp[np.maximum(j, 0)], np.nan)


bpx = at(t, p, secs * 1000.0 - LAT_B)
upx = at(tu, pu, secs * 1000.0 - LAT_U)
cl = np.load(os.path.join(DATA, "cl.npz"))
clpx = at(cl["obs"], cl["px"], secs * 1000.0)


def ewma_sig(px):
    lp = np.log(px)
    lp = np.where(np.isfinite(lp), lp, np.nan)
    r2 = np.nan_to_num(np.diff(lp, prepend=lp[np.isfinite(lp)][0]) ** 2)
    out = []
    for h in (120.0, 1800.0):
        lam = 2 ** (-1 / h)
        out.append(lfilter([1 - lam], [1, -lam], r2, zi=[lam * r2[:600].mean()])[0])
    return np.sqrt(0.5 * out[0] + 0.5 * out[1])


sig = ewma_sig(bpx); sigcl = ewma_sig(clpx)
np.savez(os.path.join(DATA, "global.npz"), S0=S0, bpx=bpx, upx=upx, clpx=clpx, sig=sig, sigcl=sigcl)
print("seconds", len(secs), "days", len(fs), len(fsu), "sigma bps/sqrt(s) p10/50/90", np.nanpercentile(sig[3600:], [10, 50, 90]) * 1e4,
      "chainlink", np.nanpercentile(sigcl[3600:], [10, 50, 90]) * 1e4)
