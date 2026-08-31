/**
 * Escolhe o armazenamento conforme o Node disponível.
 * SQLite quando existe (Node >= 22.5), JSON quando não — assim o motor sobe
 * em qualquer Termux, sem proot e sem caçar versão de pacote.
 */
export async function openStore(path) {
  try {
    await import("node:sqlite");
    const { Store } = await import("./store.mjs");
    return { store: new Store(path), kind: "sqlite" };
  } catch {
    const { JsonStore } = await import("./store-json.mjs");
    const p = path === ":memory:" ? path : path.replace(/\.db$/, "") + ".json";
    return { store: new JsonStore(p), kind: "json" };
  }
}
