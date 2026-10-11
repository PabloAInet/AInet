#!/usr/bin/env node
/**
 * AInet — Mozek agenta, Jádro a Sandbox (dlouhodobá paměť).
 *
 *   1. Mozek: výchozí hodnoty, nastavení vlastníkem (API, PATCH /me, MCP update_profile),
 *      při registraci (lite i MCP), validace, veřejné čtení, cizí token nesmí měnit.
 *   2. Vestavěný odpovídač (Anthropic atrapa) podle mozku: model, max_tokens, thinking,
 *      delší limit znaků v pravidlech; bez přemýšlení bez thinking; pád přemýšlení → záloha.
 *   3. Jádro: API, MCP remember core, cesta /jadro; v probuzení i v promptu.
 *   4. Sandbox: uložit/upravit/číst/hledat/smazat (API), MCP recall + sandbox_save,
 *      cesty /ulozit /najdi /dokument; limity; cizí token nic.
 *   5. Přetečení: nejstarší poznámky a deník se přesunou do sandboxu, nesmažou se.
 *   6. Domácí agenti: token jednoho domácího odemkne paměť všech domácích; /api/moji-agenti.
 *   7. Smazání agenta smaže i jeho sandbox.
 */
const { spawn } = require("child_process");
const fs = require("fs"); const os = require("os"); const path = require("path"); const net = require("net"); const http = require("http");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-sandbox-"));
let server = null, BASE = "", kroku = 0, chyb = 0;
function ok(c, popis, detail) { kroku++; if (c) console.log(`  ✓ ${popis}`); else { chyb++; console.log(`  ✗ ${popis}${detail !== undefined ? "\n      " + JSON.stringify(detail).slice(0, 600) : ""}`); } }
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function get(c, h = {}) { const r = await fetch(BASE + c, { headers: { Accept: "application/json", ...h } }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function req(metoda, c, b, h = {}) { const r = await fetch(BASE + c, { method: metoda, headers: { "Content-Type": "application/json", ...h }, body: b === undefined ? undefined : JSON.stringify(b) }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
const post = (c, b, h) => req("POST", c, b, h);
async function mcp(name, args = {}) { const r = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }); return r.data.result ? r.data.result.structuredContent : { error: r.data.error }; }
const pockej = (ms) => new Promise(r => setTimeout(r, ms));

/* atrapa Anthropic Messages API — zapamatuje si poslední tělo požadavku */
let posledniTelo = null, volani = 0, odmitniThinking = false;
const atrapa = http.createServer((rq, rs) => {
  let d = ""; rq.on("data", c => d += c);
  rq.on("end", () => {
    volani++; try { posledniTelo = JSON.parse(d); } catch { posledniTelo = null; }
    rs.writeHead(posledniTelo && posledniTelo.thinking && odmitniThinking ? 400 : 200, { "Content-Type": "application/json" });
    if (posledniTelo && posledniTelo.thinking && odmitniThinking) return rs.end(JSON.stringify({ error: { message: "thinking not supported" } }));
    rs.end(JSON.stringify({ content: [...(posledniTelo && posledniTelo.thinking ? [{ type: "thinking", thinking: "tajná úvaha" }] : []), { type: "text", text: `Odpověď (${volani}).` }] }));
  });
});

async function startServer(envNavic = {}) {
  const port = await volnyPort(); BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: DIR, PUBLIC_URL: BASE, INDEXNOW: "0", KEEPALIVE_URL: "0", SEED_DOMACI: "1", PREHLED: "0", RADAR: "0",
    ANTHROPIC_API_KEY: "test", LLM_PROVIDER: "anthropic", LLM_API_URL: `http://127.0.0.1:${atrapa.address().port}/v1/messages`, ...envNavic };
  delete env.OPENAI_API_KEY; delete env.LLM_MODEL; delete env.RADAR_NAME;
  server = spawn(process.execPath, [path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", d => process.stderr.write("[server] " + d));
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "/healthz")).ok) return; } catch {} await pockej(100); }
  throw new Error("server nenaběhl");
}
function stopServer() { return new Promise(r => { if (!server) return r(); server.on("exit", () => { server = null; r(); }); server.kill(); }); }
async function zalozLite(name, extra = "") {
  const r = await get(`/api/lite/register?name=${encodeURIComponent(name)}&owner=Test&skills=chat${extra}`);
  const u = r.data.ukol; const a1 = u["1_soucet"].match(/\d+/g).map(Number).reduce((x, y) => x + y, 0);
  const a2 = u["2_otoc"].replace("Napiš pozpátku: ", "").split("").reverse().join(""); const a3 = u["3_opis"].replace("Opiš přesně: ", "");
  const v = await get(`/api/lite/verify?token=${r.data.token}&a1=${a1}&a2=${encodeURIComponent(a2)}&a3=${encodeURIComponent(a3)}`);
  if (v.data.stav !== "verified") throw new Error(`lite ověření ${name}: ${JSON.stringify(v.data)}`);
  return { id: r.data.id, tok: r.data.token, kod: r.data.obnovovaci_kod, name };
}
const H = (a) => ({ "X-Owner-Token": a.tok });

(async () => {
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║  AInet — Mozek, Jádro a Sandbox (dlouhodobá paměť)        ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  await new Promise(r => atrapa.listen(0, r));
  await startServer();
  const A = await zalozLite("Ada"), B = await zalozLite("Bob");
  const C = await zalozLite("Cyril", "&model=silny&usili=vysoke&premysleni=ano");
  const dbNow = () => JSON.parse(fs.readFileSync(path.join(DIR, "agents.json"), "utf8"));
  const domaci = Object.values(dbNow().agents).filter(a => a.domaci);
  const radar = domaci.find(a => a.card.name === "TradeRadar"), org = domaci.find(a => a.card.name === "Organizer");

  console.log("\n1) Mozek");
  const m0 = (await get(`/api/agents/${A.id}/mozek`)).data;
  ok(m0.mozek.model === "stredni" && m0.mozek.usili === "stredni" && m0.mozek.premysleni === false && m0.mozek.nastaveno === false, "výchozí mozek: střední model, střední úsilí, bez přemýšlení (čte kdokoli)", m0.mozek);
  const mC = (await get(`/api/agents/${C.id}/mozek`)).data.mozek;
  ok(mC.model === "silny" && mC.usili === "vysoke" && mC.premysleni === true, "mozek zadaný už při registraci (lite)", mC);
  const mA = await post(`/api/agents/${A.id}/mozek`, { model: "Haiku", usili: "low", premysleni: "ne" }, H(A));
  ok(mA.status === 200 && mA.data.mozek.model === "rychly" && mA.data.mozek.usili === "nizke" && /rychlý model · nízké úsilí/.test(mA.data.mozek.popis), "vlastník nastavil mozek (přijímá i anglické/české aliasy)", mA.data);
  const mSpatne = await post(`/api/agents/${A.id}/mozek`, { model: "turbo" }, H(A));
  ok(mSpatne.status === 400 && /neznám/.test(mSpatne.data.error), "neznámý model → 400 s nápovědou");
  const mCizi = await post(`/api/agents/${A.id}/mozek`, { model: "silny" }, H(B));
  ok(mCizi.status === 403, "cizí token mozek nezmění");
  const me = await req("PATCH", "/api/agents/me", { usili: "vysoke", premysleni: true }, H(B));
  ok(me.status === 200 && me.data.mozek.usili === "vysoke" && me.data.mozek.premysleni === true, "PATCH /api/agents/me mění i mozek", me.data);
  const up = await mcp("update_profile", { token: B.tok, model: "silny", bio: "Testovací Bob" });
  ok(up && up.mozek && up.mozek.model === "silny" && up.bio === "Testovací Bob", "MCP update_profile: bio + mozek najednou", up);
  const rg = await mcp("register_agent", { name: "Dora", owner: "Test", skills: ["chat"], model: "rychly", thinking: true });
  ok(rg && rg.id && (await get(`/api/agents/${rg.id}/mozek`)).data.mozek.model === "rychly", "MCP register_agent přijme mozek", rg && rg.id);
  const katalog = (await get("/api/agents")).data;
  ok(katalog.find(a => a.id === C.id).mozek.model === "silny" && katalog.find(a => a.id === org.id).domaci === true, "katalog nese mozek a příznak domácího agenta");

  console.log("\n2) Vestavěný odpovídač podle mozku (Organizer)");
  const orgTok = { id: org.id, tok: org.ownerToken };
  await post(`/api/agents/${org.id}/mozek`, { model: "silny", usili: "vysoke", premysleni: true }, H(orgTok));
  let pred = volani;
  const q1 = await post("/api/messages", { from: A.id, to: org.id, text: "Ahoj Organizere, máš volno?", visibility: "private" }, H(A));
  let odp = null; for (let i = 0; i < 40 && !odp; i++) { await pockej(120); odp = (await get(`/api/messages?agent=${A.id}`, H(A))).data.find(m => m.from === org.id && m.inReplyTo === q1.data.id); }
  ok(odp && volani > pred && posledniTelo.model === "claude-opus-5-5" && posledniTelo.thinking && posledniTelo.thinking.budget_tokens === 8000 && posledniTelo.max_tokens === 10000, "silný model, přemýšlení s rozpočtem 8000, max_tokens 2000+8000", posledniTelo && { model: posledniTelo.model, thinking: posledniTelo.thinking, max: posledniTelo.max_tokens });
  ok(odp && !/tajná úvaha/.test(odp.text) && /^Odpověď/.test(odp.text), "blok přemýšlení se adresátovi neukazuje", odp && odp.text);
  ok(/maximálně 1600 znaků/.test(posledniTelo.system) && /Dej si záležet/.test(posledniTelo.system), "vysoké úsilí: delší limit a pokyn v pravidlech");
  await post(`/api/agents/${org.id}/mozek`, { model: "rychly", usili: "nizke", premysleni: false }, H(orgTok));
  pred = volani;
  const q2 = await post("/api/messages", { from: B.id, to: org.id, text: "Rychlý dotaz na termín.", visibility: "private" }, H(B));
  odp = null; for (let i = 0; i < 40 && !odp; i++) { await pockej(120); odp = (await get(`/api/messages?agent=${B.id}`, H(B))).data.find(m => m.from === org.id && m.inReplyTo === q2.data.id); }
  ok(odp && posledniTelo.model === "claude-haiku-5-5" && !posledniTelo.thinking && posledniTelo.max_tokens === 400 && /maximálně 400 znaků/.test(posledniTelo.system), "rychlý model, bez přemýšlení, 400 tokenů", posledniTelo && { model: posledniTelo.model, max: posledniTelo.max_tokens });
  await post(`/api/agents/${org.id}/mozek`, { model: "stredni", premysleni: true }, H(orgTok));
  odmitniThinking = true; pred = volani;
  const q3 = await post("/api/messages", { from: C.id, to: org.id, text: "Třetí dotaz.", visibility: "private" }, H(C));
  odp = null; for (let i = 0; i < 40 && !odp; i++) { await pockej(120); odp = (await get(`/api/messages?agent=${C.id}`, H(C))).data.find(m => m.from === org.id && m.inReplyTo === q3.data.id); }
  ok(odp && volani - pred === 2 && !posledniTelo.thinking && posledniTelo.model === "claude-sonnet-5-5", "API přemýšlení odmítne → jedna záloha bez přemýšlení se základním modelem", { volani: volani - pred, model: posledniTelo && posledniTelo.model });
  odmitniThinking = false;

  console.log("\n3) Jádro");
  const j1 = await post(`/api/agents/${A.id}/jadro`, { text: "Jsem Ada, analytička dat. Umím SQL, statistiku a grafy." }, H(A));
  ok(j1.status === 200 && /analytička/.test(j1.data.jadro.text), "jádro přes API");
  const pr = (await get(`/api/agents/${A.id}/probuzeni`, H(A))).data;
  ok(pr.jadro && /analytička/.test(pr.jadro.text) && pr.mozek && /rychlý model/.test(pr.mozek.popis) && /Vlastník chce/.test(pr.mozek.doporuceni), "probuzení nese jádro i mozek s doporučením pro aplikaci", { jadro: pr.jadro, mozek: pr.mozek });
  const jm = await mcp("remember", { token: B.tok, text: "Jsem Bob, tester. Umím rozbíjet věci.", core: true });
  ok(jm && jm.jadro && /tester/.test(jm.jadro.text), "MCP remember core: true nastaví jádro", jm);
  const jc = await get(`/jadro/${C.kod}/${encodeURIComponent("Jsem Cyril, mobilní chat. Umím psát texty.")}`);
  ok(jc.status === 200 && /mobilní chat/.test(jc.data.jadro.text) && (await get(`/jadro/${C.kod}`)).data.jadro.text === jc.data.jadro.text, "cesta /jadro/KOD/TEXT (mobilní chat) zapíše a přečte jádro");

  console.log("\n4) Sandbox");
  const dlouhy = "Postup nasazení AInetu na Render.\n" + "Krok: commit na main, Render nasadí sám. ".repeat(400) + "\nKlíčové: ANTHROPIC_API_KEY v Environment.";
  const s1 = await post(`/api/agents/${A.id}/sandbox`, { nazev: "Nasazení na Render", text: dlouhy, stitky: ["render", "postup"] }, H(A));
  ok(s1.status === 201 && s1.data.dokument.znaku === dlouhy.length && s1.data.sandbox.dokumentu === 1, `uložen dokument ${dlouhy.length} znaků (poznámka by ho uřízla na 2000)`, s1.data.sandbox);
  await post(`/api/agents/${A.id}/sandbox`, { nazev: "Recept na guláš", text: "Cibule, maso, paprika. Dusit dvě hodiny.", stitky: "vareni" }, H(A));
  const h1 = (await get(`/api/agents/${A.id}/sandbox?q=${encodeURIComponent("api klíč render")}`, H(A))).data;
  ok(h1.vysledky.length >= 1 && h1.vysledky[0].nazev === "Nasazení na Render" && /ANTHROPIC_API_KEY|Render/.test(h1.vysledky[0].uryvek), "hledání najde správný dokument s úryvkem (bez ohledu na diakritiku)", h1.vysledky.map(v => v.nazev));
  const h2 = (await get(`/api/agents/${A.id}/sandbox?q=gulas`, H(A))).data;
  ok(h2.vysledky.length === 1 && h2.vysledky[0].nazev === "Recept na guláš", "„gulas“ najde „guláš“");
  const cely = (await get(`/api/agents/${A.id}/sandbox/${s1.data.dokument.id}`, H(A))).data;
  ok(cely.dokument.text === dlouhy, "celý dokument se vrátí beze ztráty");
  const upr = await post(`/api/agents/${A.id}/sandbox/${s1.data.dokument.id}`, { text: "Zkrácený postup.", stitky: ["render"] }, H(A));
  ok(upr.status === 200 && upr.data.dokument.znaku === 16 && upr.data.sandbox.dokumentu === 2, "úprava dokumentu přepíše text, nepřidá nový");
  const ciziS = await get(`/api/agents/${A.id}/sandbox`, H(B));
  ok(ciziS.status === 403, "cizí sandbox nečte nikdo jiný");
  const moc = await post(`/api/agents/${A.id}/sandbox`, { nazev: "obr", text: "x".repeat(100_001) }, H(A));
  ok(moc.status === 400 && /moc dlouhý/.test(moc.data.error), "dokument nad 100 000 znaků se odmítne s radou rozdělit");
  const ms = await mcp("sandbox_save", { token: B.tok, title: "Testovací plán", text: "1) registrace 2) ověření 3) zprávy", tags: ["test"] });
  ok(ms && ms.ok && ms.dokument.nazev === "Testovací plán", "MCP sandbox_save");
  const mr = await mcp("recall", { token: B.tok, query: "overeni registrace" });
  ok(mr && mr.vysledky && mr.vysledky[0] && mr.vysledky[0].id === ms.dokument.id, "MCP recall query najde dokument", mr);
  const mr2 = await mcp("recall", { token: B.tok, id: ms.dokument.id });
  ok(mr2 && mr2.dokument && /zprávy/.test(mr2.dokument.text), "MCP recall id vrátí celý dokument");
  const ul = await get(`/ulozit/${C.kod}/${encodeURIComponent("Poznámky z porady")}/${encodeURIComponent("Dohodli jsme termín 15. 10. a rozpočet 2/3 z plánu.")}`);
  ok(ul.status === 200 && ul.data.dokument.nazev === "Poznámky z porady", "cesta /ulozit/KOD/NAZEV/TEXT (mobilní chat)", ul.data);
  const nj = await get(`/najdi/${C.kod}/${encodeURIComponent("termin porady")}`);
  ok(nj.status === 200 && nj.data.vysledky[0].nazev === "Poznámky z porady" && nj.data.cist, "cesta /najdi/KOD/DOTAZ vrátí výsledky a odkaz na celý text", nj.data.cist);
  const dk = await get(nj.data.cist.replace(BASE, ""));
  ok(dk.status === 200 && /2\/3 z plánu/.test(dk.data.dokument.text), "cesta /dokument/KOD/ID vrátí celý text (lomítko v textu přežije)", dk.data.dokument && dk.data.dokument.text);
  const pr2 = (await get(`/api/agents/${A.id}/probuzeni`, H(A))).data;
  ok(pr2.sandbox && pr2.sandbox.dokumentu === 2 && pr2.sandbox.posledni.length === 2 && !pr2.sandbox.posledni[0].text && pr2.sandbox.jak_hledat.hledat, "probuzení nese jen seznam názvů sandboxu + jak hledat (ne obsah)", pr2.sandbox);
  const sm = await req("DELETE", `/api/agents/${A.id}/sandbox/${s1.data.dokument.id}`, undefined, H(A));
  ok(sm.status === 200 && sm.data.sandbox.dokumentu === 1, "smazání dokumentu");

  console.log("\n5) Přetečení poznámek a deníku → sandbox");
  await stopServer();
  const db = dbNow();
  db.poznamky[B.id] = Array.from({ length: 300 }, (_, i) => ({ id: "p" + i, text: `stará poznámka č. ${i}`, kdy: "2026-09-01T10:00:00.000Z", zdroj: "test" }));
  db.denik[B.id] = Array.from({ length: 100 }, (_, i) => ({ kdy: "2026-09-02T10:00:00.000Z", shrnuti: `starý den ${i}`, rozdelano: "", pristi: "" }));
  fs.writeFileSync(path.join(DIR, "agents.json"), JSON.stringify(db));
  await startServer();
  await post(`/api/agents/${B.id}/pamet`, { text: "nová poznámka 301" }, H(B));
  await post(`/api/agents/${B.id}/usnuti`, { shrnuti: "dnešní den", rozdelano: "nic" }, H(B));
  const pm = (await get(`/api/agents/${B.id}/pamet`, H(B))).data;
  ok(pm.poznamky.length === 300 && pm.poznamky[pm.poznamky.length - 1].text === "nová poznámka 301" && pm.poznamky[0].text === "stará poznámka č. 1", "poznámek zůstává 300, nejnovější je na konci", pm.poznamky.length);
  const arch = (await get(`/api/agents/${B.id}/sandbox?q=${encodeURIComponent("stará poznámka č. 0")}`, H(B))).data.vysledky;
  ok(arch.some(v => /^Archiv poznámek \d{4}-\d{2}$/.test(v.nazev)), "nejstarší poznámka nezmizela — je v sandboxu v archivu poznámek", arch.map(v => v.nazev));
  const archD = (await get(`/api/agents/${B.id}/sandbox?q=${encodeURIComponent("starý den 0")}`, H(B))).data.vysledky;
  ok(archD.some(v => /^Archiv deníku/.test(v.nazev)) && pm.deniku_celkem === 100, "nejstarší zápis deníku je v archivu deníku, v deníku jich zůstává 100", { n: pm.deniku_celkem, a: archD.map(v => v.nazev) });

  console.log("\n6) Domácí agenti a přepínač");
  const moji = (await get("/api/moji-agenti", H(orgTok))).data;
  const jmena = moji.agenti.map(a => a.jmeno);
  ok(moji.ja === org.id && jmena[0] === "Organizer" && jmena.includes("TradeRadar") && jmena.includes("MarketPlace") && !jmena.includes("Ada"), "token Organizera: moji agenti = všichni domácí (sám první), cizí ne", jmena);
  const pR = await get(`/api/agents/${radar.id}/pamet`, H(orgTok));
  ok(pR.status === 200 && pR.data.agent === "TradeRadar", "token domácího otevře paměť jiného domácího (týž vlastník)");
  const pAda = await get(`/api/agents/${A.id}/pamet`, H(orgTok));
  ok(pAda.status === 403, "…ale cizího agenta ne");
  const mojiA = (await get("/api/moji-agenti", H(A))).data;
  ok(mojiA.agenti.length === 1 && mojiA.agenti[0].jmeno === "Ada" && mojiA.agenti[0].jadro === true && mojiA.agenti[0].sandbox === 1, "obyčejný agent vidí jen sebe (s počty paměti)", mojiA.agenti[0]);

  console.log("\n7) Smazání agenta smaže i sandbox");
  const sbSoubor = path.join(DIR, "sandbox", `${A.id}.json`);
  ok(fs.existsSync(sbSoubor), "sandbox leží ve vlastním souboru (mimo agents.json)");
  const del = await req("DELETE", `/api/agents/${A.id}`, { token: A.tok }, H(A));
  ok(del.status === 200 && !fs.existsSync(sbSoubor) && !dbNow().jadro[A.id] && !dbNow().mozek[A.id], "agent smazán → sandbox, jádro i mozek pryč", del.data);

  await stopServer(); atrapa.close();
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${chyb ? "❌" : "✅"} ${kroku - chyb}/${kroku} kroků prošlo\n`);
  process.exit(chyb ? 1 : 0);
})().catch(async (e) => { console.error("\n💥 " + e.stack); await stopServer(); process.exit(1); });
