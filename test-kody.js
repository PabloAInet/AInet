#!/usr/bin/env node
/**
 * AInet — ochrana obnovovacích kódů (11. 10. 2026).
 * Adresa za proxy se nedá podvrhnout první položkou X-Forwarded-For, denní strop na adresu,
 * globální zavření krátkých kódů při hádání z mnoha adres, /ukoly neprozradí kód,
 * /api/lite/paste počítá chybné kódy, nové kódy mají čtyři číslice, karanténa podle jména neprozradí kód.
 */
const { spawn } = require("child_process");
const fs = require("fs"); const os = require("os"); const path = require("path"); const net = require("net");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-kody-"));
let server = null, BASE = "", kroku = 0, chyb = 0;
function ok(c, popis, detail) { kroku++; if (c) console.log(`  ✓ ${popis}`); else { chyb++; console.log(`  ✗ ${popis}${detail !== undefined ? "\n      " + JSON.stringify(detail).slice(0, 500) : ""}`); } }
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function get(c, h = {}) { const r = await fetch(BASE + c, { headers: { Accept: "application/json", ...h } }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function post(c, b, h = {}) { const r = await fetch(BASE + c, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function startServer(envNavic = {}) {
  const port = await volnyPort(); BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: DIR, PUBLIC_URL: BASE, INDEXNOW: "0", KEEPALIVE_URL: "0", SEED_DOMACI: "0", PREHLED: "0", RADAR: "0", ...envNavic };
  delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY;
  server = spawn(process.execPath, [path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", d => process.stderr.write("[server] " + d));
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "/healthz")).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error("server nenaběhl");
}
function stopServer() { return new Promise(r => { if (!server) return r(); server.on("exit", () => { server = null; r(); }); server.kill(); }); }
async function registruj(name, overit = true) {
  const r = await get(`/api/lite/register?name=${encodeURIComponent(name)}&owner=Test&skills=chat`);
  if (!overit) return { id: r.data.id, tok: r.data.token, kod: r.data.obnovovaci_kod, name };
  const u = r.data.ukol; const a1 = u["1_soucet"].match(/\d+/g).map(Number).reduce((x, y) => x + y, 0);
  const a2 = u["2_otoc"].replace("Napiš pozpátku: ", "").split("").reverse().join(""); const a3 = u["3_opis"].replace("Opiš přesně: ", "");
  const v = await get(`/api/lite/verify?token=${r.data.token}&a1=${a1}&a2=${encodeURIComponent(a2)}&a3=${encodeURIComponent(a3)}`);
  if (v.data.stav !== "verified") throw new Error(`ověření ${name}: ${JSON.stringify(v.data)}`);
  return { id: r.data.id, tok: r.data.token, kod: r.data.obnovovaci_kod, name };
}
const xff = (ip) => ({ "X-Forwarded-For": ip });
const spatnyKodText = (i) => `rudy-havran-${String(7000 + i)}`;   /* tvarem kód, ale žádnému agentovi nepatří */

(async () => {
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║  AInet — ochrana obnovovacích kódů                        ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  await startServer({ KOD_DEN_IP: "5", KOD_DEN_GLOBAL: "12" });
  const liska = await registruj("Liska");
  const vlk = await registruj("Vlk");
  const novacek = await registruj("Novacek", false);
  ok(/^[a-z]+-[a-z]+-\d{4}$/.test(liska.kod), "nové obnovovací kódy mají čtyři číslice (900 000 kombinací)", liska.kod);

  /* 1) podvržená první položka X-Forwarded-For už limit neobejde */
  let r;
  for (let i = 0; i < 6; i++) r = await get(`/obnova/${spatnyKodText(i)}`, xff(`1.2.3.${i}, 10.0.0.9`));
  ok(r.status === 429, "6. chybný kód s podvrženou první adresou (vždy jiná) → 429; počítá se adresa od proxy (zprava)", r);
  const hz = await get("/healthz", xff("8.8.8.8, 10.0.0.9"));
  ok(/x-forwarded-for/.test(hz.data.ip_zdroj), "/healthz ukazuje zdroj adresy (bez adresy samotné)", hz.data.ip_zdroj);
  const hzCf = await get("/healthz", { "CF-Connecting-IP": "203.0.113.5", "X-Forwarded-For": "1.1.1.1" });
  ok(hzCf.data.ip_zdroj === "cf-connecting-ip", "s Cloudflare hlavičkou se bere CF-Connecting-IP");

  /* 2) denní strop na adresu (env 5) — ani správný kód z té adresy už neprojde */
  const dobry = await get(`/obnova/${liska.kod}`, xff("10.0.0.9"));
  ok(dobry.status === 429, "zablokovaná adresa nepustí ani správný kód");
  const jinde = await get(`/obnova/${liska.kod}`, { "CF-Connecting-IP": "198.51.100.7" });
  ok(jinde.status === 200 && jinde.data.vitej_zpet === "Liska", "z jiné adresy správný kód funguje");

  /* 3) chyby, které nejsou tvarem kód (náhodné tokeny), globální pojistku nezvedají */
  for (let i = 0; i < 5; i++) await get(`/posta/nahodny-token-bez-cisla-${i}x`, { "CF-Connecting-IP": "198.51.100.20" });
  ok((await get("/healthz")).data.kody_zavreny === false, "chybné tokeny (ne tvar kódu) globální pojistku nezvednou");

  /* 4) /api/lite/paste dřív chyby nepočítal (30 pokusů za minutu = věštírna kódů) */
  let pr;
  for (let i = 0; i < 6; i++) pr = await post("/api/lite/paste", { token: spatnyKodText(100 + i), text: "{}" }, { "CF-Connecting-IP": "198.51.100.30" });
  ok(pr.status === 429, "/api/lite/paste: po 5 chybných kódech (denní strop v testu) 429", pr);

  /* 5) hádání z mnoha adres → krátké kódy zavřené pro všechny (env 12), tokeny jedou dál */
  /* dosud tvarem kódu: 6 (krok 1, 5 se počítalo do zablokování + 6. až blokem) … sečteno serverem */
  for (let ip = 40; ip < 44; ip++) for (let i = 0; i < 5; i++) await get(`/obnova/${spatnyKodText(ip * 10 + i)}`, { "CF-Connecting-IP": `198.51.100.${ip}` });
  const hz2 = await get("/healthz");
  ok(hz2.data.kody_zavreny === true, "po 12 chybných kódech z různých adres jsou krátké kódy zavřené", hz2.data);
  const zav = await get(`/obnova/${vlk.kod}`, { "CF-Connecting-IP": "198.51.100.90" });
  ok(zav.status === 429 && /dočasně zavřené/.test(zav.data.error), "i správný krátký kód z čisté adresy → 429 s vysvětlením", zav.data);
  const tokenJede = await get(`/posta/${vlk.tok}`, { "CF-Connecting-IP": "198.51.100.91" });
  ok(tokenJede.status === 200 && tokenJede.data.agent === "Vlk", "token agenta funguje dál");
  const res = await fetch(BASE + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.92" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "resume_agent", arguments: { code: vlk.kod } } }) }).then(x => x.json());
  const ra = JSON.parse(res.result.content[0].text);
  ok(/dočasně zavřené/.test(ra.error || ""), "MCP resume_agent respektuje zavření", ra);
  const log = (await get("/api/log")).data;
  ok(JSON.stringify(log).includes("OBNOVOVACÍ KÓDY ZAVŘENY"), "zavření je v provozním logu");
  ok(!JSON.stringify(log).includes("rudy-havran-7"), "zkoušené kódy se do veřejného logu nepíšou");

  /* 6) /ukoly/JMÉNO už neprozradí kód (dřív: jméno → kód → /obnova → vlastnický token) */
  await stopServer(); await startServer();   /* čisté počítadla */
  const uk = await get(`/ukoly/${liska.name}`);
  ok(uk.status === 200 && uk.data.stav === "verified" && !JSON.stringify(uk.data).includes(liska.kod), "/ukoly/JMÉNO ověřeného agenta: bez obnovovacího kódu", uk.data);
  const ukN = await get(`/ukoly/${novacek.name}`);
  ok(ukN.status === 200 && ukN.data.ukol && !JSON.stringify(ukN.data).includes(novacek.kod), "/ukoly/JMÉNO v karanténě: nové úkoly, ale kód ne", ukN.data);
  const ukK = await get(`/ukoly/${novacek.kod}`);
  ok(ukK.data.obnovovaci_kod === novacek.kod, "/ukoly/KÓD (kdo kód má) ho vidí dál");

  /* 7) karanténa: kdo zná jen JMÉNO, agenta „dověří“, ale klíč do pošty nedostane */
  const enc = encodeURIComponent;
  const vyres = (u) => [u["1_soucet"].match(/\d+/g).map(Number).reduce((x, y) => x + y, 0),
    u["2_otoc"].split(": ")[1].split("").reverse().join(""), u["3_opis"].split(": ")[1]];
  const reg = (await get(`/pripoj/Obet/Test/chat`)).data;
  ok(reg.obnovovaci_kod && reg.odesli_odpovedi_na.includes(`/overit/${reg.obnovovaci_kod}/`), "registrace posílá ověřit KÓDEM (ne jménem)", reg.odesli_odpovedi_na);
  const cizi = (await get(`/ukoly/Obet`)).data;
  const [s1, s2, s3] = vyres(cizi.ukol);
  const prevzeti = await get(`/overit/Obet/${s1}/${enc(s2)}/${enc(s3)}`);
  const txt = JSON.stringify(prevzeti.data);
  ok(prevzeti.data.stav === "verified" && !txt.includes(reg.obnovovaci_kod) && !txt.includes(reg.token), "cizí podle jména: ověřeno, ale bez kódu i tokenu", prevzeti.data);
  const posta = await get(`/posta/${reg.obnovovaci_kod}`);
  ok(posta.status === 200 && posta.data.agent === "Obet", "vlastník se svým kódem do pošty dál dostane");
  const znovu = await get(`/overit/${liska.name}/1/x/y`);
  ok(!JSON.stringify(znovu.data).includes(liska.kod), "/overit/JMÉNO už ověřeného agenta: kód se neprozradí (dřív ano)", znovu.data);
  const reg2 = (await get(`/pripoj/Poctivec/Test/chat`)).data;
  const [t1, t2, t3] = vyres(reg2.ukol);
  const vlastni = await get(reg2.odesli_odpovedi_na.replace(BASE, "").replace("SOUCET", t1).replace("OTOCENY_RETEZEC", enc(t2)).replace("OPSANY_RETEZEC", enc(t3)));
  ok(vlastni.data.stav === "verified" && vlastni.data.ctu_postu.endsWith(`/posta/${reg2.obnovovaci_kod}`), "vlastník podle návodu (kódem): ověřeno a adresa pošty jako dřív", vlastni.data);

  await stopServer();
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch {}
  console.log(chyb ? `❌ ${chyb} z ${kroku} kroků selhalo` : `✅ ${kroku}/${kroku} kroků prošlo`);
  process.exit(chyb ? 1 : 0);
})().catch(async e => { console.error(e); await stopServer(); process.exit(1); });
