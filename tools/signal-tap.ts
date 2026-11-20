// Watch a running bot's move signals (WS /signal, src/signal.ts) and how long each took to arrive here.
//   npm run signal:tap                        ws://127.0.0.1:$PORT/signal (PORT defaults to 8040)
//   npm run signal:tap -- ws://host:8040/signal
//   npm run signal:tap -- ws://127.0.0.1:8033/signal-fast     the fast detector (5¢ in 100 ms)
//   npm run signal:tap -- ws://127.0.0.1:8033/signal-pair     every signal the pair trade's own detector fires (PAIR_*)
import WebSocket from "ws";

const url = process.argv[2] ?? `ws://127.0.0.1:${process.env.PORT ?? 8040}/signal`;
const c = (x: number | null | undefined) => (x == null ? "—" : (x * 100).toFixed(1) + "¢");
const ts = (t: number) => new Date(t).toISOString().slice(11, 23);
let beats = 0;

function connect(): void {
  const ws = new WebSocket(url);
  ws.on("open", () => console.log(`${ts(Date.now())} connected to ${url}`));
  ws.on("message", (raw) => {
    const rx = Date.now(), m = JSON.parse(raw.toString());
    if (m.type === "hello") {
      console.log(`${ts(rx)} hello: ${m.slug ?? "no window"} · ${m.armed ? "armed" : "not armed"} · min ${c(m.cfg?.minMove)} in ${m.cfg?.lookbackMs} ms${m.cut != null ? `, forecast ≥ ${c(m.cut)} now` : ""}, ` +
        `cooldown ${m.cfg?.cooldownMs} ms · ${m.recent?.length ?? 0} signal(s) this window so far`);
    } else if (m.type === "hb") {
      if (++beats % 30 === 0) console.log(`${ts(rx)} hb ${m.slug ?? "—"} ${m.armed ? "armed" : "not armed"}${m.cut != null ? ` · forecast needed ${c(m.cut)}` : ""}`);
    } else if (m.type === "move") {
      console.log(`${ts(m.t)} #${m.seq} ${m.dir === "up" ? "▲ UP  " : "▼ DOWN"} ${m.move > 0 ? "+" : ""}${c(m.move)} in ${m.lookbackMs} ms ` +
        `· target ${c(m.target.bid0)}/${c(m.target.ask0)} → ${c(m.target.bid)}/${c(m.target.ask)} · book ${c(m.book.bid)}/${c(m.book.ask)} ` +
        `(mid ${m.book.move == null ? "?" : (m.book.move >= 0 ? "+" : "") + c(m.book.move)}${m.lead ? ", lead" : ""}) · pred ${c(m.pred)} · ` +
        `${m.left.toFixed(0)} s left · ${m.step} · arrived ${rx - m.t} ms after`);
    }
  });
  ws.on("close", () => { console.log(`${ts(Date.now())} closed; reconnecting in 2 s`); setTimeout(connect, 2000); });
  ws.on("error", (e) => console.log(`${ts(Date.now())} ${e.message}`));
}
connect();
