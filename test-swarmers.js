#!/usr/bin/env node
/**
 * AInet — roj Swarmers (13. 10. 2026): porady a projekty mají víc hlasů než jeden.
 *   Pavel: „Swarmers je název pro roj agentů při projektu.“ Porady roje měly jediného účastníka (TradeRadar)
 *   a plán projektu spadl na „záložní plán bez modelu“ — JSON se do 2000 tokenů nevešel.
 *   1. Projekt ze „starého“ serveru (bez roje) s uříznutým plánem → záložní plán čeká na schválení.
 *   2. Server s rojem: 4 Swarmers založeni, ověření, ve výpisu agentů i porad; token domácího je odemkne, cizí ne.
 *   3. Rozběhnutý projekt: roj přibyde, záložní plán se stáhne, roj se znovu radí (nová úvodní porada).
 *   4. Porada: Swarmers přispějí sami (komentář), shrnutí dostane delší výstup a známky dostane každý.
 *   5. Plán modelem s 8000 tokeny; po schválení dostane krok „hlava“ i učeň z roje (Skeptik na rizika).
 *   6. Swarmer na běžnou poštu nepíše; oponenturu ve škole nedostává.
 */
const { spawn } = require("child_process");
const http = require("http"); const fs = require("fs"); const os = require("os"); const path = require("path"); const net = require("net");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-swarmers-"));
let server = null, BASE = "", kroku = 0, chyb = 0;
function ok(c, popis, detail) { kroku++; if (c) console.log(`  ✓ ${popis}`); else { chyb++; console.log(`  ✗ ${popis}${detail !== undefined ? "\n      " + JSON.stringify(detail).slice(0, 900) : ""}`); } }
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function get(c, h = {}) { const r = await fetch(BASE + c, { headers: { Accept: "application/json", ...h } }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function post(c, b, h = {}) { const r = await fetch(BASE + c, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
const pockej = (ms) => new Promise(r => setTimeout(r, ms));
async function pockejNa(fn, ms = 15000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await fn()) return true; } catch {} await pockej(200); } return false; }

const ROJ = ["Swarmer-Inzenyr", "Swarmer-Skeptik", "Swarmer-Strateg", "Swarmer-Vyzkumnik"];

/* atrapa modelu: zapisuje, kdo volal (podle systémového promptu) a s jakým max_tokens */
const volani = []; let planRozbity = true;
const atrapa = http.createServer((rq, rs) => {
  let d = ""; rq.on("data", c => d += c);
  rq.on("end", () => {
    let t = {}; try { t = JSON.parse(d); } catch {}
    const sys = String(t.system || ""), user = JSON.stringify(t.messages || []);
    const kdo = (sys.match(/^Jsi ([\w-]+) —/) || [])[1] || "";
    volani.push({ kdo, sys, max: t.max_tokens, user: user.slice(0, 400) });
    let text = "Odpověď.";
    if (/TOHLE JE PORADA ROJE/.test(sys)) text = `${kdo || "Agent"}: postup — nejdřív karty strategií, pak měření. Riziko: přeučení. Jistota střední.`;
    else if (/moderátor porady agentů/.test(sys)) {
      const jmena = [...new Set([...user.matchAll(/--- ([\w-]+) \(/g)].map(m => m[1]))];
      text = JSON.stringify({ shrnuti: "ZÁVĚR: karty → měření → stín. Podněty roje: rizika přeučení, proveditelnost.", hodnoceni: jmena.map(j => ({ jmeno: j, znamka: 4, co_dobre: "věcné", co_zlepsit: "zdroje" })) });
    }
    else if (/Roj si plán navrhuje sám|Swarmers si plán navrhují sami/.test(sys)) text = planRozbity
      ? '{"shrnuti": "Roj sepíše karty strategií a změří je", "faze": [{"nazev": "Nápady", "kroky": [{"zadani": "Sepiš kar'   /* uříznutý JSON — jako s limitem 2000 tokenů */
      : JSON.stringify({
        shrnuti: "Roj sepíše karty strategií, oponent najde slabá místa, pak měření.", meritko: "zisk papírového účtu proti SPY", ukazatel: "Ø alfa stínu",
        faze: [
          { nazev: "Nápady a rizika", cil: "karty a jejich slabá místa", vystupy: ["karty"], brana: "vlastnik", tydnu: 2, kroky: [
            { zadani: "Sepiš dvě karty strategií ze své zkušenosti.", potrebuje: "hlava", kdo: "TradeRadar", dovednost: "analysis", vystup: "2 karty" },
            { zadani: "Najdi slabá místa karet a rizika vícenásobného testování.", potrebuje: "hlava", dovednost: "rizika", vystup: "seznam rizik" },
          ] },
          { nazev: "Stín", cil: "strategie běží ve stínu", vystupy: ["stín"], brana: "vedouci", tydnu: 4 },
        ], rizika: ["přeučení"], vybava: [] });
    else if (/posuzuješ výsledek kroku/.test(sys)) text = JSON.stringify({ prijmout: true, znamka: 4, duvod: "dobré", neovereno: [], do_deniku: "hotovo" });
    else if (/Přepiš jednostránkový STAV PROJEKTU/.test(sys)) text = "STAV: fáze běží.";
    else if (/TOHLE JE KROK PROJEKTU ROJE/.test(sys)) text = `${kdo}: rizika — malý vzorek, vícenásobné testování, náklady. Vyvrátí to holdout.\nZDROJE: knihovna projektu`;
    rs.writeHead(200, { "Content-Type": "application/json" });
    rs.end(JSON.stringify({ content: [{ type: "text", text }] }));
  });
});
let rychly = null;
async function startServer(extra = {}) {
  const port = await volnyPort(); BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: DIR, PUBLIC_URL: BASE, INDEXNOW: "0", KEEPALIVE_URL: "0", SEED_DOMACI: "1", PREHLED: "0", RADAR: "0",
    ANTHROPIC_API_KEY: "test", LLM_PROVIDER: "anthropic", LLM_API_URL: `http://127.0.0.1:${atrapa.address().port}/v1/messages`, ...extra };
  delete env.OPENAI_API_KEY; delete env.LLM_MODEL; delete env.RADAR_NAME; delete env.AUTO_AGENTI; delete env.SWARMERS;
  if (!extra.SEED_SWARMERS) delete env.SEED_SWARMERS;
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
const agent = (jmeno) => Object.values(cti().agents).find(a => a.card.name === jmeno);

(async () => {
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║  AInet — roj Swarmers (porady a projekty s víc hlasy)     ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  await new Promise(r => atrapa.listen(0, r));
  rychly = path.join(DIR, "server-rychly.js");
  fs.writeFileSync(rychly, fs.readFileSync(path.join(__dirname, "server.js"), "utf8").replace("5 * 60_000);", "1500);"));
  for (const mod of ["ordinace.js", "radar.js", "trh.js", "sandbox.js", "oauth.js", "klient-ip.js", "porady.js", "zastoupeni.js", "projekty.js", "kapacita.js"]) fs.copyFileSync(path.join(__dirname, mod), path.join(DIR, mod));

  console.log("\n1) Starý server bez roje: porada o jednom hlasu, uříznutý plán");
  await startServer({ SEED_SWARMERS: "0" });
  const fable = await zalozLite("Fable", "orchestrace");
  const cizi = await zalozLite("Cizi", "chat,analysis");
  await stopServer();
  { const db = cti(); const tr = Object.values(db.agents).find(a => a.card.name === "TradeRadar"); tr.skola = { analysis: { uroven: 1, od: new Date().toISOString() } }; zapis(db); }
  await startServer({ SEED_SWARMERS: "0" });
  ok(!Object.values(cti().agents).some(a => ROJ.includes(a.card.name)), "bez roje: žádný Swarmer");
  const z0 = await post("/api/projekty", { nazev: "Roj obchoduje sám", cil: "Co nejvíc vydělat na papírovém účtu proti SPY.", dovednosti: ["analysis"], sablona: "obchod", pozvat: [] }, { "X-Owner-Token": fable.tok });
  const P0 = z0.data.id;
  ok(z0.status === 201 && !z0.data.ucastnici.some(u => ROJ.includes(u.jmeno)), "projekt založen bez roje", z0.data.ucastnici);
  ok(await pockejNa(() => (cti().porady.find(x => x.id === z0.data.kickoff) || {}).prispevky.some(x => x.jmeno === "TradeRadar")), "úvodní porada: přispěl TradeRadar");
  await post(`/api/porady/${z0.data.kickoff}/uzavrit`, {}, { "X-Owner-Token": fable.tok });
  ok(await pockejNa(() => cti().projekty.find(x => x.id === P0).stav === "schvaleni"), "plán složen → čeká na schválení");
  let p0 = cti().projekty.find(x => x.id === P0);
  ok(p0.plan.model === false && /Záložní plán bez modelu/.test(p0.plan.shrnuti), "uříznutý JSON → záložní plán bez modelu (stav z 12. 10.)", p0.plan);
  const planVolani = volani.filter(v => /Roj si plán navrhuje sám|Swarmers si plán navrhují sami/.test(v.sys));
  ok(planVolani.length === 2 && planVolani.every(v => v.max >= 8000), "plán se volá s dostatkem tokenů (≥ 8000) a jednou se zopakuje", planVolani.map(v => v.max));
  await stopServer();

  console.log("\n2) Server s rojem Swarmers");
  planRozbity = false;
  await startServer();
  const agenti = (await get("/api/agents")).data;
  const roj = agenti.filter(a => a.swarmer);
  ok(roj.map(a => a.name).sort().join(",") === ROJ.join(","), "4 Swarmers založeni", roj.map(a => a.name));
  ok(roj.every(a => a.status === "verified" && !a.spi && a.domaci === false), "ověření, nespí, ale nejsou „domácí“ (ordinace, radar, trh jim nepatří)");
  ok(cti().messages.some(m => m.to === fable.id && /roj Swarmers/.test(m.text || "")), "Fable (vlastník) dostal zprávu o roji");
  const swNast = cti().nastaveni[agent("Swarmer-Skeptik").id];
  ok(swNast && /oponent roje Swarmers/.test(swNast.role) && swNast.kym === "výchozí nastavení serveru", "Skeptik má výchozí nastavení role");
  const porady0 = (await get("/api/porady")).data;
  ok((porady0.swarmers || []).map(s => s.jmeno).sort().join(",") === ROJ.join(","), "výpis porad ukazuje roj", porady0.swarmers);
  const moji = (await get("/api/moji-agenti", { "X-Owner-Token": fable.tok })).data.agenti || [];
  ok(ROJ.every(j => moji.some(a => a.jmeno === j)), "token domácího (Fabla) roj odemkne — paměť a nastavení", moji.map(a => a.jmeno));
  const mojiCizi = (await get("/api/moji-agenti", { "X-Owner-Token": cizi.tok })).data.agenti || [];
  ok(!mojiCizi.some(a => ROJ.includes(a.jmeno)), "cizí token roj neodemkne");
  const skeptikTok = agent("Swarmer-Skeptik").ownerToken;
  ok((await get("/api/ordinace", { "X-Owner-Token": skeptikTok })).status === 403, "token Swarmera ordinaci neotevře");

  console.log("\n3) Rozběhnutý projekt: roj přibyde a záložní plán se přeplánuje");
  ok(await pockejNa(() => ROJ.every(j => cti().projekty.find(x => x.id === P0).ucastnici.some(u => u.jmeno === j && u.roj))), "Swarmers jsou účastníci starého projektu");
  p0 = cti().projekty.find(x => x.id === P0);
  ok(p0.stav === "planovani" && p0.brany.some(b => b.typ === "plan" && b.stav === "nahrazeno") && !p0.brany.some(b => b.typ === "plan" && b.stav === "ceka"), "záložní plán stažen (brána nahrazena), projekt se plánuje znovu", { stav: p0.stav, brany: p0.brany.map(b => b.stav) });
  const po1 = cti().porady.find(x => x.id === p0.kickoff);
  ok(po1 && po1.stav === "otevrena" && ROJ.every(j => po1.pozvani.includes(agent(j).id)) && po1.pozvani.includes(agent("TradeRadar").id), "nová úvodní porada: TradeRadar + celý roj", po1 && po1.pozvani.length);
  ok(cti().messages.some(m => m.to === fable.id && /přibyl roj Swarmers/.test(m.text || "") && /Záložní plán bez modelu jsem stáhl/.test(m.text || "")), "vlastník ví, proč se plánuje znovu");

  console.log("\n4) Porada s rojem");
  ok(await pockejNa(() => cti().porady.find(x => x.id === po1.id).prispevky.length >= 5, 20000), "přispěli všichni: TradeRadar + 4 Swarmers", cti().porady.find(x => x.id === po1.id).prispevky.map(x => x.jmeno));
  const pr = cti().porady.find(x => x.id === po1.id).prispevky;
  ok(pr.filter(x => ROJ.includes(x.jmeno)).every(x => x.role === "komentář" && x.vaha === 0) && pr.find(x => x.jmeno === "TradeRadar").role === "expert", "roj jsou nováčci (komentář), TradeRadar expert — škola platí");
  ok(volani.some(v => v.kdo === "Swarmer-Skeptik" && /oponent roje Swarmers/.test(v.sys) && /TOHLE JE PORADA ROJE/.test(v.sys)), "Skeptik mluví ze své role");
  const uz = await post(`/api/porady/${po1.id}/uzavrit`, {}, { "X-Owner-Token": fable.tok });
  ok(uz.status === 200 && uz.data.shrnuti && /Podněty roje/.test(uz.data.shrnuti.text), "porada uzavřena se shrnutím", uz.data.shrnuti);
  const mod = volani.filter(v => /moderátor porady agentů/.test(v.sys)).pop();
  ok(mod && mod.max >= 2000 + 500 * 5, "shrnutí porady s 5 příspěvky má delší výstup (≥ 4500 tokenů)", mod && mod.max);
  ok(ROJ.every(j => cti().messages.some(m => m.to === agent(j).id && /Tvůj příspěvek do porady/.test(m.text || ""))), "každý Swarmer dostal známku a poučení");
  ok((cti().praxeRoje || []).filter(x => ROJ.includes((Object.values(cti().agents).find(a => a.id === x.agent) || { card: {} }).card.name)).length >= 4, "známky roje jdou do školy (praxe z roje)");

  console.log("\n5) Plán modelem a kroky pro roj");
  ok(await pockejNa(() => cti().projekty.find(x => x.id === P0).stav === "schvaleni"), "nový plán čeká na schválení");
  p0 = cti().projekty.find(x => x.id === P0);
  ok(p0.plan.model === true && p0.plan.verze === 2 && p0.faze[0].kroky.length === 2, "plán v2 složil model (2 kroky první fáze)", p0.plan);
  const brana = p0.brany.find(b => b.typ === "plan" && b.stav === "ceka").id;
  ok((await post(`/api/projekty/${P0}/akce`, { akce: "schvalit", brana }, { "X-Owner-Token": fable.tok })).data.stav === "bezi", "vlastník plán schválil → běží");
  ok(await pockejNa(() => { const k = cti().projekty.find(x => x.id === P0).faze[0].kroky.find(x => /slabá místa/.test(x.zadani)); return k && k.kdoJmeno === "Swarmer-Skeptik"; }), "krok na rizika dostal učeň z roje — Skeptik", cti().projekty.find(x => x.id === P0).faze[0].kroky.map(k => [k.zadani.slice(0, 20), k.kdoJmeno, k.stav]));
  ok(await pockejNa(() => cti().projekty.find(x => x.id === P0).faze[0].kroky.every(k => k.stav === "prijat"), 20000), "oba kroky odevzdány a přijaty (TradeRadar i Skeptik)", cti().projekty.find(x => x.id === P0).faze[0].kroky.map(k => [k.kdoJmeno, k.stav]));
  ok(volani.some(v => v.kdo === "Swarmer-Skeptik" && /TOHLE JE KROK PROJEKTU ROJE/.test(v.sys) && /učeň roje Swarmers/.test(v.sys)), "Skeptik ví, že je učeň (posoudí vedoucí)");

  console.log("\n6) Nový projekt a hranice roje");
  const z1 = await post("/api/projekty", { nazev: "Motor", cil: "Parametrický 3D model malého motoru jako skript.", dovednosti: ["inzenyrstvi"], sablona: "inzenyr" }, { "X-Owner-Token": fable.tok });
  ok(z1.status === 201 && ROJ.every(j => z1.data.ucastnici.some(u => u.jmeno === j)), "nový projekt má roj od začátku", z1.data.ucastnici);
  const pocetPred = volani.filter(v => v.kdo === "Swarmer-Strateg").length;
  const strateg = agent("Swarmer-Strateg");
  const zp = await post("/api/messages", { from: cizi.id, to: strateg.id, text: "Ahoj, pomůžeš mi s domácím úkolem?", visibility: "private" }, { "X-Owner-Token": cizi.tok });
  ok(zp.status === 200 || zp.status === 201, "cizí agent Swarmerovi napsat může", zp.status);
  await pockej(2500);
  ok(!cti().messages.some(m => m.from === strateg.id && m.to === cizi.id) && volani.filter(v => v.kdo === "Swarmer-Strateg" && !/PORADA|KROK PROJEKTU/.test(v.sys)).length === 0, "…ale Swarmer na běžnou poštu modelem neodpovídá", volani.filter(v => v.kdo === "Swarmer-Strateg").length - pocetPred);

  await stopServer(); atrapa.close();
  console.log(`\n${chyb ? "❌" : "✅"} ${chyb ? `${chyb} z ${kroku} kroků selhalo` : `${kroku}/${kroku} kroků prošlo`}`);
  process.exit(chyb ? 1 : 0);
})().catch(async e => { console.error(e); await stopServer(); process.exit(1); });
