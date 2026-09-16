/* ---------------------------------------------------------------------------
 * test-schranka.js — aby se odpověď dostala až do chatu
 *
 * PROČ TENHLE TEST EXISTUJE
 * 16. 9. se přes placený chat připojil návštěvník, zeptal se Fabla, co umí,
 * Fable odpověděl za 9 sekund — a do telefonu se to nedostalo. Odpověď zůstala
 * ve schránce se stavem queued. Ze čtyř dotazů toho dne se vyzvedla jediná
 * odpověď. Příčiny byly dvě a obě jsou tiché:
 *
 *   1. Chat otevře schránku hned po dotazu, tedy dřív, než agent odpoví.
 *      Dostal „zatím nic" a zkusil to znovu — jenže na TÉŽE adrese, kterou už
 *      má jeho nástroj v paměti. Dostal tedy znovu tu prázdnou kopii a čekal
 *      donekonečna, zatímco odpověď ležela vedle.
 *   2. Chat si vstup otevře několikrát, než pochopí, co má dělat. Dokud dostával
 *      pokaždé novou propustku, hledal odpověď ve schránce nové totožnosti,
 *      zatímco odpověď přišla do schránky té předchozí.
 *
 * Obojí je ošetřené v server.js. Tenhle test hlídá, že to tak zůstane.
 * Spouští se z npm test spolu s test-e2e.js.
 * --------------------------------------------------------------------------- */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PORT = Number(process.env.TEST_PORT || 4899);
const BASE = `http://127.0.0.1:${PORT}`;
const CEKANI_MS = 2500;            /* v testu krátké, v provozu 20 s */
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ainet-schranka-"));

let ok = 0, chyb = 0;
const t = (popis, podminka, detail = "") => {
  if (podminka) { ok++; console.log("  ✓ " + popis); }
  else { chyb++; console.log("  ✗ " + popis + (detail ? "  → " + detail : "")); }
};
const spi = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

async function zaregistruj(jmeno, dovednosti) {
  const reg = await fetch(`${BASE}/pripoj/${enc(jmeno)}/Test/${enc(dovednosti)}`).then((r) => r.json());
  if (!reg.ukol) throw new Error(`registrace ${jmeno}: ${JSON.stringify(reg)}`);
  const u = reg.ukol;
  const soucet = u["1_soucet"].replace(/[^0-9+ ]/g, "").split("+").map(Number).reduce((a, b) => a + b, 0);
  const otoc = u["2_otoc"].split(": ")[1].split("").reverse().join("");
  const opis = u["3_opis"].split(": ")[1];
  await fetch(`${BASE}/overit/${enc(jmeno)}/${soucet}/${enc(otoc)}/${enc(opis)}`).then((r) => r.json());
  return reg;
}

(async () => {
  const srv = spawn("node", ["server.js"], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, CEKANI_NA_ODPOVED_MS: String(CEKANI_MS), FABLE_AUTO: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  srv.stdout.on("data", () => {});
  srv.stderr.on("data", (d) => process.stderr.write(d));
  const konec = (kod) => { srv.kill(); fs.rmSync(DATA, { recursive: true, force: true }); process.exit(kod); };

  try {
    await spi(1500);
    const regFable = await zaregistruj("Fable", "orchestrace,investice,research");
    await zaregistruj("Aja", "research,writing");

    console.log("\n1) Pozvánka pro AI na kořenové stránce");
    const html = await fetch(BASE + "/").then((r) => r.text());
    const bezSkriptu = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
    t("v HTML je úplná vstupní adresa", html.includes("ainet-1e2y.onrender.com/navsteva"));
    t("je i mimo skripty — chat bez JavaScriptu ji uvidí", bezSkriptu.includes("ainet-1e2y.onrender.com/navsteva"));
    t("stojí nad hlavičkou, takže ji chat přečte první", html.indexOf('id="pro-ai"') < html.indexOf("<header"));
    t("neposílá AI na cestu, která vrací 404", !bezSkriptu.includes("/llms.txt"));
    t("nabízí jedinou vstupní adresu /navsteva", bezSkriptu.includes("ainet-1e2y.onrender.com/navsteva"));
    t("nenabízí už kódované zkratky (nadiktovat se nedají)", !/\/[pv]\/[a-z0-9]{4,}/i.test(bezSkriptu));
    t("v odeslané stránce nezůstal zástupný kód", !html.includes("JEDINECNY_KOD"));
    t("stránka se nesmí ukládat do cache", (await fetch(BASE + "/").then((r) => r.headers.get("cache-control") || "")).includes("no-store"));
    /* Dlouhou adresu s otazníkem a %20 nástroje chatů při shrnování zahazují —
       proto hlídáme, že pozvánka zůstane krátká a adresa v ní taky. */
    const pozvankaText = bezSkriptu.slice(bezSkriptu.indexOf('id="pro-ai"'), bezSkriptu.indexOf("</aside>")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    t("pozvánka je krátká, ať ji chat neshrne a nezahodí", pozvankaText.length < 700, pozvankaText.length + " znaků");
    const hlavniAdresa = (pozvankaText.match(/https:\/\/\S*\/navsteva\S*/) || [])[0] || "";
    t("hlavní adresa je krátká, bez otazníku a nadiktovatelná", hlavniAdresa.length < 60 && !hlavniAdresa.includes("?"), hlavniAdresa);
    const vstup1 = await fetch(BASE + "/v/" + Math.random().toString(36).slice(2, 8)).then((r) => r.json());
    t("/v/KOD dál funguje (co je venku, pojede dál)", !!vstup1.propustka && Array.isArray(vstup1.kdo_je_na_siti));
    t("holá /navsteva je hlavní vchod", !!(await fetch(BASE + "/navsteva").then((r) => r.json())).propustka);
    t("pozvánka nikoho nejmenuje", !/navsteva\?[^"'\s]*to=/.test(bezSkriptu));
    t("vstupní adresa je pro indexovací roboty nofollow", (bezSkriptu.match(/rel="nofollow"/g) || []).length >= 1);

    console.log("\n1b) Zkratky /p/KOD a /v/KOD dál fungují, i když se už nenabízejí");
    const vz = await fetch(BASE + "/p/" + Math.random().toString(36).slice(2, 8)).then((r) => r.json());
    t("jedním otevřením vznikla propustka", !!vz.propustka);
    t("a dotaz rovnou odešel", !!(vz.dotaz_odeslan && vz.dotaz_odeslan.odeslano));
    t("server sám vybral, komu ho dá", !!(vz.dotaz_odeslan && vz.dotaz_odeslan.komu), JSON.stringify(vz.dotaz_odeslan || {}).slice(0, 120));
    t("chat dostane i seznam ostatních, kdyby chtěl jiného", Array.isArray(vz.kdo_je_na_siti) && vz.kdo_je_na_siti.length > 0);

    console.log("\n1d) Propadlá propustka nesmí chat zavřít do smyčky");
    const spatna = await fetch(BASE + "/s/nesmysl-propustka-999999").then((r) => r.json());
    const zachrana = (spatna.co_ted || "").match(/https?:\/\/\S*\/v\/[a-z0-9]+/i);
    t("odmítnutí nabídne JEDNORÁZOVOU adresu, ne pořád tutéž /navsteva", !!zachrana, spatna.co_ted);
    t("a vysvětlí, proč je jednorázová", /uloženou kopii/.test(spatna.proc_takova_adresa || ""));
    const spatna2 = await fetch(BASE + "/s/nesmysl-propustka-999999").then((r) => r.json());
    t("a pokaždé jinou", spatna.co_ted !== spatna2.co_ted);
    t("ta záchranná adresa opravdu vydá novou propustku",
      !!(await fetch(zachrana[0].replace(/^https?:\/\/[^/]+/, BASE)).then((r) => r.json())).propustka);

    console.log("\n1c) Vstup bez dotazu rovnou radí, co otevřít (dřív to leželo až za polem agentů)");
    const vstup = await fetch(BASE + "/navsteva").then((r) => r.json());
    const poradi = Object.keys(vstup);
    t("rada je hned druhé pole, ne až kdesi vzadu", poradi[1] === "co_udelat_ted", poradi.slice(0, 4).join(", "));
    const hotova = (vstup.co_udelat_ted.match(/https?:\/\/\S*\/u\/\S+/) || [])[0];
    t("nese úplnou adresu, kterou stačí otevřít", !!hotova);
    t("a taky adresu schránky", vstup.co_udelat_ted.includes("/s/" + vstup.propustka));
    const zacalo = await fetch(hotova).then((r) => r.json());
    t("ta adresa opravdu založí rozhovor", !zacalo.error, JSON.stringify(zacalo).slice(0, 110));
    /* Doporučit agenta s nejlepší reputací nestačí — může ho řídit člověk a ozve
       se za dvě hodiny. Se zapnutým odpovídačem musí dostat přednost ten, kdo
       odpovídá sám, jinak návštěvník civí do prázdné schránky. */
    const sOdpovidacem = await fetch(BASE + "/healthz").then((r) => r.json());
    const komuRadi = (vstup.co_udelat_ted.match(/\/u\/[^/]+\/([^/]+)\/predstav_se/) || [])[1];
    t("radí agenta, který se opravdu ozve", sOdpovidacem.fableAuto ? komuRadi === "Fable" : !!komuRadi,
      `odpovídač ${sOdpovidacem.fableAuto ? "zapnutý" : "vypnutý"}, radí ${decodeURIComponent(komuRadi || "-")}`);

    console.log("\n2) Jedna návštěva = jedna propustka");
    const v1 = await fetch(BASE + "/navsteva").then((r) => r.json());
    const v2 = await fetch(BASE + "/navsteva").then((r) => r.json());
    t("druhé otevření vstupu vrátí tutéž propustku", v1.propustka === v2.propustka, `${v1.prezdivka} vs ${v2.prezdivka}`);
    t("a tedy i tutéž schránku", v1.moje_schranka === v2.moje_schranka);

    console.log("\n3) Schránka nabízí pokaždé jinou adresu na další pokus");
    const r1 = await fetch(BASE + "/s/" + v1.propustka);
    const s1 = await r1.json();
    const s2 = await fetch(BASE + "/s/" + v1.propustka).then((r) => r.json());
    t("prázdná schránka má pole zkus_znovu", !!s1.zkus_znovu, Object.keys(s1).join(","));
    t("adresa na další pokus je pokaždé JINÁ", s1.zkus_znovu !== s2.zkus_znovu, `${s1.zkus_znovu} / ${s2.zkus_znovu}`);
    t("odpověď se nesmí kešovat", (r1.headers.get("cache-control") || "").includes("no-store"));
    t("chatu je vysvětleno, proč je adresa jiná", /pokaždé jiná/.test(s1.proc_jina_adresa || ""));
    t("adresa ze zkus_znovu opravdu funguje", (await fetch(s1.zkus_znovu).then((r) => r.json())).prezdivka === v1.prezdivka);

    console.log("\n4) Schránka počká na odpověď, místo aby poslala prázdno");
    const vd = await fetch(BASE + "/navsteva?dotaz=Co%20konkretne%20umis&to=Fable").then((r) => r.json());
    t("dotaz odešel", !!(vd.dotaz_odeslan && vd.dotaz_odeslan.odeslano));
    t("potvrzení radí otevřít schránku rovnou", /schránka na odpověď sama chvíli počká/.test(vd.dotaz_odeslan.zprava || ""));
    const zac = Date.now();
    const prazdna = await fetch(vd.dotaz_odeslan.odpoved_precti_zde).then((r) => r.json());
    const trvalo = Date.now() - zac;
    t(`nevyhrkne prázdno hned, ale počká (${CEKANI_MS} ms)`, trvalo >= CEKANI_MS - 200, trvalo + " ms");
    t("po marném čekání to řekne narovinu", /Zatím žádná odpověď/.test(prazdna.zprava || ""));
    t("a dá jinou adresu na další pokus", !!prazdna.zkus_znovu);

    console.log("\n5) Když odpověď mezitím přijde, schránka ji vydá hned");
    const zac2 = Date.now();
    const cekaSchranka = fetch(vd.dotaz_odeslan.odpoved_precti_zde).then((r) => r.json());
    await spi(900);
    const odeslani = await fetch(`${BASE}/napis/${regFable.obnovovaci_kod}/${vd.prezdivka}/${enc("Umim orchestraci, psani, analyzu a planovani.")}`).then((r) => r.json());
    t("Fable odpověď odeslal", !odeslani.error, JSON.stringify(odeslani).slice(0, 120));
    const vysledek = await cekaSchranka;
    const trvalo2 = Date.now() - zac2;
    t("čekající schránka odpověď zachytila", (vysledek.zpravy || []).some((m) => /orchestraci/.test(m.text || "")), JSON.stringify(vysledek.zprava));
    t("a vydala ji dřív, než vypršelo čekání", trvalo2 < CEKANI_MS - 100, trvalo2 + " ms");

    console.log(`\n${chyb ? "❌" : "✅"} ${ok}/${ok + chyb} kroků prošlo`);
    konec(chyb ? 1 : 0);
  } catch (e) {
    console.error("\n❌ test spadl:", e && e.message ? e.message : e);
    konec(1);
  }
})();
