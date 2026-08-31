import { spawn } from "node:child_process";

/**
 * Ponte para CLIs de IA (claude, aider, ollama, llm, qualquer um que leia
 * stdin e escreva stdout). Configure com:
 *
 *   PEGASUS_AI_CMD="claude"   PEGASUS_AI_ARGS="-p"
 *   PEGASUS_AI_CMD="ollama"   PEGASUS_AI_ARGS="run,qwen2.5-coder"
 *   PEGASUS_AI_CMD="llm"      PEGASUS_AI_ARGS="-m,gpt-4o"
 */
export function runAgent({ cmd, args = [], input, timeoutMs = 120000 }) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "", done = false;
    const finish = fn => (...a) => { if (!done) { done = true; clearTimeout(timer); fn(...a); } };
    const ok = finish(resolve), no = finish(reject);
    const timer = setTimeout(() => { p.kill("SIGKILL"); no(new Error(`agente estourou ${timeoutMs}ms`)); }, timeoutMs);

    p.stdout.on("data", d => { out += d; });
    p.stderr.on("data", d => { err += d; });
    p.on("error", e => no(new Error(`não consegui executar "${cmd}": ${e.message}`)));
    p.on("close", code => code === 0 || out.trim()
      ? ok({ stdout: out, stderr: err, code })
      : no(new Error(`agente saiu com ${code}: ${err.slice(0, 400)}`)));

    p.stdin.on("error", () => {});    // agente que fecha stdin cedo não derruba o motor
    p.stdin.end(input);
  });
}

/** Extrai JSON de uma resposta que pode vir cercada de prosa ou de ```json. */
export function extractJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fence?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    try { return JSON.parse(c.trim()); } catch {}
    const i = c.indexOf("{"), j = c.lastIndexOf("}");
    if (i >= 0 && j > i) { try { return JSON.parse(c.slice(i, j + 1)); } catch {} }
  }
  return null;
}

/** Reduz centenas de frames a uma amostra representativa por formato. */
export function sampleFrames(frames, perShape = 3, max = 40) {
  const byShape = new Map();
  for (const f of frames) {
    const d = String(f.data || "");
    // assinatura grosseira do formato: primeiras chaves ou primeiros tokens
    const shape = d.trim().startsWith("{")
      ? "json:" + Object.keys((() => { try { return JSON.parse(d); } catch { return {}; } })()).slice(0, 6).join(",")
      : "txt:" + d.slice(0, 24).replace(/\d+/g, "#");
    if (!byShape.has(shape)) byShape.set(shape, []);
    const arr = byShape.get(shape);
    if (arr.length < perShape) arr.push({ transport: f.transport, data: d.slice(0, 1200) });
  }
  return [...byShape.values()].flat().slice(0, max);
}

const PROMPT = `Você recebe frames de rede capturados de um jogo de cartas de cassino ao vivo
(Football Blitz Top Card, Pragmatic Play). Cada rodada tem exatamente um vencedor:
MANDANTE (home), VISITANTE (away) ou EMPATE (draw), e uma diferença de pontos.

Sua tarefa: identificar em QUAL frame e em QUAL campo aparece o resultado de cada
rodada, e escrever uma função JavaScript que extraia isso.

Responda SOMENTE com JSON neste formato:
{
  "found": true|false,
  "confidence": 0.0-1.0,
  "reasoning": "uma frase sobre onde está o resultado",
  "transport": "ws|net",
  "sidePath": "caminho do campo do vencedor, ex: data.result.winner",
  "sideMap": { "valor_bruto": "M|E|V" },
  "refPath": "caminho do id da rodada, ou null",
  "diffPath": "caminho da diferença de pontos, ou null",
  "code": "function parse(raw){ /* devolve {ref,side,diff} ou null */ }"
}

Se os frames não contiverem resultados de rodada, responda {"found":false,"reasoning":"..."}.
Não invente campos que não estejam nos frames.

FRAMES:
`;

/** Pede ao CLI de IA que escreva o parser a partir dos frames capturados. */
export async function discoverParser(frames, {
  cmd = process.env.PEGASUS_AI_CMD,
  args = (process.env.PEGASUS_AI_ARGS || "").split(",").filter(Boolean),
  timeoutMs = 180000,
} = {}) {
  if (!cmd) return { ok: false, error: "PEGASUS_AI_CMD não configurado", sample: sampleFrames(frames) };
  const sample = sampleFrames(frames);
  if (!sample.length) return { ok: false, error: "nenhum frame capturado" };
  const { stdout } = await runAgent({ cmd, args, input: PROMPT + JSON.stringify(sample, null, 1), timeoutMs });
  const parsed = extractJSON(stdout);
  if (!parsed) return { ok: false, error: "o agente não devolveu JSON", raw: stdout.slice(0, 1500) };
  return { ok: true, result: parsed, frames: sample.length };
}
