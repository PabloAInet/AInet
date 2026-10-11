#!/usr/bin/env node
/**
 * AInet — noční zastoupení (11. 10. 2026): Fable dělá za spícího vlastníka rutinu školy.
 *   1. Nastavuje jen vlastník (ownerToken); domácí mají jedno společné nastavení, cizí agent své.
 *   2. Mimo okno (režim „noc“, teď je den) Fable nic nepotvrdí ani nevypíše.
 *   3. Režim „vždy“: zkoušku na OVĚŘENÉHO s návrhem Fabla ≥ 4 potvrdí sám (bez lidské známky v ratings),
 *      žák dostane zprávu „potvrdil Fable (zastoupení vlastníka)“; vypíše nejvýš 2 zkoušky za noc serverovým agentům.
 *   4. Nikdy: návrh pod 4, neshoda s oponentem (> 1 bod), cíl osvědčený.
 *   5. Vrácení: zkouška zpět do hodnocení, úroveň dolů, Fable ji znovu nepotvrdí a Sentinel ji po lhůtě nezavře;
 *      vrátit smí jen vlastník té skupiny; vlastník pak potvrdí sám (lidská známka).
 *   6. Ranní souhrn: na požádání i automaticky v nastavenou hodinu, jen jednou za den, do schránky Fabla.
 */
const { spawn } = require("child_process");
const http = require("http"); const fs = require("fs"); const os = require("os"); const path = require("path"); const net = require("net");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-zastoupeni-"));
let server = null, BASE = "", kroku = 0, chyb = 0;
function ok(c, popis, detail) { kroku++; if (c) console.log(`  ✓ ${popis}`); else { chyb++; console.log(`  ✗ ${popis}${detail !== undefined ? "\n      " + JSON.stringify(detail).slice(0, 700) : ""}`); } }
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function get(c, h = {}) { const r = await fetch(BASE + c, { headers: { Accept: "application/json", ...h } }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function post(c, b, h = {}) { const r = await fetch(BASE + c, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
const pockej = (ms) => new Promise(r => setTimeout(r, ms));
async function pockejNa(fn, ms = 8000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await pockej(150); } return false; }

/* atrapa modelu: hodnotitel vrátí známku z proměnné, zkouška text práce */
let znamkaHodnotitele = 4.4;
const atrapa = http.createServer((rq, rs) => {
  let d = ""; rq.on("data", c => d += c);
  rq.on("end", () => {
    let t = {}; try { t = JSON.parse(d); } catch {}
    const sys = String(t.system || "");
    let text = "Odpověď.";
    if (/Jsi zkoušející školy AInet/.test(sys)) text = JSON.stringify({ znamka: znamkaHodnotitele, body: [4, 5, 4, 4, 5], zduvodneni: "Sedí.", zpetna_vazba: "Dobře." });
    else if (/TOHLE JE ZKOUŠKA ŠKOLY/.test(sys)) text = "Alfa po nákladech = výnos − SPY − náklad; t po dnech. Verdikt podle kritéria zapsaného předem.";
    rs.writeHead(200, { "Content-Type": "application/json" });
    rs.end(JSON.stringify({ content: [{ type: "text", text }] }));
  });
});

const prahaHodina = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Prague", hour: "2-digit", hour12: false }).format(new Date())) % 24;
let rychly = null;
async function startServer(extra = {}) {
  const port = await volnyPort(); BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: DIR, PUBLIC_URL: BASE, INDEXNOW: "0", KEEPALIVE_URL: "0", SEED_DOMACI: "1", PREHLED: "0", RADAR: "0",
    ANTHROPIC_API_KEY: "test", LLM_PROVIDER: "anthropic", LLM_API_URL: `http://127.0.0.1:${atrapa.address().port}/v1/messages`, ...extra };
  delete env.OPENAI_API_KEY; delete env.LLM_MODEL; delete env.RADAR_NAME;
  server = spawn(process.execPath, [rychly], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", d => process.stderr.write("[server] " + d));
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "/healthz")).ok) return; } catch {} await pockej(100); }
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
const posta = async (a) => (await get(`/api/messages?agent=${a.id}`, { "X-Owner-Token": a.tok })).data;
const ukol = (id) => cti().tasks.find(x => x.id === id) || {};

(async () => {
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║  AInet — noční zastoupení (Fable za spícího vlastníka)    ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  await new Promise(r => atrapa.listen(0, r));
  /* Sentinel každých 1,5 s místo 5 min */
  rychly = path.join(DIR, "server-rychly.js");
  fs.writeFileSync(rychly, fs.readFileSync(path.join(__dirname, "server.js"), "utf8").replace("5 * 60_000);", "1500);"));
  for (const mod of ["ordinace.js", "radar.js", "trh.js", "sandbox.js", "oauth.js", "klient-ip.js", "porady.js", "zastoupeni.js", "projekty.js", "kapacita.js"]) fs.copyFileSync(path.join(__dirname, mod), path.join(DIR, mod));
  const h = prahaHodina();
  const OKNO = { ZASTOUPENI_OD: String((h + 3) % 24), ZASTOUPENI_DO: String((h + 4) % 24), ZASTOUPENI_SOUHRN: String((h + 6) % 24) };   /* „noc“ teď neplatí */
  await startServer(OKNO);
  const fable = await zalozLite("Fable", "orchestrace,research");
  const lisak = await zalozLite("Lisak", "chat,analysis");
  const cizi = await zalozLite("Cizi", "chat");
  const tr = Object.values(cti().agents).find(a => a.card.name === "TradeRadar");
  const T = { id: tr.id, tok: tr.ownerToken, name: "TradeRadar" };

  console.log("\n1) Kdo nastavuje");
  ok((await get("/api/zastoupeni")).status === 403, "bez tokenu 403");
  const gF = await get("/api/zastoupeni", { "X-Owner-Token": fable.tok });
  ok(gF.status === 200 && gF.data.skupina === "domácí agenti" && gF.data.rezim === "vypnuto", "Fable (domácí) vidí společné nastavení domácích, výchozí vypnuto", gF.data);
  const gC = await get("/api/zastoupeni", { "X-Owner-Token": cizi.tok });
  ok(gC.status === 200 && gC.data.skupina === "Cizi", "cizí vlastník má vlastní skupinu (svého agenta)", gC.data);
  ok((await post("/api/zastoupeni", { rezim: "furt" }, { "X-Owner-Token": fable.tok })).status === 400, "neplatný režim → 400");
  const sN = await post("/api/zastoupeni", { rezim: "noc" }, { "X-Owner-Token": fable.tok });
  ok(sN.status === 200, "vlastník zapnul režim „jen v noci“");
  const gT = await get("/api/zastoupeni", { "X-Owner-Token": T.tok });
  ok(gT.data.rezim === "noc" && gT.data.v_okne_ted === false, "token TradeRadara vidí totéž nastavení (domácí sdílí); teď mimo okno", gT.data);

  console.log("\n2) Mimo okno nic");
  const z1 = await post("/api/skola/vypsat", { agent: "TradeRadar", dovednost: "analysis" }, { "X-Owner-Token": fable.tok });
  ok(z1.status === 201 && z1.data.cil_uroven === 1, "vlastník vypsal TradeRadarovi zkoušku na ověřeného", z1.data);
  const ohodno = await pockejNa(() => { const t = ukol(z1.data.task_id); return t.zkouskaStav === "hodnoceni" && t.znamky && t.znamky.fable; });
  ok(ohodno, "TradeRadar odpověděl, Fable navrhl 4,4");
  await pockej(3500);
  ok(ukol(z1.data.task_id).zkouskaStav === "hodnoceni", "mimo okno zůstává zkouška na vlastníkovi");
  ok(!(cti().zastoupeni.akce || []).length, "mimo okno žádná akce (ani vypsání)");

  console.log("\n3) Režim „vždy“: potvrdí a vypíše");
  znamkaHodnotitele = 3.6;   /* zkoušky, které vypíše Fable, dostanou návrh pod 4 */
  ok((await post("/api/zastoupeni", { rezim: "vzdy" }, { "X-Owner-Token": fable.tok })).status === 200, "vlastník přepnul na „vždy“");
  const potvrzeno = await pockejNa(() => ukol(z1.data.task_id).zkouskaStav === "slozena");
  const t1 = ukol(z1.data.task_id);
  ok(potvrzeno && t1.uzavreno && t1.uzavreno.auto === true && /zastoupení/.test(t1.uzavreno.kdo) && t1.zastoupeni === true, "Fable potvrdil 4,4 za vlastníka", t1.uzavreno);
  ok(!cti().ratings.some(r => r.ukol === z1.data.task_id && r.byHuman), "potvrzení není lidská známka (ratings beze změny)");
  ok(cti().agents[T.id].skola.analysis.uroven === 1, "TradeRadar je v analysis ověřený");
  const pT = await posta(T);
  ok(pT.some(m => /potvrdil Fable \(zastoupení vlastníka\) — vlastník to ráno může vrátit/.test(m.text || "")), "žák ví, že potvrzoval Fable za vlastníka");
  const vypsano = await pockejNa(() => (cti().zastoupeni.akce || []).filter(a => a.typ === "vypsano").length >= 2);
  await pockej(3500);
  const db3 = cti(), vyp = db3.zastoupeni.akce.filter(a => a.typ === "vypsano");
  ok(vypsano && vyp.length === 2, "vypsal přesně 2 zkoušky za noc (ani po dalších kolech Sentinelu víc)", vyp.map(a => `${a.zak}:${a.lekce}`));
  const vypUkoly = vyp.map(a => db3.tasks.find(t => t.id === a.task));
  ok(vypUkoly.every(t => t && t.vypsal === "Fable (zastoupení vlastníka)" && db3.agents[t.drzitel].card.name !== "Fable"), "vypsáno serverovým agentům, ne Fablovi", vypUkoly.map(t => t && t.drzitelJmeno));
  ok(new Set(vypUkoly.map(t => t.drzitel)).size === vypUkoly.length, "každý agent nejvýš jednu rozdělanou zkoušku");
  ok(!vypUkoly.some(t => t.drzitel === lisak.id || t.drzitel === cizi.id), "cizím agentům nevypisuje");

  console.log("\n4) Co Fable nikdy");
  const podCtyrmi = await pockejNa(() => vypUkoly.every(t => { const x = ukol(t.id); return x.zkouskaStav === "hodnoceni" && x.znamky && x.znamky.fable; }), 9000);
  await pockej(3500);
  ok(podCtyrmi && vypUkoly.every(t => ukol(t.id).zkouskaStav === "hodnoceni"), "návrh 3,6 (pod 4) nepotvrdí — čeká na vlastníka", vypUkoly.map(t => ukol(t.id).zkouskaStav));
  await stopServer();
  { const db = cti(); const ted = new Date().toISOString(), za = new Date(Date.now() + 48 * 3600_000).toISOString();
    const vzor = { zkouska: true, drzitel: T.id, drzitelJmeno: "TradeRadar", zkouskaStav: "hodnoceni", stav: "hotovy", lhuta: za, t: ted, rubrika: ["a"], vysledek: "práce", skills: ["x"] };
    db.tasks.push({ ...vzor, id: "neshoda", dovednost: "trading", cilUroven: 1, lekce: "Neshoda", znamky: { fable: { znamka: 4.5 }, oponent: { znamka: 2.5, agentName: "Lisak" }, clovek: null } });
    db.tasks.push({ ...vzor, id: "osvedceny", dovednost: "analysis", cilUroven: 2, lekce: "Praxe", znamky: { fable: { znamka: 5 }, oponent: null, clovek: null } });
    db.tasks.push({ ...vzor, id: "shoda", dovednost: "research", cilUroven: 1, lekce: "Shoda", znamky: { fable: { znamka: 4.2 }, oponent: { znamka: 3.4, agentName: "Lisak" }, clovek: null } });
    zapis(db); }
  await startServer(OKNO);
  await pockejNa(() => ukol("shoda").zkouskaStav === "slozena");
  ok(ukol("shoda").zkouskaStav === "slozena", "shoda s oponentem do 1 bodu (4,2 vs 3,4) → potvrzeno");
  ok(ukol("neshoda").zkouskaStav === "hodnoceni", "neshoda s oponentem (4,5 vs 2,5) → čeká na vlastníka");
  ok(ukol("osvedceny").zkouskaStav === "hodnoceni", "osvědčený (návrh 5) → vždy podpis vlastníka");
  const gC2 = await get("/api/zastoupeni", { "X-Owner-Token": fable.tok });
  const proc = Object.fromEntries((gC2.data.ceka_na_tebe || []).map(c => [c.task, c.proc]));
  ok(/osvědčený/.test(proc.osvedceny || "") && /neshoda/.test(proc.neshoda || "") && vypUkoly.every(t => /pod 4/.test(proc[t.id] || "")), "„čeká na tebe“ říká proč", proc);

  console.log("\n5) Vrácení");
  const akce1 = cti().zastoupeni.akce.find(a => a.typ === "potvrzeno" && a.task === z1.data.task_id);
  const vC = await post("/api/zastoupeni/vratit", { akce: akce1.id }, { "X-Owner-Token": cizi.tok });
  ok(vC.status === 404, "cizí vlastník cizí potvrzení nevrátí", vC.data);
  const vV = await post("/api/zastoupeni/vratit", { akce: vyp[0].id }, { "X-Owner-Token": fable.tok });
  ok(vV.status === 400, "vypsání se nevrací (jen potvrzení)", vV.data);
  const v1 = await post("/api/zastoupeni/vratit", { akce: akce1.id }, { "X-Owner-Token": T.tok });
  ok(v1.status === 200 && v1.data.stav === "hodnoceni" && v1.data.uroven === "nováček", "vlastník vrátil: zpět do hodnocení, úroveň dolů na nováčka", v1.data);
  const tV = ukol(z1.data.task_id);
  ok(tV.lhuta === null && tV.zastoupeniVraceno === true && !tV.uzavreno, "lhůta zrušena — Sentinel ji po 48 h nezavře", { lhuta: tV.lhuta, vr: tV.zastoupeniVraceno });
  await pockej(3500);
  ok(ukol(z1.data.task_id).zkouskaStav === "hodnoceni", "Fable vrácenou zkoušku znovu nepotvrdil");
  ok((await post("/api/zastoupeni/vratit", { akce: akce1.id }, { "X-Owner-Token": fable.tok })).status === 400, "podruhé vrátit nejde");
  ok((await posta(T)).some(m => /vrátil potvrzení zkoušky/.test(m.text || "")), "žák ví, že vlastník potvrzení vrátil");
  const lid = await post(`/api/tasks/${z1.data.task_id}/hodnoceni`, { znamka: 4.6 }, { "X-Owner-Token": fable.tok });
  ok(lid.status === 200 && lid.data.stav === "slozena" && cti().ratings.some(r => r.ukol === z1.data.task_id && r.byHuman && r.rating === 4.6), "vlastník potvrdil sám (lidská známka 4,6)", lid.data);

  console.log("\n6) Ranní souhrn");
  const s1 = await post("/api/zastoupeni/souhrn", {}, { "X-Owner-Token": fable.tok });
  ok(s1.status === 200 && /Potvrdil jsem za tebe \(1\)/.test(s1.data.text) && /Vypsal jsem zkoušky \(2\)/.test(s1.data.text) && /Čeká na tebe/.test(s1.data.text), "souhrn na požádání (vrácené potvrzení se nepočítá)", s1.data.text);
  const souhrny = async () => cti().messages.filter(m => m.to === fable.id && /Noční zastoupení — souhrn/.test(m.text || "")).length;   /* schránka vrací jen nepřečtené */
  ok(await souhrny() === 1, "souhrn je ve schránce Fabla");
  await stopServer();
  await startServer({ ...OKNO, ZASTOUPENI_SOUHRN: String(prahaHodina()) });
  ok(await pockejNa(async () => await souhrny() === 2), "v nastavenou hodinu přijde souhrn sám");
  await pockej(4000);
  ok(await souhrny() === 2, "jen jednou za den, ne každé kolo Sentinelu");
  ok((await post("/api/zastoupeni", { rezim: "vypnuto" }, { "X-Owner-Token": fable.tok })).status === 200 && cti().zastoupeni.nastaveni.domaci.rezim === "vypnuto", "vlastník zastoupení vypnul");

  await stopServer(); atrapa.close();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  console.log(chyb ? `❌ ${chyb} z ${kroku} kroků selhalo` : `✅ ${kroku}/${kroku} kroků prošlo`);
  process.exit(chyb ? 1 : 0);
})().catch(async e => { console.error(e); await stopServer(); try { atrapa.close(); } catch {} process.exit(1); });
