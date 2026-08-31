import { wilson, runsTest, markovTest, streaks, entropy } from "./stats.mjs";

export const NAME = { M: "MANDANTE", E: "EMPATE", V: "VISITANTE" };
const OPP = { M: "V", V: "M" };

/** Regras padrão. Cada uma é uma hipótese a ser provada ou cortada pelo placar. */
export const DEFAULT_RULES = [
  { id:"opp5",  label:"Oposto após 5", len:5, bet:"opposite", enabled:true },
  { id:"opp6",  label:"Oposto após 6", len:6, bet:"opposite", enabled:true },
  { id:"opp7",  label:"Oposto após 7", len:7, bet:"opposite", enabled:true },
  { id:"same3", label:"Segue após 3",     len:3, bet:"same",     enabled:true },
];

/**
 * Sequência atual ignorando empates: o empate não quebra nem alonga a série,
 * que é como a mesa é lida na prática.
 */
export function currentStreak(sides) {
  const bin = sides.filter(s => s !== "E");
  if (!bin.length) return { side: null, len: 0 };
  const last = streaks(bin).at(-1);
  return { side: last.s, len: last.n };
}

export class Engine {
  /**
   * @param opts.guardMin  sinais mínimos antes do corte automático (padrão 40)
   * @param opts.autoMute  cortar sozinho a regra cujo teto do IC95 fica abaixo de 50%
   */
  constructor(store, { rules = DEFAULT_RULES, notify = async () => {}, guardMin = 40,
                       autoMute = true, drawMode = "lose", log = console.log } = {}) {
    this.store = store; this.notify = notify; this.guardMin = guardMin;
    this.autoMute = autoMute; this.drawMode = drawMode; this.log = log;
    this.rules = rules.map(r => ({ ...r }));
    this.listeners = new Set();
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { for (const fn of this.listeners) { try { fn(ev); } catch {} } }

  /** Resolve os sinais em aberto contra a rodada que acabou de sair. */
  resolvePending(round) {
    const done = [];
    for (const sig of this.store.pendingSignals()) {
      if (sig.after_round >= round.id) continue;          // sinal é para a rodada seguinte
      let status, pnl;
      if (round.side === sig.pick) { status = "win"; pnl = 1; }
      else if (round.side === "E") {
        if (this.drawMode === "push") { status = "push"; pnl = 0; }
        else if (this.drawMode === "skip") { status = "void"; pnl = 0; }
        else { status = "loss"; pnl = -1; }
      } else { status = "loss"; pnl = -1; }
      this.store.resolveSignal(sig.id, { status, resultSide: round.side, pnl });
      done.push({ ...sig, status, pnl, result_side: round.side });
    }
    return done;
  }

  /** Estatística viva da janela — é o que acompanha cada sinal como evidência. */
  context(sides) {
    const bin = sides.filter(s => s !== "E");
    const c = { M:0, E:0, V:0 }; for (const s of sides) c[s]++;
    const rt = runsTest(bin);
    const mk = markovTest(sides);
    return {
      n: sides.length,
      dist: c,
      streak: currentStreak(sides),
      runsP: rt ? +rt.p.toFixed(4) : null,
      markovP: mk.p !== null ? +mk.p.toFixed(4) : null,
      entropy: +entropy([c.M, c.E, c.V]).toFixed(4),
    };
  }

  scoreboard() {
    return this.rules.map(rule => {
      const s = this.store.ruleStats(rule.id);
      const decided = (s.wins || 0) + (s.losses || 0);
      const hit = decided ? s.wins / decided : null;
      const [lo, hi] = wilson(s.wins || 0, decided);
      let verdict = "coletando";
      if (decided >= this.guardMin) {
        if (hi < 0.5) verdict = "cortada";            // teto abaixo do equilíbrio
        else if (lo > 0.5) verdict = "confirmada";    // piso acima do equilíbrio
        else verdict = "em prova";
      }
      return {
        id: rule.id, label: rule.label, enabled: rule.enabled,
        signals: s.n || 0, decided, wins: s.wins || 0, losses: s.losses || 0,
        hit, ci: [lo, hi], pnl: s.pnl || 0, verdict,
        needed: Math.max(0, this.guardMin - decided),
      };
    });
  }

  /** Corta sozinha a regra cujo teto do IC95 já não alcança o ponto de equilíbrio. */
  applyGuard() {
    if (!this.autoMute) return [];
    const muted = [];
    for (const row of this.scoreboard()) {
      if (row.verdict === "cortada") {
        const rule = this.rules.find(r => r.id === row.id);
        if (rule?.enabled) { rule.enabled = false; muted.push(row); }
      }
    }
    return muted;
  }

  async onRound(round, sides) {
    const resolved = this.resolvePending(round);
    for (const r of resolved) this.emit({ type: "resolved", signal: r });

    const muted = this.applyGuard();
    for (const m of muted) {
      await this.notify(
        `⛔️ <b>REGRA CORTADA — ${m.label}</b>\n` +
        `Acerto ${(m.hit*100).toFixed(1)}% em ${m.decided} entradas.\n` +
        `Teto do IC95 é ${(m.ci[1]*100).toFixed(1)}%, abaixo dos 50% necessários.\n` +
        `Esta regra perde dinheiro de forma estatisticamente confiável. Desligada.`);
      this.emit({ type: "muted", rule: m });
    }

    const ctx = this.context(sides);
    const emitted = [];
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      if (ctx.streak.len !== rule.len || !ctx.streak.side) continue;   // dispara na virada exata
      const pick = rule.bet === "opposite" ? OPP[ctx.streak.side] : ctx.streak.side;
      const id = this.store.addSignal({
        ts: Date.now(), rule: rule.id, pick,
        triggerSide: ctx.streak.side, triggerLen: ctx.streak.len,
        afterRound: round.id, evidence: ctx,
      });
      const board = this.scoreboard().find(r => r.id === rule.id);
      const hist = board.decided
        ? `Histórico desta regra: ${(board.hit*100).toFixed(1)}% em ${board.decided} entradas (IC95 ${(board.ci[0]*100).toFixed(0)}–${(board.ci[1]*100).toFixed(0)}%).`
        : `Sem histórico ainda — este é o sinal nº 1 desta regra.`;
      await this.notify(
        `🐎 <b>PEGASUS · ${rule.label}</b>\n\n` +
        `Gatilho: ${ctx.streak.len}× ${NAME[ctx.streak.side]}\n` +
        `Entrada: <b>${NAME[pick]}</b>\n\n` +
        `${hist}\n` +
        `${board.verdict === "confirmada" ? "✅ Regra confirmada acima do equilíbrio." :
           board.verdict === "em prova" ? "⚖️ Ainda dentro da faixa da sorte." :
           `📊 Faltam ${board.needed} entradas para o veredito.`}`);
      emitted.push({ id, rule: rule.id, pick, ctx });
      this.emit({ type: "signal", signal: { id, rule: rule.id, pick, ctx } });
    }
    return { resolved, emitted, ctx, muted };
  }
}
