import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";
import { openStore } from "./lib/open-store.mjs";
import { Engine, DEFAULT_RULES } from "./lib/engine.mjs";
import { makeNotifier } from "./lib/notify.mjs";
import { discoverParser } from "./lib/agents.mjs";
import { writeFile } from "node:fs/promises";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT     = Number(process.env.PORT || 8787);
const TOKEN    = process.env.PEGASUS_TOKEN || "troque-este-token";
const DB       = process.env.PEGASUS_DB || join(HERE, "pegasus.db");
const DRAW     = process.env.PEGASUS_DRAW || "lose";
const GUARD    = Number(process.env.PEGASUS_GUARD || 40);

const { store, kind: storeKind } = await openStore(DB);
const notify = makeNotifier({ token: process.env.TELEGRAM_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID });
const engine = new Engine(store, { rules: DEFAULT_RULES, notify, drawMode: DRAW, guardMin: GUARD });

const clients = new Set();
engine.on(ev => {
  const msg = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) { try { res.write(msg); } catch {} }
});

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const readBody = req => new Promise((ok, no) => {
  let b = ""; let size = 0;
  req.on("data", c => { size += c.length; if (size > 1e6) { no(new Error("corpo grande demais")); req.destroy(); } b += c; });
  req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { no(e); } });
  req.on("error", no);
});

function state() {
  const rounds = store.rounds(400);
  const sides  = store.rounds(5000).map(r => r.side);
  return {
    ok: true,
    total: store.count(),
    rounds: rounds.map(r => ({ id: r.id, ref: r.ref, ts: r.ts, side: r.side, diff: r.diff })),
    context: engine.context(sides),
    scoreboard: engine.scoreboard(),
    signals: store.signals(60),
    config: { drawMode: DRAW, guardMin: GUARD, telegram: Boolean(process.env.TELEGRAM_TOKEN) },
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type, x-pegasus-token");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  try {
    // ── ingestão do coletor ────────────────────────────────────────────
    if (req.method === "POST" && url.pathname === "/ingest") {
      const tok = req.headers["x-pegasus-token"];
      if (tok !== TOKEN) return json(res, 401, { ok: false, error: "token inválido" });
      const body = await readBody(req);
      const list = Array.isArray(body.rounds) ? body.rounds : [body];
      const out = [];
      for (const r of list) {
        if (!r || !["M","E","V"].includes(r.side)) continue;
        const { inserted, id } = store.addRound({
          ref: r.ref, side: r.side,
          diff: Number.isFinite(r.diff) ? r.diff : null,
          ts: Number.isFinite(r.ts) ? r.ts : Date.now(),
        });
        if (!inserted) { out.push({ id, duplicate: true }); continue; }
        const sides = store.rounds(5000).map(x => x.side);
        const r2 = await engine.onRound({ id, side: r.side }, sides);
        out.push({ id, duplicate: false, emitted: r2.emitted.length, resolved: r2.resolved.length });
        engine.emit({ type: "round", round: { id, side: r.side, diff: r.diff ?? null } });
      }
      return json(res, 200, { ok: true, accepted: out, total: store.count() });
    }

    // ── descoberta do parser via CLI de IA ─────────────────────────────
    if (req.method === "POST" && url.pathname === "/discover") {
      if (req.headers["x-pegasus-token"] !== TOKEN) return json(res, 401, { ok:false, error:"token inválido" });
      const body = await readBody(req);
      const frames = Array.isArray(body.frames) ? body.frames : [];
      console.log(`[discover] ${frames.length} frames de ${body.url || "?"}`);
      const out = await discoverParser(frames);
      if (out.ok && out.result?.code) {
        // O código sai em arquivo para você ler. O motor NÃO executa código de IA.
        const file = join(HERE, "parser.gerado.js");
        await writeFile(file,
          `// Gerado por ${process.env.PEGASUS_AI_CMD} em ${new Date().toISOString()}\n` +
          `// Confiança declarada: ${out.result.confidence}\n` +
          `// ${out.result.reasoning}\n// REVISE ANTES DE USAR.\n\n${out.result.code}\n`);
        console.log(`[discover] parser escrito em ${file}`);
        out.savedTo = file;
      }
      return json(res, 200, out);
    }

    if (req.method === "GET" && url.pathname === "/api/state")  return json(res, 200, state());
    if (req.method === "GET" && url.pathname === "/api/health") return json(res, 200, { ok: true, total: store.count(), up: process.uptime() });

    // ── stream ao vivo para o painel ───────────────────────────────────
    if (req.method === "GET" && url.pathname === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "hello", state: state() })}\n\n`);
      clients.add(res);
      const beat = setInterval(() => { try { res.write(": beat\n\n"); } catch {} }, 25000);
      req.on("close", () => { clearInterval(beat); clients.delete(res); });
      return;
    }

    // ── estáticos ──────────────────────────────────────────────────────
    const name = url.pathname === "/" ? "live.html" : normalize(url.pathname).replace(/^(\.\.[/\\])+/, "").replace(/^\//, "");
    const file = join(HERE, "public", name);
    if (!file.startsWith(join(HERE, "public"))) return json(res, 403, { ok: false });
    const types = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".json":"application/json" };
    const ext = name.slice(name.lastIndexOf("."));
    const buf = await readFile(file);
    res.writeHead(200, { "content-type": (types[ext] || "text/plain") + "; charset=utf-8" });
    return res.end(buf);
  } catch (e) {
    if (e.code === "ENOENT") return json(res, 404, { ok: false, error: "não encontrado" });
    return json(res, 500, { ok: false, error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  PEGASUS MONEY — motor no ar`);
  console.log(`  painel     http://localhost:${PORT}/`);
  console.log(`  ingestão   POST http://localhost:${PORT}/ingest   (header x-pegasus-token)`);
  console.log(`  rodadas    ${store.count()}   (armazenamento: ${storeKind})`);
  console.log(`  telegram   ${process.env.TELEGRAM_TOKEN ? "ligado" : "desligado (só console)"}`);
  console.log(`  empate     ${DRAW}   corte automático a partir de ${GUARD} entradas\n`);
});

for (const sig of ["SIGINT","SIGTERM"]) process.on(sig, () => { store.close(); process.exit(0); });
export { server, store, engine };
