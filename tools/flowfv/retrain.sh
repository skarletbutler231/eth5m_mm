#!/bin/bash
# Retrain the flow-FV model (models/flowfv-h2.json) on ETH, on the Helsinki box. README.md here has the inputs and steps.
# Usage: tools/flowfv/retrain.sh FIRST_DAY LAST_DAY [H]      e.g. tools/flowfv/retrain.sh 2026-10-20 2026-11-19
#   LAST_DAY should be a finished UTC day. Reruns are incremental: Binance days, Gamma labels and panel days already built
#   are kept (FRESH=1 rebuilds the panel). INSTALL=0 trains and exports without touching models/.
#   PY (python3), NPROC, FLOWFV_DATA, L2_ROOT, CHD_ROOT, CL_DB / CL_SQL / CL_FILE, LAT_B, LAT_U, LX, FLOWFV_EPS_BPS: see lib.py.
set -euo pipefail
[ $# -ge 2 ] || { sed -n 2,7p "$0"; exit 2; }
F=$1; L=$2; H=${3:-2}
cd "$(dirname "$0")/../.."
T=tools/flowfv
PY=${PY:-python3}
export FLOWFV_DATA=${FLOWFV_DATA:-$PWD/$T/data}
mkdir -p "$FLOWFV_DATA"
step() { echo; echo "== $(date -u +%H:%M:%S) $*"; }

step "0/7 preflight";                        $PY -I $T/preflight.py "$F" "$L"
step "1/7 Binance books -> mids";            $PY -I $T/chd_book.py "$F" "$L"
step "2/7 Gamma labels and strikes";         $PY -I $T/meta.py "$F" "$L"
step "3/7 Chainlink prints";                 $PY -I $T/cl.py "$F" "$L"
step "4/7 per-second sigma";                 $PY -I $T/prep_global.py
[ "${FRESH:-0}" = 1 ] && rm -rf "$FLOWFV_DATA/l2"
step "5/7 100 ms panel";                     $PY -I $T/l2panel.py "$FLOWFV_DATA/l2" "$F" "$L"
step "6/7 fit";                              $PY -I $T/train_ffv.py "$H"
step "7/7 export";                           $PY -I $T/export_model.py "$FLOWFV_DATA/ffv_h${H}_prod.json" "$FLOWFV_DATA/flowfv-h$H.json"

if [ "${INSTALL:-1}" != 1 ]; then echo; echo "INSTALL=0: the model is $FLOWFV_DATA/flowfv-h$H.json"; exit 0; fi
M=models/flowfv-h$H.json; V=models/flowfv-h$H.vectors.json
B="$FLOWFV_DATA/before-$(date -u +%Y%m%dT%H%M%S)"; mkdir -p "$B"
cp $M $V "$B/" 2>/dev/null || true
cp "$FLOWFV_DATA/flowfv-h$H.json" $M
cp "$FLOWFV_DATA/ffv_h${H}_prod_vectors.json" $V
step "self-test (the TS evaluator against LightGBM's predictions)"
NODE_DIR=${NODE_BIN:-$(ls -d "$HOME"/.nvm/versions/node/v*/bin 2>/dev/null | sort -V | tail -1)}
[ -n "$NODE_DIR" ] && export PATH="$NODE_DIR:$PATH"
if [ -d node_modules ] && command -v npm >/dev/null; then
  if ! npm test --silent; then
    cp "$B"/* models/ 2>/dev/null; echo "self-test failed: the previous model is back in models/ (new one in $FLOWFV_DATA)"; exit 1
  fi
else
  echo "no node_modules or npm here: run 'npm ci && npm test' before deploying"
fi
echo
echo "installed $M (tag $(grep -o '"tag":"[^"]*"' $M | head -1 | cut -d'"' -f4)); the previous one is in $B"
echo "report: $FLOWFV_DATA/ffv_h${H}_report.json"
echo "next: git add $M $V && git commit && git push; on the bot's box git pull, then pm2 restart the apps near a window boundary"
