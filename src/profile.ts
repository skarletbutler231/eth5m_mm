// The live dashboard's OWN | BASE | CHALLENGER switch (2026-11-13, the user's request): the live bot follows the paper bot's
// config (eth5m-mm-bot, "base") or the paper challenger's (eth5m-mm-challenger) for the strategy knobs SWITCH_KEYS
// (config.ts), each as that app runs it: its env in ecosystem.config.cjs, then .env, then the default. "own" = the live
// app's own values as it booted with them. A switch takes effect at the next window (engine.ts roll), so a window runs on one
// config from its open; until then it is "pending". The choice is saved in DATA_DIR/profile.json, so a restart keeps it.
// Not followed: size, cap, the venue, the wallet, the loss limit and every other knob (diffs() lists the ones that differ).
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { CFG, ROOT, SWITCH_KEYS, envFile, reloadSwitchKnobs, type SwitchKey } from "./config.js";
import { app } from "./asset.js";

export type ProfileName = "own" | "base" | "challenger";
export const PROFILES: readonly ProfileName[] = ["own", "base", "challenger"];
/** The pm2 app whose config each profile follows. */
export const PROFILE_APPS: Record<Exclude<ProfileName, "own">, string> = { base: app("mm-bot"), challenger: app("mm-challenger") };
/** Added to MM_TAG while a profile is followed, so the dashboard's setup columns keep the windows apart. */
const SUFFIX: Record<ProfileName, string> = { own: "", base: "-base", challenger: "-chal" };
/** A profile's knob values: null = unset (the default). */
export type Knobs = Record<SwitchKey, string | null>;

/** Knobs that are another app's own business and never compared (diffs): which bot it is, its feeds, its paper model. */
const NOT_STRATEGY = /^(MM_MODE|PORT|HOST|DATA_DIR|TWIN_PORT|MM_TAG|PM_SOCKETS|LIVE_.*|PAPER_.*|CRYPTOSTRUCT_.*|POLYMARKET_.*|TG_.*)$/;

const snap = (): Knobs => Object.fromEntries(SWITCH_KEYS.map((k) => [k, process.env[k] ?? null])) as Knobs;
/** The live app's own values, as it booted (before a saved profile is applied). */
const OWN = snap();
const OWN_TAG = CFG.tagName;

let active: ProfileName = "own";
let pending: { name: ProfileName; knobs: Knobs; at: number } | null = null;
/** The window the active profile took effect from (unix s); null = since the boot. */
let since: number | null = null;

/** Each app's env in ecosystem.config.cjs as the file is now (a fresh read, not the cached module). */
function ecoApps(): Map<string, Record<string, string>> {
  const req = createRequire(import.meta.url), file = path.join(ROOT, "ecosystem.config.cjs");
  delete req.cache[req.resolve(file)];
  const eco = req(file) as { apps?: ({ name?: string; env?: Record<string, unknown> } | null)[] };
  const out = new Map<string, Record<string, string>>();
  for (const a of eco?.apps ?? []) if (a?.name) out.set(a.name, Object.fromEntries(Object.entries(a.env ?? {}).map(([k, v]) => [k, String(v)])));
  return out;
}

/** An app's whole env as it runs: its ecosystem env over .env (control.ts reads MM_SESSIONS with it). */
export function appEnv(app: string): Map<string, string> {
  const env = ecoApps().get(app);
  if (!env) throw new Error(`no app "${app}" in ecosystem.config.cjs`);
  const out = envFile(path.join(ROOT, ".env"));
  for (const [k, v] of Object.entries(env)) out.set(k, v);
  return out;
}

/** The knob values a profile would apply, read from the files now. */
export function knobsOf(name: ProfileName): Knobs {
  if (name === "own") return { ...OWN };
  const env = appEnv(PROFILE_APPS[name]);
  return Object.fromEntries(SWITCH_KEYS.map((k) => [k, env.get(k) ?? null])) as Knobs;
}

/** Knobs outside SWITCH_KEYS that the profile's app runs differently from this bot: shown, not followed. */
export function diffs(name: ProfileName): { key: string; live: string | null; other: string | null }[] {
  if (name === "own") return [];
  const env = appEnv(PROFILE_APPS[name]), keys = new Set([...env.keys(), ...envFile(path.join(ROOT, ".env.example")).keys()]);
  const out: { key: string; live: string | null; other: string | null }[] = [];
  for (const k of [...keys].sort()) {
    if ((SWITCH_KEYS as readonly string[]).includes(k) || NOT_STRATEGY.test(k)) continue;
    const live = process.env[k] ?? null, other = env.get(k) ?? null;
    if ((live ?? "") !== (other ?? "")) out.push({ key: k, live, other });
  }
  return out;
}

/** Puts the knobs into process.env and CFG, and the profile's name on MM_TAG. On a bad value nothing changes. */
function apply(name: ProfileName, knobs: Knobs): void {
  const before = snap();
  const put = (v: Knobs) => { for (const k of SWITCH_KEYS) { if (v[k] == null) delete process.env[k]; else process.env[k] = v[k]!; } };
  put(knobs);
  try { reloadSwitchKnobs(); } catch (e) { put(before); reloadSwitchKnobs(); throw e; }
  CFG.tagName = OWN_TAG ? OWN_TAG + SUFFIX[name] : "";
  active = name;
}

const file = () => path.join(CFG.dataDir, "profile.json");
function save(name: ProfileName): void {
  try { fs.writeFileSync(file(), JSON.stringify({ profile: name, at: new Date().toISOString() }) + "\n"); }
  catch { /* the switch still holds until a restart */ }
}

/** At boot (live only): the saved profile, read from the files now, is applied before the first window. */
export function bootProfile(log: (m: string) => void): void {
  if (CFG.mode !== "live") return;
  let name: ProfileName = "own";
  try { name = (JSON.parse(fs.readFileSync(file(), "utf8")) as { profile?: ProfileName }).profile ?? "own"; } catch { return; }
  if (!PROFILES.includes(name) || name === "own") return;
  try {
    apply(name, knobsOf(name));
    log(`[profile] following ${name} (${PROFILE_APPS[name]}) from the boot: ${fmt(knobsOf(name))}`);
  } catch (e) {
    log(`[profile] saved profile ${name} NOT applied, running own config: ${(e as Error).message}`);
  }
}

/** The dashboard's switch: the profile, with its values read now, takes effect at the next window. */
export function requestProfile(name: string, log: (m: string) => void): { ok: true } | { ok: false; error: string } {
  if (CFG.mode !== "live") return { ok: false, error: `MM_MODE=${CFG.mode}: the switch is for the live bot` };
  if (!PROFILES.includes(name as ProfileName)) return { ok: false, error: `profile must be one of ${PROFILES.join(", ")}` };
  const p = name as ProfileName;
  let knobs: Knobs;
  try { knobs = knobsOf(p); } catch (e) { return { ok: false, error: (e as Error).message }; }
  save(p);
  if (p === active) { pending = null; log(`[profile] switch back to ${p} before the next window: nothing changes`); return { ok: true }; }
  pending = { name: p, knobs, at: Date.now() };
  log(`[profile] ${active} → ${p} requested; from the next window: ${fmt(knobs)}`);
  return { ok: true };
}

/** At a window's open (engine.ts): a pending switch is applied. true = the knobs changed (rebuild what derives from them). */
export function applyPending(startTs: number, log: (m: string) => void): boolean {
  if (!pending) return false;
  const p = pending; pending = null;
  try {
    apply(p.name, p.knobs);
    since = startTs;
    log(`[profile] window ${startTs} runs ${p.name}${p.name === "own" ? "" : ` (${PROFILE_APPS[p.name]})`}: ${fmt(p.knobs)}`);
    return true;
  } catch (e) {
    log(`[profile] ${p.name} NOT applied, staying on ${active}: ${(e as Error).message}`);
    return false;
  }
}

type Detail = Record<string, { app: string | null; knobs: Knobs | null; diffs: ReturnType<typeof diffs>; error: string | null }>;
/** Each profile's values as the files are, read at most once a minute: the reads are synchronous, on the loop the cancels run on. */
let detail: { at: number; each: Detail } | null = null;
function profileDetail(fresh = false): Detail {
  if (!fresh && detail && Date.now() - detail.at < 60_000) return detail.each;
  const each: Detail = {};
  for (const p of PROFILES) {
    try { each[p] = { app: p === "own" ? null : PROFILE_APPS[p], knobs: knobsOf(p), diffs: diffs(p), error: null }; }
    catch (e) { each[p] = { app: p === "own" ? null : PROFILE_APPS[p], knobs: null, diffs: [], error: (e as Error).message }; }
  }
  detail = { at: Date.now(), each };
  return each;
}

/** For the dashboard: the active profile, a pending one, the knobs now, and each profile's values (fresh = read the files now). */
export function profileStatus(fresh = false) {
  return { active, pending: pending ? { name: pending.name, at: pending.at } : null, since, now: snap(), tagName: CFG.tagName,
    profiles: profileDetail(fresh) };
}

const fmt = (k: Knobs) => SWITCH_KEYS.map((key) => `${key}=${k[key] ?? "(default)"}`).join(" ");
