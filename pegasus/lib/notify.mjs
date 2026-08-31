/** Telegram. Sem token configurado, cai para o console — o motor nunca para por causa disso. */
export function makeNotifier({ token, chatId, log = console.log } = {}) {
  const active = Boolean(token && chatId);
  if (!active) log("[notify] Telegram não configurado — sinais só no console e no painel.");
  return async function notify(text) {
    log("[sinal] " + text.replace(/\s+/g, " ").slice(0, 160));
    if (!active) return { sent: false, reason: "not-configured" };
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }),
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return { sent: false, reason: "http-" + res.status };
      return { sent: true };
    } catch (e) {
      log("[notify] falhou: " + e.message);        // rede caiu: segue o jogo
      return { sent: false, reason: e.message };
    }
  };
}
