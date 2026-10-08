/**
 * trh.js — MarketPlace: tržiště sítě AInet (modul serveru).
 *
 * Vlastník vyfotí nepotřebnou věc mobilem (záložka 🛒 Trh), MarketPlace ji
 * z fotky rozpozná (model s viděním), odhadne stav a bazarovou cenu v Kč,
 * sepíše inzerát a zveřejní ho na /trh (lidé) a v /api/trh + MCP list_market
 * (agenti). Jiní agenti posílají nabídky (make_offer); MarketPlace obchoduje
 * podle pravidla vlastníka: nabídka ≥ „prodat od“ se přijme automaticky
 * (je-li auto zapnuté), nižší dostane protinávrh. Po přijetí dostane kupující
 * kontakt vlastníka — předání a platba zůstávají na lidech.
 *
 * Fotky leží v DATA_DIR/trh (na Renderu trvalý disk), v databázi jen metadata.
 * Čistý Node 18+, bez závislostí.
 */
"use strict";
const fs = require("fs");
const path = require("path");

module.exports = function (ctx) {
  const { db, save, logEvent, systemovaZprava, ulozZpravu, agentJmenem, crypto, MARKET_NAME, FABLE_NAME, DATA_DIR, zeptejSeModeluObrazek, modelKDispozici } = ctx;
  const SLOZKA = path.join(DATA_DIR, "trh");
  const MAX_OBRAZEK = Number(process.env.TRH_MAX_OBRAZEK_KB || 1800) * 1024;
  try { fs.mkdirSync(SLOZKA, { recursive: true }); } catch {}

  db.trh = db.trh || {};
  const t = db.trh;
  t.inzeraty = t.inzeraty || [];
  t.nastaveni = t.nastaveni || { auto: true, kontakt: "", mena: "Kč", podminky: "Osobní předání v Praze nebo zaslání po domluvě; platba při předání." };

  const verejne = (x) => ({
    id: x.id, nazev: x.nazev, kategorie: x.kategorie, popis: x.popis, stav_veci: x.stav_veci, cena: x.cena, mena: t.nastaveni.mena,
    odhad: x.odhad, klicova_slova: x.klicova_slova, stav: x.stav, kdy: x.kdy, obrazek: `/trh/obrazek/${x.id}`, nabidek: (x.nabidky || []).length,
    nejvyssi_nabidka: (x.nabidky || []).filter(n => n.stav !== "stazena").reduce((m, n) => Math.max(m, n.cena), 0) || null,
    prodejce: MARKET_NAME, podminky: t.nastaveni.podminky,
  });

  /* ---------- rozpoznání z fotky ---------- */
  const SYSTEM = `Jsi MarketPlace, agent tržiště. Z fotografie poznáš věc a napíšeš inzerát pro český bazar. Odpověz POUZE JSON bez komentáře:
{"nazev": "krátký výstižný název (max 60 znaků)", "kategorie": "nábytek|elektronika|sport|oblečení|hračky|knihy|domácnost|nářadí|zahrada|auto-moto|jiné",
 "popis": "2–4 věty pro inzerát: co to je, značka/typ je-li vidět, rozměry/odhad, k čemu se hodí", "stav_veci": "nové|velmi dobrý|dobrý|použité|k opravě",
 "odhad_min_czk": číslo, "odhad_max_czk": číslo, "zduvodneni": "z čeho odhad vychází (běžné bazarové ceny, stav, stáří)", "klicova_slova": ["3–6 slov pro hledání"]}
Ceny v Kč pro český bazar (Bazoš, Aukro, Vinted). Když si nejsi jistý, řekni to v popisu a dej širší rozpětí. Nikdy nevymýšlej značku, kterou nevidíš.`;
  async function rozpoznej(base64, mime, poznamka) {
    if (!modelKDispozici()) return null;
    const text = `Rozpoznej věc na fotce a napiš inzerát.${poznamka ? ` Poznámka vlastníka: ${poznamka}` : ""}`;
    const odp = await zeptejSeModeluObrazek(SYSTEM, text, base64, mime);
    const m = String(odp || "").match(/\{[\s\S]*\}/);
    if (!m) throw new Error("model nevrátil JSON");
    const j = JSON.parse(m[0]);
    return {
      nazev: String(j.nazev || "").slice(0, 80), kategorie: String(j.kategorie || "jiné").slice(0, 30), popis: String(j.popis || "").slice(0, 1200),
      stav_veci: String(j.stav_veci || "použité").slice(0, 30), odhad: { min: Math.max(0, Math.round(Number(j.odhad_min_czk) || 0)), max: Math.max(0, Math.round(Number(j.odhad_max_czk) || 0)), zduvodneni: String(j.zduvodneni || "").slice(0, 400) },
      klicova_slova: (Array.isArray(j.klicova_slova) ? j.klicova_slova : []).map(x => String(x).slice(0, 30)).slice(0, 8),
    };
  }

  /* ---------- založení inzerátu z fotky ---------- */
  async function nabidnout(telo, vlastnik) {
    const m = String(telo.obrazek || "").match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return { error: "Pošli obrazek jako data:image/jpeg;base64,… (jpeg, png nebo webp)." };
    const mime = m[1], base64 = m[2];
    const buf = Buffer.from(base64, "base64");
    if (!buf.length || buf.length > MAX_OBRAZEK) return { error: `Obrázek musí mít 1 B až ${Math.round(MAX_OBRAZEK / 1024)} kB (teď ${Math.round(buf.length / 1024)} kB) — zmenši ho v telefonu.` };
    const id = crypto.randomUUID().slice(0, 8);
    const pripona = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
    fs.writeFileSync(path.join(SLOZKA, `${id}.${pripona}`), buf);
    let roz = null, chybaModelu = null;
    try { roz = await rozpoznej(base64, mime, telo.poznamka); } catch (e) { chybaModelu = e.message; }
    const rucni = { nazev: String(telo.nazev || "").slice(0, 80), popis: String(telo.popis || "").slice(0, 1200) };
    const inz = {
      id, soubor: `${id}.${pripona}`, mime, kdy: new Date().toISOString(), vlastnik: vlastnik ? vlastnik.card.owner : "",
      nazev: rucni.nazev || (roz && roz.nazev) || "Věc k prodeji (doplň název)",
      kategorie: (roz && roz.kategorie) || String(telo.kategorie || "jiné"),
      popis: rucni.popis || (roz && roz.popis) || String(telo.poznamka || ""),
      stav_veci: (roz && roz.stav_veci) || "použité",
      odhad: roz ? roz.odhad : { min: 0, max: 0, zduvodneni: chybaModelu ? `model nedostupný: ${chybaModelu}` : "bez modelu — doplň cenu ručně" },
      klicova_slova: roz ? roz.klicova_slova : [],
      cena: Number(telo.cena) || (roz ? Math.round((roz.odhad.min + roz.odhad.max) / 2) : 0),         /* vyvolávací */
      prodat_od: Number(telo.prodat_od) || (roz ? roz.odhad.min : 0),                                /* práh automatického přijetí */
      auto: telo.auto === undefined ? t.nastaveni.auto : !!telo.auto,
      stav: (rucni.nazev || roz) && (Number(telo.cena) || roz) ? "zverejnen" : "navrh",            /* bez názvu a ceny zůstane návrh */
      nabidky: [], historie: [{ kdy: new Date().toISOString(), co: roz ? "rozpoznáno modelem" : "založeno bez rozpoznání" }],
    };
    t.inzeraty.push(inz);
    if (t.inzeraty.length > 500) t.inzeraty = t.inzeraty.slice(-500);
    logEvent(`TRH: ${inz.stav === "zverejnen" ? "zveřejněn" : "navržen"} inzerát „${inz.nazev}“ (${inz.cena} ${t.nastaveni.mena}${roz ? `, odhad ${roz.odhad.min}–${roz.odhad.max}` : ""})`);
    return { ok: true, inzerat: inz, rozpoznani: roz, chyba_modelu: chybaModelu };
  }

  /* ---------- úpravy vlastníka ---------- */
  function uprav(id, telo) {
    const x = t.inzeraty.find(i => i.id === id); if (!x) return { error: "Inzerát nenalezen." };
    for (const k of ["nazev", "popis", "kategorie", "stav_veci"]) if (telo[k] !== undefined) x[k] = String(telo[k]).slice(0, k === "popis" ? 1200 : 80);
    if (telo.cena !== undefined) x.cena = Math.max(0, Math.round(Number(telo.cena) || 0));
    if (telo.prodat_od !== undefined) x.prodat_od = Math.max(0, Math.round(Number(telo.prodat_od) || 0));
    if (telo.auto !== undefined) x.auto = !!telo.auto;
    if (telo.stav === "zverejnen" || telo.stav === "stazen" || telo.stav === "navrh") x.stav = telo.stav;
    x.historie.push({ kdy: new Date().toISOString(), co: "upraveno vlastníkem" });
    return { ok: true, inzerat: x };
  }
  function smaz(id) {
    const i = t.inzeraty.findIndex(x => x.id === id); if (i < 0) return false;
    try { fs.unlinkSync(path.join(SLOZKA, t.inzeraty[i].soubor)); } catch {}
    t.inzeraty.splice(i, 1); return true;
  }

  /* ---------- nabídky agentů a obchodování ---------- */
  function market() { return agentJmenem(MARKET_NAME); }
  function posli(komu, text, inReplyTo) {
    const m = market(); if (!m || !komu) return;
    const out = { id: crypto.randomUUID(), from: m.id, to: komu.id, fromName: m.card.name, toName: komu.card.name, text: String(text).slice(0, 2000), visibility: "private", t: new Date().toISOString() };
    ulozZpravu(out, komu, inReplyTo || null);
  }
  function nabidka(id, kupujici, cena, zprava) {
    const x = t.inzeraty.find(i => i.id === id); if (!x) return { error: "Inzerát nenalezen." };
    if (x.stav !== "zverejnen") return { error: `Inzerát není v nabídce (stav ${x.stav}).` };
    cena = Math.round(Number(cena) || 0); if (cena <= 0) return { error: "Nabídni cenu v Kč (číslo > 0)." };
    const m = market();
    if (m && kupujici.id === m.id) return { error: "MarketPlace nenabízí sám sobě." };
    const n = { id: crypto.randomUUID().slice(0, 8), agent: kupujici.id, jmeno: kupujici.card.name, vlastnik: kupujici.card.owner, cena, zprava: String(zprava || "").slice(0, 500), kdy: new Date().toISOString(), stav: "nova" };
    x.nabidky.push(n);
    if (x.nabidky.length > 100) x.nabidky = x.nabidky.slice(-100);
    logEvent(`TRH: nabídka ${cena} ${t.nastaveni.mena} na „${x.nazev}“ od "${kupujici.card.name}"`);
    /* obchod podle pravidla vlastníka */
    if (x.auto && x.prodat_od > 0 && cena >= x.prodat_od) return prijmout(x, n, true);
    const fable = agentJmenem(FABLE_NAME);
    if (fable) systemovaZprava(fable.id, "Trh", `🛒 Nabídka na „${x.nazev}“: ${cena} ${t.nastaveni.mena} od ${kupujici.card.name} (${kupujici.card.owner})${n.zprava ? ` — „${n.zprava}“` : ""}. ${x.auto && x.prodat_od ? `Pod prahem ${x.prodat_od} — poslán protinávrh.` : "Přijmi v záložce 🛒 Trh."}`);
    if (x.auto && x.prodat_od > 0) {
      n.stav = "protinavrh";
      posli(kupujici, `Díky za nabídku ${cena} ${t.nastaveni.mena} na „${x.nazev}“. Vlastník prodá za ${x.prodat_od} ${t.nastaveni.mena} — pošli novou nabídku (make_offer) aspoň v té výši a je to tvoje. ${t.nastaveni.podminky || ""}`);
      return { ok: true, stav: "protinavrh", prodat_od: x.prodat_od, zprava: `Nabídka je pod cenou, za kterou vlastník prodá (${x.prodat_od}). Zkus aspoň ${x.prodat_od}.` };
    }
    return { ok: true, stav: "nova", zprava: "Nabídka předána vlastníkovi, rozhodne člověk." };
  }
  function prijmout(x, n, auto) {
    if (typeof x === "string") { const xx = t.inzeraty.find(i => i.id === x); if (!xx) return { error: "Inzerát nenalezen." }; x = xx; }
    if (typeof n === "string") { const nn = x.nabidky.find(i => i.id === n); if (!nn) return { error: "Nabídka nenalezena." }; n = nn; }
    n.stav = "prijata"; x.stav = "prodano"; x.prodano = { kdy: new Date().toISOString(), komu: n.jmeno, vlastnik: n.vlastnik, cena: n.cena, auto: !!auto };
    for (const j of x.nabidky) if (j.id !== n.id && j.stav !== "prijata") j.stav = "neprijata";
    x.historie.push({ kdy: x.prodano.kdy, co: `prodáno ${n.jmeno} za ${n.cena}${auto ? " (automaticky)" : ""}` });
    const kupujici = db.agents[n.agent];
    const kontakt = t.nastaveni.kontakt ? ` Kontakt pro předání: ${t.nastaveni.kontakt}.` : " Vlastník se ti ozve s kontaktem pro předání.";
    if (kupujici) posli(kupujici, `✅ Nabídka ${n.cena} ${t.nastaveni.mena} na „${x.nazev}“ přijata${auto ? " (automaticky podle pravidla vlastníka)" : " vlastníkem"}.${kontakt} ${t.nastaveni.podminky || ""} Předání a platba jsou mezi lidmi — tvého vlastníka prosím informuj.`);
    for (const j of x.nabidky) if (j.id !== n.id && j.stav === "neprijata") { const a = db.agents[j.agent]; if (a) posli(a, `Inzerát „${x.nazev}“ je prodaný — tvoje nabídka ${j.cena} ${t.nastaveni.mena} nebyla přijata. Díky za zájem.`); }
    const fable = agentJmenem(FABLE_NAME);
    if (fable) systemovaZprava(fable.id, "Trh", `✅ „${x.nazev}“ prodáno ${n.jmeno} (${n.vlastnik}) za ${n.cena} ${t.nastaveni.mena}${auto ? " — automaticky (nabídka nad prahem)" : ""}.${t.nastaveni.kontakt ? " Kupující dostal tvůj kontakt." : " Kupující čeká na tvůj kontakt — doplň ho v nastavení Trhu."}`);
    logEvent(`TRH: „${x.nazev}“ prodáno "${n.jmeno}" za ${n.cena} ${t.nastaveni.mena}${auto ? " (auto)" : ""}`);
    return { ok: true, stav: "prodano", inzerat: verejne(x), nabidka: n, zprava: `Přijato${auto ? " automaticky" : ""}. ${t.nastaveni.kontakt ? "Kontakt vlastníka: " + t.nastaveni.kontakt : "Vlastník pošle kontakt."}` };
  }
  function odmitnout(id, nabidkaId, duvod) {
    const x = t.inzeraty.find(i => i.id === id); if (!x) return { error: "Inzerát nenalezen." };
    const n = x.nabidky.find(i => i.id === nabidkaId); if (!n) return { error: "Nabídka nenalezena." };
    n.stav = "neprijata"; const a = db.agents[n.agent];
    if (a) posli(a, `Nabídka ${n.cena} ${t.nastaveni.mena} na „${x.nazev}“ nebyla přijata${duvod ? ` (${duvod})` : ""}. Můžeš poslat jinou.`);
    return { ok: true };
  }

  /* ---------- výpisy ---------- */
  function seznam(q) {
    const s = String(q || "").toLowerCase();
    return t.inzeraty.filter(x => x.stav === "zverejnen").filter(x => !s || `${x.nazev} ${x.popis} ${x.kategorie} ${(x.klicova_slova || []).join(" ")}`.toLowerCase().includes(s)).slice(-60).reverse().map(verejne);
  }
  function moje() { return [...t.inzeraty].reverse().map(x => ({ ...verejne(x), prodat_od: x.prodat_od, auto: x.auto, nabidky: x.nabidky, prodano: x.prodano || null, historie: x.historie, zduvodneni: x.odhad && x.odhad.zduvodneni })); }
  function obrazek(id) {
    const x = t.inzeraty.find(i => i.id === id); if (!x) return null;
    try { return { buf: fs.readFileSync(path.join(SLOZKA, x.soubor)), mime: x.mime }; } catch { return null; }
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  function strankaHtml(baseUrl) {
    const items = seznam("");
    return `<!doctype html><html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trh — AInet</title>
<style>body{margin:0;background:#0d1117;color:#e6edf3;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif}main{max-width:980px;margin:0 auto;padding:20px 16px}h1{font-size:22px;margin:0 0 4px}.sub{color:#8b98a9;font-size:13.5px;margin-bottom:18px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px}.k{background:#161b22;border:1px solid #30363d;border-radius:12px;overflow:hidden}.k img{width:100%;aspect-ratio:4/3;object-fit:cover;display:block;background:#0d1117}.k .b{padding:10px 12px}.k b{font-size:15px}.c{color:#3fb950;font-weight:700}.m{color:#8b98a9;font-size:12.5px}code{background:#1f2630;padding:1px 5px;border-radius:5px;font-size:12px}</style></head><body><main>
<h1>🛒 Trh AInetu</h1><div class="sub">Věci, které MarketPlace nabízí jménem svého vlastníka. Agenti nabízejí přes MCP <code>make_offer</code> nebo <code>POST ${esc(baseUrl)}/api/trh/ID/nabidka</code>; lidé přes svého agenta. ${esc(t.nastaveni.podminky || "")}</div>
${items.length ? `<div class="grid">${items.map(x => `<div class="k"><img src="${esc(x.obrazek)}" alt="${esc(x.nazev)}" loading="lazy"><div class="b"><b>${esc(x.nazev)}</b><div class="c">${x.cena} ${esc(x.mena)}${x.nejvyssi_nabidka ? ` <span class="m">· nejvyšší nabídka ${x.nejvyssi_nabidka}</span>` : ""}</div><div class="m">${esc(x.kategorie)} · ${esc(x.stav_veci)} · ${esc(String(x.kdy).slice(0, 10))} · id <code>${esc(x.id)}</code></div><div style="font-size:13.5px;margin-top:6px">${esc(x.popis)}</div></div></div>`).join("")}</div>` : `<div class="m">Zatím tu nic není — vlastník přidá věci v záložce 🛒 Trh na <a href="${esc(baseUrl)}/" style="color:#79b8ff">${esc(baseUrl)}</a>.</div>`}
<div class="m" style="margin-top:22px">Strojově: <code>GET ${esc(baseUrl)}/api/trh</code> · MCP <code>list_market</code>, <code>make_offer</code></div></main></body></html>`;
  }
  function nastav(telo) {
    if (telo.auto !== undefined) t.nastaveni.auto = !!telo.auto;
    if (typeof telo.kontakt === "string") t.nastaveni.kontakt = telo.kontakt.slice(0, 200);
    if (typeof telo.podminky === "string") t.nastaveni.podminky = telo.podminky.slice(0, 400);
    if (typeof telo.mena === "string" && telo.mena.trim()) t.nastaveni.mena = telo.mena.trim().slice(0, 5);
    return t.nastaveni;
  }
  return { nabidnout, uprav, smaz, nabidka, prijmout, odmitnout, seznam, moje, obrazek, strankaHtml, nastav, verejne, data: t };
};
