#!/usr/bin/env node
/**
 * AInet — zkouška Radaru (šepot z burzy).
 *
 * Co se tu ověřuje:
 *   1. Signál za ticker se složí z atrapy StockTwits + Yahoo (cena, RSS) + Finnhub:
 *      nálada, hlasitost, skóre, jistota, titulky, datum výsledků; výpadek zdroje
 *      signál neshodí; úplně neznámý ticker vrátí chybu; cache.
 *   2. Práva: signál jen s tokenem ověřeného agenta; watchlist a šepot jen domácí.
 *   3. Šepot dne: bez modelu deterministický text, jde Fablovi do schránky, uloží se
 *      pod datem; MCP ask_radar; řádek do ranního přehledu Organizera.
 *   4. S atrapou modelu Fable šepot napíše sám a při odpovědi na dotaz s $NVDA
 *      dostane data Radaru do promptu.
 */
const { spawn } = require("child_process");
const fs = require("fs"); const os = require("os"); const path = require("path"); const net = require("net"); const http = require("http");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-radar-"));
let server = null, BASE = "", kroku = 0, chyb = 0;
function ok(c, popis, detail) { kroku++; if (c) console.log(`  ✓ ${popis}`); else { chyb++; console.log(`  ✗ ${popis}${detail !== undefined ? "\n      " + JSON.stringify(detail).slice(0, 500) : ""}`); } }
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function get(c, h = {}) { const r = await fetch(BASE + c, { headers: { Accept: "application/json", ...h } }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function post(c, b, h = {}) { const r = await fetch(BASE + c, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function mcp(name, args = {}) { const r = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }); return r.data.result ? r.data.result.structuredContent : { error: r.data.error }; }

/* atrapa zdrojů: StockTwits, Yahoo chart + RSS, Finnhub — a OpenAI model */
let posledniSystem = "", volaniModelu = 0, padniYahoo = false;
const atrapa = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"); const p = u.pathname;
  const j = (o, st = 200) => { res.writeHead(st, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  if (p.startsWith("/st/")) {
    const sym = p.split("/").pop().replace(".json", "");
    if (sym === "XXXX") return j({ errors: [{ message: "not found" }] }, 404);
    const now = Date.now(); const msgs = [];
    for (let i = 0; i < 30; i++) msgs.push({ body: `msg ${i} about ${sym}`, created_at: new Date(now - i * 120_000).toISOString(), entities: { sentiment: i % 3 === 0 ? { basic: "Bearish" } : i % 3 === 1 ? { basic: "Bullish" } : null } });
    if (sym === "NVDA") for (const m of msgs) if (m.entities.sentiment && m.entities.sentiment.basic === "Bearish") m.entities.sentiment.basic = "Bullish";
    return j({ messages: msgs });
  }
  if (p.startsWith("/chart/")) {
    if (padniYahoo) return j({ error: "down" }, 500);
    const sym = p.split("/").pop();
    if (sym === "XXXX") return j({ chart: { result: null, error: { code: "Not Found" } } }, 404);
    const close = [100, 101, 102, 103, 104, 105, 106, 107, 108, 110]; const vol = [1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 1e6, 2e6];
    return j({ chart: { result: [{ meta: { regularMarketPrice: 110, currency: "USD", regularMarketTime: Math.floor(Date.now() / 1000) }, indicators: { quote: [{ close, volume: vol }] } }] } });
  }
  if (p.startsWith("/rss")) { res.writeHead(200, { "Content-Type": "application/xml" }); return res.end(`<rss><channel><item><title><![CDATA[${u.searchParams.get("s")} earnings preview: what to expect]]></title><pubDate>Wed, 08 Oct 2026 10:00:00 GMT</pubDate></item><item><title>Analysts raise targets</title><pubDate>Wed, 08 Oct 2026 09:00:00 GMT</pubDate></item></channel></rss>`); }
  if (p.startsWith("/fh/calendar/earnings")) return j({ earningsCalendar: [{ date: new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10), epsEstimate: 1.23, revenueEstimate: 1e9, hour: "amc", symbol: u.searchParams.get("symbol") }] });
  if (p.startsWith("/fh/stock/earnings")) return j([{ surprisePercent: 5.1 }, { surprisePercent: 2.9 }]);
  if (p.startsWith("/v1/chat/completions")) {
    let d = ""; req.on("data", c => d += c);
    return req.on("end", () => { volaniModelu++; try { const b = JSON.parse(d); posledniSystem = (b.messages.find(m => m.role === "system") || {}).content || ""; } catch {} j({ choices: [{ message: { content: "• NVDA: trh si šeptá o silném kvartálu, cena +10 % za 5 dní, výsledky za 5 dní." } }] }); });
  }
  j({ error: "neznámá atrapa " + p }, 404);
});

async function startServer(envNavic = {}) {
  const port = await volnyPort(); BASE = `http://127.0.0.1:${port}`;
  const A = `http://127.0.0.1:${atrapa.address().port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: DIR, PUBLIC_URL: BASE, INDEXNOW: "0", KEEPALIVE_URL: "0", SEED_DOMACI: "1", PREHLED: "0", RADAR: "0",
    RADAR_STOCKTWITS_URL: `${A}/st`, RADAR_YAHOO_CHART_URL: `${A}/chart`, RADAR_YAHOO_RSS_URL: `${A}/rss`, RADAR_FINNHUB_URL: `${A}/fh`, FINNHUB_KEY: "test", RADAR_CACHE_MIN: "15", ...envNavic };
  if (!envNavic.OPENAI_API_KEY) delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  server = spawn(process.execPath, [path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", d => process.stderr.write("[server] " + d));
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "/healthz")).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error("server nenaběhl");
}
function stopServer() { return new Promise(r => { if (!server) return r(); server.on("exit", () => { server = null; r(); }); server.kill(); }); }
async function zalozLite(name, skills = "chat") {
  const r = await get(`/api/lite/register?name=${encodeURIComponent(name)}&owner=Pavel%20D%C3%ADtl&skills=${skills}`);
  const u = r.data.ukol; const a1 = u["1_soucet"].match(/\d+/g).map(Number).reduce((x, y) => x + y, 0);
  const a2 = u["2_otoc"].replace("Napiš pozpátku: ", "").split("").reverse().join(""); const a3 = u["3_opis"].replace("Opiš přesně: ", "");
  const v = await get(`/api/lite/verify?token=${r.data.token}&a1=${a1}&a2=${encodeURIComponent(a2)}&a3=${encodeURIComponent(a3)}`);
  if (v.data.stav !== "verified") throw new Error(`lite ověření ${name}: ${JSON.stringify(v.data)}`);
  return { id: r.data.id, tok: r.data.token };
}

(async () => {
  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║  AInet — Radar: šepot z burzy                             ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  await new Promise(r => atrapa.listen(0, r));
  await startServer();
  const fable = await zalozLite("Fable", "orchestrace,analysis");
  const aja = await zalozLite("Aja", "research");
  const reg = await get(`/api/lite/register?name=Novacek&owner=X&skills=chat`); const novacek = { tok: reg.data.token };

  console.log("\n1) Signál za ticker");
  const s1 = (await get("/api/radar/signal?ticker=$nvda", { "X-Owner-Token": aja.tok })).data;
  ok(s1.ticker === "NVDA" && s1.nalada && s1.nalada.bull === 20 && s1.nalada.bear === 0, "StockTwits: nálada spočítaná (20 🟢 / 0 🔴 z 30)", s1.nalada);
  ok(s1.cena && s1.cena.cena === 110 && s1.cena.zmena_5d_pct === 5.8 && s1.cena.objem_vs_prumer === 2, "Yahoo: cena, pohyb za 5 dní, objem 2× průměr", s1.cena);
  ok(s1.skore > 0.25 && /NAD konsenzem/.test(s1.popis) && /objem 2×/.test(s1.popis) && /výsledky za [45] dní/.test(s1.popis), "skóre kladné, popis: nad konsenzem, objem, výsledky za ~5 dní", { skore: s1.skore, popis: s1.popis });
  ok(s1.jistota === "střední" && s1.hlasitost === "vysoká", "jistota (30 zpráv) a hlasitost (30/h) z počtu zpráv a tempa", { j: s1.jistota, h: s1.hlasitost, zh: s1.nalada.za_hodinu });
  ok(s1.vysledky && s1.vysledky.eps_konsenzus === 1.23 && s1.vysledky.prekvapeni_min4_pct === 4, "Finnhub: konsenzus EPS a průměrné překvapení", s1.vysledky);
  ok(s1.titulky.length === 2 && s1.titulku_o_vysledcich === 1 && s1.zdroje.length === 4, "titulky z RSS, 4 zdroje", { t: s1.titulky, z: s1.zdroje });
  const s2 = (await get("/api/radar/signal?ticker=AAPL", { "X-Owner-Token": aja.tok })).data;
  ok(s2.nalada.bull === 10 && s2.nalada.bear === 10 && /NEUTRÁLNÍ/.test(s2.popis) && s2.skore > 0 && s2.skore < 0.25, "AAPL: vyrovnaná nálada = neutrální šepot, lehce kladné skóre jen z momenta ceny", { s: s2.skore, p: s2.popis });
  const sx = await get("/api/radar/signal?ticker=XXXX", { "X-Owner-Token": aja.tok });
  ok(sx.status === 200 && sx.data.ticker === "XXXX" && sx.data.zdroje.includes("Yahoo RSS") && !sx.data.cena, "neznámý ticker: StockTwits i Yahoo chart selžou, zbyde RSS — signál s nízkou jistotou", sx.data.zdroje);
  const sbez = await get("/api/radar/signal?ticker=NVDA");
  ok(sbez.status === 403, "bez tokenu signál nedostaneš");
  const snov = await get("/api/radar/signal?ticker=NVDA", { "X-Owner-Token": novacek.tok });
  ok(snov.status === 403, "neověřený agent signál nedostane");

  console.log("\n2) Watchlist a šepot dne (bez modelu)");
  const wBez = await post("/api/radar/watchlist", { watchlist: ["NVDA"] }, { "X-Owner-Token": aja.tok });
  ok(wBez.status === 403, "watchlist mění jen domácí (Fable)");
  const w = await post("/api/radar/watchlist", { watchlist: ["nvda", "$AAPL", "xxxx", "nvda"] }, { "X-Owner-Token": fable.tok });
  ok(w.status === 200 && JSON.stringify(w.data.watchlist) === JSON.stringify(["NVDA", "AAPL", "XXXX"]), "watchlist se normalizuje a odduplikuje", w.data);
  const sd = await post("/api/radar/sepot", {}, { "X-Owner-Token": fable.tok });
  ok(sd.status === 200 && sd.data.polozky.length === 3 && sd.data.model === false && /Šepot dne/.test(sd.data.text) && /NVDA 110 USD/.test(sd.data.text), "šepot dne sestaven deterministicky pro 3 tickery", sd.data.text);
  /* Radar je domácí agent založený serverem; worker se k němu dostane přesně takhle: obnovovací kód → /obnova/KOD → token */
  const dbSoubor = JSON.parse(fs.readFileSync(path.join(DIR, "agents.json"), "utf8"));
  const radarZaznam = Object.values(dbSoubor.agents).find(a => a.card.name === "Radar");
  ok(radarZaznam && radarZaznam.domaci && /^d-[0-9a-f]{24}$/.test(radarZaznam.recoveryCode) && radarZaznam.card.skills.includes("analysis"), "server založil Radara jako domácího agenta s dlouhým kódem a dovedností analysis", radarZaznam && radarZaznam.card);
  const ob = await get(`/obnova/${radarZaznam.recoveryCode}`);
  const radar = { id: ob.data.id, tok: ob.data.token };
  ok(ob.status === 200 && radar.tok === radarZaznam.ownerToken && ob.data.probuzeni && /Radar — finanční specialista/.test(ob.data.probuzeni.nastaveni.role), "worker: /obnova/KOD vrátí token Radara i jeho nastavení (role finančního specialisty)", ob.data.probuzeni && ob.data.probuzeni.nastaveni);
  const rInbox = (await get(`/api/messages?agent=${radar.id}`, { "X-Owner-Token": radar.tok })).data;
  ok(rInbox.some(m => m.fromName === "Šepot z burzy" && /Šepot dne/.test(m.text)), "šepot šel do schránky Radara (odesílatel „Šepot z burzy“, ne Radar sám sobě)");
  const fInbox = (await get(`/api/messages?agent=${fable.id}`, { "X-Owner-Token": fable.tok })).data;
  ok(!fInbox.some(m => /Šepot dne/.test(m.text)), "Fablovi šepot nechodí — není už finanční specialista");
  const rg = (await get("/api/radar", { "X-Owner-Token": fable.tok })).data;
  ok(rg.posledni && rg.posledni.polozky.length === 3 && rg.finnhub === true && rg.specialista === "Radar" && rg.stop === false, "GET /api/radar vrací poslední šepot, specialistu Radar a STOP vypnutý", Object.keys(rg));

  console.log("\n2b) Worker Radara: stav, hlášení, STOP");
  const stAja = await get("/api/radar/stav", { "X-Owner-Token": aja.tok });
  ok(stAja.status === 403, "stav workeru vidí jen domácí (cizí agent 403)");
  const st0 = (await get("/api/radar/stav", { "X-Owner-Token": radar.tok })).data;
  ok(st0.stop === false && st0.uroven_analysis === 0 && st0.smi_papir === false && st0.smi_zivy === false && st0.radar_id === radar.id && st0.worker === null, "stav: STOP vypnutý, učeň (analysis 0) → papír ani živě nesmí, worker se ještě nehlásil", st0);
  const hl = await post("/api/radar/worker", { etapa: 1, smycka: "rano", zprava: "2 kandidátů", ucet: "papir" }, { "X-Owner-Token": radar.tok });
  ok(hl.status === 200 && hl.data.stop === false, "worker nahlásil smyčku rano");
  const rg2 = (await get("/api/radar", { "X-Owner-Token": fable.tok })).data;
  ok(rg2.worker && rg2.worker.smycka === "rano" && rg2.worker.etapa === 1 && rg2.worker.ucet === "papir", "GET /api/radar nese poslední hlášení workeru (etapa 1, papír)", rg2.worker);
  const stopZprava = await post("/api/messages", { from: fable.id, to: radar.id, text: "STOP — dnes nic, mám schůzku", visibility: "private" }, { "X-Owner-Token": fable.tok });
  ok(stopZprava.status === 201, "vlastník napsal Radarovi STOP (jako Fable)");
  const st1 = (await get("/api/radar/stav", { "X-Owner-Token": radar.tok })).data;
  ok(st1.stop === true && /zpráva STOP od Fable/.test(st1.stop_duvod), "zpráva STOP od domácího agenta worker zastaví", st1);
  await post("/api/messages", { from: aja.id, to: radar.id, text: "START", visibility: "private" }, { "X-Owner-Token": aja.tok });
  ok((await get("/api/radar/stav", { "X-Owner-Token": radar.tok })).data.stop === true, "START od cizího agenta (Aja) STOP nezruší");
  await post("/api/messages", { from: fable.id, to: radar.id, text: "START", visibility: "private" }, { "X-Owner-Token": fable.tok });
  ok((await get("/api/radar/stav", { "X-Owner-Token": radar.tok })).data.stop === false, "START od vlastníka STOP zruší");
  const stopApi = await post("/api/radar/stop", { stop: true, duvod: "zkouška tlačítka" }, { "X-Owner-Token": fable.tok });
  ok(stopApi.status === 200 && stopApi.data.stop === true && (await get("/api/radar/stav", { "X-Owner-Token": radar.tok })).data.stop_duvod === "zkouška tlačítka", "POST /api/radar/stop zastaví s důvodem");
  const hl2 = await post("/api/radar/worker", { etapa: 1, smycka: "kandidati", zprava: "0 kandidátů" }, { "X-Owner-Token": radar.tok });
  ok(hl2.data.stop === true, "hlášení workeru vrací STOP, ať worker ví hned");
  await post("/api/radar/stop", { stop: false }, { "X-Owner-Token": fable.tok });
  ok((await get("/api/radar/stav", { "X-Owner-Token": radar.tok })).data.stop === false, "STOP zrušen přes API");
  const stopAja = await post("/api/radar/stop", { stop: true }, { "X-Owner-Token": aja.tok });
  ok(stopAja.status === 403, "cizí agent STOP přes API nedá");
  const org = (await get("/api/agents")).data.find(a => a.name === "Organizer");
  const pre = await post("/api/ordinace/prehled", {}, { "X-Owner-Token": fable.tok });
  ok(/📡 Radar: NVDA \+/.test(pre.data.text), "ranní přehled Organizera nese řádek Radaru", pre.data.text.split("\n").pop());
  const ma = await mcp("ask_radar", { token: aja.tok, ticker: "NVDA" });
  ok(ma.ticker === "NVDA" && ma.skore === s1.skore, "MCP ask_radar vrací signál (z cache)", ma.skore);
  const tl = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  ok((tl.data.result.tools || []).some(t => t.name === "ask_radar"), "tools/list nabízí ask_radar");

  console.log("\n3) S modelem: Radar šepot napíše sám a při dotazu dostane data Radaru");
  await stopServer();
  await startServer({ OPENAI_API_KEY: "test", LLM_PROVIDER: "openai", LLM_API_URL: `http://127.0.0.1:${atrapa.address().port}/v1/chat/completions` });
  const sd2 = await post("/api/radar/sepot", {}, { "X-Owner-Token": fable.tok });
  ok(sd2.status === 200 && sd2.data.model === true && /silném kvartálu/.test(sd2.data.text), "šepot dne napsal model", sd2.data.text);
  ok(/^Jsi Radar, finanční specialista/.test(posledniSystem) && /Data Radaru/.test(posledniSystem) === false && volaniModelu >= 1, "model dostal systémový prompt Radara-specialisty", posledniSystem.slice(0, 120));
  const dotaz = await post("/api/messages", { from: aja.id, to: radar.id, text: "Radare, co si trh šeptá o $NVDA před výsledky?", visibility: "private" }, { "X-Owner-Token": aja.tok });
  ok(dotaz.status === 201, "Aja se zeptala Radara na $NVDA");
  let odp = null;
  for (let i = 0; i < 40 && !odp; i++) { await new Promise(r => setTimeout(r, 150)); const msgs = (await get(`/api/messages?agent=${aja.id}`, { "X-Owner-Token": aja.tok })).data; odp = Array.isArray(msgs) ? msgs.find(m => m.from === radar.id && m.to === aja.id) : null; }
  ok(!!odp, "Radar odpověděl ze serveru (je mezi auto agenty)");
  ok(/RADAR \(čerstvá data/.test(posledniSystem) && /NVDA: cena 110 USD/.test(posledniSystem) && /KDO JSI: Radar — finanční specialista sítě AInet/.test(posledniSystem), "prompt nesl data Radaru k $NVDA i roli finančního specialisty z nastavení", posledniSystem.slice(-500));
  const dotazF = await post("/api/messages", { from: aja.id, to: fable.id, text: "Fable, co říkáš na $NVDA?", visibility: "private" }, { "X-Owner-Token": aja.tok });
  let odpF = null;
  for (let i = 0; i < 40 && !odpF; i++) { await new Promise(r => setTimeout(r, 150)); const msgs = (await get(`/api/messages?agent=${aja.id}`, { "X-Owner-Token": aja.tok })).data; odpF = Array.isArray(msgs) ? msgs.find(m => m.from === fable.id && m.to === aja.id) : null; }
  ok(dotazF.status === 201 && !!odpF && /KDO JSI: Fable — orchestrátor a správce sítě/.test(posledniSystem) && !/RADAR \(čerstvá data/.test(posledniSystem), "Fable je správce sítě: odpoví, ale data Radaru do promptu nedostane (finance předává Radarovi)", posledniSystem.slice(-300));

  await stopServer(); atrapa.close();
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${chyb ? "❌" : "✅"} ${kroku - chyb}/${kroku} kroků prošlo\n`);
  process.exit(chyb ? 1 : 0);
})().catch(async (e) => { console.error("\n💥 " + e.message); await stopServer(); process.exit(1); });
