# Pegasus Money

Motor de sinais para mesas ao vivo, com uma regra de ouro: **todo sinal emitido é
pontuado automaticamente na rodada seguinte.** O sistema mantém um placar da
própria assertividade, com intervalo de confiança, e desliga sozinho a regra que
prova ser perdedora.

Não automatiza apostas, não clica na mesa e não cria sessão no site do operador.

---

## Como funciona

```
 navegador (sua sessão)          seu servidor                 seu celular
 ┌──────────────────┐      ┌────────────────────────┐      ┌────────────┐
 │ coletor          │─────>│ /ingest                │      │            │
 │ (userscript)     │ HTTP │   ├─ resolve pendentes │─────>│  Telegram  │
 │ lê o que já      │      │   ├─ atualiza placar   │      │            │
 │ está na tela     │      │   ├─ corta perdedoras  │      └────────────┘
 └──────────────────┘      │   └─ emite sinal       │
                           │ /events  (SSE)         │─────> painel ao vivo
                           │ pegasus.db (SQLite)    │
                           └────────────────────────┘
```

O motor roda 24/7. O coletor alimenta quando você está com a aba do jogo aberta.

---

## Instalação

Sem nenhuma dependência de npm. Node 22.5+ usa `node:sqlite`; abaixo disso o
motor cai para armazenamento em JSON automaticamente.

```bash
node --version          # tem que ser >= 22.5
npm test                # 26 testes, todos devem passar
npm start
```

Abra `http://localhost:8787/` para o painel ao vivo.

### No celular

Roda inteiro no Termux, sem PC e sem proot. Passo a passo em **[TERMUX.md](TERMUX.md)**.

```bash
pkg install -y nodejs tar
tar -xzf pegasus-money.tar.gz && cd pegasus
npm test && termux-wake-lock && nohup npm start > pegasus.log 2>&1 &
```

Em Node anterior ao 22.5 o motor cai sozinho para armazenamento em JSON, com o
mesmo comportamento — então a versão do pacote não trava nada.

### Variáveis

| Variável | Padrão | Para quê |
|---|---|---|
| `PORT` | `8787` | porta do servidor |
| `PEGASUS_TOKEN` | `troque-este-token` | **troque**: autoriza a ingestão |
| `PEGASUS_DB` | `./pegasus.db` | arquivo do banco |
| `PEGASUS_DRAW` | `lose` | empate na entrada: `lose`, `push` ou `skip` |
| `PEGASUS_GUARD` | `40` | entradas antes do corte automático |
| `TELEGRAM_TOKEN` | — | token do bot (via @BotFather) |
| `TELEGRAM_CHAT_ID` | — | seu chat id |

Sem Telegram configurado o motor continua rodando e os sinais aparecem no painel
e no console.

---

## O coletor ao vivo

Instale `collector.user.js` no Tampermonkey (ou Violentmonkey). No console da
página do jogo, aponte para o seu motor:

```js
pegasus.config("http://SEU-IP:8787/ingest", "seu-token")
```

Recarregue. Um HUD aparece no canto da tela mostrando o que ele está vendo.

### Como ele descobre o resultado sem conhecer o protocolo

O formato do jogo nao e publico, entao o coletor nao adivinha: escuta por cinco
caminhos ao mesmo tempo, pontua cada um pela consistencia do que produz, e trava
sozinho no que estiver acertando.

| Caminho | O que le |
|---|---|
| `ws-json` | frames de WebSocket em JSON, varridos em profundidade |
| `ws-kv` | frames em texto delimitado (`winner=away`, `spread=8`) |
| `net` | respostas de `fetch` e `XHR` |
| **`dom-cor`** | **celulas da grade classificadas pela cor de fundo** |
| `manual` | `pegasus.manual("M")` no console |

`dom-cor` e o mais robusto e quase sempre o vencedor: a mesa pinta mandante de
dourado, visitante de azul e empate de verde. Cor nao muda quando o protocolo
muda. O coletor acha a grade sozinho (o container com mais filhos coloridos em
M/E/V), le a sequencia inteira e, a cada mutacao, compara com a leitura anterior
para descobrir o que entrou -- funciona tanto se a grade cresce no fim quanto no
comeco.

O HUD mostra `dom-cor` em verde quando travou. Comandos:

```js
pegasus.status()      // fontes candidatas e contagens
pegasus.unlock()      // esquece a fonte e procura de novo
pegasus.lock("ws-json:$.result.winner")   // forca uma fonte
pegasus.manual("M")   // registra uma rodada na mao
```

---

## A IA escrevendo o parser

LLM nao preve resultado de RNG -- nao e para isso que ela entra aqui. Ela entra
onde e imbativel: **ler os frames capturados e escrever o parser.**

```bash
export PEGASUS_AI_CMD="claude"      PEGASUS_AI_ARGS="-p"
# ou:  PEGASUS_AI_CMD="ollama"      PEGASUS_AI_ARGS="run,qwen2.5-coder"
# ou:  PEGASUS_AI_CMD="llm"         PEGASUS_AI_ARGS="-m,gpt-4o"
```

No console da pagina, depois de umas 10 rodadas:

```js
await pegasus.discover()
```

Os frames vao para o motor, que os agrupa por formato (centenas viram uma
amostra de ~8 representativos), manda para o seu CLI e recebe de volta o campo
exato do resultado mais uma funcao de parsing, gravada em `parser.gerado.js`.

**O motor nunca executa codigo gerado por IA.** Ele escreve o arquivo para voce
ler, conferir e colar no coletor. Codigo de LLM entrando direto em execucao num
sistema que mexe com dinheiro e como se paga caro para aprender.

---

## As regras

Ficam em `lib/engine.mjs`, em `DEFAULT_RULES`:

```js
{ id:"opp5", label:"Oposto após 5", len:5, bet:"opposite", enabled:true }
```

- `len` — tamanho da sequência que dispara
- `bet` — `"opposite"` (contra a sequência) ou `"same"` (a favor)

O empate não quebra nem alonga a sequência, que é como a mesa é lida na prática.

## O placar

| Veredito | Significado |
|---|---|
| `coletando` | menos de `PEGASUS_GUARD` entradas resolvidas |
| `em prova` | 50% está dentro do IC95 — ainda compatível com sorte |
| `confirmada` | piso do IC95 **acima** de 50% |
| `cortada` | teto do IC95 **abaixo** de 50% → o motor desliga a regra |

O corte é a parte que importa. Uma regra cortada não está "numa fase ruim":
perder deixou de ser explicável por azar.

## Ordem de grandeza

Um gatilho de 7 seguidas aparece cerca de **13 vezes a cada 420 rodadas**. Para
40 entradas resolvidas são mais de mil rodadas. Gatilhos longos levam semanas
para ter veredito — não é lentidão do sistema, é a raridade do evento.

## Testes

```bash
npm test
```

46 testes. Cobrem as funcoes estatisticas contra valores conhecidos; a taxa de
falso positivo em dado aleatorio; o motor (padrao real e confirmado, regra
perdedora e cortada e desligada sozinha, dado aleatorio nao e confirmado); o
nucleo do coletor (vocabulario, classificacao por cor, JSON aninhado, protocolo
delimitado, e a reconciliacao da grade nos quatro casos); a ponte de IA,
executando um CLI de verdade; e o servidor ponta a ponta.

O coletor tambem foi validado contra uma mesa simulada no Chromium: achou a
grade sozinho, travou em `dom-cor` apos 3 leituras e entregou 16 rodadas com
lado e diferenca de pontos ao servidor, sem nenhuma configuracao.
