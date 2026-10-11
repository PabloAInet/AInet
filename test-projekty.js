#!/usr/bin/env node
/**
 * AInet — projekty roje (12. 10. 2026): celý koloběh s atrapou modelu a rychlým Sentinelem.
 *   1. Založení: účastníci podle dovedností, úvodní porada „jak na to a jaká výbava“ (bez artefaktu na Wonderwall).
 *   2. Plán složí vedoucí z porady; vlastník ho schválí (brána), výbavu vyřizuje po položkách.
 *   3. Kroky: „hlava“ → serverový agent odpoví sám, vedoucí jednou vrátí, pak přijme a zapíše strategii;
 *      „ruce“ → nikdy k odpovídači, vezme si ho agent s nástroji přes MCP; „worker“ → zápis strategie PŘED měřením + job.
 *   4. Ruce workeru: jen domácí token, převzetí jobu, výsledek → krok přijat, knihovna; chyba se nepočítá jako pokus.
 *   5. Kázeň měření: kritérium jen přísnější, práh t roste s pokusy, nová verze nejdřív po 14 dnech, pole proti manifestu.
 *   6. Stín → brána papíru (jen long + open_D1) → worker vidí papír až po schválení; metriky papíru bez schválení ne.
 *   7. Fáze s bránou, rozpad další fáze, konec vrácený a pak schválený.
 *   8. Rozpočet: po vyčerpání pozastaveno, bez navýšení nepokračuje; STOP a zrušení.
 */
const { spawn } = require("child_process");
const http = require("http"); const fs = require("fs"); const os = require("os"); const path = require("path"); const net = require("net");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-projekty-"));
let server = null, BASE = "", kroku = 0, chyb = 0;
function ok(c, popis, detail) { kroku++; if (c) console.log(`  ✓ ${popis}`); else { chyb++; console.log(`  ✗ ${popis}${detail !== undefined ? "\n      " + JSON.stringify(detail).slice(0, 900) : ""}`); } }
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function get(c, h = {}) { const r = await fetch(BASE + c, { headers: { Accept: "application/json", ...h } }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function post(c, b, h = {}) { const r = await fetch(BASE + c, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function mcp(name, args = {}) { const r = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }); const t = r.data.result && r.data.result.content && r.data.result.content[0]; try { return t ? JSON.parse(t.text) : r.data; } catch { return { text: t && t.text }; } }
const pockej = (ms) => new Promise(r => setTimeout(r, ms));
async function pockejNa(fn, ms = 12000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await pockej(200); } return false; }

const SKOK = { nazev: "Skok s objemem", vstup: "open_D1", vystup: { dni: 1, cena: "open" }, filtry: [{ pole: "pohyb_pct", op: ">=", hodnota: 3 }, { pole: "objem_x", op: ">=", hodnota: 2 }], razeni: { pole: "objem_x", smer: "desc" }, max_denne: 3 };
const ZAPSAT = { nazev: "Odraz po poklesu", vstup: "close_D", vystup: { dni: 2, cena: "close" }, filtry: [{ pole: "pohyb_pct", op: "<=", hodnota: -5 }] };

/* atrapa modelu podle systémového promptu */
const volani = []; let posudkuRadar = 0;
const atrapa = http.createServer((rq, rs) => {
  let d = ""; rq.on("data", c => d += c);
  rq.on("end", () => {
    let t = {}; try { t = JSON.parse(d); } catch {}
    const sys = String(t.system || ""), user = JSON.stringify(t.messages || []);
    volani.push({ sys: sys.slice(0, 200), user: user.slice(0, 300) });
    let text = "Odpověď.";
    if (/TOHLE JE PORADA ROJE/.test(sys)) text = "Postup: nejdřív karty strategií ze zkušeností, pak měření ve workeru. Výbava: chci data o short interestu. Riziko: přeučení.";
    else if (/moderátor porady agentů/.test(sys)) text = "ZÁVĚR: karty → měření → stín. Výbava: data o short interestu. Riziko: přeučení.";
    else if (/Roj si plán navrhuje sám/.test(sys)) text = JSON.stringify({
      shrnuti: "Roj sepíše karty strategií, změří je ve workeru a nejlepší pustí do stínu.", meritko: "zisk papírového účtu proti SPY", ukazatel: "Ø alfa stínu",
      vybava: [{ kdo: "Lisak", typ: "plugin", co: "konektor na short interest", proc: "výzkum shortů", bez_toho: "jen data workeru" }],
      faze: [
        { nazev: "Nápady a měření", cil: "karty strategií a první měření", vystupy: ["karty"], brana: "vlastnik", tydnu: 2, kroky: [
          { zadani: "Sepiš dvě karty strategií ze své zkušenosti.", potrebuje: "hlava", kdo: "TradeRadar", dovednost: "analysis", vystup: "2 karty" },
          { zadani: "Stáhni z webu seznam aktivistických podání a shrň ho.", potrebuje: "ruce", dovednost: "analysis", vystup: "tabulka" },
          { zadani: "Změř skok s objemem.", potrebuje: "worker", job: { typ: "backtest", parametry: { strategie: SKOK, kriterium: { t_min: 1.0, naklad_pct: 0.01 } } } },
        ] },
        { nazev: "Stín", cil: "strategie běží ve stínu", vystupy: ["stín"], brana: "vedouci", tydnu: 4 },
      ], rizika: ["přeučení"] });
    else if (/rozpadni ji na konkrétní kroky/.test(sys)) text = JSON.stringify({ kroky: [{ zadani: "Vyhodnoť stín a navrhni další krok.", potrebuje: "hlava", kdo: "TradeRadar", vystup: "vyhodnocení" }], vybava: [{ kdo: "TradeRadar", typ: "data", co: "denní export signálů Earnings Radaru", proc: "stín", bez_toho: "jen panel" }], zmena_planu: null, poznamka: "pokračujeme" });
    else if (/posuzuješ výsledek kroku/.test(sys)) {
      if (/ODEVZDAL: TradeRadar/.test(user)) {
        posudkuRadar++;
        text = posudkuRadar === 1 ? JSON.stringify({ prijmout: false, znamka: 2, duvod: "chybí kritérium vyvrácení", neovereno: [] })
          : JSON.stringify({ prijmout: true, znamka: 4, duvod: "dobré", neovereno: ["alfa 1 %"], do_deniku: "karty hotové", zaregistrovat: posudkuRadar === 2 ? [{ strategie: ZAPSAT }] : [] });
      } else text = JSON.stringify({ prijmout: true, znamka: 4, duvod: "ok", neovereno: [], do_deniku: "tabulka aktivistů" });
    }
    else if (/Přepiš jednostránkový STAV PROJEKTU/.test(sys)) text = "STAV: fáze běží, měření hotové, čeká se na stín.";
    else if (/TOHLE JE KROK PROJEKTU ROJE/.test(sys)) text = "Karta 1: skok s objemem — kupci po zprávě. Karta 2: odraz po poklesu. Vyvrátí to 40 obchodů bez alfy.\nZDROJE: knihovna projektu";
    rs.writeHead(200, { "Content-Type": "application/json" });
    rs.end(JSON.stringify({ content: [{ type: "text", text }] }));
  });
});
let rychly = null;
async function startServer() {
  const port = await volnyPort(); BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: DIR, PUBLIC_URL: BASE, INDEXNOW: "0", KEEPALIVE_URL: "0", SEED_DOMACI: "1", PREHLED: "0", RADAR: "0",
    ANTHROPIC_API_KEY: "test", LLM_PROVIDER: "anthropic", LLM_API_URL: `http://127.0.0.1:${atrapa.address().port}/v1/messages` };
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

(async () => {
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║  AInet — projekty roje (plán, výbava, ruce, měření)       ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  await new Promise(r => atrapa.listen(0, r));
  rychly = path.join(DIR, "server-rychly.js");
  fs.writeFileSync(rychly, fs.readFileSync(path.join(__dirname, "server.js"), "utf8").replace("5 * 60_000);", "1500);"));
  for (const mod of ["ordinace.js", "radar.js", "trh.js", "sandbox.js", "oauth.js", "klient-ip.js", "porady.js", "zastoupeni.js", "projekty.js"]) fs.copyFileSync(path.join(__dirname, mod), path.join(DIR, mod));
  await startServer();
  const fable = await zalozLite("Fable", "orchestrace,research");
  const lisak = await zalozLite("Lisak", "chat,analysis");
  const cizi = await zalozLite("Cizi", "chat");
  await stopServer();
  { const db = cti(); const tr = Object.values(db.agents).find(a => a.card.name === "TradeRadar");
    tr.skola = { analysis: { uroven: 1, od: new Date().toISOString() } }; db.agents[lisak.id].skola = { analysis: { uroven: 1, od: new Date().toISOString() } }; zapis(db); }
  await startServer();
  const tr = Object.values(cti().agents).find(a => a.card.name === "TradeRadar");
  const T = { id: tr.id, tok: tr.ownerToken };

  console.log("\n1) Založení a úvodní porada");
  ok((await post("/api/projekty", { nazev: "x", cil: "y", dovednosti: ["analysis"] })).status === 403, "bez tokenu projekt nevznikne");
  ok((await post("/api/projekty", { nazev: "Roj", dovednosti: ["analysis"] }, { "X-Owner-Token": fable.tok })).status === 400, "bez společného cíle nevznikne");
  const z = await post("/api/projekty", { nazev: "Roj obchoduje sám", cil: "Co nejvíc vydělat na papírovém účtu proti SPY.", dovednosti: ["analysis"], sablona: "obchod", rozpocet: 300, ruce: ["Lisak"] }, { "X-Owner-Token": fable.tok });
  const P = z.data.id;
  ok(z.status === 201 && z.data.stav === "planovani" && z.data.ucastnici.map(u => u.jmeno).sort().join(",") === "Lisak,TradeRadar", "projekt založen; pozvaní podle dovednosti (TradeRadar, Lisak), ne Cizi ani Fable", z.data.ucastnici);
  ok(z.data.ucastnici.every(u => u.role === "řešitel") && z.data.ucastnici.find(u => u.jmeno === "Lisak").ruce === true && z.data.ucastnici.find(u => u.jmeno === "TradeRadar").server === true, "role a ruce: oba řešitelé, Lisak má nástroje, TradeRadar je serverový");
  const po = cti().porady.find(x => x.id === z.data.kickoff);
  ok(po && /jak na to a jaká výbava/.test(po.tema) && /VÝBAVU od vlastníka/.test(po.otazka) && po.bezArtefaktu, "úvodní porada se ptá na postup a výbavu", po && po.tema);
  ok(await pockejNa(() => (cti().porady.find(x => x.id === P.kickoff || x.id === z.data.kickoff) || {}).prispevky.length >= 1), "TradeRadar (serverový) do porady přispěl sám");
  ok((await post(`/api/porady/${z.data.kickoff}/prispevek`, { text: "Já bych začal výzkumem aktivistů. Výbava: konektor na short interest." }, { "X-Owner-Token": lisak.tok })).status === 201, "Lisak přispěl");
  ok((await post(`/api/porady/${z.data.kickoff}/uzavrit`, {}, { "X-Owner-Token": fable.tok })).status === 200, "vedoucí poradu uzavřel");
  ok(!cti().artifacts.some(a => a.porada === z.data.kickoff), "shrnutí úvodní porady nejde jako artefakt na Wonderwall");

  console.log("\n2) Plán a výbava");
  ok(await pockejNa(() => cti().projekty[0].stav === "schvaleni"), "vedoucí složil plán z porady → čeká na schválení");
  let db = cti(), p = db.projekty[0];
  ok(p.faze.length === 2 && p.faze[0].kroky.length === 3 && p.vybava.length === 1 && p.vybava[0].co === "konektor na short interest" && p.brany.some(b => b.typ === "plan" && b.stav === "ceka"), "plán: 2 fáze, 3 kroky první fáze, 1 položka výbavy, brána plánu", { faze: p.faze.length, vybava: p.vybava });
  ok(db.messages.some(m => m.to === fable.id && /čeká na tebe: plán v1 a výbava/.test(m.text || "")), "vlastníkovi (schránka Fabla) přišla brána plánu s výbavou");
  ok((await get(`/api/projekty/${P}`, { "X-Owner-Token": cizi.tok })).status === 403 && (await get(`/api/projekty/${P}`, { "X-Owner-Token": lisak.tok })).status === 200, "detail vidí účastník, cizí ne");
  const brana = p.brany.find(b => b.typ === "plan").id;
  ok((await post(`/api/projekty/${P}/akce`, { akce: "schvalit", brana }, { "X-Owner-Token": lisak.tok })).status === 403, "účastník bránu neschválí — jen vlastník");
  ok((await post(`/api/projekty/${P}/akce`, { akce: "vybava", vybava: p.vybava[0].id, stav: "dodano", poznamka: "konektor připojen" }, { "X-Owner-Token": fable.tok })).status === 200, "vlastník výbavu dodal");
  ok(cti().messages.some(m => m.to === lisak.id && /výbava „konektor na short interest“: dodána/.test(m.text || "")), "žadatel ví, že výbavu dostal");
  const sch = await post(`/api/projekty/${P}/akce`, { akce: "schvalit", brana }, { "X-Owner-Token": fable.tok });
  ok(sch.status === 200 && sch.data.stav === "bezi", "vlastník schválil plán → projekt běží", sch.data);

  console.log("\n3) Kroky: hlava, ruce, worker");
  ok(await pockejNa(() => { const k = cti().projekty[0].faze[0].kroky; return k[0].stav !== "ceka" && k[1].stav === "ceka_na_ruce" && k[2].stav === "u_workeru"; }), "kroky rozdány: hlava → TradeRadar, ruce čekají, worker má job");
  db = cti(); p = db.projekty[0];
  const [kH, kR, kW] = p.faze[0].kroky;
  ok(!db.messages.some(m => m.projektKrok === kR.id), "krok „ruce“ nikdy nejde odpovídači (žádná zpráva serverovému agentovi)");
  ok(db.messages.some(m => m.to === fable.id && /čeká na agenta s nástroji/.test(m.text || "")), "vlastník ví, že krok čeká na ruce");
  const reg1 = p.registrace[0];
  ok(reg1 && reg1.nazev === "skok-s-objemem" && reg1.kriterium.t_min === 2 && reg1.kriterium.naklad_pct === 0.1 && reg1.pokus === 1 && kW.registrace === reg1.id, "worker krok: strategie ZAPSÁNA před měřením, kritérium zpřísněné na podlahu (t 2, náklad 0,1)", reg1 && reg1.kriterium);
  ok(await pockejNa(() => cti().projekty[0].faze[0].kroky[0].kola === 1), "vedoucí krok TradeRadara jednou vrátil k doplnění");
  ok(await pockejNa(() => cti().projekty[0].faze[0].kroky[0].stav === "prijat"), "TradeRadar doplnil, vedoucí přijal");
  db = cti(); p = db.projekty[0];
  ok(p.registrace.some(r => r.nazev === "odraz-po-poklesu" && r.zalozil === "Fable"), "z výsledku kroku vedoucí zapsal strategii k měření");
  ok(p.faze[0].kroky[0].posudek.neovereno.includes("alfa 1 %"), "neověřená čísla (bez zdroje) jsou v posudku označená");
  const kroky = await mcp("project_steps", { token: lisak.tok });
  ok(kroky.kroky && kroky.kroky.some(k => k.krok === kR.id && /ruce/.test(k.stav)), "MCP project_steps: Lisak vidí krok, který čeká na ruce", kroky);
  const prob = await get(`/api/agents/${lisak.id}/probuzeni`, { "X-Owner-Token": lisak.tok });
  ok((prob.data.co_mas_delat || []).some(x => /Projekty roje/.test(x)), "probuzení Lisakovi připomene kroky projektu", prob.data.co_mas_delat);
  ok((await mcp("project_take_step", { token: cizi.tok, step: kR.id })).error, "cizí agent si krok nevezme");
  const vz = await mcp("project_take_step", { token: lisak.tok, step: kR.id });
  ok(vz.ok && /aktivistických/.test(vz.zadani) && vz.pravidla, "Lisak (ruce) si krok vzal — dostal zadání, stav a pravidla", vz);
  const odv = await mcp("project_submit", { token: lisak.tok, step: kR.id, result: "Tabulka: 12 podání SC 13D za září.", sources: ["https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=SC%2013D"] });
  ok(odv.ok, "Lisak odevzdal se zdrojem", odv);
  ok(await pockejNa(() => cti().projekty[0].faze[0].kroky[1].stav === "prijat"), "krok s rukama přijat");

  console.log("\n4) Ruce workeru");
  ok((await get("/api/projekty/worker", { "X-Owner-Token": cizi.tok })).status === 403, "worker endpoint jen domácím tokenem");
  const w1 = await get("/api/projekty/worker", { "X-Owner-Token": T.tok });
  const jobBt = w1.data.joby.find(j => j.registrace === reg1.id);
  ok(w1.status === 200 && jobBt && jobBt.parametry.kriterium.t_min === 2 && jobBt.parametry.registrovano === reg1.t, "worker dostane job s kritériem a časem zápisu", w1.data.joby);
  ok((await post(`/api/projekty/joby/${jobBt.id}`, { stav: "bezi" }, { "X-Owner-Token": T.tok })).status === 200, "worker job převzal");
  ok((await post(`/api/projekty/joby/${jobBt.id}`, { stav: "bezi" }, { "X-Owner-Token": T.tok })).status === 409, "podruhé ho převzít nejde");
  const vys = { verdikt: "PROŠLO", duvody: [], vyvoj: { n: 640, dni: 400, vynos: 0.8, alfa: 0.62, median: 0.5, t: 6.1, kladnych_pct: 61, roky: { 2022: { alfa: 0.6, n: 200 } } }, holdout: { n: 120, alfa: 0.55, t: 3.2 }, stin: { n: 4, od: reg1.t.slice(0, 10) }, data: { od: "2021-09-13", do: "2026-10-09", titulu: 2026 }, poznamka: "panel = přeživší" };
  ok((await post(`/api/projekty/joby/${jobBt.id}`, { stav: "hotovo", vysledek: vys }, { "X-Owner-Token": T.tok })).status === 200, "worker poslal výsledek");
  db = cti(); p = db.projekty[0];
  const r1 = p.registrace.find(r => r.id === reg1.id);
  ok(r1.verdikt === "PROŠLO" && r1.stin && p.faze[0].kroky[2].stav === "prijat" && /ZDROJ: worker/.test(p.faze[0].kroky[2].vysledek), "verdikt zapsán, strategie jde do stínu, worker krok přijat se zdrojem");
  const knih = await get(`/api/projekty/${P}/knihovna?q=skok`, { "X-Owner-Token": lisak.tok });
  ok(knih.data.vysledky && knih.data.vysledky.some(d => /Měření: skok-s-objemem v1/.test(d.nazev)), "měření je v knihovně projektu", knih.data);
  const reg2 = p.registrace.find(r => r.nazev === "odraz-po-poklesu");
  const job2 = (await get("/api/projekty/worker", { "X-Owner-Token": T.tok })).data.joby.find(j => j.registrace === reg2.id);
  await post(`/api/projekty/joby/${job2.id}`, { stav: "bezi" }, { "X-Owner-Token": T.tok });
  await post(`/api/projekty/joby/${job2.id}`, { stav: "chyba", chyba: "pole mimo data" }, { "X-Owner-Token": T.tok });
  ok(cti().projekty[0].registrace.find(r => r.id === reg2.id).stav === "chyba", "chyba workeru se zapíše (a nepočítá se jako pokus)");

  console.log("\n5) Kázeň měření");
  const v2 = await post(`/api/projekty/${P}/registrace`, { strategie: SKOK }, { "X-Owner-Token": lisak.tok });
  ok(v2.status === 409 && /nejdřív/.test(v2.data.error), "nová verze téže strategie hned → ne (14 dní, mezitím stín)", v2.data);
  const v3 = await post(`/api/projekty/${P}/registrace`, { strategie: { ...SKOK, nazev: "Skok bez objemu", filtry: [{ pole: "pohyb_pct", op: ">=", hodnota: 4 }] }, kriterium: { t_min: 3.5 } }, { "X-Owner-Token": lisak.tok });
  ok(v3.status === 201 && v3.data.registrace.pokus === 2 && v3.data.registrace.kriterium.t_min === 3.5, "jiná myšlenka = jiný název; 2. pokus; přísnější t agenta platí", v3.data.registrace && v3.data.registrace.kriterium);
  const v4 = await post(`/api/projekty/${P}/registrace`, { strategie: { ...SKOK, nazev: "treti", filtry: [{ pole: "gap_pct", op: ">=", hodnota: 2 }] } }, { "X-Owner-Token": lisak.tok });
  ok(v4.status === 201 && v4.data.registrace.kriterium.t_min === 2.4, "3. pokus → práh t 2 + 0,25·log2(3) ≈ 2,4", v4.data.registrace && v4.data.registrace.kriterium.t_min);
  ok((await post(`/api/projekty/${P}/registrace`, { strategie: SKOK }, { "X-Owner-Token": cizi.tok })).status === 403, "cizí agent strategii nezapíše");
  ok((await post("/api/projekty/worker/manifest", { manifest: { typy_jobu: { backtest: "…" }, strategie: { pole: { pohyb_pct: "…", objem_x: "…", gap_pct: "…", cena: "…" } } } }, { "X-Owner-Token": T.tok })).status === 200, "worker ohlásil manifest");
  const v5 = await post(`/api/projekty/${P}/registrace`, { strategie: { nazev: "tajna", filtry: [{ pole: "zitrejsi_cena", op: ">", hodnota: 1 }] } }, { "X-Owner-Token": lisak.tok });
  ok(v5.status === 400 && /nezná/.test(v5.data.error), "pole, které worker nezná, se nezapíše", v5.data);

  console.log("\n6) Stín → brána papíru");
  ok((await post(`/api/projekty/registrace/${reg1.id}/metriky`, { typ: "papir", souhrn: { n: 3 } }, { "X-Owner-Token": T.tok })).status === 409, "metriky papíru bez schválení odmítnuty");
  await post(`/api/projekty/registrace/${reg1.id}/metriky`, { typ: "stin", souhrn: { n: 41, dni: 24, alfa: 0.31, t: 2.6, od: reg1.t.slice(0, 10) }, obchody: [{ t: "AAA", a: 0.4 }] }, { "X-Owner-Token": T.tok });
  db = cti(); p = db.projekty[0];
  const bP = p.brany.find(b => b.typ === "papir" && b.stav === "ceka");
  ok(bP && bP.registrace === reg1.id, "stín ≥ 20 dní, ≥ 30 obchodů, alfa > 0 → brána papíru pro vlastníka");
  let ws = (await get("/api/projekty/worker", { "X-Owner-Token": T.tok })).data.strategie.find(s => s.id === reg1.id);
  ok(ws && ws.stin === true && ws.papir === false, "worker: stín ano, papír ne (dokud vlastník neschválí)", ws);
  ok((await post(`/api/projekty/${P}/akce`, { akce: "schvalit", brana: bP.id }, { "X-Owner-Token": fable.tok })).status === 200, "vlastník schválil papír");
  ws = (await get("/api/projekty/worker", { "X-Owner-Token": T.tok })).data.strategie.find(s => s.id === reg1.id);
  ok(ws.papir === true, "worker: papír povolen");
  ok((await post(`/api/projekty/registrace/${reg1.id}/metriky`, { typ: "papir", souhrn: { n: 3, pl_usd: 12.5, alfa: 0.2 } }, { "X-Owner-Token": T.tok })).status === 200, "metriky papíru po schválení přijaty");
  const r3 = cti().projekty[0].registrace.find(r => r.id === v3.data.registrace.id);
  { const d2 = cti(); const rr = d2.projekty[0].registrace.find(r => r.id === r3.id); rr.verdikt = "PROŠLO"; rr.strategie.vstup = "close_D"; zapis(d2); }
  await stopServer(); await startServer();
  await post(`/api/projekty/registrace/${r3.id}/metriky`, { typ: "stin", souhrn: { n: 50, dni: 30, alfa: 0.4 } }, { "X-Owner-Token": T.tok });
  db = cti(); p = db.projekty[0];
  ok(!p.brany.some(b => b.typ === "papir" && b.registrace === r3.id) && p.denik.some(x => /papír zatím umí jen long se vstupem na otevření/.test(x.text)), "strategie se vstupem na close splní stín, ale na papír nejde (zůstává ve stínu)");

  console.log("\n7) Fáze, rozpad, konec");
  ok(await pockejNa(() => cti().projekty[0].stav === "brana" && cti().projekty[0].faze[0].stav === "hotovo"), "fáze 1 hotová → stav přepsán → brána vlastníka", cti().projekty[0].stav);
  db = cti(); p = db.projekty[0];
  ok(p.stavText && /STAV:/.test(p.stavText.text), "vedoucí přepsal stav projektu (paměť na měsíce)");
  const bF = p.brany.find(b => b.typ === "faze" && b.stav === "ceka");
  await post(`/api/projekty/${P}/akce`, { akce: "schvalit", brana: bF.id }, { "X-Owner-Token": fable.tok });
  ok(await pockejNa(() => (cti().projekty[0].faze[1].kroky || []).length >= 1), "fáze 2 se rozpadla na kroky až na svém začátku");
  db = cti(); p = db.projekty[0];
  ok(p.vybava.some(v => v.co === "denní export signálů Earnings Radaru" && v.stav === "ceka"), "při rozpadu roj požádal o další výbavu");
  ok(await pockejNa(() => cti().projekty[0].brany.some(b => b.typ === "konec" && b.stav === "ceka"), 20000), "poslední fáze hotová → brána konce");
  const bK = cti().projekty[0].brany.find(b => b.typ === "konec" && b.stav === "ceka");
  await post(`/api/projekty/${P}/akce`, { akce: "vratit", brana: bK.id, poznamka: "ještě vyhodnoť papír" }, { "X-Owner-Token": fable.tok });
  ok(await pockejNa(() => cti().projekty[0].faze[1].kroky.length >= 2), "vrácený konec → poslední fáze se doplní o kroky");
  ok(await pockejNa(() => cti().projekty[0].brany.filter(b => b.typ === "konec").length === 2 && cti().projekty[0].brany.some(b => b.typ === "konec" && b.stav === "ceka"), 20000), "po doplnění znovu brána konce");

  console.log("\n8) Rozpočet, STOP, zrušení");
  await stopServer();
  { const d2 = cti(); d2.projekty[0].rozpocet.spotreba = 40; d2.projekty[0].rozpocet.volani_mesic = 40; d2.projekty[0].stav = "bezi";
    d2.projekty[0].brany.forEach(b => { if (b.typ === "konec" && b.stav === "ceka") b.stav = "vraceno"; }); zapis(d2); }
  await startServer();
  ok(await pockejNa(() => cti().projekty[0].stav === "pozastaven" && cti().projekty[0].pozastaveno.duvod === "rozpočet"), "vyčerpaný rozpočet → projekt pozastaven");
  ws = (await get("/api/projekty/worker", { "X-Owner-Token": T.tok })).data.strategie.find(s => s.id === reg1.id);
  ok(ws.stop === true && ws.papir === false, "pozastavený projekt: worker nesmí na papír vstupovat", ws);
  ok((await post(`/api/projekty/${P}/akce`, { akce: "pokracovat" }, { "X-Owner-Token": fable.tok })).status === 409, "bez navýšení rozpočtu nepokračuje");
  await post(`/api/projekty/${P}/akce`, { akce: "rozpocet", hodnota: 500 }, { "X-Owner-Token": fable.tok });
  ok((await post(`/api/projekty/${P}/akce`, { akce: "pokracovat" }, { "X-Owner-Token": fable.tok })).data.stav === "bezi", "po navýšení pokračuje");
  ok((await post(`/api/projekty/${P}/akce`, { akce: "pozastavit", poznamka: "STOP" }, { "X-Owner-Token": fable.tok })).data.stav === "pozastaven", "STOP vlastníka");
  const zr = await post(`/api/projekty/${P}/akce`, { akce: "zrusit" }, { "X-Owner-Token": fable.tok });
  ok(zr.data.stav === "zruseno" && !(await get("/api/projekty/worker", { "X-Owner-Token": T.tok })).data.strategie.some(s => s.projekt === P), "zrušený projekt: worker už nic nestínuje ani neobchoduje");
  const cz = await mcp("start_project", { token: lisak.tok, name: "Cizí projekt", goal: "Utratit cizí rozpočet.", skills: ["analysis"] });
  ok(cz.error && /vlastník serveru/.test(cz.error), "cizí agent projekt nezaloží (platil by ho rozpočet modelu serveru)", cz);
  const st = await mcp("start_project", { token: fable.tok, name: "3D model motoru", goal: "Parametrický 3D model malého motoru jako skript (CAD v kódu).", skills: ["analysis"], template: "inzenyr", hands: ["Lisak"] });
  ok(st.ok && st.sablona === "inzenyr" && /3D model/.test(st.meritko), "MCP start_project (vlastník): inženýrský projekt se společným cílem (3D model)", st);

  await stopServer(); atrapa.close();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  console.log(chyb ? `❌ ${chyb} z ${kroku} kroků selhalo` : `✅ ${kroku}/${kroku} kroků prošlo`);
  process.exit(chyb ? 1 : 0);
})().catch(async e => { console.error(e); await stopServer(); try { atrapa.close(); } catch {} process.exit(1); });
