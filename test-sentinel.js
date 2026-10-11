#!/usr/bin/env node
/**
 * AInet — zkouška pojistky Sentinelu proti nekonečné smyčce.
 *
 *   1. Tempo: dva agenti si posílají zprávy strojovým tempem → po 10 zprávách za
 *      2 minuty se pár pozastaví, 11. zpráva neprojde (všemi cestami: API, MCP, lite).
 *   2. Zacyklení: agent pošle potřetí po sobě tutéž zprávu → pauza.
 *   3. Pozastavený pár nepustí žádnou zprávu; jiné páry žijí dál.
 *   4. /api/sentinel ukáže pozastavené páry; checkpoint vlastníka pauzu zruší,
 *      správce (ADMIN_TOKEN) smí pustit kterýkoli pár.
 *   5. Bez člověka: víc než SENTINEL_STOP zpráv za 24 h bez checkpointu → pauza.
 *   6. Vestavěný odpovídač (Fable s atrapou modelu) v pozastaveném páru mlčí
 *      a po checkpointu odpovídá znovu (počítá od checkpointu, ne od začátku věků).
 *   7. Výjimky: návštěvník ani most s pacienty ([FB:psid]) se nebrzdí.
 */
const { spawn } = require("child_process");
const fs = require("fs"); const os = require("os"); const path = require("path"); const net = require("net"); const http = require("http");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-sentinel-"));
let server = null, BASE = "", kroku = 0, chyb = 0;
function ok(c, popis, detail) { kroku++; if (c) console.log(`  ✓ ${popis}`); else { chyb++; console.log(`  ✗ ${popis}${detail !== undefined ? "\n      " + JSON.stringify(detail).slice(0, 500) : ""}`); } }
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function get(c, h = {}) { const r = await fetch(BASE + c, { headers: { Accept: "application/json", ...h } }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function post(c, b, h = {}) { const r = await fetch(BASE + c, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function mcp(name, args = {}) { const r = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }); return r.data.result ? r.data.result.structuredContent : { error: r.data.error }; }
const pockej = (ms) => new Promise(r => setTimeout(r, ms));

/* atrapa modelu (OpenAI-kompatibilní) — Fable odpovídá pořád stejně, ať je co brzdit */
let volaniModelu = 0;
const atrapa = http.createServer((req, res) => {
  let d = ""; req.on("data", c => d += c);
  req.on("end", () => { volaniModelu++; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ choices: [{ message: { content: "Díky za zprávu, rád pomůžu." } }] })); });
});

async function startServer(envNavic = {}) {
  const port = await volnyPort(); BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: DIR, PUBLIC_URL: BASE, INDEXNOW: "0", KEEPALIVE_URL: "0", SEED_DOMACI: "0", PREHLED: "0", RADAR: "0",
    ADMIN_TOKEN: "spravce-test", OPENAI_API_KEY: "test", LLM_PROVIDER: "openai", LLM_API_URL: `http://127.0.0.1:${atrapa.address().port}/v1/chat/completions`, ...envNavic };
  delete env.ANTHROPIC_API_KEY;
  server = spawn(process.execPath, [path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", d => process.stderr.write("[server] " + d));
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "/healthz")).ok) return; } catch {} await pockej(100); }
  throw new Error("server nenaběhl");
}
function stopServer() { return new Promise(r => { if (!server) return r(); server.on("exit", () => { server = null; r(); }); server.kill(); }); }
async function zalozLite(name, skills = "chat") {
  const r = await get(`/api/lite/register?name=${encodeURIComponent(name)}&owner=Test&skills=${skills}`);
  const u = r.data.ukol; const a1 = u["1_soucet"].match(/\d+/g).map(Number).reduce((x, y) => x + y, 0);
  const a2 = u["2_otoc"].replace("Napiš pozpátku: ", "").split("").reverse().join(""); const a3 = u["3_opis"].replace("Opiš přesně: ", "");
  const v = await get(`/api/lite/verify?token=${r.data.token}&a1=${a1}&a2=${encodeURIComponent(a2)}&a3=${encodeURIComponent(a3)}`);
  if (v.data.stav !== "verified") throw new Error(`lite ověření ${name}: ${JSON.stringify(v.data)}`);
  return { id: r.data.id, tok: r.data.token, name };
}
const posli = (od, komu, text) => post("/api/messages", { from: od.id, to: komu.id, text, visibility: "private" }, { "X-Owner-Token": od.tok });

(async () => {
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║  AInet — Sentinel: pojistka proti nekonečné smyčce        ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  await new Promise(r => atrapa.listen(0, r));
  await startServer();
  const A = await zalozLite("Ping"), B = await zalozLite("Pong"), C = await zalozLite("Ozvena"), D = await zalozLite("Stena"), F = await zalozLite("Fable", "orchestrace");

  console.log("\n1) Tempo: Ping ↔ Pong si píšou strojově");
  let posledni = null;
  for (let i = 1; i <= 10; i++) {
    posledni = await (i % 2 ? posli(A, B, `zpráva ${i} od Pinga`) : posli(B, A, `odpověď ${i} od Ponga`));
    if (posledni.status !== 201) break;
  }
  ok(posledni.status === 201, "10 zpráv za pár vteřin ještě projde", posledni);
  const jedenacta = await posli(B, A, "odpověď 11 od Ponga");
  ok(jedenacta.status === 409 && jedenacta.data.sentinel === true && jedenacta.data.typ === "tempo" && /11 zpráv za 2 minuty/.test(jedenacta.data.duvod), "11. zpráva za 2 minuty → 409, Sentinel pár pozastavil (tempo)", jedenacta.data);
  const dalsi = await posli(A, B, "ještě něco");
  ok(dalsi.status === 409 && /pozastavená/.test(dalsi.data.error) && dalsi.data.jak_pokracovat, "pozastavený pár nepustí ani druhou stranu — s návodem, jak pokračovat", dalsi.data);
  const mcpZprava = await mcp("send_message", { token: A.tok, to: "Pong", text: "zkusím to přes MCP" });
  ok(mcpZprava && mcpZprava.sentinel === true && !mcpZprava.odeslano, "ani přes MCP send_message", mcpZprava);
  const lite = await get(`/api/lite/send?token=${A.tok}&to=Pong&text=${encodeURIComponent("a přes lite?")}`);
  ok(lite.status === 409 && lite.data.sentinel === true, "ani přes lite /api/lite/send", lite);
  const cesta = await get(`/napis/${A.tok}/Pong/${encodeURIComponent("a cestou bez otazníku")}`);
  ok(cesta.status === 409 && cesta.data.sentinel === true, "ani cestou bez otazníku /napis/…", cesta);
  const inboxA = (await get(`/api/messages?agent=${A.id}`, { "X-Owner-Token": A.tok })).data;
  ok(inboxA.some(m => m.from === "system" && m.fromName === "Sentinel" && /pozastavil konverzaci (Ping ↔ Pong|Pong ↔ Ping)/.test(m.text)), "oba agenti dostali od Sentinelu vysvětlení", inboxA.slice(-2));
  const jinyPar = await posli(A, C, "ahoj Ozveno, jiná konverzace");
  ok(jinyPar.status === 201, "jiný pár (Ping → Ozvena) žije dál");

  console.log("\n2) Zacyklení: Ozvena posílá Stěně pořád totéž");
  const z1 = await posli(C, D, "Potvrzuji přijetí. Čekám na další instrukce.");
  const z2 = await posli(C, D, "potvrzuji  přijetí.   Čekám na další instrukce.");
  const z3 = await posli(C, D, "Potvrzuji přijetí. Čekám na další instrukce.");
  ok(z1.status === 201 && z2.status === 201, "dvakrát totéž ještě projde (i s jinými mezerami a velikostí písmen)");
  ok(z3.status === 409 && z3.data.typ === "zacyklení", "potřetí totéž → 409 a pauza (zacyklení)", z3.data);

  console.log("\n3) Přehled a puštění dál");
  const st = (await get("/api/sentinel")).data;
  const pary = (st.pozastaveno || []).map(p => `${p.aJmeno} ↔ ${p.bJmeno}`).sort();
  ok(pary.length === 2 && pary.includes("Ozvena ↔ Stena") && pary.includes("Pong ↔ Ping"), "/api/sentinel ukazuje 2 pozastavené páry", pary);
  ok(st.pojistka && st.pojistka.za2min === 10 && st.pojistka.stop24h === 20 && /POJISTKA/.test(st.pravidla[0]), "…i pravidla pojistky (10 za 2 min, 20 za 24 h)", st.pojistka);
  ok((st.nalezy || []).filter(n => n.typ === "pozastaveno").length === 2, "pauzy jsou mezi nálezy Sentinelu");
  const cizi = await post("/api/checkpoint", { partner: B.id, token: C.tok });
  const cpA = await post("/api/checkpoint", { partner: B.id, token: A.tok, note: "viděl jsem, pokračujte" });
  ok(cpA.status === 200 && cpA.data.uvolneno.length === 1 && cpA.data.uvolneno[0] === "Ping ↔ Pong", "vlastník Pinga pustil pár dál (checkpoint)", cpA.data);
  const poCp = await posli(A, B, "díky, pokračujeme");
  ok(poCp.status === 201, "po checkpointu zprávy zase projdou");
  ok(cizi.status === 200 && !(cizi.data.uvolneno || []).length, "checkpoint vlastníka jiného agenta cizí pauzu nezruší", cizi.data);
  const spravceBez = await post("/api/checkpoint", { par: [C.id, D.id].sort().join("|") });
  ok(spravceBez.status === 403, "bez tokenu správce pár nikdo nepustí");
  const spravce = await post("/api/checkpoint", { par: [C.id, D.id].sort().join("|"), note: "zkouška" }, { "X-Admin-Token": "spravce-test" });
  ok(spravce.status === 200 && spravce.data.uvolneno[0] === "Ozvena ↔ Stena", "správce sítě (ADMIN_TOKEN) pustil dál pár Ozvena ↔ Stena", spravce.data);
  ok(((await get("/api/sentinel")).data.pozastaveno || []).length === 0, "nic už není pozastavené");

  console.log("\n4) Vestavěný odpovídač (Fable) v pozastaveném páru mlčí");
  const prvni = await posli(D, F, "Ahoj Fable, co umíš?");
  let odp = []; for (let i = 0; i < 30 && odp.length < 1; i++) { await pockej(100); odp = (await get(`/api/messages?agent=${D.id}`, { "X-Owner-Token": D.tok })).data.filter(m => m.from === F.id); }
  ok(prvni.status === 201 && odp.length === 1, "Fable odpověděl (atrapa modelu)", { s: prvni.status, n: odp.length });
  await posli(D, F, "Ahoj Fable, co umíš?");
  const treti = await posli(D, F, "Ahoj Fable, co umíš?");
  ok(treti.status === 409 && treti.data.typ === "zacyklení", "Stena se ptá potřetí totéž → pauza", treti.data);
  await pockej(1200);
  const poPauze = (await get(`/api/messages?agent=${D.id}`, { "X-Owner-Token": D.tok })).data.filter(m => m.from === F.id && Date.parse(m.t) > Date.parse(treti.data.pozastaveno));
  ok(poPauze.length === 0, "po pauze Fable do pozastaveného páru nic nenapsal", poPauze.map(m => m.text));
  const pred = volaniModelu;
  await post("/api/checkpoint", { partner: F.id, token: D.tok });
  const novy = await posli(D, F, "Díky za trpělivost, mám novou otázku.");
  let poCheckpointu = []; for (let i = 0; i < 30 && !poCheckpointu.length; i++) { await pockej(100); poCheckpointu = (await get(`/api/messages?agent=${D.id}`, { "X-Owner-Token": D.tok })).data.filter(m => m.from === F.id && m.inReplyTo === novy.data.id); }
  ok(novy.status === 201 && poCheckpointu.length === 1 && volaniModelu > pred, "po checkpointu Fable odpovídá znovu", { s: novy.status, n: poCheckpointu.length });

  console.log("\n5) Bez člověka: víc než SENTINEL_STOP zpráv za 24 h (pomalé tempo)");
  await stopServer();
  await startServer({ SENTINEL_STOP: "6", SENTINEL_RYCHLE: "100" });
  const E = await zalozLite("Pomalak"), G = await zalozLite("Trpelivec");
  let r6 = null;
  for (let i = 1; i <= 6; i++) { r6 = await (i % 2 ? posli(E, G, `pomalá zpráva ${i}`) : posli(G, E, `pomalá odpověď ${i}`)); }
  const r7 = await posli(E, G, "pomalá zpráva 7");
  ok(r6.status === 201 && r7.status === 409 && r7.data.typ === "bez_checkpointu" && /7 zpráv za 24 h bez checkpointu/.test(r7.data.duvod), "7. zpráva za 24 h bez checkpointu (strop 6) → pauza", r7.data);
  const jedno = await zalozLite("Monolog");
  let mono = null; for (let i = 1; i <= 8; i++) mono = await posli(jedno, E, `oznámení č. ${i}`);
  ok(mono.status === 201, "jednosměrná oznámení (druhá strana nepíše) se jako smyčka nepočítají", mono.data);

  console.log("\n6) Výjimky: návštěvník");
  const nav = (await get("/navsteva")).data;
  const pass = nav.propustka;
  const stavy = [];
  for (let i = 1; i <= 12; i++) { const r = await get(`/zeptat?propustka=${encodeURIComponent(pass)}&to=Pomalak&text=${encodeURIComponent("Stejný dotaz návštěvníka")}`); stavy.push(r.status); }
  ok(pass && stavy.every(x => x < 400), "12 stejných dotazů návštěvníka (člověk v chatu) Sentinel nebrzdí", { pass: !!pass, stavy });
  const most = await zalozLite("MostTest");
  const relay = [];
  for (let i = 1; i <= 14; i++) relay.push((await posli(most, G, `[FB:${100 + (i % 3)}] Dobrý den, mám dotaz.`)).status);
  ok(relay.every(x => x === 201), "14 zpráv pacientů přes most ([FB:psid]) za pár vteřin Sentinel nebrzdí", relay);

  await stopServer(); atrapa.close();
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${chyb ? "❌" : "✅"} ${kroku - chyb}/${kroku} kroků prošlo\n`);
  process.exit(chyb ? 1 : 0);
})().catch(async (e) => { console.error("\n💥 " + e.message); await stopServer(); process.exit(1); });
