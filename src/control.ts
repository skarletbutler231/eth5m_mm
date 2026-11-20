// The dashboard's own controls (2026-11-17, the user's request), paper or live:
//   size        the Inventory & PnL panel's 10 | 20 | 40 switch: MM_ORDER_SIZE that many shares a side, MM_MAX_POSITION
//               twice it (10/20, 20/40, 40/80). Like the CONFIG switch (profile.ts) it takes effect at the next window
//               (engine.ts roll), so a window runs on one size from its open; until then it is "pending".
//   stop/start  the header's button: stopped = no order of any kind goes out (quotes, takes, the lock's takes), every
//               working one is cancelled at once. Held inventory, the merge / redeem jobs and the settlements carry on.
//               Separate from the live bot's own stops (loss limit, wallet check), which this does not lift.
//   sessions    MM_SESSIONS: the order size, or a stop, by the UTC hour a window opens in, e.g.
//               "0-3=20,13-16=20,4-8=stop,*=10". Ranges are whole hours, both ends included (4-8 = 04:00 to 08:59;
//               22-2 wraps midnight); a value is a size (cap 2×), size/cap ("20/30") or "stop"; * = every hour no range
//               names (no * = those hours run the base size). Re-read from the app's env in ecosystem.config.cjs, then
//               .env, at every window, so an edit takes effect from the next window without a restart. off / unset = no
//               schedule. With a schedule:
//                 · the panel's size switch overrides the session's size until the session ends (then the schedule's);
//                 · START in a stopped session trades through it until it ends; STOP always holds until START.
// The base size and a STOP are saved in DATA_DIR/control.json, so a restart keeps them (a bot stopped from the dashboard
// boots stopped); the session overrides are not (a restart goes back to the schedule).
import fs from "node:fs";
import path from "node:path";
import { CFG } from "./config.js";
import { appEnv } from "./profile.js";

export const SIZES = [10, 20, 40] as const;
/** What a window records of its session (engine.ts meta and index). */
export interface WinSession { label: string | null; size: number; cap: number; stopped: boolean }
export type SizeChoice = (typeof SIZES)[number];
/** The cap that goes with an order size. */
export const capOf = (size: number) => 2 * size;

/** One MM_SESSIONS entry: UTC hours from..to (both included, may wrap midnight), or every hour no range names (def). */
export interface Session { label: string; from: number; to: number; def: boolean; stop: boolean; size: number | null; cap: number | null }
export interface Sessions { spec: string; list: Session[]; byHour: (Session | null)[] }

/** MM_SESSIONS parsed; null = off. Throws on a bad spec (an hour in two ranges, a size out of 1..1000, ...). */
export function parseSessions(spec: string | null | undefined): Sessions | null {
  const s = (spec ?? "").trim();
  if (!s || /^off$/i.test(s)) return null;
  const list: Session[] = [];
  const byHour: (Session | null)[] = Array(24).fill(null);
  let def: Session | null = null;
  for (const raw of s.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = raw.match(/^(\*|(\d{1,2})(?:\s*-\s*(\d{1,2}))?)\s*[=:]\s*(stop|(\d+)(?:\s*\/\s*(\d+))?)$/i);
    if (!m) throw new Error(`MM_SESSIONS: "${raw}" is not HOURS=SIZE, HOURS=SIZE/CAP or HOURS=stop (HOURS: 13, 13-16 or *)`);
    const stop = /^stop$/i.test(m[4]);
    const size = stop ? null : Number(m[5]), cap = stop ? null : m[6] != null ? Number(m[6]) : capOf(size!);
    if (!stop && (!(size! >= 1 && size! <= 1000) || !(cap! >= size! && cap! <= 2000)))
      throw new Error(`MM_SESSIONS: "${raw}": size 1..1000, cap from the size to 2000`);
    if (m[1] === "*") {
      if (def) throw new Error("MM_SESSIONS: two * entries");
      def = { label: "*", from: 0, to: 23, def: true, stop, size, cap };
      continue;
    }
    const from = Number(m[2]), to = m[3] != null ? Number(m[3]) : from;
    if (from > 23 || to > 23) throw new Error(`MM_SESSIONS: "${raw}": hours are 0..23`);
    const x: Session = { label: from === to ? `${from}` : `${from}-${to}`, from, to, def: false, stop, size, cap };
    for (let h = from; ; h = (h + 1) % 24) {
      if (byHour[h]) throw new Error(`MM_SESSIONS: hour ${h} is in ${byHour[h]!.label} and ${x.label}`);
      byHour[h] = x;
      if (h === to) break;
    }
    list.push(x);
  }
  list.sort((a, b) => a.from - b.from);
  if (def) { list.push(def); for (let h = 0; h < 24; h++) byHour[h] ??= def; }
  return { spec: s, list, byHour };
}

const hourOf = (ts: number) => new Date(ts * 1000).getUTCHours();
const sizeTxt = (x: Session | null) => (!x ? "base size" : x.stop ? "STOP" : `${x.size}/${x.cap}`);

/** The size and cap the bot booted with (env), before a saved choice is applied. */
const OWN = { size: CFG.orderSize, cap: CFG.maxPosition };
/** The size when no session sets one: the env's, or the panel's choice made outside a sized session. */
let base = { ...OWN };
let pending: { size: SizeChoice; at: number } | null = null;
/** The window the current size took effect from (unix s); null = since the boot. */
let since: number | null = null;
/** STOP from the dashboard: holds until START, whatever the schedule. */
let stopped: { at: number } | null = null;

let sessions: Sessions | null = null;
let sessErr: string | null = null;
/** The session of the window now (null: no schedule, or an hour no entry names). */
let cur: Session | null = null;
let curWin: number | null = null;
/** For the session now only: the panel's size, START through a stopped session. */
let sizeOver: { size: number; cap: number } | null = null;
let startOver = false;

const file = () => path.join(CFG.dataDir, "control.json");
function save(): void {
  try { fs.writeFileSync(file(), JSON.stringify({ size: base.size, cap: base.cap, stopped: stopped != null, at: new Date().toISOString() }) + "\n"); }
  catch { /* the choice still holds until a restart */ }
}

const isSize = (v: unknown): v is SizeChoice => (SIZES as readonly unknown[]).includes(v);
/** Puts a size in CFG; true if it changed. */
const put = (s: { size: number; cap: number }) => {
  if (CFG.orderSize === s.size && CFG.maxPosition === s.cap) return false;
  CFG.orderSize = s.size; CFG.maxPosition = s.cap; return true;
};
/** The size the window now runs on: the panel's override, the session's, else the base. */
const target = () => sizeOver ?? (cur && !cur.stop && cur.size != null ? { size: cur.size, cap: cur.cap! } : base);

/** MM_SESSIONS as this app runs it now: its env in ecosystem.config.cjs over .env (pm2 names the app in env "name"),
 *  else the env it booted with. A bad spec keeps the last good one (logged once per spec). */
function loadSessions(log: (m: string) => void): void {
  let spec: string | null = process.env.MM_SESSIONS ?? null;
  const app = process.env.name;
  if (app) { try { spec = appEnv(app).get("MM_SESSIONS") ?? null; } catch { /* not in the ecosystem file: the boot env */ } }
  if ((spec ?? "").trim() === (sessions?.spec ?? "") && !sessErr) return;
  try {
    const next = parseSessions(spec);
    if ((next?.spec ?? "") !== (sessions?.spec ?? "") || sessErr)
      log(next ? `[sessions] schedule: ${next.list.map((x) => `${x.label}=${sizeTxt(x)}`).join(" · ")} (UTC hours, both ends included)` : "[sessions] no schedule (MM_SESSIONS off)");
    sessions = next; sessErr = null;
  } catch (e) {
    const msg = (e as Error).message;
    if (msg !== sessErr) log(`[sessions] ⚠ ${msg}: kept ${sessions ? `the last good schedule (${sessions.spec})` : "no schedule"}`);
    sessErr = msg;
  }
}

/** At boot (paper or live, before anything trades): the saved base size and stop, and MM_SESSIONS. */
export function bootControl(log: (m: string) => void): void {
  if (CFG.mode === "shadow") return;
  loadSessions(log);
  let st: { size?: unknown; cap?: unknown; stopped?: unknown };
  try { st = JSON.parse(fs.readFileSync(file(), "utf8")); } catch { return; }
  if (typeof st.size === "number" && st.size >= 1) {
    base = { size: st.size, cap: typeof st.cap === "number" && st.cap >= st.size ? st.cap : capOf(st.size) };
    if (put(base)) log(`[control] base order size ${base.size} sh a side, cap ${base.cap} (saved on the dashboard; env ${OWN.size}/${OWN.cap})`);
  }
  if (st.stopped === true) {
    stopped = { at: Date.now() };
    log(`[control] ⏸ STOPPED from the dashboard before the restart: no orders until START`);
  }
}

/** The panel's switch: the size, with its cap, from the next window: for the rest of the session the window opens in
 *  when a sized session runs then, else as the base. */
export function requestSize(v: unknown, log: (m: string) => void): { ok: true } | { ok: false; error: string } {
  if (CFG.mode === "shadow") return { ok: false, error: "MM_MODE=shadow: nothing is traded" };
  const s = Number(v);
  if (!isSize(s)) return { ok: false, error: `size must be one of ${SIZES.join(", ")}` };
  if (s === CFG.orderSize && capOf(s) === CFG.maxPosition) {
    if (pending) log(`[control] size back to ${s} before the next window: nothing changes`);
    pending = null;
  } else {
    pending = { size: s, at: Date.now() };
    log(`[control] order size ${CFG.orderSize}/${CFG.maxPosition} → ${s}/${capOf(s)} requested; from the next window`);
  }
  return { ok: true };
}

/** At a window's open (engine.ts): the session it opens in (MM_SESSIONS read again), then a pending size. changed = the
 *  size in CFG changed (rebuild what derives from it); stop = this window opens stopped and the last did not. */
export function applyWindow(startTs: number, log: (m: string) => void): { changed: boolean; stop: boolean } {
  const wasStopped = stopReason() != null;
  loadSessions(log);
  const next = sessions?.byHour[hourOf(startTs)] ?? null;
  if (curWin == null || next?.label !== cur?.label || next?.stop !== cur?.stop || next?.size !== cur?.size || next?.cap !== cur?.cap) {
    if (curWin != null && (sizeOver || startOver)) log(`[sessions] session ${cur?.label ?? "-"} over: the dashboard's override ends`);
    sizeOver = null; startOver = false;
    if (sessions) log(`[sessions] window ${startTs} (${hm(startTs)} UTC) session ${next?.label ?? "-"}: ${sizeTxt(next)}`);
  }
  cur = next; curWin = startTs;
  if (pending) {
    const s = { size: pending.size, cap: capOf(pending.size) };
    pending = null;
    // a size set inside a sized session lasts until it ends; elsewhere it is the base, kept by a restart
    if (cur && !cur.stop && cur.size != null) { sizeOver = s; log(`[control] window ${startTs}: ${s.size}/${s.cap} from the dashboard until session ${cur.label} ends`); }
    else { base = s; save(); log(`[control] window ${startTs}: base size ${s.size}/${s.cap} from the dashboard`); }
  }
  const changed = put(target());
  if (changed) { since = startTs; log(`[control] window ${startTs} runs ${CFG.orderSize} sh a side, cap ${CFG.maxPosition}`); }
  return { changed, stop: !wasStopped && stopReason() != null };
}

/** The header's stop / start. START in a stopped session trades through it until it ends. */
export function setStopped(on: boolean, log: (m: string) => void): void {
  if (on) {
    if (stopped) return;
    stopped = { at: Date.now() }; startOver = false;
    log(`[control] ⏸ STOPPED from the dashboard: working orders cancelled, no new ones until START`);
  } else {
    const sched = cur?.stop === true && !startOver;
    if (!stopped && !sched) return;
    stopped = null;
    if (sched) startOver = true;
    log(`[control] ▶ STARTED from the dashboard${sched ? `: trading through the scheduled stop of session ${cur!.label} until it ends` : ""}: quoting resumes`);
  }
  save();
}

/** When the session now ends: the next hour that runs another session (unix s); null = no schedule, or all day the same. */
function sessionEnd(now: number): number | null {
  if (!sessions || curWin == null) return null;
  const h0 = Math.floor(now / 3600) * 3600;
  for (let k = 1; k <= 24; k++) if (sessions.byHour[hourOf(h0 + k * 3600)] !== cur) return h0 + k * 3600;
  return null;
}
const hm = (ts: number) => new Date(ts * 1000).toISOString().slice(11, 16);

/** Why no order may go out (null = trading): the dashboard's STOP, or a stopped session. */
export function stopReason(): string | null {
  if (stopped) return `STOPPED from the dashboard at ${new Date(stopped.at).toISOString().slice(11, 19)} UTC: press START to trade`;
  if (cur?.stop && !startOver) {
    const end = sessionEnd(Date.now() / 1000);
    return `scheduled stop: session ${cur.label} UTC (MM_SESSIONS)${end ? ` until ${hm(end)} UTC` : ""}: START trades through it`;
  }
  return null;
}

/** For the dashboard. */
export function controlStatus() {
  const now = Date.now() / 1000, end = sessionEnd(now);
  const nextS = end != null ? sessions!.byHour[hourOf(end)] : null;
  return { sizes: SIZES, size: CFG.orderSize, cap: CFG.maxPosition, own: OWN, base, since,
    pending: pending ? { size: pending.size, cap: capOf(pending.size), at: pending.at } : null,
    stopped: stopReason() != null, manualStop: stopped != null, stoppedAt: stopped?.at ?? null, why: stopReason(),
    sessions: sessions ? { spec: sessions.spec, list: sessions.list.map(({ label, from, to, def, stop, size, cap }) => ({ label, from, to, def, stop, size, cap })) } : null,
    sessionError: sessErr,
    session: sessions ? { label: cur?.label ?? null, stop: cur?.stop ?? false, size: cur?.size ?? null, cap: cur?.cap ?? null,
      until: end, next: nextS ? { label: nextS.label, stop: nextS.stop, size: nextS.size, cap: nextS.cap } : end != null ? { label: null, stop: false, size: null, cap: null } : null,
      sizeOver, startOver } : null };
}
