#!/usr/bin/env bash
# Start a LIVE app (real money) beside the paper ones:
#   bash tools/start-live.sh                   eth5m-mm-live: the market maker, dashboard :8041, data in data-live/
#   bash tools/start-live.sh eth5m-pair-live   the pair trade, dashboard :8043, data in data-pair-live/ (define the app first)
#   bash tools/start-live.sh eth5m-mm-challenger-live   the paper challenger's knobs live, dashboard :8045, data in
#                                              data-challenger-live/, on its OWN wallet (data-challenger-live/wallet.json)
# The first start seeds the data dir with the paper bot's calibration and window index, so it quotes from the same model
# state instead of the priors. Settings: ecosystem.config.cjs (the app's env) over .env.
set -euo pipefail
cd "$(dirname "$0")/.."
app="${1:-eth5m-mm-live}"
case "$app" in
  eth5m-mm-live)   dir=data-live;      port=8041 ;;
  eth5m-pair-live) dir=data-pair-live; port=8043 ;;
  eth5m-mm-challenger-live) dir=data-challenger-live; port=8045 ;;
  *) echo "unknown live app: $app (eth5m-mm-live | eth5m-pair-live | eth5m-mm-challenger-live)" >&2; exit 1 ;;
esac
if [ "$app" = eth5m-mm-challenger-live ] && ! grep -q '"funder"' "$dir/wallet.json" 2>/dev/null; then
  echo "eth5m-mm-challenger-live needs its own wallet: write $dir/wallet.json" >&2
  echo '  {"funder": "0x<its Deposit Wallet>", "vault": "wallet-challenger.vault", "relayerKeyAddress": "0x<optional>"}' >&2
  echo "  and create the vault with its key: VAULT_FILE=wallet-challenger.vault npm run vault:init" >&2
  exit 1
fi
mkdir -p "$dir"
# (not before the paper bot has run: the live app then starts from the priors)
[ -f "$dir/calib.json" ] || [ ! -f data/calib.json ] || cp data/calib.json "$dir/"
[ -f "$dir/index.jsonl" ] || [ ! -f data/index.jsonl ] || cp data/index.jsonl "$dir/"
# pm2 keeps the interpreter and env an app was first started with: drop the old entry (a running bot stops and cancels
# its orders first) so ecosystem.config.cjs applies in full, Node >= 24 included
pm2 delete "$app" >/dev/null 2>&1 || true
rm -f "$dir/.vault/unlock.sock"   # the old process's socket, so the unlock below waits for the new one
pm2 start ecosystem.config.cjs --only "$app"
echo "live app started: pm2 logs $app · dashboard http://127.0.0.1:$port · stop: pm2 stop $app"
# it boots LOCKED: the private key is in the encrypted wallet vault (src/trading/vault.ts) and the passphrase is typed here,
# never stored. Ctrl-C skips it; the app keeps waiting until `npm run unlock`.
if [ -t 0 ] && command -v node >/dev/null 2>&1; then
  node node_modules/tsx/dist/cli.mjs src/vaultCli.ts unlock --wait 60 || echo "not unlocked yet: npm run unlock"
else
  echo "the app waits LOCKED for the wallet vault passphrase: npm run unlock"
fi
