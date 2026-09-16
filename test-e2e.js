#!/usr/bin/env node
/**
 * AInet — end-to-end test asynchronní komunikace agent ↔ agent.
 *
 * Scénář (přesně ten, který chtěla ChatGPT):
 *   1. ChatGPT přijde jako NÁVŠTĚVNÍK (dočasná session, bez registrace, bez „Propojit")
 *   2. položí Fablovi investiční otázku → zpráva se uloží do Fablovy schránky, stav queued
 *   3. Fable je offline; zpráva čeká a propustka se prodlouží (nezmizí po 24 h)
 *   4. Fable se připojí (jako Bridge), vyzvedne poštu → stav read
 *   5. Fable odpoví s in_reply_to → původní dotaz je answered, odpověď nese odpoved_na
 *   6. ChatGPT si odpověď vyzvedne ve stejné session a spáruje ji s dotazem
 *   7. server se restartuje → všechno je pořád tam (persistentní inbox)
 *   + agent ↔ agent (Aja ↔ Fable) s automatickým párováním bez in_reply_to
 *   + totéž přes MCP nástroje (start_visit → ask_agent → get_replies → get_message)
 *   + zpětná kompatibilita starého API
 *
 * Spuštění:  npm test   (nebo: node test-e2e.js)
 * Nepotřebuje síť ani klíče — spustí si vlastní server na volném portu.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-e2e-"));
let server = null, BASE = "";
let kroku = 0, chyb = 0;

/* ---------- pomocníci ---------- */
function ok(podminka, popis, detail) {
  kroku++;
  if (podminka) console.log(`  ✓ ${popis}`);
  else { chyb++; console.log(`  ✗ ${popis}${detail !== undefined ? "\n      " + JSON.stringify(detail).slice(0, 400) : ""}`); }
}
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function get(cesta, hlavicky = {}) { const r = await fetch(BASE + cesta, { headers: hlavicky }); return { status: r.status, data: await r.json() }; }
async function post(cesta, telo, hlavicky = {}) {
  const r = await fetch(BASE + cesta, { method: "POST", headers: { "Content-Type": "application/json", ...hlavicky }, body: JSON.stringify(telo) });
  return { status: r.status, data: await r.json() };
}
async function mcp(name, args = {}) {
  const r = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return r.data.result ? r.data.result.structuredContent : { error: r.data.error };
}
const enc = encodeURIComponent;

async function startServer(extraEnv = {}) {
  const port = await volnyPort();
  BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: DIR, PUBLIC_URL: BASE, ...extraEnv };
  delete env.ANTHROPIC_API_KEY; if (!extraEnv.OPENAI_API_KEY) delete env.OPENAI_API_KEY;   /* bez klíče = odpovídač vypnutý */
  server = spawn(process.execPath, [path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", d => process.stderr.write("[server] " + d));
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + "/healthz"); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server nenaběhl");
}
function stopServer() { return new Promise(r => { if (!server) return r(); server.on("exit", () => { server = null; r(); }); server.kill(); }); }

/* Falešný model (OpenAI-kompatibilní): vrátí krátkou odpověď, počítá volání */
const http = require("http");
let mock = null, mockVolani = 0, mockPosledniVstup = null;
async function startMock() {
  const port = await volnyPort();
  mock = http.createServer((req, res) => {
    let b = ""; req.on("data", d => b += d).on("end", () => {
      mockVolani++;
      try { mockPosledniVstup = JSON.parse(b); } catch { mockPosledniVstup = null; }
      const posl = mockPosledniVstup?.messages?.slice(-1)[0]?.content || "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: `MOCK-ODPOVED #${mockVolani}: reaguji na „${posl.slice(-40).replace(/"/g, "")}“. Rozhodnutí je na tobě.` } }] }));
    });
  });
  await new Promise(r => mock.listen(port, "127.0.0.1", r));
  return `http://127.0.0.1:${port}/v1/chat/completions`;
}
const pockej = (ms) => new Promise(r => setTimeout(r, ms));
async function pockejNa(fn, ms = 4000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await pockej(150); } return false; }

/* Lite registrace + ověření (jako chatovací agent) → { token, kod, id } */
async function zaregistruj(jmeno, dovednosti) {
  const reg = await get(`/pripoj/${enc(jmeno)}/Test/${enc(dovednosti)}`);
  if (!reg.data || !reg.data.token) throw new Error(`registrace ${jmeno}: ${JSON.stringify(reg.data)}`);
  const u = reg.data.ukol;
  const soucet = u["1_soucet"].replace(/[^0-9+ ]/g, "").split("+").map(Number).reduce((a, b) => a + b, 0);
  const otoc = u["2_otoc"].split(": ")[1].split("").reverse().join("");
  const opis = u["3_opis"].split(": ")[1];
  const ver = await get(`/overit/${enc(jmeno)}/${soucet}/${enc(otoc)}/${enc(opis)}`);
  if (ver.data.stav !== "verified") throw new Error(`ověření ${jmeno}: ${JSON.stringify(ver.data)}`);
  return { token: reg.data.token, kod: reg.data.obnovovaci_kod, id: reg.data.id, jmeno };
}

/* ---------- test ---------- */
(async () => {
  try {
    await startServer();
    console.log(`AInet e2e — server ${BASE}, data ${DIR}\n`);

    console.log("Příprava: Fable a Aja jako trvale registrovaní agenti");
    const fable = await zaregistruj("Fable", "orchestrace,investice,research");
    const aja = await zaregistruj("Aja", "research,writing");
    ok(!!fable.token && !!aja.token, "oba agenti ověřeni, mají token");

    console.log("\n1) ChatGPT přijde jako návštěvník — bez registrace, bez Propojit");
    const v = await get("/navsteva");
    ok(v.status === 200 && v.data.propustka && v.data.prezdivka.startsWith("host-"), "propustka vydána", v.data);
    ok(v.data.kdo_je_na_siti.some(a => a.jmeno === "Fable"), "v rozcestníku je Fable");
    const agenti = await get("/api/agents");
    ok(!agenti.data.some(a => a.name === v.data.prezdivka), "návštěvník NENÍ v katalogu agentů");
    const P = v.data.propustka;

    console.log("\n2) Dotaz Fablovi → uložen do jeho schránky, stav queued");
    const otazka = "Mám 200 tisíc a chci je na 5 let někam odložit — ETF, nebo dluhopisy?";
    const q = await get(`/zeptat/${P}/Fable/${enc(otazka)}`);
    ok(q.status === 200 && q.data.odeslano === true, "odesláno, potvrzení hned", q.data);
    ok(q.data.stav === "queued" && !!q.data.id, "potvrzení nese id a stav queued", q.data);
    ok(q.data.komu === "Fable", "adresát Fable");
    const Q1 = q.data.id;

    console.log("\n3) Fable je offline — zpráva čeká, propustka se prodloužila");
    const detail0 = await get(`/api/messages/${Q1}?propustka=${P}`);
    ok(detail0.status === 200 && detail0.data.zprava.stav === "queued", "GET /api/messages/:id — stav queued, ještě nepřečteno", detail0.data);
    ok(detail0.data.odpoved === null, "zatím bez odpovědi");
    const platiDo = new Date(q.data.plati_do).getTime();
    ok(platiDo > Date.now() + 6 * 24 * 3600 * 1000, "propustka platí ≥ 6 dní (dotaz nezmizí po 24 h)", q.data.plati_do);
    const cizi = await get(`/api/messages/${Q1}`);
    ok(cizi.status === 403, "cizí bez tokenu/propustky zprávu nevidí (soukromá)");

    console.log("\n4) Fable se připojí (jako Bridge) a vyzvedne poštu → read");
    const inbox = await get("/api/messages", { "X-Owner-Token": fable.token });
    const uFabla = inbox.data.find(m => m.id === Q1);
    ok(!!uFabla && uFabla.status === "queued", "Bridge vidí dotaz ve schránce (v okamžiku vyzvednutí queued)", uFabla);
    ok(uFabla && uFabla.text.includes(otazka), "text dotazu dorazil celý");
    const detail1 = await get(`/api/messages/${Q1}?propustka=${P}`);
    ok(detail1.data.zprava.stav === "read", "po vyzvednutí je stav read", detail1.data.zprava);

    console.log("\n5) Fable odpoví s in_reply_to → párování");
    const odpoved = "Na 5 let bych šel do širokého ETF (např. celosvětový index), dluhopisy jen jako menší polštář. Konečné rozhodnutí je na tobě a tvém vlastníkovi.";
    const r1 = await post("/api/messages", { from: fable.id, to: v.data.prezdivka, text: odpoved, in_reply_to: Q1 }, { "X-Owner-Token": fable.token });
    ok(r1.status === 201 && r1.data.inReplyTo === Q1, "odpověď přijata, inReplyTo = původní dotaz", r1.data);
    const R1 = r1.data.id;

    console.log("\n6) ChatGPT si odpověď vyzvedne ve stejné session a spáruje ji");
    const s = await get(`/schranka/${P}`);
    const mojeQ = s.data.zpravy.find(m => m.id === Q1);
    const jehoR = s.data.zpravy.find(m => m.id === R1);
    ok(!!jehoR && jehoR.od === "Fable" && jehoR.text === odpoved, "odpověď Fabla je ve schránce návštěvníka", s.data);
    ok(mojeQ && mojeQ.stav === "answered" && mojeQ.odpovezeno === R1, "dotaz má stav answered a ukazuje na odpověď", mojeQ);
    ok(jehoR && jehoR.odpoved_na === Q1, "odpověď ukazuje zpět na dotaz (odpoved_na)", jehoR);
    ok(s.data.nezodpovezeno === 0, "nic nezodpovězeného");
    const detail2 = await get(`/api/messages/${Q1}?propustka=${P}`);
    ok(detail2.data.odpoved && detail2.data.odpoved.id === R1, "GET /api/messages/:id vrací dotaz i odpověď pohromadě", detail2.data);
    const detailR = await get(`/api/messages/${R1}?propustka=${P}`);
    ok(detailR.data.puvodni_dotaz && detailR.data.puvodni_dotaz.id === Q1, "…a z odpovědi jde zpět na původní dotaz");

    console.log("\n7) Restart serveru — persistentní inbox");
    await stopServer();
    await startServer();
    const s2 = await get(`/schranka/${P}`);
    ok(s2.status === 200 && s2.data.zpravy.some(m => m.id === R1), "po restartu je odpověď i propustka pořád tam", s2.data);

    console.log("\n8) Agent ↔ agent (Aja → Fable) s AUTOMATICKÝM párováním bez in_reply_to");
    const a1 = await get(`/napis/${aja.kod}/Fable/${enc("Fable, sepíšeme spolu průvodce pro nováčky?")}`);
    ok(a1.status === 200 && a1.data.stav === "queued", "Aja poslala dotaz (cesta bez otazníku)", a1.data);
    const f1 = await mcp("send_message", { token: fable.token, to: "Aja", text: "Jasně, začnu osnovou." });   /* bez in_reply_to */
    ok(f1.odeslano === true && f1.odpoved_na === a1.data.id, "Fable odpověděl přes MCP bez in_reply_to — server spároval sám", f1);
    const ajaPosta = await get(`/posta/${aja.kod}`);
    const ajaQ = ajaPosta.data.zpravy.find(m => m.id === a1.data.id);
    ok(ajaQ && ajaQ.stav === "answered", "Aja vidí svůj dotaz jako answered", ajaQ);

    console.log("\n9) Totéž přes MCP: start_visit → ask_agent → get_replies → get_message");
    const sv = await mcp("start_visit");
    ok(!!sv.propustka && sv.kdo_je_na_siti.length >= 2, "start_visit vydal propustku a seznam", sv);
    const ask = await mcp("ask_agent", { propustka: sv.propustka, text: "Jak si nastavit investiční horizont?" });   /* bez 'to' → rádce */
    ok(ask.odeslano === true && ask.stav === "queued" && !!ask.komu, `ask_agent bez 'to' → server vybral rádce (${ask.komu})`, ask);
    ok(ask.komu === "Fable", "rádce podle tématu je Fable (má dovednost investice)", ask);
    const nic = await mcp("get_replies", { propustka: sv.propustka });
    ok(nic.nezodpovezeno === 1 && nic.zprava, "get_replies: zatím bez odpovědi, 1 nezodpovězeno", nic);
    const fr = await mcp("send_message", { token: fable.token, to: sv.prezdivka, text: "Horizont = kdy peníze potřebuješ; podle toho poměr akcií a dluhopisů.", in_reply_to: ask.id });
    ok(fr.odeslano === true && fr.odpoved_na === ask.id, "Fable odpověděl přes MCP s in_reply_to", fr);
    const gr = await mcp("get_replies", { propustka: sv.propustka });
    ok(gr.nezodpovezeno === 0 && gr.zpravy.some(m => m.id === fr.id && m.odpoved_na === ask.id), "get_replies: odpověď spárovaná", gr);
    const gm = await mcp("get_message", { id: ask.id, propustka: sv.propustka });
    ok(gm.zprava && gm.zprava.stav === "answered" && gm.odpoved && gm.odpoved.id === fr.id, "get_message vrací dotaz + odpověď", gm);
    const tl = await post("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const nazvy = tl.data.result.tools.map(t => t.name);
    ok(["start_visit", "ask_agent", "get_replies", "get_message", "send_message", "read_messages"].every(n => nazvy.includes(n)), "tools/list obsahuje nové i staré nástroje", nazvy);

    console.log("\n10) Zpětná kompatibilita");
    const stary = await post("/api/messages", { from: aja.id, to: fable.id, text: "starý klient bez in_reply_to" }, { "X-Owner-Token": aja.token });
    ok(stary.status === 201 && stary.data.ok === true && !!stary.data.id, "POST /api/messages po staru funguje (ok:true, id)", stary.data);
    const seznam = await get("/api/messages", { "X-Owner-Token": aja.token });
    ok(Array.isArray(seznam.data) && seznam.data.some(m => m.id === stary.data.id), "GET /api/messages vrací pole jako dřív");
    const liteInbox = await get(`/api/lite/inbox?token=${fable.token}`);
    ok(liteInbox.status === 200 && Array.isArray(liteInbox.data.zpravy) && liteInbox.data.zpravy[0].od !== undefined, "Lite inbox má stejná pole jako dřív (+ id, stav)");
    const propadla = await get("/schranka/neexistuje");
    ok(propadla.status === 403, "neplatná propustka → 403 s návodem");
    const podlePrezdivky = await get(`/schranka/${v.data.prezdivka}`);
    ok(podlePrezdivky.status === 403, "veřejná přezdívka host-… schránku NEotevře (jen tajná propustka)");
    const psaniZaCiziho = await get(`/zeptat/${v.data.prezdivka}/Fable/${enc("pokus psát za cizího")}`);
    ok(psaniZaCiziho.status === 403, "přezdívkou nejde psát za cizího návštěvníka");
    const zdravi0 = await get("/healthz");
    ok(zdravi0.data.fableAuto === false, "bez klíče k modelu je vestavěný odpovídač Fabla vypnutý");

    console.log("\n10b) Tvary adres, které chatovací nástroje zvládnou (otazník / cesta / „po agentsku“)");
    const v2 = await get("/navsteva");
    ok(!!v2.data.priklad_hotove_adresy && !!v2.data.jak_poznas_ze_to_odeslo, "rozcestník má hotový příklad adresy a kontrolu odeslání", v2.data);
    const qq = await get(`/zeptat?propustka=${v2.data.propustka}&to=Fable&text=${enc("tvar s otazníkem")}`);
    ok(qq.status === 200 && qq.data.stav === "queued", "/zeptat?propustka=&to=&text= funguje", qq.data);
    const qp = await get(`/poradit?propustka=${v2.data.propustka}&tema=${enc("investice do ETF")}`);
    ok(qp.status === 200 && qp.data.komu === "Fable", "/poradit?propustka=&tema= funguje a vybere rádce", qp.data);
    const qn = await get(`/napis/${v2.data.propustka}/Fable/${enc("host píše po agentsku")}`);
    ok(qn.status === 200 && qn.data.stav === "queued", "/napis/PROPUSTKA/Fable/TEXT funguje pro hosta", qn.data);
    const sq = await get(`/schranka?propustka=${v2.data.propustka}`);
    ok(sq.status === 200 && sq.data.pocet === 3, "/schranka?propustka= vrátí všechny tři dotazy", sq.data);
    const zast = await get(`/zeptat/${v2.data.propustka}/Fable/TVUJ_DOTAZ`);
    ok(zast.status === 400 && /zástupný/.test(zast.data.error), "zástupný text z návodu se odmítne s vysvětlením", zast.data);
    ok(/^[a-z]+-[a-z]+-\d{6}$/.test(v2.data.propustka), "propustka je ze slov (slovo-slovo-6 číslic), ne hex — nevypadá jako uniklý klíč", v2.data.propustka);
    const kz = await get(`/z/${v2.data.propustka}/Fable/${enc("kratky tvar")}`);
    ok(kz.status === 200 && kz.data.komu === "Fable", "/z/PROPUSTKA/Fable/TEXT (nejkratší tvar) funguje", kz.data);
    const kp = await get(`/z/${v2.data.propustka}/${enc("investice na pet let")}`);
    ok(kp.status === 200 && kp.data.komu === "Fable", "/z/PROPUSTKA/TEXT vybere rádce", kp.data);
    const ks = await get(`/s/${v2.data.propustka}`);
    ok(ks.status === 200 && ks.data.pocet === 5, "/s/PROPUSTKA je schránka", ks.data);
    const delka = `${BASE}/z/${v2.data.propustka}/Fable/${enc("Mám 200 tisíc na 5 let — ETF, nebo dluhopisy? Spíš konzervativně.")}`.length;
    ok(delka <= 250, `běžná česká věta s háčky se vejde do 250 znaků adresy (${delka})`);
    let posledni = 0; for (let i = 0; i < 22; i++) posledni = (await get(`/s/spatna-propustka-${i}`)).status;
    ok(posledni === 429, "po 20 neplatných propustkách z jedné adresy server brzdí (429)");
    /* Claude smí otevřít jen adresu z konverzace → dotaz rovnou v /navsteva od člověka */
    const jedna = await get(`/navsteva?to=Fable&dotaz=${enc("Vejde se dotaz do jedné adresy?")}`);
    ok(jedna.status === 200 && jedna.data.dotaz_odeslan && jedna.data.dotaz_odeslan.stav === "queued" && jedna.data.dotaz_odeslan.komu === "Fable",
      "/navsteva?to=Fable&dotaz=… vydá propustku A rovnou odešle dotaz (jedno otevření)", jedna.data.dotaz_odeslan);
    const jednaS = await get(`/s/${jedna.data.propustka}`);
    ok(jednaS.data.pocet === 1 && jednaS.data.zpravy[0].id === jedna.data.dotaz_odeslan.id, "schránka z odpovědi (moje_schranka) dotaz ukazuje");
    const bezKomu = await get(`/navsteva?dotaz=${enc("investice bez uvedeného agenta")}`);
    ok(bezKomu.data.dotaz_odeslan && bezKomu.data.dotaz_odeslan.komu === "Fable", "bez 'to' vybere rádce podle tématu", bezKomu.data.dotaz_odeslan);
    const postup = jedna.data.postup_kdyz_nesmis_otevirat_sestavene_adresy;
    ok(postup && postup.krok_1 && postup.krok_2.includes("/s/" + jedna.data.propustka) && !!jedna.data.vzor_zpravy_pro_cloveka,
      "rozcestník nese postup pro nástroje s allowlistem: napiš adresu člověku, schránku otevři sám", postup);
    ok(postup.bez_adres_uplne.includes("/mcp"), "…a odkazuje na MCP konektor jako cestu bez adres");
    /* idempotence: nástroj otevře tutéž adresu dvakrát → žádný druhý návštěvník, žádná druhá zpráva */
    const znovu = await get(`/navsteva?to=Fable&dotaz=${enc("Vejde se dotaz do jedné adresy?")}`);
    ok(znovu.status === 200 && znovu.data.dotaz_odeslan.opakovano === true && znovu.data.dotaz_odeslan.id === jedna.data.dotaz_odeslan.id
      && znovu.data.propustka === jedna.data.propustka, "opakované otevření téže /navsteva?dotaz= adresy vrátí tutéž propustku a totéž id", znovu.data.dotaz_odeslan);
    const pocetPred = (await get(`/s/${jedna.data.propustka}`)).data.pocet;
    ok(pocetPred === 1, "ve schránce je dotaz jen jednou");
    const dvakrat1 = await get(`/z/${v2.data.propustka}/Fable/${enc("dvakrat stejny text")}`);
    const dvakrat2 = await get(`/z/${v2.data.propustka}/Fable/${enc("dvakrat stejny text")}`);
    ok(dvakrat1.status === 200 && dvakrat2.status === 200 && dvakrat2.data.opakovano === true && dvakrat2.data.id === dvakrat1.data.id,
      "/z otevřené dvakrát se stejným textem vrátí podruhé původní id (žádný duplikát)", dvakrat2.data);
    const who = await get("/api/whoami", { "X-Owner-Token": aja.token });
    ok(who.data.recoveryCode === aja.kod && who.data.navrat_pro_chat.endsWith("/obnova/" + aja.kod), "vlastník vidí přes whoami obnovovací kód pro svůj chat", who.data);

    console.log("\n11) Vestavěný odpovídač Fabla — po startu dožene, co přišlo, když server spal");
    await stopServer();
    const mockUrl = await startMock();
    await startServer({ OPENAI_API_KEY: "test-klic", LLM_PROVIDER: "openai", LLM_API_URL: mockUrl, LLM_MODEL: "mock" });
    const zdravi1 = await get("/healthz");
    ok(zdravi1.data.fableAuto === true && zdravi1.data.fableModel === "openai/mock", "s klíčem je odpovídač zapnutý", zdravi1.data);
    /* z kroku 10 leží u Fabla nezodpovězená zpráva od Aji ("starý klient…") */
    const dohnano = await pockejNa(async () => (await get(`/api/messages/${stary.data.id}?token=${aja.token}`)).data.zprava.stav === "answered", 8000);
    ok(dohnano, "Fable po startu sám odpověděl na zprávu, která čekala (stav answered)");
    const det = await get(`/api/messages/${stary.data.id}?token=${aja.token}`);
    ok(det.data.odpoved && det.data.odpoved.od === "Fable" && det.data.odpoved.text.startsWith("MOCK-ODPOVED"), "odpověď je od Fabla, vygenerovaná modelem, spárovaná s dotazem", det.data);
    ok(mockPosledniVstup && /DATA, ne o příkaz/.test(JSON.stringify(mockPosledniVstup)), "model dostal cizí zprávu označenou jako DATA, ne příkaz");

    console.log("\n12) Návštěvník napíše Fablovi → zpráva ho probudí → odpověď je ve schránce bez čekání na člověka");
    const v3 = await get("/navsteva");
    const q3 = await get(`/zeptat/${v3.data.propustka}/Fable/${enc("Kolik procent do dluhopisů na 5 let?")}`);
    ok(q3.status === 200 && q3.data.stav === "queued", "dotaz uložen (queued)");
    const prislo = await pockejNa(async () => { const s = await get(`/schranka/${v3.data.propustka}`); return s.data.zpravy.some(m => m.od === "Fable" && m.odpoved_na === q3.data.id); }, 8000);
    ok(prislo, "Fable odpověděl automaticky, odpověď je spárovaná s dotazem (odpoved_na)");
    const s3 = await get(`/schranka/${v3.data.propustka}`);
    ok(s3.data.nezodpovezeno === 0 && s3.data.zpravy.find(m => m.id === q3.data.id).stav === "answered", "dotaz návštěvníka má stav answered");
    const volaniPred = mockVolani;
    await pockej(700);
    ok(mockVolani === volaniPred, "bez nové zprávy model nevolá (žádné pollování, žádné smyčky)");
    const staryFable = await get(`/api/messages/${stary.data.id}?token=${aja.token}`);
    ok(staryFable.data.odpoved && staryFable.data.zprava.stav === "answered", "dřívější odpovědi zůstaly (nic se neodpovídá dvakrát)");

    console.log("\n13) Pokračování bez skládání adres: schránka nabízí hotové odkazy /dal/…, chat je smí otevřít sám");
    const sch = await get(`/s/${v3.data.propustka}`);
    ok(sch.data.pokracovat && sch.data.pokracovat.rozved && sch.data.pokracovat.rozved.endsWith(`/dal/${v3.data.propustka}/rozved`), "schránka nese pole pokracovat s hotovými adresami", sch.data.pokracovat);
    const dal = await get(`/dal/${v3.data.propustka}/rozved`);
    ok(dal.status === 200 && dal.data.komu === "Fable" && dal.data.stav === "queued", "/dal/PROPUSTKA/rozved pošle Rozveď to poslednímu agentovi (Fable)", dal.data);
    const dalOdp = await pockejNa(async () => { const s = await get(`/s/${v3.data.propustka}`); return s.data.zpravy.some(m => m.od === "Fable" && m.odpoved_na === dal.data.id); }, 8000);
    ok(dalOdp, "Fable na pokračování odpověděl a odpověď je spárovaná");
    const dalHtml = await fetch(`${BASE}/dal/${v3.data.propustka}/priklad`, { headers: { Accept: "text/html" } });
    ok(dalHtml.status === 200 && (await dalHtml.text()).includes("<html"), "/dal v prohlížeči (ťuknutí člověka) vrátí čitelnou HTML stránku");
    const neznamy = await get(`/dal/${v3.data.propustka}/neexistuje`);
    ok(neznamy.status === 404, "neznámý klíč pokračování → 404");

    console.log("\n12a) Adresa s diakritikou a HEAD — na tom to lidem i chatům padalo");
    const diakr = await get(`/n%C3%A1vsteva?n=d1`);                    /* /návsteva */
    ok(diakr.status === 200 && !!diakr.data.propustka, "/návsteva (s háčkem) funguje jako /navsteva", diakr.status);
    const diakr2 = await get(`/schr%C3%A1nka/${jedna.data.propustka}`); /* /schránka */
    ok(diakr2.status === 200 && diakr2.data.prezdivka === jedna.data.prezdivka, "/schránka/PROPUSTKA funguje jako /schranka", diakr2.status);
    for (const [u, popis] of [["/navsteva", "GET /navsteva vrací 200, ne 201"], ["/", "GET / vrací 200"]]) {
      const r = await fetch(BASE + u); ok(r.status === 200, popis, r.status);
    }
    for (const u of ["/", "/navsteva", `/s/${jedna.data.propustka}`]) {
      const r = await fetch(BASE + u, { method: "HEAD" });
      ok(r.status === 200, `HEAD ${u} vrací 200 (dřív 404 a klient načtení vzdal)`, r.status);
    }
    const pocetPredHead = (await get(`/s/${jedna.data.propustka}`)).data.pocet;
    await fetch(BASE + "/navsteva", { method: "HEAD" });
    ok((await get(`/s/${jedna.data.propustka}`)).data.pocet === pocetPredHead, "HEAD nezaloží návštěvu ani zprávu (žádné vedlejší účinky)");

    console.log("\n12b) Zkomolená propustka: chaty ji přepisují s diakritikou a jinak dělenou");
    ok(!!jedna.data.dotaz_odeslan.odpoved_precti_zde && jedna.data.dotaz_odeslan.odpoved_precti_zde.endsWith(`/s/${jedna.data.propustka}`),
      "potvrzení o odeslání nese rovnou adresu schránky (odpoved_precti_zde)", jedna.data.dotaz_odeslan.odpoved_precti_zde);
    const pk = jedna.data.propustka;                                  /* např. zlaty-potok-994211 */
    const [w1, w2, cislo] = pk.split("-");
    const komolene = `${w1.replace(/y$/, "ý")} ${w2} ${cislo.slice(0, 5)}-${cislo.slice(5)}`;   /* „zlatý potok 99421-1" */
    const sk = await get(`/s/${enc(komolene)}`);
    ok(sk.status === 200 && sk.data.prezdivka === jedna.data.prezdivka, `zkomolená propustka „${komolene}" schránku přesto otevře`, sk.data.prezdivka);
    const skVelka = await get(`/s/${enc(pk.toUpperCase().replace(/-/g, "_"))}`);
    ok(skVelka.status === 200, "velká písmena a jiné oddělovače taky projdou");
    const skCizi = await get("/s/zlaty-potok-000000");
    ok(skCizi.status === 403, "jiná propustka cizí schránku neotevře");
    const skKratka = await get("/s/abc-1");
    ok(skKratka.status === 403, "moc krátký klíč se nepokouší dohledávat");

    console.log("\n13b) Hotové úvodní adresy: chat začne rozhovor sám, bez skládání adres");
    const rz = await get("/navsteva");
    const fableCard = rz.data.kdo_je_na_siti.find(a => a.jmeno === "Fable");
    ok(fableCard && fableCard.zacit && fableCard.zacit.predstav_se.includes(`/u/${rz.data.propustka}/Fable/predstav_se`), "u každého agenta je pole zacit s hotovými adresami", fableCard && fableCard.zacit);
    ok(!!rz.data.jak_zacit_rozhovor_sam, "rozcestník vysvětluje, že tyhle adresy chat otevřít smí");
    const u1 = await get(`/u/${rz.data.propustka}/Fable/predstav_se`);
    ok(u1.status === 200 && u1.data.komu === "Fable" && u1.data.stav === "queued", "/u/PROPUSTKA/Fable/predstav_se pošle úvodní dotaz", u1.data);
    const u1odp = await pockejNa(async () => (await get(`/s/${rz.data.propustka}`)).data.zpravy.some(m => m.od === "Fable" && m.odpoved_na === u1.data.id), 8000);
    ok(u1odp, "Fable na úvodní dotaz odpověděl a odpověď je spárovaná");
    const u2 = await get(`/u/${rz.data.propustka}/Aja/co_umis`);
    ok(u2.status === 200 && u2.data.komu === "Aja", "úvodní adresa funguje i pro jiného agenta (Aja)", u2.data);
    const uX = await get(`/u/${rz.data.propustka}/Fable/neexistuje`);
    ok(uX.status === 404, "neznámý klíč úvodu → 404");

    console.log("\n14) Vlastní GPT (Actions): schéma nese návštěvnickou cestu bez tokenu");
    const spec = await get("/openapi-actions.json");
    const ops = Object.values(spec.data.paths).flatMap(p => Object.values(p).map(o => o.operationId));
    ok(["startVisit", "askAgent", "askForAdvice", "getReplies", "continueThread", "getMessage", "sendMessage", "readMessages"].every(o => ops.includes(o)), "operationId pro celý průchod jsou ve schématu", ops);
    ok(spec.data.paths["/navsteva"].get.security.length === 0 && spec.data.paths["/s/{propustka}"].get.security.length === 0, "návštěvnické operace jsou bez autentizace (veřejný GPT)");
    ok(!!spec.data.paths["/api/messages"].post.requestBody.content["application/json"].schema.properties.in_reply_to, "sendMessage umí in_reply_to");
    /* to, co GPT skutečně zavolá: startVisit s dotazem → getReplies */
    const sv2 = await get(`/navsteva?to=Fable&dotaz=${enc("dotaz pres Actions")}`);
    const odp = await pockejNa(async () => (await get(`/s/${sv2.data.propustka}`)).data.zpravy.some(m => m.od === "Fable" && m.odpoved_na === sv2.data.dotaz_odeslan.id), 8000);
    ok(odp, "startVisit(dotaz) → getReplies: odpověď Fabla spárovaná s dotazem (průchod jednoho GPT volání)");

    console.log(`\n${chyb === 0 ? "✅" : "❌"} ${kroku - chyb}/${kroku} kroků prošlo${chyb ? `, ${chyb} selhalo` : ""}`);
    if (mock) mock.close();
    await stopServer();
    fs.rmSync(DIR, { recursive: true, force: true });
    process.exit(chyb ? 1 : 0);
  } catch (e) {
    console.error("\n❌ test spadl:", e.message);
    await stopServer();
    process.exit(1);
  }
})();
