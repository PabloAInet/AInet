#!/usr/bin/env node
/**
 * AInet — zkouška MarketPlace (tržiště).
 *
 * Co se tu ověřuje:
 *   1. Vlastník pošle fotku → model (atrapa) ji rozpozná → inzerát se zveřejní
 *      s odhadem, cenou a prahem „prodat od“; fotka je na /trh/obrazek/:id,
 *      inzerát na /trh (HTML) i /api/trh (JSON) a v MCP list_market.
 *   2. Práva: nabízet smí jen ověřený agent; vlastnické cesty jen domácí token.
 *   3. Obchod: nabídka pod prahem → protinávrh (zpráva kupujícímu, hlášení
 *      Fablovi); nabídka nad prahem → automaticky přijato, kupující dostane
 *      kontakt, ostatní „neprijata“; bez auto čeká na vlastníka → prijmout/odmitnout.
 *   4. Úpravy, stažení, smazání; bez modelu vznikne návrh k doplnění.
 */
const { spawn } = require("child_process");
const fs = require("fs"); const os = require("os"); const path = require("path"); const net = require("net"); const http = require("http");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-trh-"));
let server = null, BASE = "", kroku = 0, chyb = 0;
function ok(c, popis, detail) { kroku++; if (c) console.log(`  ✓ ${popis}`); else { chyb++; console.log(`  ✗ ${popis}${detail !== undefined ? "\n      " + JSON.stringify(detail).slice(0, 500) : ""}`); } }
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function get(c, h = {}) { const r = await fetch(BASE + c, { headers: { Accept: "application/json", ...h } }); const ct = r.headers.get("content-type") || ""; return { status: r.status, ct, data: /json/.test(ct) ? await r.json().catch(() => ({})) : await r.text() }; }
async function post(c, b, h = {}) { const r = await fetch(BASE + c, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function del(c, h = {}) { const r = await fetch(BASE + c, { method: "DELETE", headers: h }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function mcp(name, args = {}) { const r = await post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }); return r.data.result ? r.data.result.structuredContent : { error: r.data.error }; }
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

let posledniUser = null, volani = 0;
const atrapa = http.createServer((req, res) => {
  let d = ""; req.on("data", c => d += c);
  req.on("end", () => {
    volani++;
    try { const b = JSON.parse(d); posledniUser = b.messages.find(m => m.role === "user"); } catch {}
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: 'Tady je inzerát:\n{"nazev":"Dětská dřevěná židlička IKEA","kategorie":"nábytek","popis":"Dřevěná dětská židlička, výška sedáku cca 30 cm, bez poškození.","stav_veci":"velmi dobrý","odhad_min_czk":300,"odhad_max_czk":500,"zduvodneni":"podobné kusy na Bazoši 300–500 Kč","klicova_slova":["židlička","IKEA","dětská","dřevo"]}' } }] }));
  });
});

async function startServer(envNavic = {}) {
  const port = await volnyPort(); BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: DIR, PUBLIC_URL: BASE, INDEXNOW: "0", KEEPALIVE_URL: "0", SEED_DOMACI: "1", PREHLED: "0", RADAR: "0", ...envNavic };
  if (!envNavic.OPENAI_API_KEY) delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  server = spawn(process.execPath, [path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", d => process.stderr.write("[server] " + d));
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "/healthz")).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error("server nenaběhl");
}
function stopServer() { return new Promise(r => { if (!server) return r(); server.on("exit", () => { server = null; r(); }); server.kill(); }); }
async function zalozLite(name, owner = "Test", skills = "chat") {
  const r = await get(`/api/lite/register?name=${encodeURIComponent(name)}&owner=${encodeURIComponent(owner)}&skills=${skills}`);
  const u = r.data.ukol; const a1 = u["1_soucet"].match(/\d+/g).map(Number).reduce((x, y) => x + y, 0);
  const a2 = u["2_otoc"].replace("Napiš pozpátku: ", "").split("").reverse().join(""); const a3 = u["3_opis"].replace("Opiš přesně: ", "");
  const v = await get(`/api/lite/verify?token=${r.data.token}&a1=${a1}&a2=${encodeURIComponent(a2)}&a3=${encodeURIComponent(a3)}`);
  if (v.data.stav !== "verified") throw new Error(`lite ověření ${name}: ${JSON.stringify(v.data)}`);
  return { id: r.data.id, tok: r.data.token };
}

(async () => {
  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║  AInet — MarketPlace (tržiště)                            ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  await new Promise(r => atrapa.listen(0, r));
  await startServer({ OPENAI_API_KEY: "test", LLM_PROVIDER: "openai", LLM_API_URL: `http://127.0.0.1:${atrapa.address().port}/v1/chat/completions` });
  const fable = await zalozLite("Fable", "Pavel Dítl", "orchestrace");
  const aja = await zalozLite("Aja", "Andrea", "research");
  const bob = await zalozLite("Bob", "Robert", "chat");
  await stopServer(); await startServer({ OPENAI_API_KEY: "test", LLM_PROVIDER: "openai", LLM_API_URL: `http://127.0.0.1:${atrapa.address().port}/v1/chat/completions` });

  console.log("\n1) Fotka → inzerát");
  await post("/api/trh/nastaveni", { kontakt: "Pavel, tel. 777 000 111", auto: true }, { "X-Owner-Token": fable.tok });
  const n1 = await post("/api/trh/nabidnout", { obrazek: `data:image/png;base64,${PNG}`, poznamka: "židlička po dětech" }, { "X-Owner-Token": fable.tok });
  ok(n1.status === 201 && n1.data.ok && n1.data.rozpoznani && n1.data.inzerat.nazev === "Dětská dřevěná židlička IKEA", "model rozpoznal věc z fotky a vznikl inzerát", n1.data);
  const inz = n1.data.inzerat;
  ok(inz.stav === "zverejnen" && inz.cena === 400 && inz.prodat_od === 300 && inz.odhad.max === 500, "zveřejněno: cena = střed odhadu (400), prodat od = minimum (300)", { stav: inz.stav, cena: inz.cena, od: inz.prodat_od });
  ok(posledniUser && Array.isArray(posledniUser.content) && posledniUser.content.some(c => c.type === "image_url") && /židlička po dětech/.test(JSON.stringify(posledniUser)), "model dostal obrázek i poznámku vlastníka", null);
  const obr = await fetch(`${BASE}/trh/obrazek/${inz.id}`);
  ok(obr.status === 200 && obr.headers.get("content-type") === "image/png", "fotka se servíruje z /trh/obrazek/:id");
  const html = await get("/trh");
  ok(html.status === 200 && /text\/html/.test(html.ct) && /Dětská dřevěná židlička/.test(html.data) && /400 Kč/.test(html.data), "veřejná stránka /trh ukazuje inzerát s cenou", null);
  const ver = (await get("/api/trh")).data;
  ok(ver.inzeraty.length === 1 && ver.inzeraty[0].obrazek === `/trh/obrazek/${inz.id}` && ver.inzeraty[0].prodejce === "MarketPlace" && !("prodat_od" in ver.inzeraty[0]), "veřejné API neprozradí práh ani kontakt", ver.inzeraty[0]);
  const lm = await mcp("list_market", { query: "ikea" });
  ok(lm.items && lm.items.length === 1 && lm.items[0].id === inz.id, "MCP list_market s filtrem", lm);
  const lm0 = await mcp("list_market", { query: "lednice" });
  ok(lm0.items && lm0.items.length === 0, "filtr, který nesedí, vrátí prázdno");

  console.log("\n2) Práva");
  const nbez = await post(`/api/trh/${inz.id}/nabidka`, { cena: 350 });
  ok(nbez.status === 403, "nabídka bez tokenu 403");
  const moje = await get("/api/trh/moje", { "X-Owner-Token": aja.tok });
  ok(moje.status === 403, "cizí agent nevidí vlastnické cesty");
  const mojeOk = (await get("/api/trh/moje", { "X-Owner-Token": fable.tok })).data;
  ok(mojeOk.inzeraty.length === 1 && mojeOk.inzeraty[0].prodat_od === 300 && mojeOk.nastaveni.kontakt === "Pavel, tel. 777 000 111", "vlastník vidí práh i kontakt", mojeOk.nastaveni);

  console.log("\n3) Obchod");
  const o1 = await mcp("make_offer", { token: aja.tok, listing_id: inz.id, price: 200, message: "Pro neteř." });
  ok(o1.ok && o1.stav === "protinavrh" && o1.prodat_od === 300, "nabídka pod prahem → protinávrh", o1);
  const ajaInbox = (await get(`/api/lite/inbox?token=${aja.tok}`)).data;
  ok((ajaInbox.zpravy || []).some(m => m.od === "MarketPlace" && /prodá za 300/.test(m.text)), "kupující dostal protinávrh od MarketPlace", null);
  const fIn = (await get(`/api/messages?agent=${fable.id}`, { "X-Owner-Token": fable.tok })).data;
  ok(fIn.some(m => m.fromName === "Trh" && /200 Kč od Aja/.test(m.text)), "Fable dostal hlášení o nabídce");
  const o2 = await post(`/api/trh/${inz.id}/nabidka`, { cena: 320, zprava: "Beru." }, { "X-Owner-Token": bob.tok });
  ok(o2.status === 200 && o2.data.stav === "prodano" && /Kontakt vlastníka: Pavel/.test(o2.data.zprava), "nabídka nad prahem → prodáno automaticky, kupující dostal kontakt", o2.data);
  const bobInbox = (await get(`/api/lite/inbox?token=${bob.tok}`)).data;
  ok((bobInbox.zpravy || []).some(m => m.od === "MarketPlace" && /přijata/.test(m.text) && /777 000 111/.test(m.text)), "zpráva kupujícímu s kontaktem", null);
  const ajaInbox2 = (await get(`/api/lite/inbox?token=${aja.tok}`)).data;
  ok((ajaInbox2.zpravy || []).some(m => m.od === "MarketPlace" && /prodaný/.test(m.text)), "ostatní zájemci dostali „prodáno“");
  const ver2 = (await get("/api/trh")).data;
  ok(ver2.inzeraty.length === 0, "prodaný inzerát z veřejného seznamu zmizel");
  const o3 = await mcp("make_offer", { token: aja.tok, listing_id: inz.id, price: 500 });
  ok(o3.error && /není v nabídce/.test(o3.error), "na prodaný inzerát už nabídka nejde", o3);

  console.log("\n4) Bez auto: rozhoduje vlastník; úpravy, stažení, smazání, bez modelu");
  const n2 = await post("/api/trh/nabidnout", { obrazek: `data:image/png;base64,${PNG}`, auto: false, cena: 1000, prodat_od: 800 }, { "X-Owner-Token": fable.tok });
  const inz2 = n2.data.inzerat;
  ok(n2.status === 201 && inz2.auto === false && inz2.cena === 1000 && inz2.prodat_od === 800, "ruční cena a práh přebijí odhad; auto vypnuté", { auto: inz2.auto, cena: inz2.cena });
  const o4 = await mcp("make_offer", { token: aja.tok, listing_id: inz2.id, price: 900 });
  ok(o4.ok && o4.stav === "nova", "bez auto nabídka čeká na vlastníka", o4);
  const mojeB = (await get("/api/trh/moje", { "X-Owner-Token": fable.tok })).data.inzeraty.find(x => x.id === inz2.id);
  const nabId = mojeB.nabidky[0].id;
  const odm = await post(`/api/trh/${inz2.id}/odmitnout`, { nabidkaId: nabId, duvod: "málo" }, { "X-Owner-Token": fable.tok });
  ok(odm.status === 200, "vlastník nabídku odmítl");
  const o5 = await mcp("make_offer", { token: bob.tok, listing_id: inz2.id, price: 950 });
  const mojeC = (await get("/api/trh/moje", { "X-Owner-Token": fable.tok })).data.inzeraty.find(x => x.id === inz2.id);
  const pri = await post(`/api/trh/${inz2.id}/prijmout`, { nabidkaId: mojeC.nabidky.find(n => n.cena === 950).id }, { "X-Owner-Token": fable.tok });
  ok(pri.status === 200 && pri.data.stav === "prodano" && pri.data.nabidka.jmeno === "Bob", "vlastník přijal nabídku Boba", pri.data);
  const n3 = await post("/api/trh/nabidnout", { obrazek: `data:image/png;base64,${PNG}` }, { "X-Owner-Token": fable.tok });
  const up = await post(`/api/trh/${n3.data.inzerat.id}`, { nazev: "Lampa", cena: 150, stav: "stazen" }, { "X-Owner-Token": fable.tok });
  ok(up.status === 200 && up.data.inzerat.nazev === "Lampa" && up.data.inzerat.stav === "stazen", "úprava a stažení inzerátu", up.data);
  const dl = await del(`/api/trh/${n3.data.inzerat.id}`, { "X-Owner-Token": fable.tok });
  ok(dl.status === 200 && (await fetch(`${BASE}/trh/obrazek/${n3.data.inzerat.id}`)).status === 404, "smazání odstraní i fotku");
  const spatny = await post("/api/trh/nabidnout", { obrazek: "data:text/plain;base64,QUJD" }, { "X-Owner-Token": fable.tok });
  ok(spatny.status === 400, "jiný formát než obrázek odmítne");
  const velky = Buffer.concat([Buffer.from(PNG, "base64"), require("crypto").randomBytes(1_200_000)]).toString("base64");
  const nv = await post("/api/trh/nabidnout", { obrazek: `data:image/png;base64,${velky}` }, { "X-Owner-Token": fable.tok });
  ok(nv.status === 201, "fotka 1,2 MB (dataURL 1,6 M znaků) projde — tělo požadavku má pro trh vyšší strop", nv.data);
  const obri = Buffer.concat([Buffer.from(PNG, "base64"), require("crypto").randomBytes(2_000_000)]).toString("base64");
  const no = await post("/api/trh/nabidnout", { obrazek: `data:image/png;base64,${obri}` }, { "X-Owner-Token": fable.tok }).catch(() => ({ status: 0 }));
  ok(no.status === 400 || no.status === 0, "fotka 2 MB už neprojde (strop 1,8 MB)", no.status);
  await stopServer(); await startServer();   /* bez modelu */
  const n4 = await post("/api/trh/nabidnout", { obrazek: `data:image/png;base64,${PNG}` }, { "X-Owner-Token": fable.tok });
  ok(n4.status === 201 && n4.data.inzerat.stav === "navrh" && n4.data.rozpoznani === null && /doplň název/.test(n4.data.inzerat.nazev), "bez modelu vznikne návrh k ručnímu doplnění", n4.data.inzerat);
  const ver3 = (await get("/api/trh")).data;
  ok(!ver3.inzeraty.some(x => x.id === n4.data.inzerat.id), "návrh není veřejný");

  await stopServer(); atrapa.close();
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${chyb ? "❌" : "✅"} ${kroku - chyb}/${kroku} kroků prošlo\n`);
  process.exit(chyb ? 1 : 0);
})().catch(async (e) => { console.error("\n💥 " + e.message); await stopServer(); process.exit(1); });
