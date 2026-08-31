// ==UserScript==
// @name         Pegasus Money — Coletor Vivo
// @namespace    pegasus.money
// @version      0.2.0
// @description  Captura os resultados da mesa ao vivo por WebSocket, rede ou DOM. Não aposta, não clica, não automatiza a mesa.
// @match        https://www.zonadejogo.bet.br/*
// @match        https://*.pragmaticplay.net/*
// @match        https://*.pragmaticplay.com/*
// @run-at       document-start
// @all-frames   true
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// ==/UserScript==

/**
 * COMO ISTO FUNCIONA
 *
 * O formato do jogo não é público, então o coletor não tenta adivinhá-lo: ele
 * escuta por cinco caminhos ao mesmo tempo, pontua cada um pela qualidade do
 * que produz, e trava naquele que estiver acertando.
 *
 *   ws-json    frames de WebSocket em JSON
 *   ws-kv      frames de WebSocket em texto delimitado (estilo Pragmatic)
 *   net        respostas de fetch / XHR
 *   dom-cor    células da grade classificadas pela COR DE FUNDO  ← dispensa protocolo
 *   dom-texto  vocabulário de resultado em nós de texto
 *
 * O caminho dom-cor é o mais robusto: a mesa pinta mandante de dourado,
 * visitante de azul e empate de verde. Isso não muda quando o protocolo muda.
 */
(() => {
  "use strict";

  // Com qualquer @grant o script roda numa sandbox e `window` não é o da
  // página. Hook em janela de sandbox não intercepta nada — precisa da real.
  const W = (typeof unsafeWindow !== "undefined" && unsafeWindow) || window;
  if (W.__pegasusLoaded) return;
  W.__pegasusLoaded = true;

  /** POST resistente a CSP: GM_xmlhttpRequest quando existe, fetch quando não. */
  const httpPost = (url, body) => new Promise(resolve => {
    const payload = JSON.stringify(body);
    if (typeof GM_xmlhttpRequest === "function") {
      GM_xmlhttpRequest({
        method: "POST", url, data: payload,
        headers: { "content-type": "application/json", "x-pegasus-token": CFG.token },
        timeout: 15000,
        onload:    r => resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, text: r.responseText }),
        onerror:   () => resolve({ ok: false, status: 0 }),
        ontimeout: () => resolve({ ok: false, status: 0 }),
      });
      return;
    }
    (W.fetch || fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-pegasus-token": CFG.token },
      body: payload,
    }).then(async r => resolve({ ok: r.ok, status: r.status, text: await r.text().catch(() => "") }))
      .catch(() => resolve({ ok: false, status: 0 }));
  });

  const CFG = {
    endpoint: localStorage.getItem("pegasus.endpoint") || "http://localhost:8787/ingest",
    token:    localStorage.getItem("pegasus.token")    || "troque-este-token",
    lockAfter: 3,           // leituras consistentes para travar numa fonte
    hud:      localStorage.getItem("pegasus.hud") !== "0",
  };

  const SIDES = ["M", "E", "V"];

  /* ══════════════════════════════════════════════════════════════════
     NÚCLEO PURO — sem DOM, testável fora do navegador
     ══════════════════════════════════════════════════════════════════ */

  /** Vocabulário de lado. Devolve null quando não há certeza. */
  function toSide(v) {
    if (v == null) return null;
    const s = String(v).toLowerCase().trim();
    if (!s) return null;
    if (/^(m|home|host|casa|mandante|local|1)$/.test(s)) return "M";
    if (/^(v|away|guest|fora|visitante|visitor|2)$/.test(s)) return "V";
    if (/^(e|d|draw|tie|empate|x|0)$/.test(s)) return "E";
    if (/\b(home|mandante|host)\b/.test(s)) return "M";
    if (/\b(away|visitante|visitor|guest)\b/.test(s)) return "V";
    if (/\b(draw|tie|empate)\b/.test(s)) return "E";
    return null;
  }

  /** Hue → lado. A cor da célula sobrevive a qualquer mudança de protocolo. */
  function hueToSide(r, g, b) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (mx < 40 || d < 28) return null;                    // cinza ou escuro demais
    let h;
    if (mx === r) h = 60 * (((g - b) / d) % 6);
    else if (mx === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
    if (h < 0) h += 360;
    if (h >= 25 && h <= 70) return "M";                    // dourado / âmbar
    if (h >= 185 && h <= 250) return "V";                  // azul
    if (h >= 100 && h <= 175) return "E";                  // verde
    return null;
  }

  const parseRGB = str => {
    const m = String(str).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(",").map(Number);
    if (p.length >= 4 && p[3] < 0.35) return null;         // transparente demais
    return p.slice(0, 3);
  };

  /** Percorre um objeto atrás de registros de resultado, guardando o caminho. */
  function walkJSON(obj, depth = 0, path = "$") {
    const out = [];
    if (!obj || typeof obj !== "object" || depth > 6) return out;
    if (Array.isArray(obj)) {
      obj.forEach(v => out.push(...walkJSON(v, depth + 1, path + "[]")));
      return out;
    }
    let side = null, ref = null, diff = null, sideKey = null;
    for (const [k, v] of Object.entries(obj)) {
      const kl = k.toLowerCase();
      if (side == null && /winner|result|outcome|side|won|victor/.test(kl)) {
        const s = toSide(v);
        if (s) { side = s; sideKey = k; }
      }
      if (ref == null && /roundid|gameid|round_id|game_id|^id$|gameround|tableround/.test(kl)) {
        if (/^[\w-]{4,40}$/.test(String(v))) ref = String(v);
      }
      if (diff == null && /spread|diff|margin|points|delta/.test(kl) && Number.isFinite(Number(v))) {
        diff = Math.abs(Number(v));
      }
    }
    if (side) out.push({ side, ref, diff, path: path + "." + sideKey });
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === "object") out.push(...walkJSON(v, depth + 1, path + "." + k));
    }
    return out;
  }

  /** Protocolos de texto delimitado: a=b|c=d, a=b&c=d. */
  function parseKV(text) {
    if (text.length > 20000) return [];
    const pairs = {};
    for (const seg of text.split(/[|&\n;]/)) {
      const m = seg.match(/^\s*([\w.]{1,40})\s*[=:]\s*(.{0,120})$/);
      if (m) pairs[m[1].toLowerCase()] = m[2].trim();
    }
    if (!Object.keys(pairs).length) return [];
    let side = null, ref = null, diff = null;
    for (const [k, v] of Object.entries(pairs)) {
      if (side == null && /winner|result|outcome|side|won/.test(k)) side = toSide(v);
      if (ref == null && /roundid|gameid|round|table/.test(k) && /^[\w-]{4,40}$/.test(v)) ref = v;
      if (diff == null && /spread|diff|margin|points/.test(k) && Number.isFinite(Number(v))) diff = Math.abs(Number(v));
    }
    return side ? [{ side, ref, diff, path: "kv" }] : [];
  }

  /**
   * Reconcilia a grade da mesa entre dois instantes.
   * A grade é reescrita inteira a cada rodada, então em vez de confiar em
   * "nó adicionado" descobrimos o que entrou comparando as sequências —
   * serve tanto para grade que cresce no fim quanto no começo.
   */
  function reconcile(prev, next) {
    if (!prev.length) return next.length <= 3 ? next : [];   // 1ª leitura: não inventa histórico
    if (next.length < prev.length) return [];                // grade encolheu: ignora
    if (prev.every((v, i) => v === next[i])) return next.slice(prev.length);   // novos no fim
    for (let k = 1; k <= Math.min(6, next.length - prev.length); k++) {
      if (prev.every((v, i) => v === next[i + k])) return next.slice(0, k).reverse();  // novos no começo
    }
    return [];
  }

  const CORE = { toSide, hueToSide, parseRGB, walkJSON, parseKV, reconcile };
  W.__pegasusCore = CORE;
  window.__pegasusCore = CORE;

  /* ══════════════════════════════════════════════════════════════════
     REGISTRO DE FONTES — pontua e trava na que funciona
     ══════════════════════════════════════════════════════════════════ */
  const sources = new Map();
  let locked = null;
  const emitted = new Set();
  const recent = [];
  const stats = { ws: 0, net: 0, dom: 0, frames: 0, sent: 0, fail: 0 };

  function observe(key, rec) {
    if (!rec || !SIDES.includes(rec.side)) return;
    let s = sources.get(key);
    if (!s) { s = { hits: 0, lastRef: null }; sources.set(key, s); }
    if (rec.ref && rec.ref === s.lastRef) return;            // repetição não conta
    s.lastRef = rec.ref ?? null;
    s.hits++;
    if (!locked && s.hits >= CFG.lockAfter) {
      locked = key;
      log(`fonte travada: ${key} (${s.hits} leituras consistentes)`);
    }
    if (locked === key) send(rec);
    hudRender();
  }

  async function send(rec) {
    const ref = rec.ref || `auto-${Date.now()}`;
    if (emitted.has(ref)) return;
    emitted.add(ref);
    recent.unshift({ ...rec, ref, t: Date.now() });
    if (recent.length > 24) recent.pop();
    const r = await httpPost(CFG.endpoint,
      { rounds: [{ ref, side: rec.side, diff: rec.diff ?? null, ts: Date.now() }] });
    r.ok ? stats.sent++ : stats.fail++;
    hudRender();
  }

  const frames = [];
  function keepFrame(transport, url, data) {
    stats.frames++;
    frames.push({ t: Date.now(), transport, url: String(url).slice(0, 140), data: String(data).slice(0, 4000) });
    if (frames.length > 600) frames.shift();
  }

  function handleText(transport, url, text) {
    if (!text || typeof text !== "string") return;
    keepFrame(transport, url, text);
    let recs = [];
    try {
      recs = walkJSON(JSON.parse(text)).map(r => ({ ...r, path: `${transport}-json:${r.path}` }));
    } catch {
      recs = parseKV(text).map(r => ({ ...r, path: `${transport}-kv` }));
    }
    for (const r of recs) observe(r.path, r);
  }

  /* ── CAPTURA 1 — WebSocket ───────────────────────────────────────── */
  const OrigWS = W.WebSocket;
  if (OrigWS) {
    W.WebSocket = function (...args) {
      const ws = new OrigWS(...args);
      stats.ws++;
      ws.addEventListener("message", ev => {
        const d = ev.data;
        if (typeof d === "string") handleText("ws", args[0], d);
        else if (typeof Blob !== "undefined" && d instanceof Blob) d.text().then(t => handleText("ws", args[0], t)).catch(() => {});
        else if (d instanceof ArrayBuffer) {
          try { handleText("ws", args[0], new TextDecoder().decode(d)); } catch {}
        }
      });
      return ws;
    };
    W.WebSocket.prototype = OrigWS.prototype;
    Object.assign(W.WebSocket, OrigWS);
  }

  /* ── CAPTURA 2 — fetch e XHR ─────────────────────────────────────── */
  const origFetch = W.fetch;
  if (origFetch) {
    W.fetch = async function (...args) {
      const res = await origFetch.apply(this, args);
      try {
        const ct = res.headers.get("content-type") || "";
        if (/json|text/.test(ct)) {
          res.clone().text().then(t => { stats.net++; handleText("net", args[0], t); }).catch(() => {});
        }
      } catch {}
      return res;
    };
  }
  const origOpen = W.XMLHttpRequest.prototype.open;
  W.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.addEventListener("load", () => {
      try {
        if (typeof this.responseText === "string" && this.responseText.length < 200000) {
          stats.net++; handleText("net", url, this.responseText);
        }
      } catch {}
    });
    return origOpen.call(this, method, url, ...rest);
  };

  /* ── CAPTURA 3 — DOM por cor (dispensa protocolo) ────────────────── */
  let gridPrev = [], gridEl = null, scanBusy = false;

  /** Acha o container com mais filhos coloridos em M/E/V: é a grade de resultados. */
  function findGrid() {
    let best = null, bestScore = 4;
    for (const el of document.querySelectorAll("div,ul,section,tbody")) {
      const kids = el.children;
      if (kids.length < 6 || kids.length > 400) continue;
      const step = Math.max(1, Math.floor(kids.length / 24));
      let colored = 0, looked = 0;
      for (let i = 0; i < kids.length; i += step) {
        looked++;
        const rgb = parseRGB(getComputedStyle(kids[i]).backgroundColor);
        if (rgb && hueToSide(...rgb)) colored++;
      }
      const ratio = looked ? colored / looked : 0;
      const score = ratio * Math.min(kids.length, 60);
      if (ratio > 0.6 && score > bestScore) { bestScore = score; best = el; }
    }
    return best;
  }

  function readGrid(el) {
    const out = [];
    for (const kid of el.children) {
      const rgb = parseRGB(getComputedStyle(kid).backgroundColor);
      const side = rgb && hueToSide(...rgb);
      if (!side) continue;
      const m = (kid.textContent || "").match(/(\d{1,2})/);
      out.push(side + (m ? ":" + m[1] : ""));
    }
    return out;
  }

  function scanDOM() {
    if (scanBusy) return;
    scanBusy = true;
    requestAnimationFrame(() => {
      try {
        if (!gridEl || !gridEl.isConnected) { gridEl = findGrid(); gridPrev = []; }
        if (!gridEl) return;
        const now = readGrid(gridEl);
        const fresh = reconcile(gridPrev, now);
        gridPrev = now;
        stats.dom++;
        for (const token of fresh) {
          const [side, diff] = token.split(":");
          observe("dom-cor", { side, diff: diff ? Number(diff) : null, ref: null });
        }
      } catch {} finally { scanBusy = false; }
    });
  }

  function startDOM() {
    new MutationObserver(muts => {
      for (const m of muts) if (m.addedNodes.length || m.type === "attributes") { scanDOM(); return; }
    }).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style"],
    });
    setInterval(scanDOM, 4000);      // rede de segurança: o jogo pode pintar sem mutar o DOM
    scanDOM();
  }

  /* ── HUD: você precisa VER que está vivo ─────────────────────────── */
  let hud;
  function hudBuild() {
    if (!CFG.hud || hud) return;
    hud = document.createElement("div");
    hud.style.cssText = `position:fixed;right:8px;bottom:70px;z-index:2147483647;width:188px;
      background:rgba(7,7,10,.94);border:1px solid rgba(233,185,73,.35);border-radius:12px;
      padding:9px 10px;font:11px/1.45 ui-monospace,Menlo,monospace;color:#A8A29B;
      box-shadow:0 10px 30px -10px #000`;
    document.documentElement.append(hud);
    hudRender();
  }
  function hudRender() {
    if (!hud) return;
    const top = [...sources.entries()].sort((a, b) => b[1].hits - a[1].hits).slice(0, 3);
    hud.innerHTML =
      `<div style="color:#E9B949;font-weight:700;letter-spacing:.12em;margin-bottom:5px">PEGASUS</div>` +
      `<div>ws ${stats.ws} · rede ${stats.net} · dom ${stats.dom}</div>` +
      `<div>frames ${stats.frames}</div>` +
      `<div style="margin:5px 0;color:${locked ? "#2FD48A" : "#FF9F43"}">` +
        (locked ? "▶ " + locked.slice(0, 22) : "⏳ procurando fonte") + `</div>` +
      (top.length ? `<div style="color:#6E6A66;font-size:10px">` +
        top.map(([k, v]) => `${k.slice(0, 18)} ·${v.hits}`).join("<br>") + `</div>` : "") +
      `<div style="margin-top:6px;display:flex;gap:3px;flex-wrap:wrap">` +
        recent.slice(0, 12).map(r => {
          const c = { M: "#BF8608", V: "#528DFF", E: "#02AD6D" }[r.side];
          return `<i style="width:15px;height:15px;border-radius:4px;background:${c};display:grid;
            place-items:center;font-style:normal;font-size:8px;color:#07070A;font-weight:700">${r.side}</i>`;
        }).join("") + `</div>` +
      `<div style="margin-top:6px;color:#6E6A66;font-size:10px">enviados ${stats.sent}${stats.fail ? " · falhas " + stats.fail : ""}</div>`;
  }

  const log = (...a) => console.log("%c PEGASUS ", "background:#E9B949;color:#07070A;font-weight:700", ...a);

  /* ── console ─────────────────────────────────────────────────────── */
  const API = {
    status: () => ({ locked, stats, sources: Object.fromEntries([...sources].map(([k, v]) => [k, v.hits])) }),
    dump: () => JSON.stringify({ url: location.href, at: new Date().toISOString(), stats, frames }, null, 1),
    /** Manda os frames ao motor, que aciona seu CLI de IA para escrever o parser. */
    discover: async () => {
      const r = await httpPost(CFG.endpoint.replace(/\/ingest$/, "/discover"),
        { url: location.href, frames });
      try { return JSON.parse(r.text); } catch { return r; }
    },
    lock: key => { locked = key; hudRender(); return "travado em " + key; },
    unlock: () => { locked = null; sources.clear(); hudRender(); return "destravado"; },
    manual: side => observe("manual", { side, ref: "man-" + Date.now() }),
    config: (endpoint, token) => {
      if (endpoint) localStorage.setItem("pegasus.endpoint", endpoint);
      if (token) localStorage.setItem("pegasus.token", token);
      return "salvo — recarregue a página";
    },
  };
  W.pegasus = API;            // console da página
  window.pegasus = API;       // console da sandbox

  const boot = () => { hudBuild(); startDOM(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
  log("coletor vivo · pegasus.status() · pegasus.dump() · pegasus.discover()");
})();
