// WALLET VAULT — the Polymarket private key (and the optional L2 API creds + Relayer API key) live ONLY in an encrypted
// file (default <repo>/wallet.vault, override VAULT_FILE), never in .env. The passphrase that opens it is typed by the
// developer at startup and kept in memory only: nothing that opens the vault is ever written to disk. Ported from pmqb
// (packages/execution/src/live/vault.ts, 2026-10-30, after a VPS breach exposed its .env): same file format, so either
// project's tools read the other's vault.
//
// ⚠️ What this does NOT stop: someone with a shell on the box WHILE the bot runs can read the key out of process memory,
// or patch the code to log it at the next unlock. Keep only working capital in this wallet.
//
// Crypto  scrypt (N=2^17, r=8, p=1 → 128 MiB and ~0.5 s per guess) stretches the passphrase + a random 32-byte salt into
//         a 256-bit key; AES-256-GCM encrypts AND authenticates the secrets. The KDF params + salt are bound as GCM
//         associated data, so editing the header (e.g. to weaken N) fails exactly like a wrong passphrase.
// Unlock  only MM_MODE=live and the real-order tools unlock (paper and shadow never touch the key). With a terminal:
//         a no-echo prompt. Under pm2 (no TTY): the process listens on a 0600 unix socket in a 0700 dir
//         (<DATA_DIR>/.vault/unlock.sock for the bot) and waits for `npm run unlock`, which answers every waiting app.
//         Decrypted values stay inside this module — NOT in process.env, which spawned children (python tools) inherit.
// Restart every restart relocks: a crashed live app waits locked, its last run's orders still on the book, until
//         someone runs `npm run unlock` (the Trader cancels them right after).
import { randomBytes, scrypt, createCipheriv, createDecipheriv } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, chmodSync, unlinkSync, readdirSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";

/** What the vault holds: the key that signs, and the optional secrets that go with it. The funder address and the Relayer
 *  key's address are not secret and stay in .env. */
export const VAULT_KEYS = ["POLYMARKET_PRIVATE_KEY", "POLYMARKET_API_KEY", "POLYMARKET_API_SECRET",
                           "POLYMARKET_API_PASSPHRASE", "POLYMARKET_RELAYER_API_KEY"] as const;
export type VaultKey = (typeof VAULT_KEYS)[number];
export type VaultSecrets = Partial<Record<VaultKey, string>>;

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
// functions, not constants: the env is loaded (config.ts) after this module's imports are evaluated
export const vaultFile = () => process.env.VAULT_FILE || join(REPO, "wallet.vault");

const KDF = { N: 2 ** 17, r: 8, p: 1 };
export const MIN_PASSPHRASE = 12;
export const PK_RE = /^(0x)?[0-9a-fA-F]{64}$/;

interface Kdf { name: "scrypt"; N: number; r: number; p: number; salt: string }
interface VaultFile {
  format: "pmqb-vault";
  v: 1;
  kdf: Kdf;
  cipher: { name: "aes-256-gcm"; iv: string; tag: string };
  ct: string;
}

export class WrongPassphrase extends Error {}

function deriveKey(passphrase: string, salt: Buffer, k: { N: number; r: number; p: number }): Promise<Buffer> {
  // maxmem must exceed 128·N·r (Node's default 32 MiB cap would reject N=2^17)
  return new Promise((res, rej) => scrypt(passphrase.normalize("NFKC"), salt, 32,
    { N: k.N, r: k.r, p: k.p, maxmem: 256 * k.N * k.r }, (e, key) => (e ? rej(e) : res(key))));
}

// GCM associated data: authenticated but not encrypted — pins the header to the ciphertext.
const aad = (v: number, k: Kdf, cipher: string) =>
  Buffer.from(`pmqb-vault/${v}/${k.name}/${k.N}/${k.r}/${k.p}/${k.salt}/${cipher}`);

/** Encrypt `secrets` under `passphrase` (fresh salt + IV every time) and write `file` atomically, mode 0600. */
export async function sealVault(secrets: VaultSecrets, passphrase: string, file = vaultFile()): Promise<void> {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
  const salt = randomBytes(32), iv = randomBytes(12);
  const kdf: Kdf = { name: "scrypt", ...KDF, salt: salt.toString("base64") };
  const key = await deriveKey(passphrase, salt, kdf);
  const c = createCipheriv("aes-256-gcm", key, iv);
  c.setAAD(aad(1, kdf, "aes-256-gcm"));
  const pt = Buffer.from(JSON.stringify(secrets), "utf8");
  const ct = Buffer.concat([c.update(pt), c.final()]);
  pt.fill(0); key.fill(0); // best effort — JS strings can't be wiped
  const out: VaultFile = { format: "pmqb-vault", v: 1, kdf,
    cipher: { name: "aes-256-gcm", iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64") },
    ct: ct.toString("base64") };
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}

/** Decrypt `file`. Throws WrongPassphrase on a bad passphrase OR a tampered file (GCM can't tell them apart). */
export async function openVault(passphrase: string, file = vaultFile()): Promise<VaultSecrets> {
  const f = JSON.parse(readFileSync(file, "utf8")) as VaultFile;
  if (f.format !== "pmqb-vault" || f.v !== 1 || f.kdf?.name !== "scrypt" || f.cipher?.name !== "aes-256-gcm")
    throw new Error(`${file}: not a wallet vault (or an unsupported version)`);
  const { N, r, p } = f.kdf;
  if (!(Number.isInteger(N) && Number.isInteger(r) && Number.isInteger(p)
        && N >= 2 ** 14 && r >= 1 && p >= 1 && p <= 16 && 128 * N * r <= 2 ** 30))
    throw new Error(`${file}: implausible scrypt parameters`);
  const key = await deriveKey(passphrase, Buffer.from(f.kdf.salt, "base64"), f.kdf);
  // authTagLength pins the full 16-byte tag — otherwise Node accepts a truncated (forgeable) one
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(f.cipher.iv, "base64"), { authTagLength: 16 });
  d.setAAD(aad(f.v, f.kdf, f.cipher.name));
  let pt: Buffer;
  try {
    d.setAuthTag(Buffer.from(f.cipher.tag, "base64"));
    pt = Buffer.concat([d.update(Buffer.from(f.ct, "base64")), d.final()]);
  } catch { throw new WrongPassphrase("wrong passphrase (or the vault file was modified)"); }
  finally { key.fill(0); }
  const secrets = JSON.parse(pt.toString("utf8")) as VaultSecrets;
  pt.fill(0);
  return secrets;
}

/** Read one line from the terminal without echoing it. Rejects on Ctrl-C / Ctrl-D or without a TTY. */
export function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.reject(new Error("no terminal to prompt on"));
  return new Promise((res, rej) => {
    let buf = "";
    const finish = (err?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      if (err) rej(err); else res(buf);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003" || ch === "\u0004") return finish(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else if (ch >= " ") buf += ch;
      }
    };
    stdin.setRawMode(true); // echo off BEFORE the prompt shows, so nothing typed early is echoed
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
    process.stderr.write(question);
  });
}

export const envValue = (k: string) => (process.env[k] || "").replace(/\s+#.*$/, "").trim();

/** Names of vault secrets still present in plaintext in the environment (i.e. in .env). */
export function plaintextSecrets(): string[] {
  return VAULT_KEYS.filter((k) => envValue(k));
}

/** Live trading and the real-order tools refuse to start while a vault secret sits in plaintext in .env / the env. */
export function assertNoPlaintextSecrets(): void {
  const leaked = plaintextSecrets();
  if (leaked.length) throw new Error(`${leaked.join(", ")} still set in plaintext (.env / environment). ` +
    "Move them into the vault (npm run vault:init, or vault:edit), then delete those lines from .env.");
}

let secrets: VaultSecrets | null = null;
export const vaultUnlocked = () => secrets !== null;

/** The unix socket a process without a terminal waits on: the bot's in its DATA_DIR, a tool's under <repo>/.vault. */
function unlockSocket(sockDir?: string): string {
  if (process.env.VAULT_SOCK) return process.env.VAULT_SOCK;
  if (sockDir) return join(sockDir, ".vault", "unlock.sock");
  return join(REPO, ".vault", `${basename(process.argv[1] ?? "tool").replace(/\.[^.]+$/, "")}-${process.pid}.sock`);
}

export interface UnlockOpts {
  /** the bot passes its DATA_DIR, so each live app has its own socket */
  sockDir?: string;
  /** told when a wait on the socket starts (no terminal) */
  onLocked?: (msg: string) => void;
}

/**
 * Decrypt the vault once per process. With a terminal: prompt (3 tries). Without one (pm2): wait on the unlock socket
 * for `npm run unlock`. Refuses while a vault secret is still in plaintext in the environment.
 */
export async function unlockVault(opts: UnlockOpts = {}): Promise<void> {
  if (secrets) return;
  assertNoPlaintextSecrets();
  const file = vaultFile();
  if (!existsSync(file)) throw new Error(`no wallet vault at ${file} — create it with: npm run vault:init`);
  const onLocked = opts.onLocked ?? ((m: string) => console.log(m));

  if (!process.stdin.isTTY) { secrets = await awaitSocketUnlock(file, unlockSocket(opts.sockDir), onLocked); return; }
  for (let attempt = 1; ; attempt++) {
    try { secrets = await openVault(await askHidden("🔒 Wallet vault passphrase: "), file); return; }
    catch (e) {
      if (!(e instanceof WrongPassphrase) || attempt >= 3) throw e;
      console.error(`✗ ${e.message} — try again`);
    }
  }
}

export interface WalletSecrets {
  privateKey: `0x${string}`;
  /** the stored L2 API creds, or null: the client derives them at startup */
  api: { key: string; secret: string; passphrase: string } | null;
  /** "" when not stored: merges and redeems are then left to polymarket.com */
  relayerKey: string;
}

/** The wallet's secrets, unlocking the vault first if this process has not yet (a no-echo prompt with a terminal, the
 *  unlock socket without). The only way the bot and the tools get the key. */
export async function walletSecrets(opts: UnlockOpts = {}): Promise<WalletSecrets> {
  await unlockVault(opts);
  const v = (k: VaultKey) => (secrets?.[k] ?? "").trim();
  const pk = v("POLYMARKET_PRIVATE_KEY");
  if (!PK_RE.test(pk)) throw new Error(`the wallet vault (${vaultFile()}) holds no POLYMARKET_PRIVATE_KEY: add it with npm run vault:edit`);
  const key = v("POLYMARKET_API_KEY"), secret = v("POLYMARKET_API_SECRET"), passphrase = v("POLYMARKET_API_PASSPHRASE");
  return {
    privateKey: (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`,
    api: key && secret && passphrase ? { key, secret, passphrase } : null,
    relayerKey: v("POLYMARKET_RELAYER_API_KEY"),
  };
}

/** No terminal (pm2): accept the passphrase on a private unix socket, one attempt at a time. */
function awaitSocketUnlock(file: string, sock: string, onLocked: (msg: string) => void): Promise<VaultSecrets> {
  // unix socket paths max out at 108 bytes and an over-long one is silently TRUNCATED — possibly to a path outside the
  // 0700 dir. Refuse instead.
  if (Buffer.byteLength(sock) > 100) throw new Error(`unlock socket path too long (${sock}) — set VAULT_SOCK to a shorter path`);
  mkdirSync(dirname(sock), { recursive: true, mode: 0o700 });
  chmodSync(dirname(sock), 0o700); // tighten a pre-existing dir too
  try { unlinkSync(sock); } catch { /* no stale socket from a previous run */ }
  return new Promise((res, rej) => {
    let busy = false;
    const srv = createServer((conn) => {
      let buf = "", got = false;
      conn.setEncoding("utf8");
      conn.on("error", () => { /* client went away */ });
      conn.on("data", async (d: string) => {
        if (got) return;
        buf += d;
        const nl = buf.indexOf("\n");
        if (nl < 0) { if (buf.length > 1024) conn.destroy(); return; }
        got = true;
        if (busy) return void conn.end("error: another unlock attempt is in progress\n");
        busy = true;
        try {
          const s = await openVault(buf.slice(0, nl), file);
          conn.end("ok\n");
          srv.close();
          try { unlinkSync(sock); } catch { /* already gone */ }
          res(s);
        } catch (e) {
          conn.end(`error: ${(e as Error).message}\n`);
          if (!(e instanceof WrongPassphrase)) { srv.close(); rej(e); } // corrupt/unreadable file: fail loudly
        } finally { busy = false; }
      });
    });
    srv.on("error", rej);
    srv.listen(sock, () => {
      chmodSync(sock, 0o600);
      onLocked(`🔒 wallet vault LOCKED — waiting for the passphrase on ${sock}. On the server run: npm run unlock`);
    });
  });
}

/** Every unlock socket under the repo: <repo>/.vault/*.sock and <repo>/<dir>/.vault/*.sock (each live app's DATA_DIR). */
export function waitingSockets(): string[] {
  if (process.env.VAULT_SOCK) return [process.env.VAULT_SOCK];
  const dirs = [join(REPO, ".vault")];
  try {
    for (const d of readdirSync(REPO, { withFileTypes: true }))
      if (d.isDirectory() && d.name !== "node_modules" && !d.name.startsWith(".")) dirs.push(join(REPO, d.name, ".vault"));
  } catch { /* unreadable repo dir */ }
  const out: string[] = [];
  for (const d of dirs) {
    try { for (const f of readdirSync(d)) if (f.endsWith(".sock")) out.push(join(d, f)); } catch { /* no such dir */ }
  }
  return out;
}

/** `npm run unlock` side: send the passphrase to a process waiting in awaitSocketUnlock(); returns its reply. */
export function sendUnlock(passphrase: string, sock: string): Promise<string> {
  return new Promise((res, rej) => {
    const c = createConnection(sock);
    let reply = "";
    c.setEncoding("utf8");
    c.on("connect", () => c.write(`${passphrase}\n`));
    c.on("data", (d: string) => { reply += d; });
    c.on("end", () => res(reply.trim()));
    c.on("error", rej);
  });
}
