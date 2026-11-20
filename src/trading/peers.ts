// PEERS — the other bots trading the same wallet (LIVE_PEER_STATE: their live state.json files, comma-separated).
// The wallet check compares the wallet's tokens of the live window with what this account booked; another bot's tokens
// of the same window (the ask bot's split pairs, the market maker's bids) would read as unseen fills and stop it. So the
// check adds what each peer's account books for those tokens, read from the state.json it rewrites about once a second.
//
// Both bots' state.json carry `wins` (upTok / downTok / up / down, and pairs on btc5m-mm-bot), so a peer is read the same
// whichever bot it is. A peer that just booked a fill or has a split / merge on chain (lastFillAt / busy, saved since
// 2026-11-17) makes the check skip a round: its account and the wallet move at different moments then. A peer stopped
// with tokens still held keeps them in its saved file, so they keep counting (the 2026-11-17 11:57 UTC stop).
// A missing file counts as no peer (it never ran live there); an unreadable one is logged and counts as none too.
import fs from "node:fs";

/** A peer that booked a fill this recently, or has a split / merge on chain, may disagree with the wallet for now. */
export const PEER_QUIET_MS = 30_000;

export interface PeerHeld {
  /** Shares of each asked token the peers' accounts hold, in the order asked. */
  held: number[];
  /** Why the wallet and the peers' books may disagree right now (null = they can be compared). */
  quiet: string | null;
  /** Peers read (files that exist and parsed), for the stop message. */
  peers: number;
}

const short = (f: string) => f.split("/").slice(-4, -2).join("/") || f;
let lastErr = 0;

/** What the peers' saved accounts hold of these tokens (windows not yet settled), and whether to skip this round. */
export async function peerHeld(files: readonly string[], tokens: readonly string[], now: number, log?: (m: string) => void): Promise<PeerHeld> {
  const out: PeerHeld = { held: tokens.map(() => 0), quiet: null, peers: 0 };
  for (const f of files) {
    let st: any;
    try { st = JSON.parse(await fs.promises.readFile(f, "utf8")); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (log && now - lastErr > 3_600_000) { lastErr = now; log(`[live] ⚠ peer state ${f} unreadable (${(e as Error).message}): its tokens are not counted`); }
      continue;
    }
    out.peers++;
    if (typeof st?.lastFillAt === "number" && now - st.lastFillAt < PEER_QUIET_MS) out.quiet ??= `${short(f)} booked a fill ${Math.round((now - st.lastFillAt) / 1000)} s ago`;
    if (st?.busy) out.quiet ??= `${short(f)} has a split / merge on chain`;
    for (const w of st?.wins ?? []) {
      if (w?.state === "settled") continue;
      const pairs = typeof w.pairs === "number" ? w.pairs : 0;
      tokens.forEach((t, i) => {
        if (w.upTok === t) out.held[i] += (w.up ?? 0) + pairs;
        else if (w.downTok === t) out.held[i] += (w.down ?? 0) + pairs;
      });
    }
  }
  return out;
}

/** LIVE_PEER_STATE as a list of paths. */
export const peerFiles = (v: string): string[] => v.split(",").map((s) => s.trim()).filter(Boolean);
