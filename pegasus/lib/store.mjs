import { DatabaseSync } from "node:sqlite";

export class Store {
  constructor(path = "pegasus.db") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ref TEXT UNIQUE, ts INTEGER NOT NULL,
        side TEXT NOT NULL CHECK(side IN ('M','E','V')), diff INTEGER
      );
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL, rule TEXT NOT NULL, pick TEXT NOT NULL,
        trigger_side TEXT, trigger_len INTEGER, after_round INTEGER,
        status TEXT NOT NULL DEFAULT 'pending',
        result_side TEXT, resolved_ts INTEGER, pnl REAL, evidence TEXT
      );
      CREATE INDEX IF NOT EXISTS ix_sig_status ON signals(status);
      CREATE INDEX IF NOT EXISTS ix_sig_rule ON signals(rule);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    `);
  }
  /** Idempotente: a mesma rodada reenviada pelo coletor não duplica. */
  addRound({ ref, side, diff = null, ts = Date.now() }) {
    if (!["M","E","V"].includes(side)) throw new Error("lado inválido: " + side);
    if (ref) {
      const seen = this.db.prepare("SELECT id FROM rounds WHERE ref=?").get(String(ref));
      if (seen) return { inserted: false, id: seen.id };
    }
    const r = this.db.prepare("INSERT INTO rounds (ref,ts,side,diff) VALUES (?,?,?,?)")
      .run(ref ? String(ref) : null, ts, side, diff);
    return { inserted: true, id: Number(r.lastInsertRowid) };
  }
  rounds(limit = 5000) {
    return this.db.prepare("SELECT * FROM rounds ORDER BY id DESC LIMIT ?").all(limit).reverse();
  }
  count() { return this.db.prepare("SELECT COUNT(*) c FROM rounds").get().c; }
  addSignal(s) {
    const r = this.db.prepare(`INSERT INTO signals
      (ts,rule,pick,trigger_side,trigger_len,after_round,evidence)
      VALUES (?,?,?,?,?,?,?)`)
      .run(s.ts, s.rule, s.pick, s.triggerSide, s.triggerLen, s.afterRound, JSON.stringify(s.evidence ?? {}));
    return Number(r.lastInsertRowid);
  }
  pendingSignals() { return this.db.prepare("SELECT * FROM signals WHERE status='pending'").all(); }
  resolveSignal(id, { status, resultSide, pnl }) {
    this.db.prepare("UPDATE signals SET status=?,result_side=?,pnl=?,resolved_ts=? WHERE id=?")
      .run(status, resultSide, pnl, Date.now(), id);
  }
  signals(limit = 200) {
    return this.db.prepare("SELECT * FROM signals ORDER BY id DESC LIMIT ?").all(limit);
  }
  ruleStats(rule) {
    return this.db.prepare(`SELECT
        COUNT(*) n,
        SUM(status='win')  wins,
        SUM(status='loss') losses,
        SUM(status='push') pushes,
        COALESCE(SUM(pnl),0) pnl
      FROM signals WHERE rule=? AND status<>'pending'`).get(rule);
  }
  getMeta(k, d = null) { return this.db.prepare("SELECT v FROM meta WHERE k=?").get(k)?.v ?? d; }
  setMeta(k, v) { this.db.prepare("INSERT INTO meta (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, String(v)); }
  close() { this.db.close(); }
}
