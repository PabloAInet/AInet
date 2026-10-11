#!/usr/bin/env node
/**
 * AInet — škola 2 (11. 10. 2026): zkouška jako rozhovor, dvě úrovně, živý účet jen výslovně.
 *
 *   1. Zkoušku vypíše vlastník žáka nebo Fable (POST /api/skola/vypsat, MCP assign_exam); cizí ne.
 *   2. Zadání přijde žákovi jako zpráva od Fabla (škola); Obchodování 1 má pokaždé jiná čísla,
 *      klíč vidí jen hodnotitel.
 *   3. Serverový agent bez vlastních nástrojů (TradeRadar) zkoušku vypracuje vestavěným
 *      odpovídačem — i když zadání přišlo od domácího Fabla — s „otevřenými zápisky“ ze sandboxu;
 *      odpověď se rovnou odevzdá a Fable navrhne známku podle klíče. Fable na odevzdání neodpovídá.
 *   4. Lite agent odevzdá zprávou se značkou [zkouska:…]; obyčejný dotaz Fablovi odevzdáním není.
 *   5. Osvědčený = zkouška 2 + praxe (u obchodního agenta 20 dní stínu hlášených workerem).
 *      smi_papir od osvědčeného, smi_zivy jen s výslovným povolením vlastníka.
 *   6. Migrace: stará úroveň 3 → 2, staré tři lekce analysis → nové dvě.
 * Model nahrazuje atrapa Anthropic API na lokálním portu — bez sítě a bez klíčů.
 */
const { spawn } = require("child_process");
const http = require("http"); const fs = require("fs"); const os = require("os"); const path = require("path"); const net = require("net");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-skola2-"));
let server = null, BASE = "", kroku = 0, chyb = 0;
function ok(c, popis, detail) { kroku++; if (c) console.log(`  ✓ ${popis}`); else { chyb++; console.log(`  ✗ ${popis}${detail !== undefined ? "\n      " + JSON.stringify(detail).slice(0, 600) : ""}`); } }
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function get(c, h = {}) { const r = await fetch(BASE + c, { headers: { Accept: "application/json", ...h } }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function post(c, b, h = {}) { const r = await fetch(BASE + c, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function mcp(name, args = {}) { const r = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }); const t = r.data.result && r.data.result.content && r.data.result.content[0]; return t ? JSON.parse(t.text) : r.data; }
const pockej = (ms) => new Promise(r => setTimeout(r, ms));
async function pockejNa(fn, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await pockej(150); } return false; }

/* atrapa modelu: zkoušející dostane JSON se známkou, zkouška text práce, jinak krátká odpověď */
const volani = [];
let rozbitaZnamka = true;   /* první odpověď hodnotitele nečitelná → server musí zkusit znovu */
let zkouskaSelze = false;   /* výpadek modelu u zkoušky → zadání zůstane bez odpovědi */
const atrapa = http.createServer((rq, rs) => {
  let d = ""; rq.on("data", c => d += c);
  rq.on("end", () => {
    let t = {}; try { t = JSON.parse(d); } catch {}
    const sys = String(t.system || "");
    volani.push({ sys, max_tokens: t.max_tokens, user: JSON.stringify(t.messages || []), thinking: t.thinking || null });
    /* jako Opus 5.5: konverzace musí končit zprávou uživatele (žádný „prefill“) */
    const zpr = Array.isArray(t.messages) ? t.messages : [];
    if (zpr.length && zpr[zpr.length - 1].role === "assistant") {
      volani.push({ prefill: true });
      rs.writeHead(400, { "Content-Type": "application/json" });
      return rs.end(JSON.stringify({ error: { message: "This model does not support assistant message prefill. The conversation must end with a user message." } }));
    }
    /* jako Opus 5.5: „enabled“ přemýšlení odmítne, chce „adaptive“ */
    if (t.thinking && t.thinking.type === "enabled") {
      rs.writeHead(400, { "Content-Type": "application/json" });
      return rs.end(JSON.stringify({ error: { message: '"thinking.type.enabled" is not supported for this model. Use "thinking.type.adaptive" instead.' } }));
    }
    if (zkouskaSelze && /TOHLE JE ZKOUŠKA ŠKOLY/.test(sys)) { rs.writeHead(500, { "Content-Type": "application/json" }); return rs.end(JSON.stringify({ error: { message: "overloaded" } })); }
    let text = "Odpověď.";
    if (/Jsi zkoušející školy AInet/.test(sys)) {
      if (rozbitaZnamka) { rozbitaZnamka = false; text = 'Hodnotím podle rubriky: {"znamka": 4.4, "body": [4, 5'; }
      else text = JSON.stringify({ znamka: 4.4, body: [4, 5, 4, 4, 5], zduvodneni: "Výpočet sedí s klíčem.", zpetna_vazba: "Dobře spočítané." });
    }
    else if (/TOHLE JE ZKOUŠKA ŠKOLY/.test(sys)) text = "Alfa po nákladech = výnos − SPY − náklad; t po dnech = alfa / (sd/√dní), protože obchody téhož dne nejsou nezávislé. Verdikt podle kritéria. Při NEPROŠLO nová registrace, žádné ladění.";
    rs.writeHead(200, { "Content-Type": "application/json" });
    rs.end(JSON.stringify({ content: [{ type: "text", text }] }));
  });
});

async function startServer(soubor) {
  const port = await volnyPort(); BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: DIR, PUBLIC_URL: BASE, INDEXNOW: "0", KEEPALIVE_URL: "0", SEED_DOMACI: "1", PREHLED: "0", RADAR: "0",
    ANTHROPIC_API_KEY: "test", LLM_PROVIDER: "anthropic", LLM_API_URL: `http://127.0.0.1:${atrapa.address().port}/v1/messages` };
  delete env.OPENAI_API_KEY; delete env.LLM_MODEL; delete env.RADAR_NAME;
  server = spawn(process.execPath, [soubor || path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
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

(async () => {
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║  AInet — škola 2: zkouška jako rozhovor, dvě úrovně       ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  await new Promise(r => atrapa.listen(0, r));
  await startServer();
  const fable = await zalozLite("Fable", "orchestrace,research");
  const lisak = await zalozLite("Lisak", "chat,analysis");
  const cizi = await zalozLite("Cizi", "chat");
  const db0 = cti();
  const tr = Object.values(db0.agents).find(a => a.card.name === "TradeRadar");
  const T = { id: tr.id, tok: tr.ownerToken, name: "TradeRadar" };

  console.log("\n1) Kdo smí vypsat zkoušku");
  const zCizi = await post("/api/skola/vypsat", { agent: "TradeRadar", dovednost: "analysis" }, { "X-Owner-Token": cizi.tok });
  ok(zCizi.status === 403, "cizí agent zkoušku nevypíše", zCizi.data);
  /* TradeRadar si dá do sandboxu zápisky, ze kterých bude při zkoušce vycházet (zapisuje Fable — domácí) */
  const sb = await post("/api/agents/TradeRadar/sandbox", { nazev: "Zásady měření", text: "Alfa po nákladech = výnos minus SPY minus náklad. t po dnech, ne po obchodech. Kritérium zapsané předem.", stitky: ["zasady"] }, { "X-Owner-Token": fable.tok });
  ok(sb.status === 201, "Fable (domácí) uložil TradeRadarovi zápisky do sandboxu", sb.data);
  const mz = await post("/api/agents/TradeRadar/mozek", { model: "silny", usili: "vysoke", premysleni: true }, { "X-Owner-Token": fable.tok });
  ok(mz.status === 200, "TradeRadar má nejsilnější mozek s přemýšlením (jako v provozu)", mz.data);
  const z1 = await post("/api/skola/vypsat", { agent: "TradeRadar", dovednost: "analysis" }, { "X-Owner-Token": fable.tok });
  ok(z1.status === 201 && z1.data.cil_uroven === 1 && /Obchodování 1 — Kritérium a náklady/.test(z1.data.zkouska), "Fable vypsal TradeRadarovi Obchodování 1", z1.data);
  const zFin = await post("/api/skola/vypsat", { agent: "TradeRadar", dovednost: "finance" }, { "X-Owner-Token": fable.tok });
  ok(zFin.status === 201, "hned za ní druhá zkouška (finance) — jako když vlastník klikne dvakrát po sobě", zFin.data);
  ok(/DATA \(test strategie/.test(z1.data.zadani) && /KRITÉRIUM ZAPSANÉ PŘEDEM/.test(z1.data.zadani), "zadání nese vylosovaná data a kritérium");
  ok(!JSON.stringify(z1.data).includes("verdikt") && !JSON.stringify(z1.data).includes("KLÍČ"), "klíč se žákovi neukazuje");
  ok(z1.data.zprava_id && /^\[zkouska:[0-9a-f]{8}\]$/.test(z1.data.znacka), "zkouška má zprávu a značku", z1.data);
  const tGet = (await get(`/api/tasks/${z1.data.task_id}`)).data;
  ok(!("klic" in tGet), "GET /api/tasks/:id klíč nevrací");
  const z1b = await post("/api/skola/vypsat", { agent: lisak.id, dovednost: "analysis" }, { "X-Owner-Token": lisak.tok });
  const z1c = await mcp("assign_exam", { token: fable.tok, agent: "Lisak", skill: "analysis" });
  ok(z1b.status === 201 && z1c.error && z1c.task_id === z1b.data.task_id, "vlastník (Lisak sám) vypsal; MCP assign_exam druhou rozdělanou nevypíše", { z1b: z1b.data.ok, z1c });
  const z2a = await post("/api/skola/vypsat", { agent: "Lisak", dovednost: "analysis" }, { "X-Owner-Token": lisak.tok });
  ok(z2a.status === 400, "jedna rozdělaná zkouška na dovednost");

  console.log("\n2) Serverový agent (TradeRadar) zkoušku vypracuje odpovídačem");
  const odevzdano = await pockejNa(async () => (await get(`/api/tasks/${z1.data.task_id}`)).data.zkouskaStav === "hodnoceni");
  ok(odevzdano, "TradeRadar odpověděl na zadání a zkouška je v hodnocení (bez lidského zásahu)");
  const tH = (await get(`/api/tasks/${z1.data.task_id}`)).data;
  ok(/Alfa po nákladech/.test(tH.vysledek || ""), "odevzdaná práce je text odpovědi", tH.vysledek);
  const vZk = volani.find(v => /TOHLE JE ZKOUŠKA ŠKOLY/.test(v.sys));
  ok(vZk && /TVOJE ZÁPISKY/.test(vZk.sys) && /Zásady měření/.test(vZk.sys), "odpovídač dostal k zadání vlastní zápisky ze sandboxu");
  ok(vZk && vZk.max_tokens >= 2000, "na zkoušku delší odpověď (úsilí vysoké)", vZk && vZk.max_tokens);
  ok(volani.some(v => /TOHLE JE ZKOUŠKA ŠKOLY/.test(v.sys) && v.thinking && v.thinking.type === "adaptive"), "model, který chce adaptivní přemýšlení, ho dostal (žádný pád na slabší model)");
  ok(tH.oponent === "Lisak", "oponent je agent, který dovednost umí (Lisak), ne kdokoli", tH.oponent);
  const obe = await pockejNa(async () => (await get(`/api/tasks/${zFin.data.task_id}`)).data.zkouskaStav === "hodnoceni");
  ok(obe && !volani.some(v => v.prefill), "odpovídač vypracoval obě zkoušky po sobě (konverzace vždy končí zadáním, žádný „prefill“)");
  const znamkovano = await pockejNa(async () => { const t = cti().tasks.find(x => x.id === z1.data.task_id); return t && t.znamky && t.znamky.fable; });
  const tDb = cti().tasks.find(x => x.id === z1.data.task_id);
  ok(znamkovano && tDb.znamky.fable.znamka === 4.4, "Fable navrhl známku 4,4 (napoprvé nečitelná odpověď → druhý pokus)", tDb.znamky);
  const vHod = volani.filter(v => /Jsi zkoušející školy AInet/.test(v.sys));
  ok(vHod.length >= 2 && vHod.every(v => v.max_tokens >= 2000), "hodnotitel má delší odpověď (dřív 600 tokenů → uříznutý JSON)", vHod.map(v => v.max_tokens));
  const vZn = volani.find(v => /Jsi zkoušející školy AInet/.test(v.sys));
  ok(vZn && /KLÍČ PRO HODNOTITELE/.test(vZn.user), "hodnotitel dostal klíč k vylosovaným číslům");
  await pockej(600);
  const fPosta = await posta(fable);
  const odevzdavaci = fPosta.find(m => m.from === T.id || m.fromName === "TradeRadar");
  ok(odevzdavaci && !fPosta.some(m => m.fromName === "Fable" && m.toName === "TradeRadar" && m.odpoved_na === odevzdavaci.id), "Fable na odevzdání neodpověděl (odevzdání je vyřízené)");

  console.log("\n3) Lite agent odevzdá značkou; dotaz odevzdáním není");
  const lPosta = await posta(lisak);
  const zadani = lPosta.find(m => /ZKOUŠKA \[zkouska:/.test(m.text || ""));
  ok(zadani && zadani.fromName === "Fable (škola)", "Lisak má zadání od Fabla (škola) ve schránce", zadani && zadani.fromName);
  await post("/api/messages", { from: lisak.id, to: fable.id, text: "Mám dotaz k rubrice, co znamená bod 3?", visibility: "private" }, { "X-Owner-Token": lisak.tok });
  await pockej(300);
  ok((await get(`/api/tasks/${z1b.data.task_id}`)).data.zkouskaStav === "probiha", "obyčejný dotaz Fablovi zkoušku neodevzdal");
  await post("/api/messages", { from: lisak.id, to: fable.id, text: `${z1b.data.znacka} Alfa = 0,12 − 0,03 − 0,10 = −0,01 %; NEPROŠLO.`, visibility: "private" }, { "X-Owner-Token": lisak.tok });
  const tL = (await get(`/api/tasks/${z1b.data.task_id}`)).data;
  ok(tL.zkouskaStav === "hodnoceni" && /^Alfa = 0,12/.test(tL.vysledek), "zpráva se značkou = odevzdání (značka z textu práce odstraněna)", tL);
  const lPosta2 = await posta(lisak);
  ok(lPosta2.some(m => m.fromName === "Škola" && /odevzdána/.test(m.text)), "žák dostal potvrzení o odevzdání");

  console.log("\n4) Osvědčený = zkouška 2 + praxe; živý účet jen výslovně");
  const pot1 = await post(`/api/tasks/${z1.data.task_id}/hodnoceni`, { znamka: 4 }, { "X-Owner-Token": fable.tok });
  ok(pot1.status === 200 && pot1.data.uroven === 1, "vlastník (token domácího) potvrdil 4/5 → TradeRadar ověřený", pot1.data);
  const op1 = await post(`/api/tasks/${z1.data.task_id}/hodnoceni`, { znamka: 4.6, oprava: true }, { "X-Owner-Token": fable.tok });
  ok(op1.status === 200 && op1.data.opraveno && op1.data.puvodni === 4 && op1.data.znamka === 4.6, "vlastník přepsal svou známku 4 → 4,6 (desetinná)", op1.data);
  ok(cti().ratings.find(r => r.ukol === z1.data.task_id && r.byHuman).rating === 4.6, "lidské hodnocení v databázi je 4,6 (žádné druhé)");
  const op2 = await post(`/api/tasks/${z1.data.task_id}/hodnoceni`, { znamka: 3, oprava: true }, { "X-Owner-Token": fable.tok });
  ok(op2.status === 409, "oprava, která by otočila výsledek (složena → nesložena), neprojde", op2.data);
  ok((await post(`/api/tasks/${z1.data.task_id}/hodnoceni`, { znamka: 5, oprava: true }, { "X-Owner-Token": cizi.tok })).status === 403, "cizí známku neopraví");
  ok((await post(`/api/tasks/${z1.data.task_id}/hodnoceni`, { znamka: 5 }, { "X-Owner-Token": fable.tok })).status === 409, "bez „oprava“ uzavřenou zkoušku znovu nepotvrdí");
  const st0 = (await get("/api/radar/stav", { "X-Owner-Token": fable.tok })).data;
  ok(st0.smi_papir === false && st0.smi_zivy === false && st0.praxe_dny === 0, "ověřený: ani papír, ani živý účet", st0);
  const z2 = await post("/api/skola/vypsat", { agent: "TradeRadar", dovednost: "analysis" }, { "X-Owner-Token": fable.tok });
  ok(z2.status === 201 && z2.data.cil_uroven === 2 && /Obchodování 2 — Praxe/.test(z2.data.zkouska), "vypsáno Obchodování 2 — Praxe (cíl osvědčený)", z2.data);
  await pockejNa(async () => (await get(`/api/tasks/${z2.data.task_id}`)).data.zkouskaStav === "hodnoceni");
  const pot2 = await post(`/api/tasks/${z2.data.task_id}/hodnoceni`, { znamka: 4 }, { "X-Owner-Token": fable.tok });
  ok(pot2.status === 200 && pot2.data.uroven === 1 && (pot2.data.chybi_k_postupu || []).some(x => /20 obchodních dní/.test(x)), "zkouška 2 složena, ale bez praxe zůstává ověřený (chybí 20 dní stínu)", pot2.data);
  for (let i = 1; i <= 20; i++) await post("/api/radar/worker", { etapa: 1, smycka: "stin", zprava: "stín", praxe_den: `2026-10-${String(i).padStart(2, "0")}` }, { "X-Owner-Token": T.tok });
  await post("/api/radar/worker", { etapa: 1, smycka: "stin", praxe_den: "2026-10-01" }, { "X-Owner-Token": T.tok });   /* týž den podruhé */
  const st1 = (await get("/api/radar/stav", { "X-Owner-Token": fable.tok })).data;
  ok(st1.praxe_dny === 20 && st1.uroven_analysis === 2 && st1.uroven_nazev === "osvědčený", "20 dní praxe (bez duplicit) → osvědčený", st1);
  ok(st1.smi_papir === true && st1.smi_zivy === false, "osvědčený smí papír, živý účet ne (bez povolení vlastníka)", st1);
  const ziv = await post("/api/radar/zivy", { povolit: true }, { "X-Owner-Token": fable.tok });
  const st2 = (await get("/api/radar/stav", { "X-Owner-Token": fable.tok })).data;
  ok(ziv.status === 200 && st2.smi_zivy === true && st2.zivy_povolen === true, "po výslovném povolení vlastníka smi_zivy", st2);
  ok((await post("/api/radar/zivy", { povolit: true }, { "X-Owner-Token": lisak.tok })).status === 403, "cizí agent živý účet nepovolí");
  await post("/api/radar/zivy", { povolit: false }, { "X-Owner-Token": fable.tok });
  ok((await get("/api/radar/stav", { "X-Owner-Token": fable.tok })).data.smi_zivy === false, "zákaz platí hned");

  console.log("\n5) Zadání bez odpovědi (výpadek modelu) — Sentinel to zkusí znovu");
  zkouskaSelze = true;
  const zTr = await post("/api/skola/vypsat", { agent: "TradeRadar", dovednost: "trading" }, { "X-Owner-Token": fable.tok });
  await pockej(1500);
  ok(zTr.status === 201 && (await get(`/api/tasks/${zTr.data.task_id}`)).data.zkouskaStav === "probiha", "model u zkoušky selhal — zadání visí bez odpovědi", zTr.data);
  zkouskaSelze = false;
  await stopServer();
  {
    const db = cti(); const pred = new Date(Date.now() - 10 * 60_000).toISOString();
    const m = db.messages.find(x => x.zkouska === zTr.data.task_id); if (m) m.t = pred;
    zapis(db);
    const kod = fs.readFileSync(path.join(__dirname, "server.js"), "utf8").replace("5 * 60_000);", "1500);");
    fs.writeFileSync(path.join(DIR, "server-rychly.js"), kod);
    for (const mod of ["ordinace.js", "radar.js", "trh.js", "sandbox.js", "oauth.js", "klient-ip.js", "porady.js"]) fs.copyFileSync(path.join(__dirname, mod), path.join(DIR, mod));
  }
  await startServer(path.join(DIR, "server-rychly.js"));
  const dohnano = await pockejNa(async () => (await get(`/api/tasks/${zTr.data.task_id}`)).data.zkouskaStav === "hodnoceni", 9000);
  ok(dohnano, "po startu / Sentinelem odpovídač zadání vypracoval a odevzdal");
  const logy = (await get("/api/log")).data;
  ok(Array.isArray(logy), "server běží dál");
  await stopServer();
  await startServer();

  console.log("\n6) Migrace ze tří úrovní");
  await stopServer();
  {
    const db = cti();
    db.agents[lisak.id].skola = { analysis: { uroven: 3, od: new Date().toISOString() } };
    db.skola.kurikulum.analysis = [{ poradi: 1, cil_uroven: 1, nazev: "Obchodování 1 — Data", zadani: "x", rubrika: [] }, { poradi: 2, cil_uroven: 2, nazev: "Obchodování 2 — Vyhodnocení", zadani: "x", rubrika: [] }, { poradi: 3, cil_uroven: 3, nazev: "Obchodování 3 — Obhajoba postupu", zadani: "x", rubrika: [] }];
    db.tasks.push({ id: "stara-zkouska-3", zkouska: true, cilUroven: 3, dovednost: "analysis", drzitel: cizi.id, zkouskaStav: "slozena", znamky: {}, t: new Date().toISOString() });
    zapis(db);
  }
  {
    const db = cti(); const now = new Date().toISOString();
    db.ratings = db.ratings.filter(r => r.agent !== lisak.id);
    for (const [h, v] of [[true, 5], [true, 5], [false, 3.5], [false, 3.5]]) db.ratings.push({ id: "r" + Math.random(), agent: lisak.id, agentName: "Lisak", rating: v, byHuman: h, vaha: h ? 1 : 0.5, od: "Test", t: now });
    zapis(db);
  }
  await startServer();
  const vLis = (await get(`/api/agents/${lisak.id}/vysvedceni`)).data;
  ok(vLis.vysvedceni.analysis.zmrazeno === false, "lidé dávají víc než agenti (drift −1,5) → nezmrazí se", vLis.vysvedceni.analysis);
  await stopServer();
  {
    const db = cti(); const now = new Date().toISOString();
    db.ratings = db.ratings.filter(r => r.agent !== lisak.id);
    for (const [h, v] of [[true, 3], [true, 3], [false, 5], [false, 5]]) db.ratings.push({ id: "r" + Math.random(), agent: lisak.id, agentName: "Lisak", rating: v, byHuman: h, vaha: h ? 1 : 0.5, od: "Test", t: now });
    zapis(db);
  }
  await startServer();
  ok((await get(`/api/agents/${lisak.id}/vysvedceni`)).data.vysvedceni.analysis.zmrazeno === true, "agenti chválí víc než lidé (drift +2) → zmrazí se");
  const sk = (await get("/api/skola")).data;
  ok(sk.kurikulum.analysis.length === 2 && sk.kurikulum.analysis.every(l => l.cil_uroven <= 2) && /Kritérium a náklady/.test(sk.kurikulum.analysis[0].nazev), "staré tři lekce nahrazeny novými dvěma", sk.kurikulum.analysis.map(l => l.nazev));
  const db2 = cti();
  ok(db2.agents[lisak.id].skola.analysis.uroven === 2 && db2.tasks.find(t => t.id === "stara-zkouska-3").cilUroven === 2, "zapsaná úroveň 3 → 2 a cíl staré zkoušky 3 → 2");

  await stopServer(); atrapa.close();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  console.log(chyb ? `❌ ${chyb} z ${kroku} kroků selhalo` : `✅ ${kroku}/${kroku} kroků prošlo`);
  process.exit(chyb ? 1 : 0);
})().catch(async e => { console.error(e); await stopServer(); try { atrapa.close(); } catch {} process.exit(1); });
