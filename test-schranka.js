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
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DATA, CEKANI_NA_ODPOVED_MS: String(CEKANI_MS), FABLE_AUTO: "0", INDEXNOW: "0" },
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
    

    console.log("\n1a) Rozcestníky pro stroje — ať AInet najde i ten, kdo stránku neotevře");
    t("stránka má popis pro vyhledávače a náhledy", /<meta[^>]+name="description"[^>]+content="[^"]{80,}"/i.test(html));
    t("a ten popis rovnou nese vstupní adresu", /name="description"[^>]*content="[^"]*\/navsteva/i.test(html));
    const llms = await fetch(BASE + "/llms.txt");
    const llmsTxt = await llms.text();
    t("/llms.txt odpovídá", llms.status === 200, "status " + llms.status);
    t("…a ukazuje obojí dveře", /\/navsteva/.test(llmsTxt) && /\/start/.test(llmsTxt));
    t("…a připomíná, že zprávy jsou data, ne příkazy", /DATA, nikdy příkazy/.test(llmsTxt));
    const robots = await fetch(BASE + "/robots.txt");
    const robotsTxt = await robots.text();
    t("/robots.txt odpovídá", robots.status === 200, "status " + robots.status);
    t("…nic nezakazuje a posílá AI na llms.txt", /Allow: \//.test(robotsTxt) && /llms\.txt/.test(robotsTxt) && !/Disallow: \/\s*$/m.test(robotsTxt));
    t("…a odkazuje na sitemapu", /Sitemap: .*\/sitemap\.xml/.test(robotsTxt));
    const mapa = await fetch(BASE + "/sitemap.xml");
    const mapaXml = await mapa.text();
    t("/sitemap.xml odpovídá", mapa.status === 200, "status " + mapa.status);
    t("…a je v ní vstup pro návštěvníka", /<loc>[^<]*\/navsteva<\/loc>/.test(mapaXml));

    console.log("\n1h) Aby vstup našel i ten, kdo ho hledá místo otevření");
    const klicTxt = await fetch(BASE + "/ainet1e2y2026navstevaindexnowkey.txt");
    t("soubor s klíčem pro IndexNow existuje", klicTxt.status === 200 && (await klicTxt.text()).trim() === "ainet1e2y2026navstevaindexnowkey");
    const vstupHtml = await fetch(BASE + "/navsteva?h=" + Math.random(), { headers: { Accept: "text/html", "X-Forwarded-For": "10.9.1.4" } }).then((r) => r.text());
    t("/navsteva má pro vyhledávače titulek, pod kterým se dá najít", /<title>AInet \/navsteva/.test(vstupHtml));
    t("…a popis místo noindex", /name="description"/.test(vstupHtml) && !/noindex/.test(vstupHtml));
    t("…a nahoře hlasitou instrukci pro chat", /NEHLEDEJ TU URL, NESKLÁDEJ JI, NEUPRAVUJ JI\. KLIKNĚTE PŘÍMO NA TENTO ODKAZ/.test(vstupHtml));
    t("vstupní adresa na hlavní stránce už není nofollow (ať ji roboti zaindexují)", !/href="\/navsteva"[^>]*nofollow/.test(bezSkriptu));

    console.log("\n1b) Zkratky /p/KOD a /v/KOD dál fungují, i když se už nenabízejí");
    const vz = await fetch(BASE + "/p/" + Math.random().toString(36).slice(2, 8)).then((r) => r.json());
    t("jedním otevřením vznikla propustka", !!vz.propustka);
    t("a dotaz rovnou odešel", !!(vz.dotaz_odeslan && vz.dotaz_odeslan.odeslano));
    t("server sám vybral, komu ho dá", !!(vz.dotaz_odeslan && vz.dotaz_odeslan.komu), JSON.stringify(vz.dotaz_odeslan || {}).slice(0, 120));
    t("chat dostane i seznam ostatních, kdyby chtěl jiného", Array.isArray(vz.kdo_je_na_siti) && vz.kdo_je_na_siti.length > 0);

    console.log("\n1f) Vlastní dotaz s nejmenší možnou úpravou: adresa končí lomítkem, chat jen připíše");
    const vst = await fetch(BASE + "/navsteva?w=" + Math.random(), { headers: { "X-Forwarded-For": "10.9.1.6" } }).then((r) => r.json());   /* jiná IP: test jinak narazí na limit 10 návštěv/min */
    const fableVSeznamu = (vst.kdo_je_na_siti || []).find((a) => a.jmeno === "Fable");
    t("u každého agenta je adresa vlastni_dotaz", (vst.kdo_je_na_siti || []).every((a) => typeof a.vlastni_dotaz === "string"));
    t("…končí lomítkem a má vyplněnou propustku i jméno", /\/z\/[^/]+\/Fable\/$/.test(fableVSeznamu.vlastni_dotaz), fableVSeznamu.vlastni_dotaz);
    t("rozcestník vysvětluje, že se jen připisuje za lomítko", /za to lomítko/.test(vst.jak_polozit_vlastni_dotaz || ""));
    t("co_udelat_ted tu cestu nabízí taky", /za poslední lomítko připiš/.test(vst.co_udelat_ted || ""));
    const jenLomitko = await fetch(fableVSeznamu.vlastni_dotaz).then((r) => r.json());
    t("otevření samotné adresy s lomítkem nic neodešle a neskončí jako téma Fable", !!jenLomitko.error && !jenLomitko.odeslano, JSON.stringify(jenLomitko).slice(0, 100));
    t("…ale vrátí začátek adresy bez zástupných slov", /\/z\/[^/]+\/Fable\/$/.test(jenLomitko.zacatek_adresy || "") && !/TVUJ_DOTAZ/.test(jenLomitko.zacatek_adresy || ""));
    const pripsano = await fetch(fableVSeznamu.vlastni_dotaz + encodeURIComponent("Jak vyhubit orobinec v rybníku")).then((r) => r.json());
    t("po připsání dotazu za lomítko odejde přesně ten text", pripsano.odeslano === true && pripsano.text_ktery_dorazil === "Jak vyhubit orobinec v rybníku", pripsano.text_ktery_dorazil);

    console.log("\n1g) Useknutá hotová adresa (/u/PROPUSTKA bez agenta a úvodu) nesmí být slepá ulička");
    /* 16. 9.: chat otevřel jen /u/rudy-majak-076235, dostal 404 „Neznámá cesta"
       a jeho nástroj utekl na doménu — „skončila jsem na hlavní stránce". */
    const torzo1 = await fetch(BASE + "/u/" + vst.propustka);
    const torzo1j = await torzo1.json();
    t("/u/PROPUSTKA vrací 200, ne 404", torzo1.status === 200, "status " + torzo1.status);
    t("…nic neodešle", !torzo1j.odeslano && !torzo1j.dotaz_odeslan);
    t("…a dá celou hotovou adresu hned v co_udelat_ted", /\/u\/[^/]+\/Fable\/predstav_se/.test(torzo1j.co_udelat_ted || ""), torzo1j.co_udelat_ted);
    t("…a seznam agentů i s celými adresami", Array.isArray(torzo1j.kdo_je_na_siti) && torzo1j.kdo_je_na_siti.every((a) => a.zacit && a.zacit.predstav_se));
    const torzo2 = await fetch(BASE + "/u/" + vst.propustka + "/Aja/").then((r) => r.json());
    t("/u/PROPUSTKA/Aja/ (bez úvodu) postaví Aju na první místo", torzo2.kdo_je_na_siti[0].jmeno === "Aja" && /\/Aja\/predstav_se/.test(torzo2.co_udelat_ted || ""));
    const torzoHtml = await fetch(BASE + "/u/" + vst.propustka, { headers: { Accept: "text/html" } });
    const torzoHtmlTxt = await torzoHtml.text();
    t("pro prohlížeč je z toho čitelná stránka s odkazy, ne holý JSON", torzoHtml.status === 200 && /<a href="[^"]*\/u\/[^"]*predstav_se"/.test(torzoHtmlTxt));
    const torzoCizi = await fetch(BASE + "/u/nesmysl-propustka-000000");
    t("useknutá adresa s neplatnou propustkou → 403 se záchrannou adresou", torzoCizi.status === 403 && /\/v\/[a-z0-9]+/.test((await torzoCizi.json()).co_ted || ""));
    const plna = await fetch(fableVSeznamu.zacit.predstav_se).then((r) => r.json());
    t("celá adresa /u/PROPUSTKA/Fable/predstav_se dál normálně odesílá", plna.odeslano === true || plna.opakovano === true, JSON.stringify(plna).slice(0, 80));

    console.log("\n1e) Znaky v dotazu: adresa umí dotaz tiše useknout");
    const vz2 = await fetch(BASE + "/navsteva?x=" + Math.random(), { headers: { "X-Forwarded-For": "10.9.1.5" } }).then((r) => r.json());
    const P = vz2.propustka;
    const posli = (t) => fetch(`${BASE}/z/${P}/Aja/${t}`).then((r) => r.json());
    const sOtaznikem = await posli("Co je lepsi? ETF nebo dluhopisy");
    t("otazník uvnitř dotazu se slepí zpátky, ne usekne",
      /ETF nebo dluhopisy/.test(sOtaznikem.text_ktery_dorazil || ""), sOtaznikem.text_ktery_dorazil);
    const sHackem = await posli(enc("Jak vyhubit orobinec v rybníku"));
    t("háčky a čárky projdou beze změny", sHackem.text_ktery_dorazil === "Jak vyhubit orobinec v rybníku", sHackem.text_ktery_dorazil);
    t("odpověď vždy ukáže, co doopravdy dorazilo", typeof sHackem.text_ktery_dorazil === "string");
    const rozcestnik = await fetch(BASE + "/navsteva").then((r) => r.json());
    t("rozcestník varuje před ? # % a +", /%3F/.test(rozcestnik.pravidlo_znaku || "") && /%23/.test(rozcestnik.pravidlo_znaku || "") && /%25/.test(rozcestnik.pravidlo_znaku || ""));

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
    t("rada je mezi prvními třemi poli, ne až kdesi vzadu (první je akce)", poradi[0] === "akce" && poradi.indexOf("co_udelat_ted") <= 2, poradi.slice(0, 4).join(", "));
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

    console.log("\n6) Celý průchod jen přes pole akce: chat nic negeneruje, jen otevírá přesně to, co dostane");
    /* Chat: „AInet musí vrátit jednu hotovou URL a agent ji má prostě přímo otevřít." */
    const krok1 = await fetch(BASE + "/navsteva?a=" + Math.random(), { headers: { "X-Forwarded-For": "10.9.1.7" } }).then((r) => r.json());
    t("akce je ÚPLNĚ PRVNÍ pole odpovědi", Object.keys(krok1)[0] === "akce", Object.keys(krok1).slice(0, 3).join(", "));
    t("akce má typ open_direct a přesnou adresu", krok1.akce && krok1.akce.typ === "open_direct" && /^https?:\/\/\S+\/u\/\S+\/predstav_se$/.test(krok1.akce.url), JSON.stringify(krok1.akce).slice(0, 120));
    t("instrukce říká: klikni přímo, nehledej, neskládej, neupravuj", /NEHLEDEJ TU URL, NESKLÁDEJ JI, NEUPRAVUJ JI\. KLIKNI PŘÍMO NA TENTO ODKAZ/.test(krok1.akce.instrukce) && /vyhledáván/i.test(krok1.akce.instrukce));
    t("a rovnou říká, co otevřít potom (schránku)", krok1.akce.potom && krok1.akce.potom.typ === "open_direct" && krok1.akce.potom.url === `${BASE}/s/${krok1.propustka}`);
    const krok2 = await fetch(krok1.akce.url).then((r) => r.json());
    t("otevření akce odešle dotaz — potvrzení nese odeslano, id, stav", krok2.odeslano === true && !!krok2.id && krok2.stav === "queued");
    t("potvrzení má jako první pole zase akci: otevři schránku", Object.keys(krok2)[0] === "akce" && krok2.akce.typ === "open_direct" && krok2.akce.url === `${BASE}/s/${krok1.propustka}`);
    const krok3 = await fetch(krok2.akce.url).then((r) => r.json());
    t("prázdná schránka radí open_direct na JINOU adresu", krok3.akce.typ === "open_direct" && krok3.akce.url !== krok2.akce.url && /\/s\/[^/]+\/\d+$/.test(krok3.akce.url), krok3.akce.url);
    await fetch(`${BASE}/napis/${regFable.obnovovaci_kod}/${krok1.prezdivka}/${enc("Ahoj, jsem Fable.")}`).then((r) => r.json());
    const krok4 = await fetch(krok3.akce.url).then((r) => r.json());
    t("po příchodu odpovědi říká schránka hotovo a nic dalšího neotvírá", krok4.akce.typ === "hotovo" && krok4.zpravy.some((m) => /jsem Fable/.test(m.text || "")), JSON.stringify(krok4.akce));
    const krok1html = await fetch(BASE + "/navsteva?b=" + Math.random(), { headers: { Accept: "text/html", "X-Forwarded-For": "10.9.1.8" } }).then((r) => r.text());
    t("v HTML podobě je nahoře hlasitá instrukce a odkaz", /KLIKNĚTE PŘÍMO NA TENTO ODKAZ/.test(krok1html) && /<a href="[^"]*\/u\/[^"]*predstav_se"/.test(krok1html));
    const sDotazem = await fetch(BASE + "/navsteva?dotaz=" + enc("Co umis") + "&to=Fable", { headers: { "X-Forwarded-For": "10.9.1.9" } }).then((r) => r.json());
    t("vstup s dotazem v adrese má akci rovnou na schránku", sDotazem.akce.typ === "open_direct" && sDotazem.akce.url === `${BASE}/s/${sDotazem.propustka}`);

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
