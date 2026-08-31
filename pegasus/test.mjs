import assert from "node:assert/strict";
import { wilson, chi2P, normCdf, runsTest, entropy, markovTest } from "./lib/stats.mjs";
import { Store } from "./lib/store.mjs";
import { Engine, currentStreak } from "./lib/engine.mjs";

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); console.log("  ✓ " + name); pass++; }
  catch (e) { console.log("  ✗ " + name + "\n      " + e.message); fail++; } };
const ta = async (name, fn) => { try { await fn(); console.log("  ✓ " + name); pass++; }
  catch (e) { console.log("  ✗ " + name + "\n      " + e.message); fail++; } };
const near = (a, b, tol = 1e-3) => Math.abs(a - b) < tol;

console.log("\nESTATÍSTICA — contra valores conhecidos");
t("normCdf(1.96) ≈ 0.975",        () => assert.ok(near(normCdf(1.96), 0.975)));
t("chi2P(3.841, 1) ≈ 0.05",       () => assert.ok(near(chi2P(3.841, 1), 0.05)));
t("chi2P(9.488, 4) ≈ 0.05",       () => assert.ok(near(chi2P(9.488, 4), 0.05)));
t("wilson(50,100) ≈ [.404,.596]", () => { const [l,h]=wilson(50,100); assert.ok(near(l,0.4038)&&near(h,0.5962)); });
t("wilson(0,0) não explode",      () => assert.deepEqual(wilson(0,0), [0,0]));
t("entropy([1,1]) = 1 bit",       () => assert.equal(entropy([1,1]), 1));
t("entropy([1,0]) = 0 bit",       () => assert.equal(entropy([1,0]), 0));
t("runsTest detecta alternância", () => {
  const alt = Array.from({length:200},(_,i)=> i%2 ? "M":"V");
  assert.ok(runsTest(alt).p < 1e-6);
});
t("runsTest fica quieto no acaso", () => {
  let sig = 0;
  for (let k=0;k<100;k++){
    const s = Array.from({length:300},()=> Math.random()<0.5?"M":"V");
    if (runsTest(s).p < 0.05) sig++;
  }
  assert.ok(sig <= 12, `falsos positivos ${sig}/100 (esperado ~5)`);
});
t("markovTest detecta memória", () => {
  const s=["M"]; for(let i=1;i<600;i++) s.push(Math.random()<0.85 ? s[i-1] : (s[i-1]==="M"?"V":"M"));
  assert.ok(markovTest(s).p < 1e-6);
});

console.log("\nSEQUÊNCIA — empate não quebra a série");
t("5×M com empate no meio conta 5", () => {
  assert.deepEqual(currentStreak(["M","M","E","M","M","M"]), { side:"M", len:5 });
});
t("série vazia não quebra", () => assert.deepEqual(currentStreak([]), { side:null, len:0 }));
t("só empates não inventa lado",  () => assert.deepEqual(currentStreak(["E","E"]), { side:null, len:0 }));

console.log("\nARMAZENAMENTO — SQLite e JSON têm que se comportar igual");
const { JsonStore } = await import("./lib/store-json.mjs");
for (const [nome, Make] of [["sqlite", () => new Store(":memory:")], ["json", () => new JsonStore(":memory:")]]) {
  t(`[${nome}] rodada duplicada não entra duas vezes`, () => {
    const s = Make();
    assert.equal(s.addRound({ ref:"abc", side:"M" }).inserted, true);
    assert.equal(s.addRound({ ref:"abc", side:"M" }).inserted, false);
    assert.equal(s.count(), 1);
    s.close();
  });
  t(`[${nome}] lado inválido é rejeitado`, () => {
    const s = Make();
    assert.throws(() => s.addRound({ side:"X" }), /lado inválido/);
    s.close();
  });
  t(`[${nome}] sinal pendente resolve e entra na estatística`, () => {
    const s = Make();
    const { id: rid } = s.addRound({ side:"M", ref:"r1" });
    const sid = s.addSignal({ ts:Date.now(), rule:"x", pick:"V", triggerSide:"M", triggerLen:5, afterRound:rid });
    assert.equal(s.pendingSignals().length, 1);
    s.resolveSignal(sid, { status:"win", resultSide:"V", pnl:1 });
    assert.equal(s.pendingSignals().length, 0);
    const st = s.ruleStats("x");
    assert.equal(st.wins, 1); assert.equal(st.pnl, 1);
    s.close();
  });
  t(`[${nome}] signals() devolve do mais novo para o mais antigo`, () => {
    const s = Make();
    const a = s.addSignal({ ts:1, rule:"a", pick:"M", triggerSide:"V", triggerLen:3, afterRound:1 });
    const b = s.addSignal({ ts:2, rule:"b", pick:"V", triggerSide:"M", triggerLen:4, afterRound:2 });
    assert.equal(s.signals()[0].id, b, "o primeiro tem que ser o mais recente");
    s.close();
  });
}

/* Alimenta o motor com uma sequência e devolve o placar. */
async function feed(sides, rules) {
  const store = new Store(":memory:");
  const engine = new Engine(store, { rules, notify: async () => {}, guardMin: 30 });
  const acc = [];
  for (const side of sides) {
    const { id } = store.addRound({ side, ref: "r" + acc.length });
    acc.push(side);
    await engine.onRound({ id, side }, acc);
  }
  const board = engine.scoreboard();
  store.close();
  return { board, engine };
}

console.log("\nMOTOR — o placar reflete a realidade?");
await ta("padrão real de continuação é CONFIRMADO", async () => {
  // sequência grudenta: depois de 3 iguais, quase sempre continua igual
  const s = ["M"];
  for (let i=1;i<3000;i++) s.push(Math.random()<0.88 ? s[i-1] : (s[i-1]==="M"?"V":"M"));
  const { board } = await feed(s, [{ id:"same3", label:"Segue após 3", len:3, bet:"same", enabled:true }]);
  const r = board[0];
  assert.ok(r.decided > 50, "poucas entradas: " + r.decided);
  assert.ok(r.hit > 0.8, "acerto baixo demais: " + r.hit);
  assert.equal(r.verdict, "confirmada");
});
await ta("regra perdedora é CORTADA e desligada sozinha", async () => {
  // mesma sequência grudenta, mas apostando no oposto: perde quase sempre
  const s = ["M"];
  for (let i=1;i<3000;i++) s.push(Math.random()<0.88 ? s[i-1] : (s[i-1]==="M"?"V":"M"));
  const { board, engine } = await feed(s, [{ id:"opp3", label:"Oposto após 3", len:3, bet:"opposite", enabled:true }]);
  const r = board[0];
  assert.ok(r.hit < 0.3, "acerto alto demais: " + r.hit);
  assert.equal(r.verdict, "cortada");
  assert.equal(engine.rules[0].enabled, false, "a regra deveria ter sido desligada");
});
await ta("no acaso puro a regra NÃO é confirmada", async () => {
  const s = Array.from({length:3000},()=> { const r=Math.random(); return r<0.07?"E":(r<0.535?"M":"V"); });
  const { board } = await feed(s, [{ id:"opp5", label:"Oposto após 5", len:5, bet:"opposite", enabled:true }]);
  assert.notEqual(board[0].verdict, "confirmada", "confirmou padrão em dado aleatório!");
});
await ta("P&L bate com ganhos menos perdas", async () => {
  const s = Array.from({length:1200},()=> Math.random()<0.5?"M":"V");
  const { board } = await feed(s, [{ id:"opp4", label:"Oposto após 4", len:4, bet:"opposite", enabled:true }]);
  const r = board[0];
  assert.equal(r.pnl, r.wins - r.losses, `pnl ${r.pnl} ≠ ${r.wins}-${r.losses}`);
  assert.equal(r.decided, r.wins + r.losses);
});
await ta("sinal só é emitido no comprimento exato do gatilho", async () => {
  const { board } = await feed("MMMMMMMMMM".split(""),
    [{ id:"o5", label:"Oposto após 5", len:5, bet:"opposite", enabled:true }]);
  assert.equal(board[0].signals, 1, "emitiu " + board[0].signals + " sinais para uma única passagem por 5×");
});

console.log("\nCOLETOR — núcleo de captura");
// Carrega o userscript num navegador de mentira e testa as funções puras.
{
  const { readFileSync } = await import("node:fs");
  const noop = () => {};
  const win = {
    localStorage: { getItem: () => null, setItem: noop },
    WebSocket: function () { this.addEventListener = noop; },
    fetch: async () => ({ ok: true, headers: { get: () => "" }, clone: () => ({ text: async () => "" }) }),
    XMLHttpRequest: function () {},
    MutationObserver: function () { this.observe = noop; },
    setInterval: noop, requestAnimationFrame: noop,
    getComputedStyle: () => ({ backgroundColor: "rgba(0,0,0,0)" }),
    console: { log: noop },
  };
  win.window = win;
  win.XMLHttpRequest.prototype = { open: noop };
  const doc = {
    readyState: "complete", addEventListener: noop,
    documentElement: { append: noop }, querySelectorAll: () => [],
    createElement: () => ({ style: {}, append: noop }),
  };
  const src = readFileSync(new URL("./collector.user.js", import.meta.url), "utf8");
  new Function("window", "document", "localStorage", "WebSocket", "fetch",
               "XMLHttpRequest", "MutationObserver", "setInterval",
               "requestAnimationFrame", "getComputedStyle", "console", "Blob", src)
    (win, doc, win.localStorage, win.WebSocket, win.fetch, win.XMLHttpRequest,
     win.MutationObserver, win.setInterval, win.requestAnimationFrame,
     win.getComputedStyle, win.console, undefined);

  const C = win.__pegasusCore;
  t("o coletor expõe o núcleo", () => assert.ok(C && C.toSide));

  t("vocabulário de lado em pt e en", () => {
    for (const v of ["home","HOST","mandante","casa","1","M"]) assert.equal(C.toSide(v), "M", v);
    for (const v of ["away","visitante","guest","2","V"]) assert.equal(C.toSide(v), "V", v);
    for (const v of ["draw","empate","tie","X","E"]) assert.equal(C.toSide(v), "E", v);
  });
  t("vocabulário não chuta no desconhecido", () => {
    for (const v of ["banana", "", null, undefined, "jackpot"]) assert.equal(C.toSide(v), null, String(v));
  });

  t("cor da célula vira lado (dourado/azul/verde)", () => {
    assert.equal(C.hueToSide(0xBF,0x86,0x08), "M");   // dourado da mesa
    assert.equal(C.hueToSide(0x52,0x8D,0xFF), "V");   // azul
    assert.equal(C.hueToSide(0x02,0xAD,0x6D), "E");   // verde
    assert.equal(C.hueToSide(0xE0,0xA6,0x2A), "M");   // dourado mais claro
  });
  t("cinza e escuro não viram lado", () => {
    assert.equal(C.hueToSide(0x12,0x18,0x22), null);
    assert.equal(C.hueToSide(0x88,0x88,0x88), null);
    assert.equal(C.hueToSide(0x07,0x07,0x0A), null);
  });
  t("cor transparente é descartada", () => {
    assert.equal(C.parseRGB("rgba(191,134,8,0.1)"), null);
    assert.deepEqual(C.parseRGB("rgb(191,134,8)"), [191,134,8]);
  });

  t("acha o resultado dentro de JSON aninhado", () => {
    const payload = { type:"gameState", data:{ table:"blitz",
      round:{ roundId:"17053695201", result:{ winner:"home", spread:5 } } } };
    const hits = C.walkJSON(payload);
    const h = hits.find(x => x.side);
    assert.equal(h.side, "M");
    assert.ok(h.path.includes("winner"), h.path);
  });
  t("acha resultado em texto delimitado", () => {
    const r = C.parseKV("cmd=roundEnd|roundId=170536|winner=away|spread=8");
    assert.equal(r[0].side, "V"); assert.equal(r[0].ref, "170536"); assert.equal(r[0].diff, 8);
  });
  t("não inventa resultado onde não há", () => {
    assert.equal(C.walkJSON({ balance: 12.5, currency: "BRL" }).length, 0);
    assert.equal(C.parseKV("cmd=ping|ts=123").length, 0);
  });

  t("grade que cresce no fim: pega só o novo", () => {
    assert.deepEqual(C.reconcile(["M","V","E"], ["M","V","E","M"]), ["M"]);
  });
  t("grade que cresce no começo: pega só o novo", () => {
    assert.deepEqual(C.reconcile(["M","V","E"], ["V","M","V","E"]), ["V"]);
  });
  t("grade parada não emite nada", () => {
    assert.deepEqual(C.reconcile(["M","V","E"], ["M","V","E"]), []);
  });
  t("grade que encolhe é ignorada", () => {
    assert.deepEqual(C.reconcile(["M","V","E"], ["M","V"]), []);
  });
  t("primeira leitura não inventa histórico", () => {
    assert.deepEqual(C.reconcile([], Array(40).fill("M")), []);
  });
}

console.log("\nIA — ponte com o CLI");
{
  const { extractJSON, sampleFrames, runAgent } = await import("./lib/agents.mjs");
  t("extrai JSON cercado de prosa", () => {
    assert.deepEqual(extractJSON('Claro! Aqui vai:\n```json\n{"found":true}\n```\nEspero ajudar.'), { found: true });
  });
  t("extrai JSON sem cerca", () => {
    assert.deepEqual(extractJSON('bla bla {"found":false,"x":1} fim'), { found: false, x: 1 });
  });
  t("devolve null quando não há JSON", () => assert.equal(extractJSON("desculpe, não sei"), null));
  t("amostragem agrupa frames do mesmo formato", () => {
    const frames = [];
    for (let i = 0; i < 100; i++) frames.push({ transport:"ws", data: JSON.stringify({ cmd:"tick", n:i }) });
    for (let i = 0; i < 100; i++) frames.push({ transport:"ws", data: JSON.stringify({ winner:"home", id:i }) });
    const s = sampleFrames(frames);
    assert.ok(s.length <= 8, "amostra grande demais: " + s.length);
    assert.ok(s.some(f => f.data.includes("winner")), "perdeu o formato que importa");
  });
  await ta("executa um CLI de verdade e lê a resposta", async () => {
    const { stdout } = await runAgent({
      cmd: "node",
      args: ["-e", 'let i="";process.stdin.on("data",d=>i+=d).on("end",()=>process.stdout.write(JSON.stringify({found:true,bytes:i.length})))'],
      input: "frames de teste",
    });
    const r = extractJSON(stdout);
    assert.equal(r.found, true); assert.ok(r.bytes > 0);
  });
  await ta("CLI inexistente falha com mensagem clara", async () => {
    await assert.rejects(
      runAgent({ cmd: "cli-que-nao-existe-xyz", input: "x" }),
      /não consegui executar/);
  });
}

console.log("\nSERVIDOR — ingestão ponta a ponta");
process.env.PEGASUS_TOKEN = "tok-de-teste";
process.env.PEGASUS_DB = ":memory:";
const { server, store: srvStore } = await import("./server.mjs");
await new Promise(r => setTimeout(r, 300));
const PORT = server.address().port;
const post = (body, token = "tok-de-teste") => fetch(`http://127.0.0.1:${PORT}/ingest`, {
  method: "POST", headers: { "content-type": "application/json", "x-pegasus-token": token },
  body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));

await ta("token errado é recusado", async () => {
  const r = await post({ rounds: [{ ref:"x1", side:"M" }] }, "errado");
  assert.equal(r.status, 401);
});
await ta("rodada válida é aceita", async () => {
  const r = await post({ rounds: [{ ref:"a1", side:"M", diff:5 }] });
  assert.equal(r.status, 200); assert.equal(r.body.accepted[0].duplicate, false);
});
await ta("reenvio da mesma rodada não duplica", async () => {
  const r = await post({ rounds: [{ ref:"a1", side:"M", diff:5 }] });
  assert.equal(r.body.accepted[0].duplicate, true);
  assert.equal(r.body.total, 1);
});
await ta("lado inválido é ignorado sem derrubar o servidor", async () => {
  const r = await post({ rounds: [{ ref:"bad", side:"Z" }] });
  assert.equal(r.status, 200); assert.equal(r.body.accepted.length, 0);
});
await ta("/api/state responde com o placar", async () => {
  const s = await fetch(`http://127.0.0.1:${PORT}/api/state`).then(r => r.json());
  assert.ok(s.ok); assert.ok(Array.isArray(s.scoreboard)); assert.equal(s.total, 1);
});
await ta("gatilho ao vivo dispara sinal via HTTP", async () => {
  for (let i = 0; i < 6; i++) await post({ rounds: [{ ref: "s" + i, side: "V" }] });
  const s = await fetch(`http://127.0.0.1:${PORT}/api/state`).then(r => r.json());
  assert.ok(s.signals.length > 0, "nenhum sinal emitido após 5× VISITANTE");
  const opp5 = s.signals.find(g => g.rule === "opp5");     // signals() vem do mais novo ao mais antigo
  assert.ok(opp5, "a regra opp5 não disparou");
  assert.equal(opp5.pick, "M", "após 5× VISITANTE o oposto é MANDANTE");
  assert.equal(opp5.trigger_len, 5);
});
server.close(); srvStore.close();

console.log(`\n${fail ? "✗" : "✓"}  ${pass} passaram, ${fail} falharam\n`);
process.exit(fail ? 1 : 0);
