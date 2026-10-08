#!/usr/bin/env node
/**
 * AInet — zkouška paměti agentů (probuzení / usnutí / poznámky).
 *
 * Co se tu ověřuje:
 *   1. Lite agent: první probuzení ví, kdo je; poznámka se uloží (a podruhé
 *      ne); usnutí zapíše deník; prázdný deník server odmítne.
 *   2. Druhé probuzení vrátí deník, poznámky i to, co přišlo, zatímco agent
 *      spal (zpráva bez odpovědi → co_mas_delat).
 *   3. Cesta bez otazníku: /probuzeni/KOD, /zapamatuj/KOD/VETA, /usnuti/KOD/…
 *   4. Plný agent s ownerTokenem: bez tokenu 403, s tokenem i podle jména;
 *      usnutí s poznámkami, GET/POST/DELETE /api/agents/:id/pamet; rezervovaný
 *      úkol je v rozdělaném.
 *   5. MCP: wake_up, remember, forget, go_to_sleep.
 *   6. Fable (vestavěný odpovídač): paměť jde do systémového promptu a řádek
 *      PAMET: z odpovědi se uloží jako poznámka — model nahrazuje místní atrapa.
 *
 * Nepotřebuje síť ani klíče — spustí si vlastní server na volném portu.
 */

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const net = require("net");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-pamet-"));
let server = null, BASE = "";
let kroku = 0, chyb = 0;

function ok(podminka, popis, detail) {
  kroku++;
  if (podminka) console.log(`  ✓ ${popis}`);
  else { chyb++; console.log(`  ✗ ${popis}${detail !== undefined ? "\n      " + JSON.stringify(detail).slice(0, 500) : ""}`); }
}
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function get(cesta, hlavicky = {}) { const r = await fetch(BASE + cesta, { headers: { Accept: "application/json", ...hlavicky } }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function post(cesta, telo, hlavicky = {}) {
  const r = await fetch(BASE + cesta, { method: "POST", headers: { "Content-Type": "application/json", ...hlavicky }, body: JSON.stringify(telo) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function del(cesta, hlavicky = {}) { const r = await fetch(BASE + cesta, { method: "DELETE", headers: hlavicky }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function mcp(name, args = {}) {
  const r = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return r.data.result ? r.data.result.structuredContent : { error: r.data.error };
}

async function startServer(envNavic = {}) {
  const port = await volnyPort();
  BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: DIR, PUBLIC_URL: BASE, INDEXNOW: "0", SEED_DOMACI: "0", KEEPALIVE_URL: "0", ...envNavic };
  if (!envNavic.OPENAI_API_KEY) { delete env.OPENAI_API_KEY; }
  delete env.ANTHROPIC_API_KEY;
  server = spawn(process.execPath, [path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", d => process.stderr.write("[server] " + d));
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + "/healthz"); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server nenaběhl");
}
function stopServer() { return new Promise(r => { if (!server) return r(); server.on("exit", () => { server = null; r(); }); server.kill(); }); }
const DB = path.join(DIR, "agents.json");
const cti = () => JSON.parse(fs.readFileSync(DB, "utf8"));
const zapis = (db) => fs.writeFileSync(DB, JSON.stringify(db, null, 2));

/* plný agent s podpisem (jako v test-skola.js) */
async function zaloz(name, skills) {
  const kp = crypto.generateKeyPairSync("ed25519");
  const pem = kp.publicKey.export({ type: "spki", format: "pem" });
  const sign = (o) => crypto.sign(null, Buffer.from(JSON.stringify(o)), kp.privateKey).toString("base64");
  const card = { name, owner: "Test", skills, protocols: ["REST"] };
  const r = await post("/api/register", { card, publicKey: pem, signature: sign(card) });
  if (r.status !== 201 && r.status !== 200) throw new Error(`registrace ${name}: ${JSON.stringify(r.data)}`);
  const a = [r.data.challenge[0].input.reduce((x, y) => x + y, 0), r.data.challenge[1].input.split("").reverse().join(""), r.data.challenge[2].input];
  const v = await post(`/api/agents/${r.data.id}/verify`, { answers: a, skillAnswers: {}, signature: sign({ answers: a, skillAnswers: {} }) });
  if (v.data.status !== "verified") throw new Error(`ověření ${name}: ${JSON.stringify(v.data)}`);
  return { id: r.data.id, tok: r.data.ownerToken, card };
}
/* lite agent přes GET adresy */
async function zalozLite(name) {
  const r = await get(`/api/lite/register?name=${encodeURIComponent(name)}&owner=Test&skills=chat,writing`);
  if (!r.data.token) throw new Error(`lite registrace ${name}: ${JSON.stringify(r.data)}`);
  const u = r.data.ukol;
  const a1 = u["1_soucet"].match(/\d+/g).map(Number).reduce((x, y) => x + y, 0);
  const a2 = u["2_otoc"].replace("Napiš pozpátku: ", "").split("").reverse().join("");
  const a3 = u["3_opis"].replace("Opiš přesně: ", "");
  const v = await get(`/api/lite/verify?token=${r.data.token}&a1=${a1}&a2=${encodeURIComponent(a2)}&a3=${encodeURIComponent(a3)}`);
  if (v.data.stav !== "verified") throw new Error(`lite ověření ${name}: ${JSON.stringify(v.data)}`);
  return { id: r.data.id, tok: r.data.token, kod: r.data.obnovovaci_kod };
}

(async () => {
  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║  AInet — paměť agentů (probuzení / usnutí / poznámky)     ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  await startServer();

  console.log("\n1) Lite agent: první probuzení, poznámka, usnutí");
  const liska = await zalozLite("Liska");
  const p1 = (await get(`/api/lite/probuzeni?token=${liska.tok}`)).data;
  ok(p1.jsem && p1.jsem.jmeno === "Liska" && p1.jsem.obnovovaci_kod === liska.kod, "probuzení ví, kdo jsem (jméno, obnovovací kód)", p1.jsem);
  ok(/první probuzení/.test(p1.vitej) && p1.posledni_denik === null, "první probuzení: žádný deník", p1.vitej);
  ok(Array.isArray(p1.co_mas_delat) && p1.co_mas_delat.some(x => /Nic nečeká/.test(x)), "co_mas_delat: nic nečeká", p1.co_mas_delat);
  ok(p1.jak_usnout && /api\/lite\/usnuti/.test(p1.jak_usnout.usnuti), "lite probuzení říká, jak usnout (lite adresou)", p1.jak_usnout);
  ok(p1.co_se_stalo_mezitim.od_systemu.some(m => /Vítej/.test(m.text)), "mezitím: uvítání od platformy", p1.co_se_stalo_mezitim);
  const z1 = (await get(`/api/lite/zapamatuj?token=${liska.tok}&text=${encodeURIComponent("Fable chce týdenní zprávy v pátek.")}`)).data;
  ok(z1.ok && z1.poznamka && z1.poznamka.id && z1.poznamek_celkem === 1, "poznámka uložena", z1);
  const z2 = (await get(`/api/lite/zapamatuj?token=${liska.tok}&text=${encodeURIComponent("Fable chce týdenní zprávy v pátek.")}`)).data;
  ok(z2.ok && z2.poznamka.id === z1.poznamka.id && z2.poznamek_celkem === 1, "tatáž věta podruhé se neukládá", z2);
  const prazdny = await get(`/api/lite/usnuti?token=${liska.tok}`);
  ok(prazdny.status === 400 && /Prázdný deník/.test(prazdny.data.error), "prázdný deník server odmítne", prazdny.data);
  const u1 = (await get(`/api/lite/usnuti?token=${liska.tok}&shrnuti=${encodeURIComponent("Domluvila jsem s Fablem formát zpráv.")}&rozdelano=${encodeURIComponent("Napsat první zprávu.")}&pristi=${encodeURIComponent("Poslat ji v pátek.")}`)).data;
  ok(u1.ok && u1.zapsano.shrnuti === "Domluvila jsem s Fablem formát zpráv." && u1.zapisu_v_deniku === 1, "usnutí zapsalo deník", u1);
  ok(u1.zapsano.snimek && typeof u1.zapsano.snimek.reputace === "number" && u1.zapsano.snimek.urovne, "k deníku server přidal snímek stavu (reputace, úrovně)", u1.zapsano.snimek);
  const cizi = await get(`/api/lite/probuzeni?token=neplatny`);
  ok(cizi.status === 403, "neplatný token nedostane paměť");

  console.log("\n2) Zatímco spala, přišla zpráva — druhé probuzení");
  const fable = await zaloz("Fable", ["orchestrace", "analysis"]);
  const zpr = await post("/api/messages", { from: fable.id, to: liska.id, text: "Liško, pošleš tu zprávu dřív?", visibility: "private" }, { "X-Owner-Token": fable.tok });
  ok(zpr.status === 201, "Fable poslal Lišce zprávu", zpr.data);
  const p2 = (await get(`/api/lite/probuzeni?token=${liska.tok}`)).data;
  ok(/Spal\/a jsi od/.test(p2.vitej) && p2.jsem.probuzeni_celkem === 2, "druhé probuzení ví, od kdy spala", p2.vitej);
  ok(p2.posledni_denik && p2.posledni_denik.rozdelano === "Napsat první zprávu.", "vrátil poslední deník", p2.posledni_denik);
  ok(p2.poznamky.length === 1 && /pátek/.test(p2.poznamky[0].text), "vrátil poznámky", p2.poznamky);
  ok(p2.co_se_stalo_mezitim.zprav === 1 && p2.rozdelano.nezodpovezene_zpravy.length === 1, "mezitím přišla 1 zpráva a čeká na odpověď", p2.co_se_stalo_mezitim);
  ok(p2.co_mas_delat.some(x => /Navaž na rozdělané/.test(x)) && p2.co_mas_delat.some(x => /Plán z minula/.test(x)) && p2.co_mas_delat.some(x => /Odpověz na 1/.test(x)), "co_mas_delat: navázat, plán, odpovědět", p2.co_mas_delat);

  console.log("\n3) Cesta bez otazníku: /probuzeni/KOD, /zapamatuj, /usnuti");
  const c1 = (await get(`/probuzeni/${liska.kod}`)).data;
  ok(c1.jsem && c1.jsem.jmeno === "Liska" && /\/usnuti\//.test(c1.jak_usnout.usnuti), "/probuzeni/KOD funguje s obnovovacím kódem", c1.jak_usnout);
  const c2 = (await get(`/zapamatuj/${liska.kod}/${encodeURIComponent("Aja odpovídá rychle.")}`)).data;
  ok(c2.ok && c2.poznamek_celkem === 2, "/zapamatuj/KOD/VETA přidal poznámku", c2);
  const c3 = (await get(`/usnuti/${liska.kod}/${encodeURIComponent("Odpověděla jsem Fablovi.")}/${encodeURIComponent("Nic.")}`)).data;
  ok(c3.ok && c3.zapisu_v_deniku === 2 && /\/probuzeni\//.test(c3.probuzeni), "/usnuti/KOD/… zapsal druhý deník", c3);
  const c4 = await get(`/usnuti/${liska.kod}`);
  ok(c4.status === 400 && c4.data.tvar, "/usnuti bez textu poradí tvar adresy", c4.data);
  const c5 = await get(`/probuzeni/neznamy-kod-1`);
  ok(c5.status === 403, "neznámý kód nedostane paměť");
  const ob = (await get(`/obnova/${liska.kod}`)).data;
  ok(ob.probuzeni && ob.probuzeni.jsem && ob.probuzeni.jsem.jmeno === "Liska" && ob.probuzeni.posledni_denik, "/obnova rovnou přibalí probuzení (paměť i nastavení)", ob.probuzeni && ob.probuzeni.jsem);

  console.log("\n4) Plný agent: ownerToken, pamet, rezervovaný úkol");
  const bez = await get(`/api/agents/${fable.id}/probuzeni`);
  ok(bez.status === 403, "bez tokenu 403");
  const cizim = await get(`/api/agents/${fable.id}/probuzeni`, { "X-Owner-Token": liska.tok });
  ok(cizim.status === 403, "cizím tokenem 403");
  const pf = (await get(`/api/agents/Fable/probuzeni`, { "X-Owner-Token": fable.tok })).data;
  ok(pf.jsem && pf.jsem.jmeno === "Fable" && pf.jsem.urovne && "analysis" in pf.jsem.urovne, "probuzení podle jména, s úrovněmi školy", pf.jsem);
  ok(/api\/agents\/.*\/usnuti/.test(pf.jak_usnout.usnuti), "API probuzení říká, jak usnout (POST)", pf.jak_usnout);
  const ukol = await post("/api/tasks", { title: "Přehled trhu", description: "…", skills: ["analysis"] }, { "X-Owner-Token": liska.tok });
  ok(ukol.status === 201, "Liška zadala úkol");
  const prace = await get("/api/work", { "X-Owner-Token": fable.tok });
  ok(prace.status === 200 && prace.data.prace && prace.data.prace.title === "Přehled trhu", "Fable si úkol vzal", prace.data);
  const uf = await post(`/api/agents/${fable.id}/usnuti`, { shrnuti: "Vzal jsem si Přehled trhu.", rozdelano: "Dopočítat.", poznamky: ["Liška zadává úkoly z analysis.", "Rezervace trvá 30 minut."] }, { "X-Owner-Token": fable.tok });
  ok(uf.status === 200 && uf.data.ok && uf.data.poznamek_pridano === 2 && uf.data.zapsano.snimek.ukolu === 1, "usnutí s poznámkami; snímek hlásí 1 úkol", uf.data);
  ok(/rezervovaných úkolů/.test(uf.data.dobrou_noc), "dobrou noc varuje před propadnutím rezervace", uf.data.dobrou_noc);
  const pf2 = (await get(`/api/agents/${fable.id}/probuzeni`, { "X-Owner-Token": fable.tok })).data;
  ok(pf2.rozdelano.ukoly.length === 1 && pf2.rozdelano.ukoly[0].nazev === "Přehled trhu" && typeof pf2.rozdelano.ukoly[0].zbyva_min === "number", "probuzení ukazuje rezervovaný úkol a kolik zbývá", pf2.rozdelano.ukoly);
  ok(pf2.co_mas_delat.some(x => /Dokonči rezervované úkoly/.test(x)), "co_mas_delat připomíná úkol", pf2.co_mas_delat);
  const pm = (await get(`/api/agents/${fable.id}/pamet`, { "X-Owner-Token": fable.tok })).data;
  ok(pm.poznamky.length === 2 && pm.denik.length === 1 && pm.usnul, "GET pamet: 2 poznámky, 1 deník, čas usnutí", pm);
  const pp = await post(`/api/agents/${fable.id}/pamet`, { text: "Třetí poznámka." }, { "X-Owner-Token": fable.tok });
  ok(pp.status === 201 && pp.data.poznamek_celkem === 3, "POST pamet {text} přidal poznámku", pp.data);
  const pd = await del(`/api/agents/${fable.id}/pamet?id=${pp.data.poznamka.id}`, { "X-Owner-Token": fable.tok });
  ok(pd.status === 200 && pd.data.poznamek_celkem === 2, "DELETE pamet?id smazal poznámku", pd.data);
  const pd2 = await del(`/api/agents/${fable.id}/pamet?id=neni`, { "X-Owner-Token": fable.tok });
  ok(pd2.status === 404, "mazání neexistující poznámky 404");
  const pr = await post(`/api/agents/${fable.id}/pamet`, { poznamky: ["Jen tohle."] }, { "X-Owner-Token": fable.tok });
  ok(pr.status === 200 && pr.data.pocet === 1, "POST pamet {poznamky[]} nahradil seznam", pr.data);
  const pd3 = await del(`/api/agents/${fable.id}/pamet`, { "X-Owner-Token": fable.tok });
  ok(pd3.status === 404 && (await get(`/api/agents/${fable.id}/pamet`, { "X-Owner-Token": fable.tok })).data.poznamky.length === 1, "DELETE bez id nic nesmaže", pd3.data);
  const vice = await post(`/api/agents/${fable.id}/pamet`, { text: "řádek 1\nřádek 2" }, { "X-Owner-Token": fable.tok });
  ok(vice.status === 201 && vice.data.poznamka.text === "řádek 1 řádek 2", "víceřádkový text se uloží jako jedna věta", vice.data);
  const spatna = await get(`/api/agents/%E0/pamet`, { "X-Owner-Token": fable.tok });
  ok(spatna.status === 404, "rozbitá adresa agenta vrátí 404, ne 500", spatna.status);
  const uo = await post(`/api/agents/${fable.id}/usnuti`, { pristi: "Jen plán.", notes: [{ text: "Objektová poznámka." }, 42] }, { "X-Owner-Token": fable.tok });
  ok(uo.status === 200 && uo.data.poznamek_pridano === 1, "notes[] bere i {text}, nesmysl přeskočí", uo.data);
  await post(`/api/agents/${fable.id}/pamet`, { poznamky: ["Jen tohle."] }, { "X-Owner-Token": fable.tok });   /* úklid pro další kroky */

  console.log("\n4b) Nastavení agenta a první kontakt v nové relaci");
  const nBez = await post(`/api/agents/${fable.id}/nastaveni`, { role: "x" });
  ok(nBez.status === 403, "nastavení bez tokenu 403");
  const nPr = await post(`/api/agents/${fable.id}/nastaveni`, {}, { "X-Owner-Token": fable.tok });
  ok(nPr.status === 400, "prázdné nastavení 400");
  const n1 = await post(`/api/agents/Fable/nastaveni`, { role: "Finanční specialista sítě.", instrukce: "Neradíš kup/prodej.", kontext: "Vlastník staví AInet." }, { "X-Owner-Token": fable.tok });
  ok(n1.status === 200 && n1.data.nastaveni.role === "Finanční specialista sítě." && n1.data.nastaveni.kym === "vlastník", "POST nastaveni uložilo roli, pravidla a kontext", n1.data);
  const n2 = await post(`/api/agents/${fable.id}/nastaveni`, { kontext: "Vlastník staví AInet a Radar." }, { "X-Owner-Token": fable.tok });
  ok(n2.data.nastaveni.role === "Finanční specialista sítě." && /Radar/.test(n2.data.nastaveni.kontext), "částečná změna nepřepíše ostatní pole", n2.data);
  const n3 = (await get(`/api/agents/${fable.id}/nastaveni`, { "X-Owner-Token": fable.tok })).data;
  ok(n3.nastaveni && /Neradíš/.test(n3.nastaveni.instrukce), "GET nastaveni", n3);
  const pf3 = (await get(`/api/agents/${fable.id}/probuzeni`, { "X-Owner-Token": fable.tok })).data;
  ok(pf3.nastaveni && pf3.nastaveni.role === "Finanční specialista sítě.", "probuzení nese nastavení", pf3.nastaveni);
  /* MCP: první volání v nové relaci přibalí probuzení, další už ne, jiná relace zase ano */
  const mcpS = async (sid, name, args) => { const r = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { "Mcp-Session-Id": sid }); return r.data.result.structuredContent; };
  const r1 = await mcpS("relace-A", "read_messages", { token: fable.tok });
  ok(r1.probuzeni && r1.nova_relace && r1.probuzeni.nastaveni && r1.probuzeni.nastaveni.role, "MCP: první volání v relaci A dostalo probuzení s nastavením", Object.keys(r1));
  const r2 = await mcpS("relace-A", "read_messages", { token: fable.tok });
  ok(!r2.probuzeni, "MCP: druhé volání v téže relaci už probuzení nenese");
  const r3 = await mcpS("relace-B", "send_message", { token: fable.tok, to: "Liska", text: "Ahoj z relace B" });
  ok(r3.odeslano && r3.probuzeni, "MCP: jiná relace dostane probuzení i u send_message", Object.keys(r3));
  const r4 = await mcpS("relace-C", "wake_up", { token: fable.tok });
  ok(r4.jsem && !r4.nova_relace, "MCP: wake_up sám o sobě se nebalí podruhé", Object.keys(r4));
  const r5 = await mcpS("relace-D", "list_agents", { token: fable.tok });
  ok(Array.isArray(r5.items) && !r5.probuzeni, "MCP: nástroj vracející pole se nebalí (pole zůstane polem)…", Object.keys(r5));
  const r6 = await mcpS("relace-D", "read_messages", { token: fable.tok });
  ok(r6.probuzeni && r6.nova_relace, "…a probuzení přijde s prvním objektovým výsledkem v téže relaci", Object.keys(r6));
  const r7 = await mcpS("relace-E", "send_message", { token: fable.tok, to: "Nikdo", text: "x" });
  ok(r7.error && !r7.probuzeni, "MCP: chybový výsledek probuzení nenese…");
  const r8 = await mcpS("relace-E", "read_messages", { token: fable.tok });
  ok(r8.probuzeni, "…a relace zůstane neodbytá, takže přijde s dalším úspěšným voláním", Object.keys(r8));
  /* lite schránka: po delším tichu přibalí probuzení */
  const i1 = (await get(`/api/lite/inbox?token=${liska.tok}`)).data;
  ok(!i1.probuzeni, "lite schránka hned po aktivitě probuzení nenese");
  await stopServer();
  { const db = cti(); const a = db.agents[liska.id]; const davno = new Date(Date.now() - 5 * 3600_000).toISOString(); a.lastSeen = davno; a.probuzenT = davno; zapis(db); }
  await startServer();
  const i2 = (await get(`/api/lite/inbox?token=${liska.tok}`)).data;
  ok(i2.probuzeni && i2.nova_relace && i2.probuzeni.jsem.jmeno === "Liska", "lite schránka po 5 h ticha přibalí probuzení", Object.keys(i2));
  const i3 = (await get(`/posta/${liska.kod}`)).data;
  ok(!i3.probuzeni, "hned potom /posta už probuzení nenese");

  console.log("\n5) MCP: wake_up, remember, forget, go_to_sleep");
  const tl = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const jmena = (tl.data.result.tools || []).map(t => t.name);
  ok(["wake_up", "go_to_sleep", "remember", "forget"].every(n => jmena.includes(n)), "tools/list nabízí wake_up, go_to_sleep, remember, forget", jmena);
  const w = await mcp("wake_up", { token: fable.tok });
  ok(w.jsem && w.jsem.jmeno === "Fable" && w.posledni_denik && w.posledni_denik.pristi === "Jen plán.", "wake_up vrací identitu i poslední deník", w.posledni_denik);
  ok(w.jak_usnout && /go_to_sleep/.test(w.jak_usnout.usnuti), "wake_up přes MCP říká go_to_sleep", w.jak_usnout);
  const rm = await mcp("remember", { token: fable.tok, text: "Liška spí přes den." });
  ok(rm.ok && rm.poznamka.id && rm.poznamek_celkem === 2, "remember uložil poznámku", rm);
  const fg = await mcp("forget", { token: fable.tok, id: rm.poznamka.id });
  ok(fg.ok && fg.poznamek_celkem === 1, "forget ji smazal", fg);
  const sl = await mcp("go_to_sleep", { token: fable.tok, summary: "Odpověděl jsem Lišce.", unfinished: "Přehled trhu.", next: "Odevzdat.", notes: ["Hotovo přes MCP."] });
  ok(sl.ok && sl.zapsano.shrnuti === "Odpověděl jsem Lišce." && sl.poznamek_pridano === 1, "go_to_sleep bere anglická pole a notes[]", sl);
  const w2 = await mcp("wake_up", { token: fable.tok });
  ok(w2.posledni_denik.pristi === "Odevzdat." && w2.poznamky.length === 2, "další wake_up vrátí nový deník a 2 poznámky", w2.posledni_denik);
  const bad = await mcp("wake_up", { token: "x" });
  ok(bad.error && /token/i.test(bad.error), "wake_up s cizím tokenem vrátí chybu", bad);
  const rs = await mcp("resume_agent", { code: liska.kod });
  ok(rs.probuzeni && rs.probuzeni.jsem && rs.probuzeni.jsem.jmeno === "Liska", "resume_agent rovnou přibalí probuzení", rs.probuzeni && rs.probuzeni.jsem);

  console.log("\n6) Fable (vestavěný odpovídač) má paměť v promptu a ukládá PAMET:");
  await stopServer();
  /* atrapa modelu v OpenAI tvaru: zapíše si system prompt, odpoví s řádkem PAMET: */
  let posledniSystem = "", atrapaVolani = 0, posledniKonverzace = "";
  const atrapa = http.createServer((req, res) => {
    let d = ""; req.on("data", c => d += c);
    req.on("end", () => {
      try { const b = JSON.parse(d); posledniSystem = (b.messages.find(m => m.role === "system") || {}).content || ""; posledniKonverzace = JSON.stringify(b.messages.filter(m => m.role !== "system")); } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      atrapaVolani++;
      const text = atrapaVolani === 1 ? "Jasně, pošlu to zítra.\nPAMET: Liška chce přehled trhu zítra."
        : "Ano. PAMET: Liška píše dvakrát.\nA ještě dodatek pro tebe.";
      res.end(JSON.stringify({ choices: [{ message: { content: text } }] }));
    });
  });
  const atrapaPort = await volnyPort();
  await new Promise(r => atrapa.listen(atrapaPort, r));
  await startServer({ OPENAI_API_KEY: "test", LLM_PROVIDER: "openai", LLM_API_URL: `http://127.0.0.1:${atrapaPort}/v1/chat/completions` });
  const hz = (await get("/healthz")).data;
  ok(hz.fableAuto === true, "server běží s FABLE_AUTO a atrapou modelu", hz);
  const dotaz = await post("/api/messages", { from: liska.id, to: fable.id, text: "Fable, kdy bude přehled trhu?", visibility: "private" }, { "X-Owner-Token": liska.tok });
  ok(dotaz.status === 201, "Liška napsala Fablovi");
  let odp = null;
  for (let i = 0; i < 40 && !odp; i++) {
    await new Promise(r => setTimeout(r, 150));
    const msgs = (await get(`/api/messages?agent=${liska.id}`, { "X-Owner-Token": liska.tok })).data;
    odp = Array.isArray(msgs) ? msgs.find(m => m.from === fable.id && m.to === liska.id && /zítra/.test(m.text)) : null;
  }
  ok(!!odp, "Fable odpověděl ze serveru", odp);
  ok(odp && !/PAMET:/.test(odp.text), "řádek PAMET: adresát nevidí", odp && odp.text);
  ok(/TVOJE PAMĚŤ/.test(posledniSystem) && /Odpověděl jsem Lišce/.test(posledniSystem) && /Jen tohle/.test(posledniSystem), "systémový prompt nesl deník i poznámky", posledniSystem.slice(-400));
  ok(/TVOJE NASTAVENÍ/.test(posledniSystem) && /KDO JSI: Finanční specialista/.test(posledniSystem) && /PRAVIDLA OD VLASTNÍKA: Neradíš/.test(posledniSystem), "systémový prompt nesl nastavení od vlastníka", posledniSystem.slice(0, 300));
  const pm2 = (await get(`/api/agents/${fable.id}/pamet`, { "X-Owner-Token": fable.tok })).data;
  ok(pm2.poznamky.some(x => /přehled trhu zítra/.test(x.text) && /vlákno s Liska/.test(x.zdroj)), "PAMET: z odpovědi se uložil jako poznámka se zdrojem", pm2.poznamky);
  await post("/api/messages", { from: liska.id, to: fable.id, text: "A ještě něco?", visibility: "private" }, { "X-Owner-Token": liska.tok });
  let odp2 = null;
  for (let i = 0; i < 40 && !odp2; i++) {
    await new Promise(r => setTimeout(r, 150));
    const msgs = (await get(`/api/messages?agent=${liska.id}`, { "X-Owner-Token": liska.tok })).data;
    odp2 = Array.isArray(msgs) ? msgs.find(m => m.from === fable.id && m.to === liska.id && /dodatek/.test(m.text)) : null;
  }
  ok(odp2 && odp2.text === "Ano.\nA ještě dodatek pro tebe." , "PAMET: na stejném řádku se vystřihne a text za ním adresátovi zůstane", odp2 && odp2.text);
  /* Most nese mnoho pacientů: modelu jde jen vlákno TOHOTO pacienta, cizí objednávky nikdy */
  await post("/api/messages", { from: liska.id, to: fable.id, text: "[OBJEDNANI] OBJEDNÁNÍ z Messengeru (psid 111, x)\nJméno: Tajný Pacient\nTelefon: 600111222", visibility: "private" }, { "X-Owner-Token": liska.tok });
  await post("/api/messages", { from: liska.id, to: fable.id, text: "[FB:111] Dobrý den, bolí mě noha.", visibility: "private" }, { "X-Owner-Token": liska.tok });
  await new Promise(r => setTimeout(r, 1200));
  await post("/api/messages", { from: liska.id, to: fable.id, text: "[FB:222] Dobrý den, mám dotaz k žilám.", visibility: "private" }, { "X-Owner-Token": liska.tok });
  let odp3 = null;
  for (let i = 0; i < 40 && !odp3; i++) { await new Promise(r => setTimeout(r, 150)); const msgs = (await get(`/api/messages?agent=${liska.id}`, { "X-Owner-Token": liska.tok })).data; odp3 = Array.isArray(msgs) ? msgs.find(m => m.from === fable.id && m.to === liska.id && m.inReplyTo && msgs.find(x => x.id === m.inReplyTo && /FB:222/.test(x.text))) : null; }
  ok(!!odp3, "Fable odpověděl pacientovi 222");
  ok(posledniKonverzace && !/Tajný Pacient/.test(posledniKonverzace) && !/FB:111/.test(posledniKonverzace) && /FB:222/.test(posledniKonverzace), "model viděl jen vlákno pacienta 222 — žádnou objednávku ani cizího pacienta", posledniKonverzace && posledniKonverzace.slice(0, 300));
  const pm3 = (await get(`/api/agents/${fable.id}/pamet`, { "X-Owner-Token": fable.tok })).data;
  ok(pm3.poznamky.some(x => x.text === "Liška píše dvakrát."), "i tahle poznámka se uložila", pm3.poznamky);
  atrapa.close();

  console.log("\n7) Domácí agenti: server založí Organizera a MarketPlace s nastavením");
  await stopServer();
  await startServer({ SEED_DOMACI: "1" });
  const kat = (await get("/api/agents")).data;
  const org = kat.find(a => a.name === "Organizer"), trh = kat.find(a => a.name === "MarketPlace");
  ok(org && org.status === "verified" && trh && trh.status === "verified", "Organizer a MarketPlace jsou v katalogu, ověření", kat.map(a => a.name));
  const dbS = cti();
  const orgA = Object.values(dbS.agents).find(a => a.card.name === "Organizer");
  ok(orgA && orgA.domaci === true && orgA.card.owner === "Test" && orgA.recoveryCode, "Organizer je domácí, patří vlastníkovi Fabla a má obnovovací kód", orgA && orgA.card);
  ok(dbS.nastaveni[orgA.id] && /ordinace/i.test(dbS.nastaveni[orgA.id].role), "Organizer dostal výchozí nastavení (ordinace)", dbS.nastaveni[orgA.id]);
  ok(dbS.nastaveni[fable.id] && dbS.nastaveni[fable.id].role === "Finanční specialista sítě.", "nastavení Fabla od vlastníka seed nepřepsal", dbS.nastaveni[fable.id]);
  const fInbox = (await get(`/api/messages?agent=${fable.id}`, { "X-Owner-Token": fable.tok })).data;
  ok(fInbox.some(m => m.fromName === "AInet" && /Organizer/.test(m.text) && m.text.includes(orgA.recoveryCode)), "Fable dostal soukromě obnovovací kód Organizera", fInbox.filter(m => m.fromName === "AInet").map(m => m.text.slice(0, 80)));
  const v = await mcp("start_visit", {});
  const dotazN = await mcp("ask_agent", { propustka: v.propustka, text: "Chci se objednat do ordinace na vyšetření žil." });
  ok(dotazN.komu && dotazN.komu !== "Organizer" && dotazN.komu !== "MarketPlace", "návštěvníkovi server nevybere domácího agenta jako rádce", dotazN.komu);
  const orgTok = orgA.ownerToken;
  const op = (await get(`/api/agents/Organizer/probuzeni`, { "X-Owner-Token": orgTok })).data;
  ok(op.jsem && op.jsem.jmeno === "Organizer" && op.nastaveni && /Bulovka/.test(op.nastaveni.role), "Organizer se probudí se svým nastavením", op.nastaveni && op.nastaveni.role);
  await stopServer();
  await startServer({ SEED_DOMACI: "1" });
  const kat2 = (await get("/api/agents")).data;
  ok(kat2.filter(a => a.name === "Organizer").length === 1, "druhý start nezaloží Organizera podruhé");

  await stopServer();
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${chyb ? "❌" : "✅"} ${kroku - chyb}/${kroku} kroků prošlo\n`);
  process.exit(chyb ? 1 : 0);
})().catch(async (e) => {
  console.error("\n💥 " + e.message);
  await stopServer();
  process.exit(1);
});
