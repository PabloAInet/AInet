#!/usr/bin/env node
/**
 * AInet — zkouška školy agentů.
 *
 * Co se tu ověřuje:
 *   1. Úroveň za dovednost: test dovednosti při registraci dává „ověřený“ (1).
 *   2. Žádost o zkoušku: vypíše se jako úkol s rubrikou, rezervovaný žákovi,
 *      jedna rozdělaná na dovednost, cíl = další úroveň.
 *   3. Odevzdání → hodnocení: oponent přidělen, posudek smí psát jen on,
 *      známku potvrdí jen vlastník žáka (nebo správce), lhůta běží.
 *   4. Složená zkouška sama nestačí — tovaryš chce 3 lidsky hodnocené úkoly
 *      a schválený artefakt; vysvědčení říká, co chybí; s důkazy úroveň roste.
 *   5. Sentinel: po lhůtě platí návrh jen pro úroveň 1; archivace snižuje
 *      úroveň o stupeň.
 *   6. MCP: request_exam a review_exam.
 *
 * Nepotřebuje síť ani klíče — spustí si vlastní server na volném portu.
 */

const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-skola-"));
const DB = path.join(DIR, "agents.json");
let server = null, BASE = "";
let kroku = 0, chyb = 0;

function ok(podminka, popis, detail) {
  kroku++;
  if (podminka) console.log(`  ✓ ${popis}`);
  else { chyb++; console.log(`  ✗ ${popis}${detail !== undefined ? "\n      " + JSON.stringify(detail).slice(0, 400) : ""}`); }
}
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function get(cesta, hlavicky = {}) { const r = await fetch(BASE + cesta, { headers: hlavicky }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function post(cesta, telo, hlavicky = {}) {
  const r = await fetch(BASE + cesta, { method: "POST", headers: { "Content-Type": "application/json", ...hlavicky }, body: JSON.stringify(telo) });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}
async function mcp(name, args = {}) {
  const r = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return r.data.result ? r.data.result.structuredContent : { error: r.data.error };
}

async function startServer(soubor) {
  const port = await volnyPort();
  BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: DIR, PUBLIC_URL: BASE, INDEXNOW: "0", KEEPALIVE_URL: "0" };
  delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY;   /* bez klíče = Fable neznámkuje, hodnotí lidé */
  server = spawn(process.execPath, [soubor || path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", d => process.stderr.write("[server] " + d));
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + "/healthz"); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server nenaběhl");
}
function stopServer() { return new Promise(r => { if (!server) return r(); server.on("exit", () => { server = null; r(); }); server.kill(); }); }
const cti = () => JSON.parse(fs.readFileSync(DB, "utf8"));
const zapis = (db) => fs.writeFileSync(DB, JSON.stringify(db, null, 2));

function resSkill(t) {
  if (t.type === "stat") { const n = t.input.numbers; return Math.round(n.reduce((a, b) => a + b, 0) / n.length * 100) / 100; }
  if (t.type === "json-map") return t.input.items.reduce((a, b) => (b.value > a.value ? b : a)).id;
  if (t.type === "calc-return") return Math.round((t.input.sell - t.input.buy) / t.input.buy * 100 * 100) / 100;
  if (t.type === "write-constraint") { const z = ["Sit", t.input.mustInclude, "spojuje", "chytre", "agenty", "kteri", "spolu", "tvori", "hodnotne", "vysledky", "denne"]; return z.slice(0, t.input.words).join(" "); }
  if (t.type === "priority-sort") return [...t.input.tasks].sort((a, b) => b.priority - a.priority).map(x => x.name);
  return null;
}
async function zaloz(name, skills, bezTestu) {
  const kp = crypto.generateKeyPairSync("ed25519");
  const pem = kp.publicKey.export({ type: "spki", format: "pem" });
  const sign = (o) => crypto.sign(null, Buffer.from(JSON.stringify(o)), kp.privateKey).toString("base64");
  const card = { name, owner: "Test", skills, protocols: ["REST"] };
  const r = await post("/api/register", { card, publicKey: pem, signature: sign(card) });
  if (r.status !== 201 && r.status !== 200) throw new Error(`registrace ${name}: ${JSON.stringify(r.data)}`);
  const a = [r.data.challenge[0].input.reduce((x, y) => x + y, 0), r.data.challenge[1].input.split("").reverse().join(""), r.data.challenge[2].input];
  const sa = {}; if (!bezTestu) for (const t of (r.data.skillChallenge || [])) sa[t.skill] = resSkill(t);
  const v = await post(`/api/agents/${r.data.id}/verify`, { answers: a, skillAnswers: sa, signature: sign({ answers: a, skillAnswers: sa }) });
  if (v.data.status !== "verified") throw new Error(`ověření ${name}: ${JSON.stringify(v.data)}`);
  return { id: r.data.id, tok: r.data.ownerToken, card };
}

(async () => {
  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║  AInet — škola agentů                                     ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  await startServer();

  console.log("\n1) Úroveň za dovednost");
  const alfa = await zaloz("Alfa", ["analysis", "writing"]);
  const beta = await zaloz("Beta", ["analysis"]);
  const gama = await zaloz("Gama", ["analysis"]);
  const delta = await zaloz("Delta", ["marketing"], true);     /* bez testu dovednosti → nováček */
  const prehled = (await get("/api/skola")).data;
  const uA = prehled.agenti.find(a => a.jmeno === "Alfa").dovednosti;
  ok(uA.analysis && uA.analysis.uroven === 1, "Alfa je po testu dovednosti v analysis „ověřený“ (1)", uA);
  ok(prehled.agenti.find(a => a.jmeno === "Delta").dovednosti.marketing.uroven === 0, "Delta bez testu je v marketingu nováček (0)");
  ok(prehled.kurikulum.analysis && prehled.kurikulum.analysis.length === 3, "kurikulum analysis má tři lekce (Obchodování 1–3)", prehled.kurikulum);
  ok(prehled.lhuta_h === 48, "lhůta na lidskou známku je 48 h", prehled.lhuta_h);
  const kur = (await get("/api/skola/analysis")).data;
  ok(/Obchodování 2/.test(kur.lekce[1].nazev) && Array.isArray(kur.lekce[1].rubrika), "GET /api/skola/analysis vrací lekce s rubrikou");

  console.log("\n2) Žádost o zkoušku");
  const z = await post("/api/skola/zkouska", { dovednost: "analysis" }, { "X-Owner-Token": alfa.tok });
  ok(z.status === 201 && z.data.ok, "Alfa dostala zkoušku", z.data);
  ok(z.data.cil_uroven === 2 && /Obchodování 2/.test(z.data.zkouska), "cíl je tovaryš a zadání je Obchodování 2 — Vyhodnocení", z.data);
  ok(Array.isArray(z.data.rubrika) && z.data.rubrika.length === 5, "zkouška nese rubriku o pěti bodech");
  const t = (await get(`/api/tasks/${z.data.task_id}`)).data;
  ok(t.zkouska === true && t.stav === "rezervovan" && t.drzitel === "Alfa" && t.zkouskaStav === "probiha", "zkouška je úkol rezervovaný žákovi", t);
  const dup = await post("/api/skola/zkouska", { dovednost: "analysis" }, { "X-Owner-Token": alfa.tok });
  ok(dup.status === 400 && dup.data.task_id === z.data.task_id, "druhou zkoušku z téže dovednosti nevypíše, vrátí tu rozdělanou", dup.data);
  const cizi = await post("/api/skola/zkouska", { dovednost: "coding" }, { "X-Owner-Token": alfa.tok });
  ok(cizi.status === 400, "dovednost, kterou nemá v kartě, zkoušet nejde", cizi.data);
  const bezTok = await post("/api/skola/zkouska", { dovednost: "analysis" });
  ok(bezTok.status === 403, "bez tokenu zkoušku nedostane");

  console.log("\n3) Odevzdání, posudek, lidská známka");
  const od = await post(`/api/work/${z.data.task_id}/submit`, { vysledek: "Po dnech: 15 dní, průměr +0,03 %, medián +0,46 %; bez 3. 8. +0,03 %; SPY nad nulou 7 dní: +0,92 % průměr, medián −0,03 %." }, { "X-Owner-Token": alfa.tok });
  ok(od.status === 200 && od.data.zkouska === "hodnoceni", "po odevzdání je zkouška ve stavu hodnocení", od.data);
  ok(["Beta", "Gama"].includes(od.data.oponent), "oponent byl přidělen z ostatních ověřených (Beta/Gama)", od.data.oponent);
  ok(typeof od.data.lhuta === "string" && new Date(od.data.lhuta) > new Date(), "lhůta na lidskou známku běží", od.data.lhuta);
  const opTok = od.data.oponent === "Beta" ? beta.tok : gama.tok, neTok = od.data.oponent === "Beta" ? gama.tok : beta.tok;
  const opInbox = (await get("/api/messages?agent=" + (od.data.oponent === "Beta" ? beta.id : gama.id), { "X-Owner-Token": opTok })).data;
  ok(Array.isArray(opInbox) && opInbox.some(m => m.fromName === "Škola" && /Posudek/.test(m.text)), "oponent dostal výzvu k posudku do schránky");
  const cizíPos = await post(`/api/tasks/${z.data.task_id}/posudek`, { znamka: 5, posudek: "x" }, { "X-Owner-Token": neTok });
  ok(cizíPos.status === 403, "posudek smí psát jen přidělený oponent");
  const pos = await post(`/api/tasks/${z.data.task_id}/posudek`, { znamka: 4, posudek: "Po dnech správně, chybí rozptyl." }, { "X-Owner-Token": opTok });
  ok(pos.status === 200 && pos.data.ok, "oponent odevzdal posudek 4/5", pos.data);
  const cizíZn = await post(`/api/tasks/${z.data.task_id}/hodnoceni`, { znamka: 5 }, { "X-Owner-Token": beta.tok });
  ok(cizíZn.status === 403, "známku nepotvrdí cizí vlastník");
  const zn = await post(`/api/tasks/${z.data.task_id}/hodnoceni`, { znamka: 4, komentar: "Souhlasím s oponentem." }, { "X-Owner-Token": alfa.tok });
  ok(zn.status === 200 && zn.data.stav === "slozena", "vlastník žáka známku potvrdil — zkouška složena", zn.data);
  ok(zn.data.uroven === 1, "úroveň zůstává 1: zkouška sama na tovaryše nestačí", zn.data);
  ok(zn.data.chybi_k_postupu.some(x => /úkol/.test(x)) && zn.data.chybi_k_postupu.some(x => /artefakt/.test(x)), "odpověď říká, co chybí (úkoly hodnocené lidmi, artefakt)", zn.data.chybi_k_postupu);
  const v1 = (await get(`/api/agents/${alfa.id}/vysvedceni`)).data;
  ok(v1.vysvedceni.analysis.dukazy.slozene_zkousky.includes(2) && v1.vysvedceni.analysis.dukazy.hodnocene_ukoly === 1, "vysvědčení eviduje složenou zkoušku a jeden lidsky hodnocený úkol", v1.vysvedceni.analysis.dukazy);
  const zakInbox = (await get("/api/messages?agent=" + alfa.id, { "X-Owner-Token": alfa.tok })).data;
  ok(zakInbox.some(m => m.fromName === "Škola" && /složena/.test(m.text)), "žák dostal zprávu o složené zkoušce");

  console.log("\n4) S důkazy úroveň roste");
  await stopServer();
  {
    const db = cti();
    const now = new Date().toISOString();
    for (let i = 0; i < 2; i++) db.ratings.push({ id: crypto.randomUUID(), agent: alfa.id, agentName: "Alfa", rating: 4.5, byHuman: true, vaha: 1, od: "Test", ukol: "ukol-" + i, dovednost: "analysis", t: now });
    db.artifacts.push({ id: crypto.randomUUID(), authors: [alfa.id], authorNames: ["Alfa"], title: "Postup po dnech", description: "…", approved: true, uses: 0, t: now });
    zapis(db);
  }
  await startServer();
  const v2 = (await get(`/api/agents/${alfa.id}/vysvedceni`)).data;
  ok(v2.vysvedceni.analysis.uroven === 2 && v2.vysvedceni.analysis.nazev === "tovaryš", "se 3 hodnocenými úkoly a artefaktem je Alfa tovaryš", v2.vysvedceni.analysis);
  ok(v2.vysvedceni.analysis.prava.some(p => /oponent/.test(p)), "tovaryš má právo být oponentem", v2.vysvedceni.analysis.prava);
  ok(v2.vysvedceni.analysis.chybi_k_postupu.some(x => /zkoušku na úroveň 3/.test(x)), "na mistra teď chybí zkouška na úroveň 3", v2.vysvedceni.analysis.chybi_k_postupu);

  console.log("\n5) MCP: request_exam a review_exam");
  const mz = await mcp("request_exam", { token: gama.tok, skill: "analysis" });
  ok(mz && mz.ok && mz.cil_uroven === 2, "Gama si řekla o zkoušku přes MCP", mz);
  const mOd = await mcp("submit_work", { token: gama.tok, task_id: mz.task_id, result: "Vyhodnocení po dnech…" });
  ok(mOd && mOd.zkouska === "hodnoceni" && mOd.oponent, "odevzdání přes MCP spustilo hodnocení a přidělilo oponenta", mOd);
  const opG = mOd.oponent === "Alfa" ? alfa.tok : mOd.oponent === "Beta" ? beta.tok : delta.tok;
  const mr = await mcp("review_exam", { token: opG, task_id: mz.task_id, grade: 4, review: "Ujde." });
  ok(mr && mr.ok && mr.znamka === 4, "oponent poslal posudek přes MCP", mr);

  console.log("\n6) Sentinel: lhůta a archivace");
  const dz = await post("/api/skola/zkouska", { dovednost: "marketing" }, { "X-Owner-Token": delta.tok });
  ok(dz.status === 201 && dz.data.cil_uroven === 1 && /marketing/.test(dz.data.zkouska), "Delta bez kurikula dostala obecnou zkoušku na úroveň 1", dz.data);
  const dOd = await post(`/api/work/${dz.data.task_id}/submit`, { vysledek: "Vstup, kroky, výstup, kontrola." }, { "X-Owner-Token": delta.tok });
  ok(dOd.status === 200, "Delta odevzdala");
  await stopServer();
  {
    const db = cti();
    const tD = db.tasks.find(x => x.id === dz.data.task_id);
    tD.znamky.oponent = { agent: "x", agentName: "Oponent", znamka: 4.5, posudek: "ok", t: new Date().toISOString() };
    tD.lhuta = new Date(Date.now() - 3600_000).toISOString();                 /* lhůta uplynula */
    const tG = db.tasks.find(x => x.id === mz.task_id);
    tG.lhuta = new Date(Date.now() - 3600_000).toISOString();                 /* cíl 2 — bez člověka neprojde */
    const kdy = new Date(Date.now() - 40 * 86400_000).toISOString();         /* Alfa 40 dní ticho → archiv */
    const aA = db.agents[alfa.id]; aA.lastSeen = kdy; aA.verifiedAt = kdy; aA.registered = kdy;
    db.messages = db.messages.filter(m => m.from !== alfa.id && m.to !== alfa.id);
    db.ratings = db.ratings.map(r => r.agent === alfa.id ? { ...r, t: kdy } : r);
    zapis(db);
    /* Sentinel běží každých 5 minut — pro test kopie serveru s intervalem 1,5 s */
    const kod = fs.readFileSync(path.join(__dirname, "server.js"), "utf8").replace("5 * 60_000);", "1500);");
    fs.writeFileSync(path.join(DIR, "server-rychly.js"), kod);
  }
  await startServer(path.join(DIR, "server-rychly.js"));
  await new Promise(r => setTimeout(r, 2500));
  const tD2 = (await get(`/api/tasks/${dz.data.task_id}`)).data;
  ok(tD2.zkouskaStav === "slozena" && tD2.uzavreno && tD2.uzavreno.auto === true, "úroveň 1: po lhůtě platí návrh bez člověka (zkouška složena automaticky)", tD2);
  const vD = (await get(`/api/agents/${delta.id}/vysvedceni`)).data;
  ok(vD.vysvedceni.marketing.uroven === 1, "Delta je v marketingu ověřená (1)", vD.vysvedceni.marketing);
  const tG2 = (await get(`/api/tasks/${mz.task_id}`)).data;
  ok(tG2.zkouskaStav === "hodnoceni", "cíl tovaryš: po lhůtě zkouška dál čeká na lidský podpis", tG2.zkouskaStav);
  const sent = (await get("/api/sentinel")).data;
  ok((sent.nalezy || []).some(n => n.typ === "čeká_na_známku"), "Sentinel to hlásí jako nález čeká_na_známku", sent.nalezy);
  const vA = (await get(`/api/agents/${alfa.id}/vysvedceni`)).data;
  ok(vA.vysvedceni.analysis.uroven === 1, "archivace po 40 dnech ticha snížila Alfu z tovaryše na ověřeného", vA.vysvedceni.analysis);
  const katA = (await get("/api/agents?vse=1")).data.find(a => a.name === "Alfa");
  ok(katA && katA.archived === true, "Alfa je v archivu (jméno i klíč rezervované)", katA && katA.archived);

  await stopServer();
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${chyb ? "❌" : "✅"} ${kroku - chyb}/${kroku} kroků prošlo\n`);
  process.exit(chyb ? 1 : 0);
})().catch(async (e) => {
  console.error("\n💥 " + e.message);
  await stopServer();
  process.exit(1);
});
