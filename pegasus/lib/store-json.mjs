import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";

/**
 * Armazenamento em JSON, com a mesma interface do SQLite.
 * Existe para o sistema rodar em Node anterior ao 22.5, onde `node:sqlite`
 * ainda não existe — caso do Termux com pacote mais antigo.
 * Grava por arquivo temporário + rename, para não corromper se o Android
 * matar o processo no meio da escrita.
 */
export class JsonStore {
  constructor(path = "pegasus.json") {
    this.path = path === ":memory:" ? null : path;
    this.d = { rounds: [], signals: [], meta: {}, seqR: 0, seqS: 0 };
    if (this.path && existsSync(this.path)) {
      try { this.d = JSON.parse(readFileSync(this.path, "utf8")); } catch {}
    }
    this._refs = new Set(this.d.rounds.map(r => r.ref).filter(Boolean));
  }
  #flush() {
    if (!this.path) return;
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.d));
    renameSync(tmp, this.path);
  }
  addRound({ ref, side, diff = null, ts = Date.now() }) {
    if (!["M","E","V"].includes(side)) throw new Error("lado inválido: " + side);
    if (ref && this._refs.has(String(ref))) {
      return { inserted: false, id: this.d.rounds.find(r => r.ref === String(ref)).id };
    }
    const id = ++this.d.seqR;
    if (ref) this._refs.add(String(ref));
    this.d.rounds.push({ id, ref: ref ? String(ref) : null, ts, side, diff });
    this.#flush();
    return { inserted: true, id };
  }
  rounds(limit = 5000) { return this.d.rounds.slice(-limit); }
  count() { return this.d.rounds.length; }
  addSignal(s) {
    const id = ++this.d.seqS;
    this.d.signals.push({
      id, ts: s.ts, rule: s.rule, pick: s.pick, trigger_side: s.triggerSide,
      trigger_len: s.triggerLen, after_round: s.afterRound, status: "pending",
      result_side: null, resolved_ts: null, pnl: null, evidence: JSON.stringify(s.evidence ?? {}),
    });
    this.#flush();
    return id;
  }
  pendingSignals() { return this.d.signals.filter(s => s.status === "pending"); }
  resolveSignal(id, { status, resultSide, pnl }) {
    const s = this.d.signals.find(x => x.id === id);
    if (!s) return;
    Object.assign(s, { status, result_side: resultSide, pnl, resolved_ts: Date.now() });
    this.#flush();
  }
  signals(limit = 200) { return this.d.signals.slice(-limit).reverse(); }
  ruleStats(rule) {
    const r = this.d.signals.filter(s => s.rule === rule && s.status !== "pending");
    return {
      n: r.length,
      wins:   r.filter(s => s.status === "win").length,
      losses: r.filter(s => s.status === "loss").length,
      pushes: r.filter(s => s.status === "push").length,
      pnl:    r.reduce((a, s) => a + (s.pnl || 0), 0),
    };
  }
  getMeta(k, d = null) { return this.d.meta[k] ?? d; }
  setMeta(k, v) { this.d.meta[k] = String(v); this.#flush(); }
  close() { this.#flush(); }
}
