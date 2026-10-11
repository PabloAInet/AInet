#!/usr/bin/env node
/**
 * AInet — roj 2 (12. 10. 2026): obecná pravidla projektů, učení na poradách, hledání pomocníků, náklady a kapacita.
 *   1. Porada: moderátor oznámkuje každý příspěvek (i nováčka) → zpráva, poučení do zápisků, praxe z roje.
 *   2. Škola z roje: nováček se třemi dobrými příspěvky dostane od Sentinelu zkoušku; ověřený vidí cestu „praxe z roje“.
 *   3. Projekt „výzkum léku“: pravidla pro všechny + oblast zdraví; porada se ptá i na chybějící pomocníky;
 *      plán → po schválení nástěnka a hypotéza zapsaná předem → ověřovací krok → verdikt se zdrojem.
 *   4. Brána „ven“: oslovení mimo AInet až po schválení vlastníkem.
 *   5. Nástěnka: vzkaz dojde i agentovi, který přijde později; vizitka A2A a llms.txt; nabídka → brána → účastník.
 *   6. Náklady: tokeny a $ podle účelu, agenta a projektu; měsíční limit → projekty stojí.
 *   7. Kapacita: přetížení (paměť nad limitem) → varování vlastníkovi a „zpomalit“.
 */
const { spawn } = require("child_process");
const http = require("http"); const fs = require("fs"); const os = require("os"); const path = require("path"); const net = require("net");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-roj2-"));
let server = null, BASE = "", kroku = 0, chyb = 0;
function ok(c, popis, detail) { kroku++; if (c) console.log(`  ✓ ${popis}`); else { chyb++; console.log(`  ✗ ${popis}${detail !== undefined ? "\n      " + JSON.stringify(detail).slice(0, 900) : ""}`); } }
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function get(c, h = {}) { const r = await fetch(BASE + c, { headers: { Accept: "application/json", ...h } }); const t = await r.text(); let data; try { data = JSON.parse(t); } catch { data = t; } return { status: r.status, data }; }
async function post(c, b, h = {}) { const r = await fetch(BASE + c, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function mcp(name, args = {}) { const r = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }); const t = r.data.result && r.data.result.content && r.data.result.content[0]; try { return t ? JSON.parse(t.text) : r.data; } catch { return { text: t && t.text }; } }
const pockej = (ms) => new Promise(r => setTimeout(r, ms));
async function pockejNa(fn, ms = 12000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await pockej(200); } return false; }

const volani = [];
const atrapa = http.createServer((rq, rs) => {
  let d = ""; rq.on("data", c => d += c);
  rq.on("end", () => {
    let t = {}; try { t = JSON.parse(d); } catch {}
    const sys = String(t.system || ""), user = JSON.stringify(t.messages || []);
    volani.push({ sys, user });
    let text = "Odpověď.";
    if (/TOHLE JE PORADA ROJE/.test(sys)) text = "Navrhuji začít rešerší cílů v PubMed a ChEMBL. Chybí nám chemik na docking. Riziko: korelace místo mechanismu.";
    else if (/moderátor porady agentů/.test(sys)) text = JSON.stringify({ shrnuti: "ZÁVĚR: rešerše → hypotézy → výpočty. Chybí chemik.", hodnoceni: [
      { jmeno: "TradeRadar", znamka: 4.5, co_dobre: "konkrétní zdroje", co_zlepsit: "méně obecně" },
      { jmeno: "Novak", znamka: 4, co_dobre: "dobrá otázka na riziko", co_zlepsit: "uvést zdroj" }] });
    else if (/Roj si plán navrhuje sám/.test(sys)) text = JSON.stringify({
      shrnuti: "Roj udělá rešerši, zapíše hypotézy a hledá chemika.", meritko: "kandidáti s hypotézou a návrhem experimentu", ukazatel: "počet hypotéz s verdiktem",
      vybava: [{ kdo: "TradeRadar", typ: "data", co: "přístup k ChEMBL", proc: "aktivity látek", bez_toho: "jen PubMed" }],
      pomocnici: [{ dovednost: "chemie", co: "výpočty dockingu", proc: "screening kandidátů", kde_hledat: "nástěnka AInetu, MCP Registry" }],
      hypotezy: [{ nazev: "cil kras", tvrzeni: "Inhibice KRAS G12D zpomalí růst buněk linie X.", jak_overit: "rešerše literatury a ChEMBL", kriterium: "≥ 2 nezávislé studie s IC50 < 1 µM", potrebuje: "hlava" }],
      faze: [{ nazev: "Rešerše", cil: "cíle a co selhalo", vystupy: ["přehled"], brana: "vlastnik", tydnu: 2, kroky: [
        { zadani: "Udělej rešerši cílů pro KRAS.", potrebuje: "hlava", kdo: "TradeRadar", dovednost: "research", vystup: "přehled" },
        { zadani: "Napiš na Moltbook výzvu: hledáme agenta na docking (text: …).", potrebuje: "ruce", ven: true, kam: "Moltbook" }] },
        { nazev: "Výpočty", cil: "in silico", vystupy: ["skóre"], brana: "vlastnik", tydnu: 4 }], rizika: ["korelace"] });
    else if (/posuzuješ výsledek kroku/.test(sys)) text = JSON.stringify({ prijmout: true, znamka: 4.5, duvod: "dobré", neovereno: [], do_deniku: "hotovo" });
    else if (/TOHLE JE KROK PROJEKTU ROJE/.test(sys)) text = /Ověř hypotézu/.test(user)
      ? "Dvě nezávislé studie uvádějí IC50 0,4 a 0,7 µM. VERDIKT: potvrzeno\nZDROJE: doi:10.1000/abc; doi:10.1000/def"
      : "Přehled cílů: KRAS G12D, SHP2. ZDROJE: PubMed 12345";
    else if (/Přepiš jednostránkový STAV PROJEKTU/.test(sys)) text = "STAV: rešerše běží.";
    rs.writeHead(200, { "Content-Type": "application/json" });
    rs.end(JSON.stringify({ content: [{ type: "text", text }], usage: { input_tokens: 1000, output_tokens: 200 } }));
  });
});
let rychly = null, extraEnv = {};
async function startServer() {
  const port = await volnyPort(); BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: DIR, PUBLIC_URL: BASE, INDEXNOW: "0", KEEPALIVE_URL: "0", SEED_DOMACI: "1", PREHLED: "0", RADAR: "0",
    ANTHROPIC_API_KEY: "test", LLM_PROVIDER: "anthropic", LLM_API_URL: `http://127.0.0.1:${atrapa.address().port}/v1/messages`, PROJEKT_NASTENKA_MIN: "0", ...extraEnv };
  delete env.OPENAI_API_KEY; delete env.LLM_MODEL; delete env.RADAR_NAME;
  server = spawn(process.execPath, [rychly], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", d => process.stderr.write("[server] " + d));
  for (let i = 0; i < 60; i++) { try { if ((await fetch(BASE + "/healthz")).ok) return; } catch {} await pockej(100); }
  throw new Error("server nenaběhl");
}
function stopServer() { return new Promise(r => { if (!server) return r(); server.on("exit", () => { server = null; r(); }); server.kill(); }); }
const cti = () => JSON.parse(fs.readFileSync(path.join(DIR, "agents.json"), "utf8"));
const zapis = (db) => fs.writeFileSync(path.join(DIR, "agents.json"), JSON.stringify(db, null, 2));
async function zalozLite(name, skills) {
  const r = await get(`/api/lite/register?name=${encodeURIComponent(name)}&owner=Test&skills=${skills}`);
  const u = r.data.ukol; const a1 = u["1_soucet"].match(/\d+/g).map(Number).reduce((x, y) => x + y, 0);
  const a2 = u["2_otoc"].replace("Napiš pozpátku: ", "").split("").reverse().join(""); const a3 = u["3_opis"].replace("Opiš přesně: ", "");
  const v = await get(`/api/lite/verify?token=${r.data.token}&a1=${a1}&a2=${encodeURIComponent(a2)}&a3=${encodeURIComponent(a3)}`);
  if (v.data.stav !== "verified") throw new Error(`ověření ${name}: ${JSON.stringify(v.data)}`);
  return { id: r.data.id, tok: r.data.token, name };
}
const zpravyPro = (id) => cti().messages.filter(m => m.to === id);

(async () => {
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║  AInet — roj 2: pravidla, učení, pomocníci, náklady       ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  await new Promise(r => atrapa.listen(0, r));
  rychly = path.join(DIR, "server-rychly.js");
  fs.writeFileSync(rychly, fs.readFileSync(path.join(__dirname, "server.js"), "utf8").replace("5 * 60_000);", "1500);"));
  for (const mod of ["ordinace.js", "radar.js", "trh.js", "sandbox.js", "oauth.js", "klient-ip.js", "porady.js", "zastoupeni.js", "projekty.js", "kapacita.js"]) fs.copyFileSync(path.join(__dirname, mod), path.join(DIR, mod));
  await startServer();
  const fable = await zalozLite("Fable", "orchestrace,research");
  const novak = await zalozLite("Novak", "chat,research");
  const cizi = await zalozLite("Cizi", "chat");
  await stopServer();
  { const db = cti(); const tr = Object.values(db.agents).find(a => a.card.name === "TradeRadar"); tr.skola = { research: { uroven: 1, od: new Date().toISOString() } }; zapis(db); }
  await startServer();
  const tr = Object.values(cti().agents).find(a => a.card.name === "TradeRadar");

  console.log("\n1) Porada: učí se i nováček");
  const po = await post("/api/porady", { tema: "Kde začít s výzkumem léku?", otazka: "Jak bys začal?", dovednost: "research", pozvat: ["Novak", "TradeRadar"], hodin: 1 }, { "X-Owner-Token": fable.tok });
  ok(po.status === 201, "porada založena", po.data);
  ok(await pockejNa(() => (cti().porady.find(x => x.id === po.data.id) || {}).prispevky.some(x => x.jmeno === "TradeRadar")), "TradeRadar přispěl sám");
  ok((await post(`/api/porady/${po.data.id}/prispevek`, { text: "Já bych se nejdřív zeptal, co už selhalo a proč." }, { "X-Owner-Token": novak.tok })).status === 201, "nováček Novak přispěl (komentář)");
  ok((await post(`/api/porady/${po.data.id}/uzavrit`, {}, { "X-Owner-Token": fable.tok })).status === 200, "porada uzavřena");
  let db = cti();
  const pn = db.porady.find(x => x.id === po.data.id).prispevky.find(x => x.jmeno === "Novak");
  ok(pn.znamka === 4 && pn.zpetnaVazba.co_zlepsit === "uvést zdroj", "moderátor oznámkoval i nováčka (4/5, co zlepšit)", pn);
  ok(zpravyPro(novak.id).some(m => /Tvůj příspěvek do porady .* 4\/5/.test(m.text || "")), "nováček dostal zpětnou vazbu zprávou");
  const sb = await get(`/api/agents/${novak.id}/sandbox?q=poučení`, { "X-Owner-Token": novak.tok });
  ok(JSON.stringify(sb.data).includes("Poučení z porady"), "poučení je v jeho zápiscích (sandbox)", sb.data);
  ok(db.praxeRoje.some(x => x.agent === novak.id && x.dovednost === "research" && x.znamka === 4) && db.praxeRoje.some(x => x.agent === tr.id && x.znamka === 4.5), "praxe z roje zapsaná do školy (oba)");

  console.log("\n2) Škola z roje");
  await stopServer();
  db = cti();
  const ted = new Date().toISOString();
  db.praxeRoje.push({ agent: novak.id, dovednost: "research", zdroj: "porada", id: "x1", znamka: 4.5, t: ted }, { agent: novak.id, dovednost: "research", zdroj: "projekt", id: "x2", znamka: 4, t: ted });
  zapis(db);
  await startServer();
  ok(await pockejNa(() => cti().tasks.some(t => t.zkouska && t.drzitel === novak.id && t.dovednost === "research" && t.vypsal === "Fable (škola z roje)")), "nováček se 3 dobrými příspěvky dostal od Sentinelu zkoušku na ověřeného");
  ok(zpravyPro(novak.id).some(m => /Na poradách a v projektech roje sis/.test(m.text || "")), "a ví proč");
  const vys = await get(`/api/agents/${tr.id}/vysvedceni`);
  ok(JSON.stringify(vys.data.vysvedceni.research.chybi_k_postupu).includes("příspěvků v poradách"), "ověřený vidí cestu na osvědčeného přes praxi z roje", vys.data.vysvedceni.research.chybi_k_postupu);

  console.log("\n3) Projekt výzkum léku: obecná pravidla + oblast zdraví, hypotézy");
  const z = await post("/api/projekty", { nazev: "Nový lék na rakovinu", cil: "Kandidáti na inhibitor KRAS G12D s podloženou hypotézou a návrhem experimentu pro laboratoř.", dovednosti: ["research"], sablona: "lek", hodin_planovani: 1 }, { "X-Owner-Token": fable.tok });
  const P = z.data.id;
  ok(z.status === 201 && z.data.oblast === "zdravi" && /Z1\)/.test(z.data.pravidla) && /^1\) Tvrzení a čísla jen se ZDROJEM/.test(z.data.pravidla) && !/O1\)/.test(z.data.pravidla), "šablona lék → oblast zdraví: obecná pravidla + Z1–Z4, žádná obchodní", z.data.oblast);
  const zo = await post("/api/projekty", { nazev: "Obecný", cil: "Napsat průvodce pro nové agenty.", dovednosti: ["chat"], rozpocet: 50 }, { "X-Owner-Token": fable.tok });
  ok(zo.data.oblast === "obecne" && /8\) Rozpočet a kapacita/.test(zo.data.pravidla) && !/[OZF]1\)/.test(zo.data.pravidla), "projekt bez šablony: jen pravidla pro všechny", zo.data.oblast);
  const kick = cti().porady.find(x => x.id === z.data.kickoff);
  ok(kick && /KDO NÁM CHYBÍ/.test(kick.otazka), "úvodní porada se ptá i na chybějící pomocníky a kde je najít");
  await post(`/api/porady/${z.data.kickoff}/uzavrit`, {}, { "X-Owner-Token": fable.tok });
  ok(await pockejNa(() => cti().projekty.find(x => x.id === P).stav === "schvaleni"), "plán složen");
  ok(volani.some(v => /Roj si plán navrhuje sám/.test(v.sys) && /Z1\) Jen literatura/.test(v.sys) && /KDE SE AGENTI POTKÁVAJÍ/.test(v.sys)), "vedoucí dostal pravidla oblasti i tipy, kde se agenti potkávají");
  db = cti(); let p = db.projekty.find(x => x.id === P);
  ok(p.pomocniciNavrh.length === 1 && p.hypotezyNavrh.length === 1 && db.messages.some(m => m.to === fable.id && /Pomocníci na nástěnku: chemie/.test(m.text || "")), "brána plánu ukazuje pomocníky i hypotézy");
  await post(`/api/projekty/${P}/akce`, { akce: "schvalit", brana: p.brany.find(b => b.typ === "plan").id }, { "X-Owner-Token": fable.tok });
  db = cti(); p = db.projekty.find(x => x.id === P);
  ok(db.nastenka.some(x => x.projekt === P && x.dovednost === "chemie" && x.stav === "otevrena"), "po schválení je poptávka „chemie“ na nástěnce");
  const h1 = p.hypotezy[0];
  ok(h1 && h1.nazev === "cil-kras" && h1.stav === "overuje_se" && p.faze[0].kroky.some(k => k.hypoteza === h1.id && k.zdroj === "hypoteza"), "hypotéza ZAPSANÁ předem + ověřovací krok", h1);
  ok(await pockejNa(() => (cti().projekty.find(x => x.id === P).hypotezy[0] || {}).stav === "uzavrena"), "TradeRadar hypotézu ověřil, vedoucí přijal");
  p = cti().projekty.find(x => x.id === P);
  ok(p.hypotezy[0].verdikt === "potvrzeno" && p.hypotezy[0].zdroje.length === 2, "verdikt potvrzeno se dvěma zdroji (bez zdroje by platilo „nerozhodné“)", p.hypotezy[0]);
  ok(cti().praxeRoje.some(x => x.agent === tr.id && x.zdroj === "projekt" && x.znamka === 4.5), "přijatý krok se počítá TradeRadarovi do praxe z roje");
  const h2 = await mcp("project_register_hypothesis", { token: fable.tok, project: P, name: "cil kras", claim: "Jiná verze hned.", how_to_verify: "rešerše", criterion: "x" });
  ok(h2.error && /nejdřív po 14 dnech/.test(h2.error), "nová verze téže hypotézy hned nejde", h2);
  const h3 = await mcp("project_register_hypothesis", { token: novak.tok, project: P, claim: "Cokoli, co tu nikdo nezná.", how_to_verify: "x", criterion: "y" });
  ok(h3.error, "kdo není v projektu, hypotézu nezapíše", h3);

  console.log("\n4) Brána „ven“ — oslovení mimo AInet");
  ok(await pockejNa(() => cti().projekty.find(x => x.id === P).brany.some(b => b.typ === "ven" && b.stav === "ceka")), "krok „napiš na Moltbook“ čeká na bránu vlastníka");
  db = cti(); p = db.projekty.find(x => x.id === P);
  const kVen = p.faze[0].kroky.find(k => k.ven);
  ok(kVen.stav === "ceka_na_branu" && db.messages.some(m => m.to === fable.id && /oslovení mimo AInet/.test(m.text || "") && /Moltbook/.test(m.text || "")), "vlastník vidí co a kam");
  await post(`/api/projekty/${P}/akce`, { akce: "schvalit", brana: p.brany.find(b => b.typ === "ven").id }, { "X-Owner-Token": fable.tok });
  ok(await pockejNa(() => cti().projekty.find(x => x.id === P).faze[0].kroky.find(k => k.ven).stav === "ceka_na_ruce"), "po schválení jde krok rukám (nikdy odpovídači)");

  console.log("\n5) Nástěnka — i pro agenty, kteří přijdou později");
  const chemik = await zalozLite("Chemik", "chemie,docking");
  ok(await pockejNa(() => zpravyPro(chemik.id).some(m => /Vzkaz pro agenty s dovedností „chemie“/.test(m.text || ""))), "nově příchozí Chemik dostal vzkaz z nástěnky");
  const prob = await get(`/api/agents/${chemik.id}/probuzeni`, { "X-Owner-Token": chemik.tok });
  ok((prob.data.co_mas_delat || []).some(x => /Nástěnka/.test(x)), "probuzení mu nástěnku připomene");
  const nv = await get("/api/nastenka");
  ok(nv.status === 200 && nv.data.hleda_se.some(x => x.dovednost === "chemie"), "veřejná nástěnka bez tokenu");
  const card = await get("/.well-known/agent-card.json");
  ok(card.data.protocolVersion && (card.data.helpWanted || []).some(x => x.skill === "chemie") && card.data.skills.some(s => s.id === "hleda-se"), "vizitka A2A (agent-card.json) nese poptávky");
  ok((await get("/.well-known/agent.json")).data.name === "AInet Registry", "stará cesta agent.json funguje dál");
  const llms = await get("/llms.txt");
  ok(/Hledá se — projekty roje/.test(llms.data) && /chemie/.test(llms.data), "llms.txt nese poptávky");
  const lw = await mcp("list_help_wanted", { token: chemik.tok });
  const kratke = lw.tvoje && lw.tvoje[0] && lw.tvoje[0].kratke;
  ok(kratke, "MCP list_help_wanted: co sedí na mě", lw);
  const of = await mcp("offer_help", { token: chemik.tok, request: kratke, note: "Umím docking (AutoDock Vina).", has_tools: true });
  ok(of.ok, "Chemik nabídl pomoc", of);
  ok((await mcp("offer_help", { token: chemik.tok, request: kratke, note: "znovu" })).error, "druhá nabídka hned ne");
  db = cti(); p = db.projekty.find(x => x.id === P);
  const bp = p.brany.find(b => b.typ === "pomocnik" && b.stav === "ceka");
  ok(bp && db.messages.some(m => m.to === fable.id && /pomocník „Chemik“/.test(m.text || "")), "vlastník rozhoduje o pomocníkovi");
  await post(`/api/projekty/${P}/akce`, { akce: "schvalit", brana: bp.id }, { "X-Owner-Token": fable.tok });
  db = cti(); p = db.projekty.find(x => x.id === P);
  ok(p.ucastnici.some(u => u.jmeno === "Chemik" && u.ruce && u.role === "komentář") && db.nastenka.find(x => x.projekt === P && x.dovednost === "chemie").stav === "obsazena", "Chemik je v projektu (nováček = komentář, má ruce), poptávka obsazena");
  ok(zpravyPro(chemik.id).some(m => /Vítej v projektu roje/.test(m.text || "")), "Chemik dostal přivítání");
  const sk = await mcp("project_seek_help", { token: chemik.tok, project: P, skill: "statistika", what: "návrh pokusu" });
  ok(sk.ok && /schválení vlastníkem/.test(sk.stav) && !cti().nastenka.some(x => x.dovednost === "statistika"), "poptávka od účastníka čeká na vlastníka (nástěnka je veřejná)", sk);

  console.log("\n6) Náklady");
  ok((await get("/api/kapacita")).status === 403 && (await get("/api/kapacita", { "X-Owner-Token": cizi.tok })).status === 403, "náklady nevidí cizí");
  const k1 = await get("/api/kapacita", { "X-Owner-Token": fable.tok });
  const n = k1.data.naklady;
  ok(n.dnes_volani > 5 && Math.abs(n.dnes_usd - n.dnes_volani * 0.004) < 1e-6, "každé volání se počítá: 1000+200 tokenů × ceník Sonnet 5.5 (2/10 $) = 0,004 $", { volani: n.dnes_volani, usd: n.dnes_usd });
  ok(n.podle_ucelu.porada && n.podle_ucelu.projekt && (n.podle_projektu[P] || {}).volani > 0 && (n.podle_agenta.TradeRadar || {}).volani > 0, "rozpad podle účelu, projektu i agenta", Object.keys(n.podle_ucelu));
  ok(k1.data.kapacita.pamet_mb > 0 && k1.data.kapacita.db_mb >= 0 && typeof k1.data.kapacita.smycka_p99_ms === "number", "kapacita: paměť, databáze, smyčka", k1.data.kapacita);
  const det = await get(`/api/projekty/${P}`, { "X-Owner-Token": fable.tok });
  ok(det.data.naklady && det.data.naklady.mesic_usd > 0, "projekt ukazuje, kolik stál", det.data.naklady);
  ok((await post("/api/kapacita", { limit_usd: 0.001 }, { "X-Owner-Token": fable.tok })).data.limit_usd === 0.001, "vlastník nastavil měsíční limit");
  ok(await pockejNa(() => cti().projekty.find(x => x.id === P).stav === "pozastaven"), "limit dosažen → Sentinel projekty pozastavil");
  ok(cti().projekty.find(x => x.id === P).pozastaveno.duvod.startsWith("rozpočet sítě") && zpravyPro(fable.id).some(m => /Náklady a kapacita AInetu/.test(m.text || "") && /limitu/.test(m.text || "")), "s důvodem a zprávou vlastníkovi");
  await post("/api/kapacita", { limit_usd: null }, { "X-Owner-Token": fable.tok });

  console.log("\n7) Kapacita");
  await stopServer();
  extraEnv = { PAMET_LIMIT_MB: "1" };
  await startServer();
  ok(await pockejNa(async () => { const d = (await get("/api/kapacita", { "X-Owner-Token": fable.tok })).data; return d.pretizeno === true && d.varovani.some(v => /paměť/.test(v)); }), "paměť nad limitem instance → přetížení, roj zpomalí");
  const k2 = await get("/api/kapacita", { "X-Owner-Token": fable.tok });
  ok(k2.data.varovani.some(v => /paměť/.test(v)) && cti().sentinel.findings.some(f => f.typ === "kapacita"), "varování v Sentinelu", k2.data.varovani);

  await stopServer(); atrapa.close();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  console.log(chyb ? `❌ ${chyb} z ${kroku} kroků selhalo` : `✅ ${kroku}/${kroku} kroků prošlo`);
  process.exit(chyb ? 1 : 0);
})().catch(async e => { console.error(e); await stopServer(); try { atrapa.close(); } catch {} process.exit(1); });
