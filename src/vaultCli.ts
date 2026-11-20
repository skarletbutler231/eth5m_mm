// Wallet vault CLI. Design + threat model: src/trading/vault.ts.
//
//   npm run vault:init      create the vault: the private key (imported from .env if it is still there, else pasted),
//                           optionally the L2 API creds and the Relayer API key, and a passphrase. `-- --force` replaces one.
//   npm run vault:edit      change entries of an existing vault (keep / paste / remove)
//   npm run vault:verify    decrypt and show what it holds — the signer ADDRESS, never a key
//   npm run vault:passwd    change the passphrase (fresh salt + IV)
//   npm run unlock          send the passphrase to every live app (or tool) waiting locked under pm2
// Every secret is typed with echo off, so none ever touches disk (or shell history) unencrypted.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { ROOT } from "./config.js";   // loads .env
import { app } from "./asset.js";
import { askHidden, envValue, openVault, sealVault, sendUnlock, plaintextSecrets, vaultFile, waitingSockets,
         MIN_PASSPHRASE, PK_RE, type VaultSecrets } from "./trading/vault.js";

const signer = (pk: string) => privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`).address;

function describe(s: VaultSecrets) {
  const funder = envValue("POLYMARKET_FUNDER_ADDRESS");
  console.log(`  private key         ${s.POLYMARKET_PRIVATE_KEY ? `set · signer ${signer(s.POLYMARKET_PRIVATE_KEY)}` : "NOT SET — live trading refuses to start"}`);
  console.log(`  funder (.env)       ${funder || "not set in .env (POLYMARKET_FUNDER_ADDRESS)"}`);
  console.log(`  L2 API creds        ${s.POLYMARKET_API_KEY ? "stored" : "derived at startup"}`);
  console.log(`  Relayer API key     ${s.POLYMARKET_RELAYER_API_KEY ? "stored" : "not set (merges / redeems left to polymarket.com)"}`);
}

async function newPassphrase(): Promise<string> {
  console.log(`Choose a vault passphrase (≥ ${MIN_PASSPHRASE} chars; 5+ random words is ideal). It is NEVER stored —`);
  console.log("lose it and the vault is gone (the key itself is still yours, if you have it elsewhere).");
  const a = await askHidden("New passphrase: ");
  if (a.length < MIN_PASSPHRASE) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
  if ((await askHidden("Repeat passphrase: ")) !== a) throw new Error("passphrases do not match");
  return a;
}

async function askKey(prompt: string): Promise<string> {
  const pk = (await askHidden(prompt)).trim();
  if (pk && pk !== "-" && !PK_RE.test(pk)) throw new Error("not a 32-byte hex private key");
  return pk;
}

async function askApiCreds(s: VaultSecrets) {
  s.POLYMARKET_API_KEY = (await askHidden("L2 API key: ")).trim();
  s.POLYMARKET_API_SECRET = (await askHidden("L2 API secret: ")).trim();
  s.POLYMARKET_API_PASSPHRASE = (await askHidden("L2 API passphrase: ")).trim();
  if (!s.POLYMARKET_API_KEY || !s.POLYMARKET_API_SECRET || !s.POLYMARKET_API_PASSPHRASE)
    throw new Error("the L2 API key, secret and passphrase are all required");
}

const yes = async (q: string, dflt: boolean) => {
  const a = (await askHidden(q)).trim().toLowerCase();
  return a ? a === "y" || a === "yes" : dflt;
};

/** Rewrite .env without the vault secrets' lines (atomically, same mode). Only after the vault was re-opened. */
function stripEnv(names: string[]): number {
  const f = path.join(ROOT, ".env");
  if (!fs.existsSync(f)) return 0;
  const re = new RegExp(`^\\s*(${names.join("|")})\\s*=`);
  const lines = fs.readFileSync(f, "utf8").split("\n");
  const keep = lines.filter((l) => !re.test(l));
  const tmp = `${f}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, keep.join("\n"), { mode: fs.statSync(f).mode & 0o777 });
  fs.renameSync(tmp, f);
  return lines.length - keep.length;
}

function warnPlaintext() {
  const leaked = plaintextSecrets();
  if (leaked.length) console.log(`⚠️  still in plaintext in .env: ${leaked.join(", ")} — delete those lines; ` +
    "live trading refuses to start while they are there.");
}

async function init() {
  const file = vaultFile();
  if (fs.existsSync(file) && !process.argv.includes("--force"))
    throw new Error(`${file} already exists — use \`npm run vault:edit\` to change it, or \`-- --force\` to replace it`);
  const s: VaultSecrets = {};
  const imported: string[] = [];
  // what is still in .env can be moved as is; only what is missing is asked for
  const inEnv = plaintextSecrets().filter((k) => k !== "POLYMARKET_PRIVATE_KEY" || PK_RE.test(envValue(k)));
  const envPk = inEnv.includes("POLYMARKET_PRIVATE_KEY") ? ` (signer ${signer(envValue("POLYMARKET_PRIVATE_KEY"))})` : "";
  if (inEnv.length && await yes(`Import ${inEnv.join(", ")} from .env${envPk}? (Y/n): `, true)) {
    for (const k of inEnv) { s[k as keyof VaultSecrets] = envValue(k); imported.push(k); }
    console.log(`  imported from .env: ${imported.join(", ")}`);
  }
  if (!s.POLYMARKET_PRIVATE_KEY) {
    const pk = await askKey("Polymarket private key (hidden): ");
    if (!pk || pk === "-") throw new Error("the private key is required");
    s.POLYMARKET_PRIVATE_KEY = pk;
    console.log(`  signer ${signer(pk)}`);
  }
  if (!s.POLYMARKET_API_KEY && await yes("Store cached L2 API creds? (y/N): ", false)) await askApiCreds(s);
  if (!s.POLYMARKET_RELAYER_API_KEY) {
    const rk = (await askHidden("Relayer API key (optional — Enter to skip): ")).trim();
    if (rk) s.POLYMARKET_RELAYER_API_KEY = rk;
  }
  const pass = await newPassphrase();
  await sealVault(s, pass, file);
  await openVault(pass, file);   // read it back before anything is removed from .env
  console.log(`✓ vault written and verified: ${file} (mode 0600)`);
  describe(s);
  if (imported.length) {
    if (await yes(`Remove ${imported.join(", ")} from .env now? (y/N): `, false))
      console.log(`✓ ${stripEnv(imported)} line(s) removed from ${path.join(ROOT, ".env")}`);
  }
  warnPlaintext();
}

async function edit() {
  const pass = await askHidden("Vault passphrase: ");
  const s = await openVault(pass);
  console.log("Current contents:"); describe(s);
  console.log("For each entry: Enter keeps it. Typed input is hidden.");
  const pk = await askKey(`Private key [${s.POLYMARKET_PRIVATE_KEY ? "set" : "not set"}] — paste a new one: `);
  if (pk && pk !== "-") s.POLYMARKET_PRIVATE_KEY = pk;
  const api = (await askHidden(`L2 API creds [${s.POLYMARKET_API_KEY ? "stored" : "derived"}] — "y" to enter new ones, "-" to remove: `)).trim().toLowerCase();
  if (api === "-") { delete s.POLYMARKET_API_KEY; delete s.POLYMARKET_API_SECRET; delete s.POLYMARKET_API_PASSPHRASE; }
  else if (api === "y") await askApiCreds(s);
  const rk = (await askHidden(`Relayer API key [${s.POLYMARKET_RELAYER_API_KEY ? "stored" : "not set"}] — paste a new one, or "-" to remove: `)).trim();
  if (rk === "-") delete s.POLYMARKET_RELAYER_API_KEY;
  else if (rk) s.POLYMARKET_RELAYER_API_KEY = rk;
  // entries this bot doesn't use (e.g. pmqb's USER_SECRETS_KEY, when VAULT_FILE points at its vault) are kept as they are
  await sealVault(s, pass);
  console.log(`✓ vault updated (same passphrase, fresh salt + IV) · ${vaultFile()}`);
  describe(s);
  console.log("Restart the live app (and unlock) for it to take effect.");
  warnPlaintext();
}

async function verify() {
  const s = await openVault(await askHidden("Vault passphrase: "));
  console.log("✓ unlocked"); describe(s);
  warnPlaintext();
}

async function passwd() {
  const s = await openVault(await askHidden("Current passphrase: "));
  await sealVault(s, await newPassphrase());
  console.log(`✓ passphrase changed · ${vaultFile()}`);
}

/** Every process waiting locked gets the passphrase (the two live apps can both be waiting). `--wait N`: poll up to N s for
 *  a socket to appear first (tools/start-live.sh, right after pm2 start). */
async function unlock() {
  const wi = process.argv.indexOf("--wait"), waitS = wi > 0 ? Number(process.argv[wi + 1]) || 0 : 0;
  let socks = await listening();
  for (const t0 = Date.now(); !socks.length && Date.now() - t0 < waitS * 1000; socks = await listening())
    await new Promise((r) => setTimeout(r, 500));
  if (!socks.length) throw new Error(`no live app is waiting for an unlock (is it running under pm2? pm2 logs ${app("mm-live")})`);
  const pass = await askHidden("🔒 Wallet vault passphrase: ");
  let ok = 0;
  for (const sock of socks) {
    const where = shown(sock);
    try {
      const reply = await sendUnlock(pass, sock);
      if (reply === "ok") { ok++; console.log(`✓ unlocked: ${where}`); }
      else console.log(`✗ ${where}: ${reply.replace(/^error:\s*/, "")}`);
    } catch (e) { console.log(`✗ ${where}: ${(e as Error).message}`); }
  }
  if (!ok) throw new Error("nothing was unlocked");
}

/** A socket's path for the log: relative inside the repo, absolute outside it. */
const shown = (sock: string) => { const r = path.relative(ROOT, path.resolve(sock)); return r.startsWith("..") ? path.resolve(sock) : r; };

/** The unlock sockets a process is listening on. A socket file whose process is gone (a killed app leaves it) is removed. */
async function listening(): Promise<string[]> {
  const out: string[] = [];
  for (const sock of waitingSockets()) {
    const up = await new Promise<boolean>((res) => {
      const c = net.createConnection(sock);
      c.on("connect", () => { c.destroy(); res(true); });
      c.on("error", () => res(false));
    });
    if (up) out.push(sock);
    else { try { fs.unlinkSync(sock); console.log(`· ${shown(sock)}: nobody listening (stale), removed`); } catch { /* not ours */ } }
  }
  return out;
}

const cmds: Record<string, () => Promise<void>> = { init, edit, verify, passwd, unlock };
const cmd = cmds[process.argv[2] ?? ""];
if (!cmd) {
  console.error("usage: vaultCli.ts init [--force] | edit | verify | passwd | unlock [--wait S]");
  process.exit(2);
}
cmd().then(() => process.exit(0), (e) => { console.error("✗", e?.message || e); process.exit(1); });
