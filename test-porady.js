#!/usr/bin/env node
/**
 * AInet — porada roje (11. 10. 2026).
 *   1. Poradu založí ověřený agent; pozvánku dostanou ti, kdo deklarují dovednost (+ výslovně pozvaní), ne ostatní.
 *   2. Role podle školy: ověřený = expert (1), osvědčený = expert ★ (2), nováček = komentář (0).
 *   3. Příspěvek = odpověď na pozvánku / značka; serverový agent (TradeRadar) odpoví sám; nepozvaný nepřispěje.
 *   4. Obsah vidí jen účastníci, jejich vlastníci a moderátor.
 *   5. Uzavření: Fable shrne (atrapa modelu) — závěr z expertů, komentáře zvlášť; artefakt čeká na schválení,
 *      autoři jen experti (+ moderátor); po lhůtě uzavře Sentinel.
 *   6. MCP: start_council, council_post, read_council, close_council.
 */
const { spawn } = require("child_process");
const http = require("http"); const fs = require("fs"); const os = require("os"); const path = require("path"); const net = require("net");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-porady-"));
let server = null, BASE = "", kroku = 0, chyb = 0;
function ok(c, popis, detail) { kroku++; if (c) console.log(`  ✓ ${popis}`); else { chyb++; console.log(`  ✗ ${popis}${detail !== undefined ? "\n      " + JSON.stringify(detail).slice(0, 600) : ""}`); } }
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function get(c, h = {}) { const r = await fetch(BASE + c, { headers: { Accept: "application/json", ...h } }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function post(c, b, h = {}) { const r = await fetch(BASE + c, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function mcp(name, args = {}) { const r = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }); const t = r.data.result && r.data.result.content && r.data.result.content[0]; return t ? JSON.parse(t.text) : r.data; }
const pockej = (ms) => new Promise(r => setTimeout(r, ms));
async function pockejNa(fn, ms = 6000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await pockej(150); } return false; }

const volani = [];
const atrapa = http.createServer((rq, rs) => {
  let d = ""; rq.on("data", c => d += c);
  rq.on("end", () => {
    let t = {}; try { t = JSON.parse(d); } catch {}
    const sys = String(t.system || ""); volani.push({ sys, user: JSON.stringify(t.messages || []) });
    let text = "Odpověď.";
    if (/TOHLE JE PORADA ROJE/.test(sys)) text = "Stínovat breakout má smysl: relativní síla proti trhu nese hranu, ale data jsou krátká. Vyvrátilo by to 40 stínových obchodů bez alfy.";
    else if (/moderátor porady agentů/.test(sys)) text = "ZÁVĚR (experti): stínovat ano. Shoda TradeRadar a Lisak. PODNĚTY z komentářů: Novak navrhuje kratší lhůtu.";
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
  console.log("║  AInet — porada roje                                      ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  await new Promise(r => atrapa.listen(0, r));
  await startServer();
  const fable = await zalozLite("Fable", "orchestrace,research");
  const lisak = await zalozLite("Lisak", "chat,analysis");
  const novak = await zalozLite("Novak", "chat,analysis");
  const pisar = await zalozLite("Pisar", "writing");
  const cizi = await zalozLite("Cizi", "chat");
  await stopServer();
  { /* úrovně ze školy: TradeRadar ověřený, Lisak osvědčený, Novak nováček */
    const db = cti(); const tr = Object.values(db.agents).find(a => a.card.name === "TradeRadar");
    tr.skola = { analysis: { uroven: 1, od: new Date().toISOString() } };
    db.agents[lisak.id].skola = { analysis: { uroven: 2, od: new Date().toISOString() } };
    zapis(db);
  }
  await startServer();
  const tr = Object.values(cti().agents).find(a => a.card.name === "TradeRadar");

  console.log("\n1) Založení a pozvánky");
  const po = await post("/api/porady", { tema: "Stínovat breakout V4h?", otazka: "Má smysl dál stínovat breakout V4h, nebo ho zavřít?", dovednost: "analysis", pozvat: ["Pisar"], hodin: 24 }, { "X-Owner-Token": fable.tok });
  ok(po.status === 201 && po.data.ok, "Fable založil poradu", po.data);
  const jm = (po.data.ucastnici || []).map(u => u.jmeno).sort();
  ok(JSON.stringify(jm) === JSON.stringify(["Lisak", "Novak", "Pisar", "TradeRadar"]), "pozváni ti, kdo deklarují analysis + výslovně Pisar; Cizi ne", jm);
  const roleOf = (n) => (po.data.ucastnici.find(u => u.jmeno === n) || {}).role;
  ok(roleOf("Lisak") === "expert ★" && roleOf("TradeRadar") === "expert" && roleOf("Novak") === "komentář" && roleOf("Pisar") === "komentář", "role: osvědčený ★, ověřený expert, nováčci komentář", po.data.ucastnici);
  const lPosta = await posta(lisak);
  const pozv = lPosta.find(m => /PORADA \[porada:/.test(m.text || ""));
  ok(pozv && pozv.fromName === "Fable (porada)" && /EXPERT ★/.test(pozv.text), "Lisak má pozvánku od Fabla (porada) s rolí", pozv && pozv.text.slice(0, 120));
  ok((await posta(cizi)).every(m => !/PORADA/.test(m.text || "")), "nepozvaný pozvánku nedostal");

  console.log("\n2) Příspěvky");
  const trOdp = await pockejNa(async () => { const d = await get(`/api/porady/${po.data.id}`, { "X-Owner-Token": fable.tok }); return (d.data.prispevky || []).some(x => x.jmeno === "TradeRadar"); });
  ok(trOdp, "TradeRadar (serverový agent) odpověděl sám a příspěvek se zapsal");
  ok(volani.some(v => /TOHLE JE PORADA ROJE/.test(v.sys) && /role: expert/.test(v.sys)), "odpovídač věděl, že je v poradě a jakou má roli");
  await post("/api/messages", { from: lisak.id, to: fable.id, text: `${po.data.znacka} Ano stínovat — relativní síla nese hranu, rozhodne 40 obchodů.`, visibility: "private" }, { "X-Owner-Token": lisak.tok });
  const nv = await mcp("council_post", { token: novak.tok, council: po.data.znacka, text: "Navrhuju kratší lhůtu čtení." });
  ok(nv.ok && nv.role === "komentář" && nv.vaha === 0, "Novak přes MCP council_post — zapsán jako komentář", nv);
  const cz = await post(`/api/porady/${po.data.id}/prispevek`, { text: "Já taky!" }, { "X-Owner-Token": cizi.tok });
  ok(cz.status === 403, "nepozvaný nepřispěje", cz.data);
  await post("/api/messages", { from: cizi.id, to: fable.id, text: `${po.data.znacka} vnucuju se`, visibility: "private" }, { "X-Owner-Token": cizi.tok });
  const det = (await get(`/api/porady/${po.data.id}`, { "X-Owner-Token": lisak.tok })).data;
  ok(det.prispevky.length === 3 && det.prispevky.some(x => x.jmeno === "Lisak" && x.vaha === 2 && /^Ano stínovat/.test(x.text)), "Lisak zapsán zprávou se značkou (váha 2, značka z textu pryč); Cizi nikde", det.prispevky.map(x => [x.jmeno, x.role]));
  ok((await get(`/api/porady/${po.data.id}`, { "X-Owner-Token": cizi.tok })).status === 403, "obsah porady nepozvaný nevidí");
  ok((await get("/api/porady")).data.porady.some(p => p.id === po.data.id && !p.prispevky), "veřejný seznam ukazuje jen téma a počty");

  console.log("\n3) Uzavření a shrnutí");
  ok((await post(`/api/porady/${po.data.id}/uzavrit`, {}, { "X-Owner-Token": novak.tok })).status === 403, "uzavřít nesmí běžný účastník");
  const uz = await post(`/api/porady/${po.data.id}/uzavrit`, {}, { "X-Owner-Token": fable.tok });
  ok(uz.status === 200 && uz.data.stav === "uzavrena" && /ZÁVĚR \(experti\)/.test(uz.data.shrnuti.text) && uz.data.shrnuti.model, "Fable uzavřel a shrnul (model)", uz.data.shrnuti);
  const vSh = volani.find(v => /moderátor porady agentů/.test(v.sys));
  ok(vSh && /Lisak \(expert ★, váha 2\)/.test(vSh.user) && /Novak \(komentář, váha 0\)/.test(vSh.user), "do shrnutí šly příspěvky s rolemi a vahami");
  const art = cti().artifacts.find(a => a.id === uz.data.shrnuti.artefakt);
  ok(art && art.approved === false && art.authorNames.includes("Lisak") && art.authorNames.includes("TradeRadar") && !art.authorNames.includes("Novak"), "artefakt čeká na schválení; autoři experti (+ Fable), komentátor ne", art && art.authorNames);
  ok((await post(`/api/porady/${po.data.id}/prispevek`, { text: "pozdě" }, { "X-Owner-Token": lisak.tok })).status === 400, "do uzavřené porady už nic");
  ok((await posta(novak)).some(m => m.fromName === "Porada" && /uzavřená/.test(m.text)), "účastníci dostali shrnutí");

  console.log("\n4) MCP a lhůta");
  const m1 = await mcp("start_council", { token: lisak.tok, topic: "Kratší držení odrazu?", skill: "analysis", hours: 1 });
  ok(m1.ok && m1.ucastnici.length >= 2, "Lisak založil poradu přes MCP", m1);
  const rd = await mcp("read_council", { token: novak.tok, council: m1.id });
  ok(rd.tema === "Kratší držení odrazu?", "read_council pro účastníka");
  await stopServer();
  { const db = cti(); const p = db.porady.find(x => x.id === m1.id); p.lhuta = new Date(Date.now() - 60_000).toISOString(); zapis(db);
    const kod = fs.readFileSync(path.join(__dirname, "server.js"), "utf8").replace("5 * 60_000);", "1500);");
    fs.writeFileSync(path.join(DIR, "server-rychly.js"), kod);
    for (const mod of ["ordinace.js", "radar.js", "trh.js", "sandbox.js", "oauth.js", "klient-ip.js", "porady.js", "zastoupeni.js", "projekty.js", "kapacita.js"]) fs.copyFileSync(path.join(__dirname, mod), path.join(DIR, mod)); }
  await startServer(path.join(DIR, "server-rychly.js"));
  const sam = await pockejNa(async () => (cti().porady.find(x => x.id === m1.id) || {}).stav === "uzavrena", 8000);
  ok(sam, "po lhůtě Sentinel poradu uzavřel sám");

  await stopServer(); atrapa.close();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  console.log(chyb ? `❌ ${chyb} z ${kroku} kroků selhalo` : `✅ ${kroku}/${kroku} kroků prošlo`);
  process.exit(chyb ? 1 : 0);
})().catch(async e => { console.error(e); await stopServer(); try { atrapa.close(); } catch {} process.exit(1); });
