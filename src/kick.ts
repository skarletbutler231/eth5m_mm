// KICK — MM_DECIDE_EVENTS' scheduler: an input changed, so run the decide step as soon as the event loop is free, once for a
// burst of messages (setImmediate), and never sooner than minMs after the last run from any source: a kick inside that
// gap waits for its end (a timer) instead of being dropped. The engine calls ran() from its own timer step too.

export class Kick {
  private last = -Infinity;
  private imm = false;
  private timer: NodeJS.Timeout | null = null;
  /** Kicks that waited for the gap (for the engine's minute log). */
  deferred = 0;

  constructor(private readonly minMs: number, private readonly run: () => void, private readonly now: () => number = Date.now) {}

  /** A decide step ran now (from the kick or elsewhere): the gap counts from here. */
  ran(t = this.now()): void { this.last = t; }

  /** Within the gap since the last run. */
  tooSoon(t = this.now()): boolean { return t - this.last < this.minMs; }

  kick(): void {
    if (this.imm || this.timer) return;
    const go = () => { this.imm = false; this.timer = null; this.run(); };
    const wait = this.last + this.minMs - this.now();
    if (wait > 0) { this.deferred++; this.timer = setTimeout(go, wait); }
    else { this.imm = true; setImmediate(go); }
  }
}
