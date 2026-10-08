#!/usr/bin/env node
/**
 * AInet — zkouška ordinace Organizera.
 *
 * Co se tu ověřuje:
 *   1. Server založí Organizera; objednávka [OBJEDNANI] od Mostu (i když přijde
 *      Fablovi) se rozebere na pole, dostane navržený termín v preferovaný den
 *      a pacient dostane potvrzení přijetí přes Most ([FB:psid]) — bez termínu.
 *   2. Triage „do 2 dnů“ bere nejbližší ordinační den bez ohledu na preferenci;
 *      triage 155 pošle varování.
 *   3. Vlastník (token Fabla i Organizera) vidí kalendář, volné sloty, objednávky;
 *      cizí token ne. Potvrzení termínu pošle pacientovi zprávu přes Most,
 *      přesun hlídá kolize, ruční termín obsadí slot, zrušení ho uvolní.
 *   4. Nastavení ordinace (dny, délka, blokace) ovlivní sloty.
 *   5. Ranní přehled: sestaví se, uloží, jde Organizerovi i Fablovi; model
 *      hlášení [OBJEDNANI]/[HOVOR] nedostane; hovor [HOVOR] se uloží.
 *   6. Odchozí hovor bez nastavení vrátí srozumitelnou chybu.
 *
 * Nepotřebuje síť ani klíče — spustí si vlastní server na volném portu.
 */
const { spawn } = require("child_process");
const fs = require("fs"); const os = require("os"); const path = require("path"); const net = require("net");

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-ordinace-"));
const DB = path.join(DIR, "agents.json");
let server = null, BASE = "", kroku = 0, chyb = 0;
function ok(podminka, popis, detail) { kroku++; if (podminka) console.log(`  ✓ ${popis}`); else { chyb++; console.log(`  ✗ ${popis}${detail !== undefined ? "\n      " + JSON.stringify(detail).slice(0, 500) : ""}`); } }
const volnyPort = () => new Promise(r => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
async function get(c, h = {}) { const r = await fetch(BASE + c, { headers: { Accept: "application/json", ...h } }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
async function post(c, b, h = {}) { const r = await fetch(BASE + c, { method: "POST", headers: { "Content-Type": "application/json", ...h }, body: JSON.stringify(b) }); return { status: r.status, data: await r.json().catch(() => ({})) }; }
const cti = () => JSON.parse(fs.readFileSync(DB, "utf8"));
async function startServer(envNavic = {}) {
  const port = await volnyPort(); BASE = `http://127.0.0.1:${port}`;
  const env = { ...process.env, PORT: String(port), DATA_DIR: DIR, PUBLIC_URL: BASE, INDEXNOW: "0", KEEPALIVE_URL: "0", SEED_DOMACI: "1", PREHLED: "0", ...envNavic };
  delete env.ANTHROPIC_API_KEY; delete env.OPENAI_API_KEY;
  server = spawn(process.execPath, [path.join(__dirname, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  server.stderr.on("data", d => process.stderr.write("[server] " + d));
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "/healthz")).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error("server nenaběhl");
}
function stopServer() { return new Promise(r => { if (!server) return r(); server.on("exit", () => { server = null; r(); }); server.kill(); }); }
async function zalozLite(name, skills = "chat") {
  const r = await get(`/api/lite/register?name=${encodeURIComponent(name)}&owner=Pavel%20D%C3%ADtl&skills=${skills}`);
  const u = r.data.ukol; const a1 = u["1_soucet"].match(/\d+/g).map(Number).reduce((x, y) => x + y, 0);
  const a2 = u["2_otoc"].replace("Napiš pozpátku: ", "").split("").reverse().join(""); const a3 = u["3_opis"].replace("Opiš přesně: ", "");
  const v = await get(`/api/lite/verify?token=${r.data.token}&a1=${a1}&a2=${encodeURIComponent(a2)}&a3=${encodeURIComponent(a3)}`);
  if (v.data.stav !== "verified") throw new Error(`lite ověření ${name}: ${JSON.stringify(v.data)}`);
  return { id: r.data.id, tok: r.data.token, kod: r.data.obnovovaci_kod };
}
const objednavka = (zdroj, pole) => `[OBJEDNANI] OBJEDNÁNÍ z ${zdroj}\n` + Object.entries(pole).map(([k, v]) => `${k}: ${v}`).join("\n");
const dalsiDen = (den) => { const d = new Date(); do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() !== den); return d.toISOString().slice(0, 10); };

(async () => {
  console.log("\n╔═══════════════════════════════════════════════════════════╗");
  console.log("║  AInet — ordinace Organizera                              ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  await startServer();
  /* Fable jako lite agent (jméno Fable → domácí), pak restart, ať seed dostane vlastníka */
  const fable = await zalozLite("Fable", "orchestrace,analysis");
  const most = await zalozLite("FB-Most", "messaging");
  const cizi = await zalozLite("Cizi", "chat");
  await stopServer(); await startServer();

  console.log("\n1) Objednávka z Messengeru → navržený termín, potvrzení přijetí");
  const db0 = cti();
  const org = Object.values(db0.agents).find(a => a.card.name === "Organizer");
  ok(org && org.status === "verified" && org.card.owner === "Pavel Dítl", "Organizer existuje a patří vlastníkovi Fabla", org && org.card);
  const po = dalsiDen(1);
  const o1 = await get(`/api/lite/send?token=${most.tok}&to=Fable&text=${encodeURIComponent(objednavka("Messenger (psid 123456, 2026-10-08T10:00)", { "Požadavek": "objednání", "Jméno": "Jan Novák", "Telefon": "777 123 456", "Věk": "58", "Diagnóza": "varixy", "Triage": "běžný termín", "Hlavní potíž": "tíha a otoky", "Preferovaný den": "pondělí Bulovka" }))}`);
  ok(o1.status === 200 && o1.data.odeslano, "Most poslal objednávku Fablovi (výchozí adresát)", o1.data);
  await new Promise(r => setTimeout(r, 300));
  const kal = (await get("/api/ordinace", { "X-Owner-Token": fable.tok })).data;
  ok(kal.objednavky && kal.objednavky.length === 1 && kal.objednavky[0].jmeno === "Jan Novák" && kal.objednavky[0].psid === "123456", "objednávka rozebraná na pole (jméno, psid)", kal.objednavky);
  const obj1 = kal.objednavky[0];
  ok(obj1.stav === "navrzena" && obj1.navrzeny && obj1.navrzeny.stav === "navrzen", "termín navržen a rezervován", obj1.navrzeny);
  ok(obj1.navrzeny && new Date(obj1.navrzeny.kdy).toISOString().slice(0, 10) === po && obj1.navrzeny.misto === "Bulovka", `navržen nejbližší pondělí (${po}) na Bulovce`, obj1.navrzeny && obj1.navrzeny.kdy);
  const mostInbox = (await get(`/api/lite/inbox?token=${most.tok}`)).data;
  const ack = (mostInbox.zpravy || []).find(m => m.od === "Organizer" && /^\[FB:123456\]/.test(m.text));
  ok(ack && /přijali/.test(ack.text) && !/pondělí/.test(ack.text), "pacient dostal potvrzení přijetí bez termínu (od Organizera přes Most)", ack && ack.text);
  const fInbox = (await get(`/api/messages?agent=${fable.id}`, { "X-Owner-Token": fable.tok })).data;
  const puv = fInbox.find(m => /^\[OBJEDNANI\]/.test(m.text));
  ok(puv && puv.status === "answered", "původní objednávka u Fabla je vyřízená (Sentinel ji neurguje)", puv && puv.status);
  ok(fInbox.some(m => m.fromName === "Ordinace" && /Jan Novák/.test(m.text)), "Fable dostal hlášení o nové objednávce", null);

  console.log("\n2) Triage");
  const ct = dalsiDen(4);
  await get(`/api/lite/send?token=${most.tok}&to=Organizer&text=${encodeURIComponent(objednavka("webu (web_abc, 2026-10-08T11:00)", { "Jméno": "Eva Malá", "Telefon": "608111222", "Triage": "do 2 dnů", "Hlavní potíž": "zarudlá zatvrdlá žíla", "Preferovaný den": "čtvrtek" }))}`);
  await get(`/api/lite/send?token=${most.tok}&to=Organizer&text=${encodeURIComponent(objednavka("hlasového hovoru (2026-10-08T12:00)", { "Jméno": "Petr Rychlý", "Telefon": "601000111", "Triage": "155", "Hlavní potíž": "náhle oteklá noha a dušnost" }))}`);
  await new Promise(r => setTimeout(r, 300));
  const kal2 = (await get("/api/ordinace", { "X-Owner-Token": org.ownerToken })).data;
  const eva = kal2.objednavky.find(x => x.jmeno === "Eva Malá"), petr = kal2.objednavky.find(x => x.jmeno === "Petr Rychlý");
  const prvniOrd = [dalsiDen(1), dalsiDen(4)].sort()[0];
  ok(eva && eva.zdroj === "web" && eva.navrzeny && new Date(eva.navrzeny.kdy).toISOString().slice(0, 10) === prvniOrd, `triage „do 2 dnů“: nejbližší ordinační den (${prvniOrd}), ne až čtvrtek ${ct}`, eva && eva.navrzeny && eva.navrzeny.kdy);
  ok(petr && petr.urgentni === true && petr.zdroj === "hovor", "triage 155 je označená jako urgentní", petr);
  const dbA = cti();
  const varovani = dbA.messages.find(m => m.fromName === "Organizer" && /155/.test(m.text) && /naléhav/.test(m.text));
  ok(!!varovani, "u triage 155 Organizer poslal varování (volejte 155)", null);

  console.log("\n3) Práva, potvrzení, přesun, ruční termín, zrušení");
  const c1 = await get("/api/ordinace", { "X-Owner-Token": cizi.tok });
  ok(c1.status === 403, "cizí agent ordinaci nevidí");
  const c2 = await get("/api/ordinace");
  ok(c2.status === 403, "bez tokenu 403");
  const potv = await post(`/api/ordinace/terminy/${obj1.navrzeny.id}`, { akce: "potvrdit" }, { "X-Owner-Token": fable.tok });
  ok(potv.status === 200 && potv.data.termin.stav === "potvrzen" && potv.data.oznameno === true, "vlastník potvrdil termín, pacient informován", potv.data);
  const mostInbox2 = (await get(`/api/lite/inbox?token=${most.tok}`)).data;
  const conf = (mostInbox2.zpravy || []).find(m => m.od === "Organizer" && /^\[FB:123456\]/.test(m.text) && /potvrzujeme/i.test(m.text));
  ok(conf && /Bulovka/.test(conf.text) && /pondělí/.test(conf.text), "potvrzení pacientovi nese den i místo", conf && conf.text);
  const kal3 = (await get(`/api/ordinace?od=${po}&dni=1`, { "X-Owner-Token": fable.tok })).data;
  const denPo = kal3.dny.find(d => d.datum === po);
  ok(denPo && denPo.terminy.length >= 1 && !denPo.volno.some(s => s.kdy === obj1.navrzeny.kdy), "obsazený slot není mezi volnými", denPo && denPo.volno.slice(0, 3));
  const kolize = await post(`/api/ordinace/terminy`, { kdy: obj1.navrzeny.kdy, pacient: { jmeno: "Kolize" } }, { "X-Owner-Token": fable.tok });
  ok(kolize.status === 201, "ruční termín se založí (kolize hlídá jen přesun)");
  const pres = await post(`/api/ordinace/terminy/${kolize.data.termin.id}`, { akce: "presunout", kdy: obj1.navrzeny.kdy }, { "X-Owner-Token": fable.tok });
  ok(pres.status === 400 && /někdo/.test(pres.data.error), "přesun na obsazený čas odmítne", pres.data);
  const volny = denPo.volno[0];
  const pres2 = await post(`/api/ordinace/terminy/${kolize.data.termin.id}`, { akce: "presunout", kdy: volny.kdy }, { "X-Owner-Token": fable.tok });
  ok(pres2.status === 200 && pres2.data.termin.kdy === volny.kdy && pres2.data.termin.historie.some(h => /přesun/.test(h.co)), "přesun na volný slot projde a zapíše se do historie", pres2.data);
  const zrus = await post(`/api/ordinace/terminy/${kolize.data.termin.id}`, { akce: "zrusit", duvod: "test" }, { "X-Owner-Token": fable.tok });
  ok(zrus.status === 200 && zrus.data.termin.stav === "zrusen", "zrušení termínu");
  const kal4 = (await get(`/api/ordinace?od=${po}&dni=1`, { "X-Owner-Token": fable.tok })).data;
  ok(kal4.dny[0].volno.some(s => s.kdy === volny.kdy), "zrušený slot je zase volný");
  const navrh = await post(`/api/ordinace/objednavky/${eva.id}`, { akce: "navrhnout", den: "čtvrtek" }, { "X-Owner-Token": fable.tok });
  ok(navrh.status === 200 && navrh.data.navrh.length >= 3 && navrh.data.navrh.every(s => s.misto === "Neratovice"), "nový návrh termínů pro objednávku (čtvrtek = Neratovice)", navrh.data);
  const zrusO = await post(`/api/ordinace/objednavky/${petr.id}`, { akce: "zrusit" }, { "X-Owner-Token": fable.tok });
  ok(zrusO.status === 200 && zrusO.data.objednavka.stav === "zrusena", "zrušení objednávky");

  console.log("\n4) Nastavení ordinace");
  const nast = await post("/api/ordinace/nastaveni", { delka: 30, dny: { "1": { misto: "Bulovka", od: "09:00", do: "12:00" }, "4": { misto: "Neratovice", od: "08:00", do: "15:00" } }, blokace: [{ od: ct, do: ct, duvod: "kongres" }] }, { "X-Owner-Token": fable.tok });
  ok(nast.status === 200 && nast.data.nastaveni.delka === 30, "nastavení uloženo", nast.data);
  const kal5 = (await get(`/api/ordinace?od=${po}&dni=7`, { "X-Owner-Token": fable.tok })).data;
  const dPo = kal5.dny.find(d => d.datum === po), dCt = kal5.dny.find(d => d.datum === ct);
  ok(dPo && dPo.volno.every(s => s.cas >= "09:00" && s.cas < "12:00") && dPo.volno.length <= 6, "pondělí má sloty jen 9–12 po 30 minutách", dPo && dPo.volno.map(s => s.cas));
  ok(dCt && dCt.blokace && dCt.volno.length === 0, "blokovaný čtvrtek nemá volné sloty", dCt && dCt.blokace);

  console.log("\n5) Přehled, hlášení, hovory");
  await get(`/api/lite/send?token=${most.tok}&to=Organizer&text=${encodeURIComponent("[HOVOR] Volal pan Dvořák, ptal se na kompresní punčochy, objednat zatím nechce.")}`);
  await new Promise(r => setTimeout(r, 200));
  const pr = await post("/api/ordinace/prehled", {}, { "X-Owner-Token": fable.tok });
  ok(pr.status === 200 && /Ranní přehled/.test(pr.data.text) && /Čeká na tvoje potvrzení/.test(pr.data.text) && /Eva Malá/.test(pr.data.text), "přehled sestaven s objednávkami k potvrzení", pr.data.text);
  ok(/Hovory z poradny/.test(pr.data.text) && /Dvořák/.test(pr.data.text), "přehled obsahuje hovor z poradny", null);
  const prG = (await get("/api/ordinace/prehled", { "X-Owner-Token": org.ownerToken })).data;
  ok(prG.ulozeny && prG.ulozeny.text === pr.data.text, "přehled je uložený pod dnešním datem");
  const dbB = cti();
  ok(dbB.messages.filter(m => m.fromName === "Ranní přehled").length === 2, "přehled šel Organizerovi i Fablovi", dbB.messages.filter(m => m.fromName === "Ranní přehled").map(m => m.toName));
  ok(dbB.ordinace.hovory.length >= 1 && /Dvořák/.test(dbB.ordinace.hovory[0].text), "hovor uložen v ordinaci");

  console.log("\n5b) Bezpečnost: cizí agent kalendář neplní, domácí nespí, kódy se nehádají");
  const podvrh = await get(`/api/lite/send?token=${cizi.tok}&to=Organizer&text=${encodeURIComponent(objednavka("webu (x)", { "Jméno": "Podvrh", "Telefon": "600000000", "Preferovaný den": "pondělí" }))}`);
  ok(podvrh.status === 200, "cizí agent zprávu [OBJEDNANI] poslat může…");
  await new Promise(r => setTimeout(r, 200));
  const kalP = (await get("/api/ordinace", { "X-Owner-Token": fable.tok })).data;
  ok(!kalP.objednavky.some(x => x.jmeno === "Podvrh") && !kalP.dny.some(d => d.terminy.some(t => t.pacient.jmeno === "Podvrh")), "…ale do ordinace se nedostane (hlášení bere Organizer jen od Mostu)", kalP.objednavky.map(x => x.jmeno));
  ok(!/Jan Novák/.test(JSON.stringify((await get("/api/log")).data)), "jméno pacienta není ve veřejném logu");
  await stopServer();
  { const dbX = cti(); const davno = new Date(Date.now() - 40 * 86400_000).toISOString(); for (const a of Object.values(dbX.agents)) if (a.domaci) { a.lastSeen = davno; a.verifiedAt = davno; a.registered = davno; } fs.writeFileSync(DB, JSON.stringify(dbX)); }
  await startServer();
  const kat = (await get("/api/agents")).data;
  ok(kat.find(a => a.name === "Organizer") && !kat.find(a => a.name === "Organizer").spi, "Organizer po 40 dnech ticha nespí (domácí agent je vždy k mání)", kat.find(a => a.name === "Organizer"));
  const o40 = await get(`/api/lite/send?token=${most.tok}&to=Organizer&text=${encodeURIComponent(objednavka("webu (y)", { "Jméno": "Pozdní", "Telefon": "600000001" }))}`);
  ok(o40.status === 200 && o40.data.odeslano, "Most mu pošle objednávku i po 40 dnech ticha", o40.data);
  ok(/^d-[a-f0-9]{24}$/.test(org.recoveryCode) && org.ownerToken !== org.liteToken, "Organizer má dlouhý obnovovací kód a token zvlášť (neuhodnutelné)", org.recoveryCode);
  let posledni = 0;
  for (let i = 0; i < 11; i++) posledni = (await get(`/obnova/rudy-havran-${10 + i}`)).status;
  ok(posledni === 429, "po 10 špatných kódech dostane adresa 429 (brzda proti hádání)", posledni);
  const okKod = await get(`/obnova/${org.recoveryCode}`);
  ok(okKod.status === 429, "…a platí i pro správný kód, dokud brzda neodezní", okKod.status);

  console.log("\n6) Odchozí hovor bez nastavení");
  const zav = await post("/api/ordinace/zavolat", { telefon: "777123456", ucel: "test" }, { "X-Owner-Token": fable.tok });
  ok(zav.status === 400 && /MOST_KLIC/.test(zav.data.error), "bez MOST_KLIC vrátí srozumitelnou chybu", zav.data);

  await stopServer();
  fs.rmSync(DIR, { recursive: true, force: true });
  console.log(`\n${chyb ? "❌" : "✅"} ${kroku - chyb}/${kroku} kroků prošlo\n`);
  process.exit(chyb ? 1 : 0);
})().catch(async (e) => { console.error("\n💥 " + e.message); await stopServer(); process.exit(1); });
