# Pegasus no celular

Roda inteiro no Android. Não precisa de PC e, na maioria dos casos, **não precisa
de proot** — o Termux nativo dá conta. O proot (Alpine/Ubuntu) funciona também,
só é mais lento e mais passo para o mesmo resultado.

---

## 1. O motor, no Termux nativo

```bash
pkg update && pkg upgrade -y
pkg install -y nodejs tar
node -v
```

Descompacte e suba:

```bash
tar -xzf pegasus-money.tar.gz
cd pegasus
npm test          # tem que dar 52 verdes
npm start
```

**Sobre a versão do Node:** o `node:sqlite` só existe do Node 22.5 para cima. Se
o seu for mais antigo, o motor **não quebra** — ele cai sozinho para um
armazenamento em JSON com o mesmo comportamento (a paridade entre os dois é
testada). A linha de abertura diz qual está em uso:

```
rodadas    0   (armazenamento: sqlite)
```

Então pode ignorar a versão. Só instale e rode.

### Se preferir proot

```bash
pkg install -y proot-distro
proot-distro install alpine
proot-distro login alpine
# dentro do Alpine:
apk add nodejs npm
```

Funciona igual. A única diferença prática é que o `localhost` continua sendo o
mesmo do aparelho, então nada muda na configuração do coletor.

---

## 2. Deixar rodando 24/7

```bash
termux-wake-lock            # impede o Android de matar o processo
nohup npm start > pegasus.log 2>&1 &
tail -f pegasus.log         # acompanhar
```

Para parar: `pkill -f server.mjs` e `termux-wake-unlock`.

Vale também desligar a otimização de bateria do Termux nas configurações do
Android, senão o sistema derruba o processo quando a tela apaga.

---

## 3. O navegador — atenção aqui

O coletor é um userscript, então precisa de um navegador que aceite extensão.

| Navegador | Serve? |
|---|---|
| **Firefox para Android** | **Sim** — instale o Violentmonkey ou Tampermonkey pela loja de add-ons |
| Edge / Lemur / Kiwi (Chromium com extensões) | Sim |
| **Brave** | **Não** — o Brave no Android não suporta extensões |

Pelos seus prints você está no Brave. Vai precisar abrir o jogo no Firefox para o
coletor funcionar.

Instalado o gerenciador, adicione o `collector.user.js`, abra o jogo e no console:

```js
pegasus.config("http://localhost:8787/ingest", "seu-token")
```

**`localhost` funciona de verdade aqui.** Navegador e motor estão no mesmo
aparelho, e os navegadores tratam `localhost` como origem confiável — então a
página em HTTPS consegue falar com o seu motor em HTTP sem bloqueio de conteúdo
misto. Não precisa de IP, nem de túnel, nem de certificado.

O coletor usa `GM_xmlhttpRequest` quando disponível, que passa por fora do CSP da
página do jogo. Sem isso o site poderia bloquear o envio.

---

## 4. O painel

Abra `http://localhost:8787/` em qualquer aba. Atualiza sozinho por SSE.

---

## 5. Telegram

Fale com o @BotFather, crie um bot, pegue o token. Para descobrir seu chat id,
mande qualquer mensagem ao bot e abra:

```
https://api.telegram.org/bot<SEU_TOKEN>/getUpdates
```

Depois:

```bash
export TELEGRAM_TOKEN="123456:AA..."
export TELEGRAM_CHAT_ID="987654321"
npm start
```

Sem isso o motor roda igual, só manda os sinais para o painel e o console.

---

## 6. CLI de IA no Termux

Qualquer um que leia stdin e escreva stdout serve:

```bash
npm install -g @openai/codex          # Codex CLI
export PEGASUS_AI_CMD="codex" PEGASUS_AI_ARGS="exec"

# ou o CLI da Anthropic
npm install -g @anthropic-ai/claude-code
export PEGASUS_AI_CMD="claude" PEGASUS_AI_ARGS="-p"

# ou modelo local, se o aparelho aguentar
pkg install ollama && ollama serve &
export PEGASUS_AI_CMD="ollama" PEGASUS_AI_ARGS="run,qwen2.5-coder:1.5b"
```

Modelo local em celular é pesado: prefira um de 1–3B, ou use um CLI de nuvem.

Para editar código no aparelho, o **Acode** abre a pasta do Termux normalmente
(conceda acesso ao armazenamento com `termux-setup-storage`).

---

## Resumo

```bash
pkg install -y nodejs tar
tar -xzf pegasus-money.tar.gz && cd pegasus
npm test && termux-wake-lock && nohup npm start > pegasus.log 2>&1 &
```

Depois: Firefox + Violentmonkey + `collector.user.js`, e
`pegasus.config("http://localhost:8787/ingest", "seu-token")` no console.
