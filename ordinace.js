/**
 * ordinace.js — kalendář ordinace pro agenta Organizer (modul serveru AInet).
 *
 * Organizer vede ordinaci MUDr. Dítla uvnitř AInetu, bez cizích kalendářů:
 *   - ORDINAČNÍ HODINY: za den v týdnu místo a hodiny (výchozí pondělí Bulovka
 *     12–15 h, čtvrtek Neratovice 16–18 h, termín 20 minut) + blokace (dovolená, kongres).
 *     Název místa drž krátký — podle něj se v přání pacienta pozná preferovaný den.
 *   - OBJEDNÁVKY: zprávy [OBJEDNANI] od FB-Mostu (Messenger, web, hlasový hovor)
 *     Organizer rozebere na pole, navrhne nejbližší volné termíny podle triage
 *     a preferovaného dne, PRVNÍ si rezervuje jako „navržený“ a pacientovi
 *     (má-li psid) potvrdí přijetí — bez termínu, ten potvrdí až vlastník
 *   - TERMÍNY: navržen → potvrzen (vlastník) → probehl | zrusen; potvrzení
 *     pacientovi jde přes FB-Most ([FB:psid] …), když přišel z Messengeru
 *   - RANNÍ PŘEHLED: v PREHLED_HODINA (výchozí 7:00 Praha) Organizer sepíše
 *     program dne, co čeká na potvrzení, co přišlo z poradny a co je bez
 *     odpovědi; uloží ho, pošle do schránky Organizera a — je-li
 *     ORGANIZER_FB_PSID — i vlastníkovi do Messengeru přes FB-Most.
 *     Fable (finance) ordinační hlášení nedostává — dělba rolí vlastníka.
 *   - HOVORY: zprávy [HOVOR] (shrnutí z ElevenLabs přes Most) se ukládají
 *     a jdou do přehledu; odchozí hovor pacientovi spouští vlastník
 *     (POST /api/ordinace/zavolat → Most → ElevenLabs/Twilio)
 *
 * Údaje pacientů zůstávají jen tady a v soukromých zprávách domácích agentů.
 * Čistý Node 18+, bez závislostí. Časy se počítají v Europe/Prague.
 */
"use strict";

module.exports = function (ctx) {
  const { db, save, logEvent, systemovaZprava, ulozZpravu, agentJmenem, crypto, ORGANIZER_NAME, FABLE_NAME, MOST_NAME, baseUrlDefault } = ctx;
  const TZ = "Europe/Prague";
  const DEN = ["neděle", "pondělí", "úterý", "středa", "čtvrtek", "pátek", "sobota"];
  const PREHLED_HODINA = Number(process.env.PREHLED_HODINA || 7);
  const MOST_URL = (process.env.MOST_URL || "https://fb-most.onrender.com").replace(/\/$/, "");
  const MOST_KLIC = process.env.MOST_KLIC || "";             /* sdílené tajemství pro /organizer/* na Mostu */
  const ORGANIZER_FB_PSID = process.env.ORGANIZER_FB_PSID || ""; /* Messenger vlastníka (ranní přehled) */

  db.ordinace = db.ordinace || {};
  const o = db.ordinace;
  o.nastaveni = o.nastaveni || {
    delka: 20,
    dny: { "1": { misto: "Bulovka", od: "12:00", do: "15:00" }, "4": { misto: "Neratovice", od: "16:00", do: "18:00" } },
    blokace: [],            /* [{od:"YYYY-MM-DD", do:"YYYY-MM-DD", duvod}] */
    potvrzeniText: "Dobrý den, potvrzujeme Vám termín {kdy} ({misto}). Vezměte s sebou kartičku pojišťovny a dosavadní nálezy. Kdyby termín nevyhovoval, napište nám prosím. MUDr. Dítl",
  };
  o.terminy = o.terminy || [];
  o.objednavky = o.objednavky || [];
  o.prehledy = o.prehledy || {};
  o.hovory = o.hovory || [];

  /* ---------- čas v Praze ---------- */
  function praha(d = new Date()) {
    const f = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false });
    const p = {}; for (const x of f.formatToParts(d)) p[x.type] = x.value;
    const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
    return { datum: `${p.year}-${p.month}-${p.day}`, cas: `${p.hour === "24" ? "00" : p.hour}:${p.minute}`, den: wd, y: +p.year, m: +p.month, d: +p.day, hh: +(p.hour === "24" ? 0 : p.hour), mm: +p.minute };
  }
  /* ISO (UTC) pro pražský čas „YYYY-MM-DD HH:MM“ — bez knihoven: zkusit UTC a dorovnat posun */
  function isoZPrahy(datum, cas) {
    const [y, m, d] = datum.split("-").map(Number); const [hh, mm] = cas.split(":").map(Number);
    let t = Date.UTC(y, m - 1, d, hh, mm);
    for (let i = 0; i < 3; i++) {
      const p = praha(new Date(t));
      const chce = Date.UTC(y, m - 1, d, hh, mm), ma = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm);
      if (ma === chce) break; t += chce - ma;
    }
    return new Date(t).toISOString();
  }
  const datumPlus = (datum, dni) => { const [y, m, d] = datum.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + dni)).toISOString().slice(0, 10); };
  const denTydne = (datum) => { const [y, m, d] = datum.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };
  const hezky = (iso) => { const p = praha(new Date(iso)); return `${DEN[p.den]} ${p.d}. ${p.m}. ${p.y} v ${p.cas}`; };
  const minut = (cas) => { const [h, m] = cas.split(":").map(Number); return h * 60 + m; };
  const casZMinut = (n) => `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;

  /* ---------- sloty ---------- */
  const zive = () => o.terminy.filter(t => t.stav !== "zrusen");
  function blokovano(datum) { return (o.nastaveni.blokace || []).find(b => b.od <= datum && datum <= (b.do || b.od)) || null; }
  function volneSloty(datum) {
    const den = o.nastaveni.dny[String(denTydne(datum))];
    if (!den || blokovano(datum)) return [];
    const delka = Number(o.nastaveni.delka) || 20;
    const ted = Date.now();
    const out = [];
    for (let m = minut(den.od); m + delka <= minut(den.do); m += delka) {
      const iso = isoZPrahy(datum, casZMinut(m));
      const start = new Date(iso).getTime(), konec = start + delka * 60_000;
      if (konec <= ted) continue;
      const kolize = zive().some(t => { const ts = new Date(t.kdy).getTime(), te = ts + (t.delka || delka) * 60_000; return ts < konec && te > start; });
      if (!kolize) out.push({ kdy: iso, cas: casZMinut(m), misto: den.misto });
    }
    return out;
  }
  /* nejbližší volné termíny: preferovaný den týdne (je-li), jinak kterýkoli ordinační; triage zkracuje horizont */
  function navrhniTerminy(pref, triage, kolik = 3, odDatum) {
    const start = odDatum || praha().datum;
    const prefDen = prefDenTydne(pref);
    const naleh = /155|do 2 dn/i.test(triage || "") ? 0 : /do t[ýy]dne/i.test(triage || "") ? 1 : 2;   /* 0 = cokoli nejdřív, 1 = do 14 dní cokoli, 2 = preferovaný den */
    const out = [];
    for (let i = 0; i < 60 && out.length < kolik; i++) {
      const datum = datumPlus(start, i);
      if (naleh === 2 && prefDen !== null && denTydne(datum) !== prefDen) continue;
      if (naleh === 1 && i > 14 && prefDen !== null && denTydne(datum) !== prefDen) continue;
      for (const s of volneSloty(datum)) { out.push(s); if (out.length >= kolik) break; }
    }
    if (!out.length && prefDen !== null) return navrhniTerminy("", "do týdne", kolik, odDatum);   /* preferovaný den plný → cokoli */
    return out;
  }
  function prefDenTydne(text) {
    const t = String(text || "").toLowerCase();
    for (const [k, v] of Object.entries(o.nastaveni.dny)) if (v.misto && t.includes(v.misto.toLowerCase())) return Number(k);
    const dny = { "pond": 1, "úter": 2, "uter": 2, "střed": 3, "stred": 3, "čtvr": 4, "ctvr": 4, "pát": 5, "pat": 5 };
    for (const [k, v] of Object.entries(dny)) if (t.includes(k)) return v;
    return null;
  }

  /* ---------- objednávky z poradny ---------- */
  function rozeberObjednavku(text) {
    const t = String(text || "").replace(/^\[OBJEDNANI\]\s*/, "");
    const radky = t.split("\n").map(s => s.trim()).filter(Boolean);
    const hlava = radky[0] || "";
    const pole = {};
    for (const r of radky.slice(1)) { const m = r.match(/^([^:]{2,40}):\s*(.*)$/); if (m) pole[m[1].trim().toLowerCase()] = m[2].trim(); }
    const vem = (...k) => { for (const x of k) if (pole[x]) return pole[x]; return ""; };
    const psid = (hlava.match(/psid\s*(\d+)/i) || [])[1] || null;
    const zdroj = /messenger/i.test(hlava) ? "messenger" : /hlasov/i.test(hlava) ? "hovor" : /web/i.test(hlava) ? "web" : "jine";
    return {
      zdroj, psid, hlava,
      jmeno: vem("jméno", "jmeno"), telefon: vem("telefon"), vek: vem("věk", "vek"), diagnoza: vem("diagnóza", "diagnoza"),
      doporuceni: vem("doporučení ai", "doporuceni ai"), triage: vem("triage"), potiz: vem("hlavní potíž", "hlavni potiz", "potíž"), trvani: vem("trvání", "trvani"),
      varovne: vem("varovné příznaky", "varovne priznaky"), probehlo: vem("už proběhlo", "uz probehlo"), den: vem("preferovaný den", "preferovany den"), poznamka: vem("poznámka", "poznamka"),
      pozadavek: vem("požadavek", "pozadavek"),
    };
  }
  /* vstup z ulozZpravu: zpráva [OBJEDNANI] pro Organizera → objednávka + navržený termín + potvrzení přijetí */
  function zpracujObjednavku(msg, organizer, baseUrl) {
    if (o.objednavky.some(x => x.zpravaId === msg.id)) return null;
    const p = rozeberObjednavku(msg.text);
    const navrh = navrhniTerminy(p.den, p.triage, 3);
    const obj = {
      id: crypto.randomUUID().slice(0, 8), zpravaId: msg.id, od: msg.fromName, prijato: msg.t || new Date().toISOString(),
      ...p, stav: "nova", navrh: navrh.map(s => s.kdy), terminId: null, urgentni: /155/.test(p.triage || ""),
    };
    if (navrh.length) {
      const t = zalozTermin({ kdy: navrh[0].kdy, misto: navrh[0].misto, pacient: { jmeno: p.jmeno, telefon: p.telefon }, duvod: [p.potiz, p.diagnoza].filter(Boolean).join(" · "), objednavkaId: obj.id, zdroj: p.zdroj, stav: "navrzen", poznamka: p.triage ? `triage: ${p.triage}` : "" });
      obj.terminId = t.id; obj.stav = "navrzena";
    }
    o.objednavky.push(obj);
    if (o.objednavky.length > 500) o.objednavky = o.objednavky.slice(-500);
    logEvent(`ORDINACE: objednávka z ${p.zdroj}${obj.urgentni ? " — ⚠ triage 155" : ""}: ${navrh.length ? "navržen termín " + hezky(navrh[0].kdy) : "žádný volný termín"} (čeká na potvrzení vlastníkem)`);
    /* potvrzení přijetí pacientovi — bez termínu, ten potvrdí vlastník */
    const most = db.agents[msg.from];
    if (most) {
      const text = obj.urgentni
        ? (p.psid ? `[FB:${p.psid}] ` : "") + "Vaše obtíže mohou být naléhavé — pokud se stav zhoršuje (náhle oteklá bolestivá noha, dušnost, silné krvácení), volejte prosím 155. Objednávku jsme přijali a ordinace se Vám ozve co nejdříve."
        : (p.psid ? `[FB:${p.psid}] ` : "") + "Děkujeme, objednávku jsme přijali. Ordinace Vám termín potvrdí do 2 pracovních dnů zprávou nebo SMS.";
      const out = { id: crypto.randomUUID(), from: organizer.id, to: most.id, fromName: organizer.card.name, toName: most.card.name, text, visibility: "private", t: new Date().toISOString() };
      ulozZpravu(out, most, msg.id);
    }
    /* hlášení jen Organizerovi — Fable je finance, ordinaci nevede */
    const kam = [organizer].filter(Boolean);
    for (const a of kam) systemovaZprava(a.id, "Ordinace", `📋 Nová objednávka (${p.zdroj}): ${p.jmeno || "?"}${p.vek ? `, ${p.vek}` : ""} — ${p.potiz || p.diagnoza || "?"}${p.triage ? ` · triage ${p.triage}` : ""}. ${navrh.length ? `Navržen ${hezky(navrh[0].kdy)} (${navrh[0].misto}).` : "Žádný volný termín — vyber ručně."} Potvrď v záložce 🩺 Ordinace.`);
    return obj;
  }
  function zpracujHovor(msg) {
    const text = String(msg.text || "").replace(/^\[HOVOR\]\s*/, "");
    o.hovory.push({ id: crypto.randomUUID().slice(0, 8), kdy: msg.t || new Date().toISOString(), od: msg.fromName, text: text.slice(0, 2000) });
    if (o.hovory.length > 300) o.hovory = o.hovory.slice(-300);
    logEvent(`ORDINACE: shrnutí hovoru z poradny uloženo`);
  }

  /* ---------- termíny ---------- */
  function zalozTermin(t) {
    const x = {
      id: crypto.randomUUID().slice(0, 8), kdy: t.kdy, delka: Number(t.delka) || Number(o.nastaveni.delka) || 20,
      misto: t.misto || (o.nastaveni.dny[String(praha(new Date(t.kdy)).den)] || {}).misto || "",
      pacient: { jmeno: String((t.pacient || {}).jmeno || "").slice(0, 120), telefon: String((t.pacient || {}).telefon || "").slice(0, 40) },
      duvod: String(t.duvod || "").slice(0, 400), poznamka: String(t.poznamka || "").slice(0, 400),
      stav: t.stav || "potvrzen", objednavkaId: t.objednavkaId || null, zdroj: t.zdroj || "rucne",
      vytvoreno: new Date().toISOString(), historie: [],
    };
    o.terminy.push(x);
    if (o.terminy.length > 2000) o.terminy = o.terminy.slice(-2000);
    return x;
  }
  function objednavkaTerminu(t) { return t.objednavkaId ? o.objednavky.find(x => x.id === t.objednavkaId) : null; }
  /* akce vlastníka nad termínem; vrací {ok, termin, oznameno} */
  function upravTermin(id, telo, organizer, kdo) {
    const t = o.terminy.find(x => x.id === id);
    if (!t) return { error: "Termín nenalezen." };
    const akce = String(telo.akce || "");
    const obj = objednavkaTerminu(t);
    let oznameno = false;
    const zapis = (co) => t.historie.push({ kdy: new Date().toISOString(), co, kdo: kdo || "vlastník" });
    if (akce === "presunout" || (akce === "potvrdit" && telo.kdy)) {
      if (!telo.kdy) return { error: "Chybí kdy." };
      const novy = new Date(telo.kdy); if (isNaN(novy)) return { error: "Špatný čas." };
      const kolize = zive().some(x => x.id !== t.id && Math.abs(new Date(x.kdy).getTime() - novy.getTime()) < (t.delka || 20) * 60_000);
      if (kolize) return { error: "V ten čas už někdo je." };
      zapis(`přesun z ${hezky(t.kdy)} na ${hezky(novy.toISOString())}`);
      t.kdy = novy.toISOString(); t.misto = telo.misto || (o.nastaveni.dny[String(praha(novy).den)] || {}).misto || t.misto;
    }
    if (akce === "potvrdit" || akce === "presunout" && t.stav === "potvrzen") {
      t.stav = "potvrzen"; zapis("potvrzeno");
      if (obj) obj.stav = "potvrzena";
      if (telo.oznamit !== false) oznameno = oznamPacientovi(t, obj, organizer);
    } else if (akce === "zrusit") {
      t.stav = "zrusen"; zapis(`zrušeno${telo.duvod ? ": " + telo.duvod : ""}`);
      if (obj) obj.stav = "zrusena";
      if (telo.oznamit === true && obj && obj.psid) oznameno = poslatPacientovi(obj.psid, `Omlouváme se, termín ${hezky(t.kdy)} musíme zrušit${telo.duvod ? " (" + telo.duvod + ")" : ""}. Ozveme se s náhradním termínem.`, organizer);
    } else if (akce === "probehl") { t.stav = "probehl"; zapis("proběhl"); }
    else if (akce === "neprisel") { t.stav = "neprisel"; zapis("nepřišel"); }
    else if (akce === "poznamka") { t.poznamka = String(telo.poznamka || "").slice(0, 400); }
    else if (akce !== "presunout") return { error: `Neznámá akce "${akce}" (potvrdit, presunout, zrusit, probehl, neprisel, poznamka).` };
    return { ok: true, termin: t, oznameno };
  }
  function oznamPacientovi(t, obj, organizer) {
    if (!obj || !obj.psid) return false;
    const text = (o.nastaveni.potvrzeniText || "Potvrzujeme termín {kdy} ({misto}).").replace("{kdy}", hezky(t.kdy)).replace("{misto}", t.misto || "");
    return poslatPacientovi(obj.psid, text, organizer);
  }
  function poslatPacientovi(psid, text, organizer) {
    const most = agentJmenem(MOST_NAME); if (!most || !organizer) return false;
    const out = { id: crypto.randomUUID(), from: organizer.id, to: most.id, fromName: organizer.card.name, toName: most.card.name, text: `[FB:${psid}] ${text}`, visibility: "private", t: new Date().toISOString() };
    ulozZpravu(out, most, null);
    logEvent(`ORDINACE: pacientovi odeslána zpráva přes ${most.card.name}`);
    return true;
  }

  /* ---------- přehled dne ---------- */
  function terminyDne(datum) {
    return zive().filter(t => praha(new Date(t.kdy)).datum === datum).sort((a, b) => a.kdy < b.kdy ? -1 : 1);
  }
  function sestavPrehled(datum, extra) {
    const p = praha(); datum = datum || p.datum;
    const den = o.nastaveni.dny[String(denTydne(datum))];
    const dnes = terminyDne(datum);
    const zitra = terminyDne(datum ? datumPlus(datum, 1) : null);
    const ceka = o.objednavky.filter(x => x.stav === "nova" || x.stav === "navrzena");
    const od24 = Date.now() - 24 * 3600_000;
    const hovory = o.hovory.filter(h => new Date(h.kdy).getTime() > od24);
    const org = agentJmenem(ORGANIZER_NAME), fable = agentJmenem(FABLE_NAME);
    const bezOdpovedi = [org, fable].filter(Boolean).map(a => ({ a, n: db.messages.filter(m => m.to === a.id && m.from !== "system" && m.status !== "answered" && !/^\[(OBJEDNANI|HOVOR|PREHLED)\]/.test(m.text || "") && !db.messages.some(r => r.from === a.id && r.to === m.from && r.t > m.t)).length }));
    const r = [];
    r.push(`🩺 Ranní přehled — ${DEN[denTydne(datum)]} ${datum.split("-").reverse().join(". ")}${den ? ` · ordinace ${den.misto} ${den.od}–${den.do}` : " · dnes se neordinuje"}${blokovano(datum) ? ` · BLOKACE: ${blokovano(datum).duvod || ""}` : ""}`);
    if (dnes.length) { r.push(`\nDnes ${dnes.length} termínů:`); for (const t of dnes) r.push(`  ${praha(new Date(t.kdy)).cas} ${t.pacient.jmeno || "?"}${t.pacient.telefon ? " (" + t.pacient.telefon + ")" : ""} — ${t.duvod || "?"} [${t.stav}]`); }
    else r.push(`\nDnes žádný termín.`);
    if (zitra.length) r.push(`Zítra ${zitra.length} termínů (${zitra.map(t => praha(new Date(t.kdy)).cas).join(", ")}).`);
    if (ceka.length) { r.push(`\n⏳ Čeká na tvoje potvrzení (${ceka.length}):`); for (const x of ceka.slice(0, 10)) { const t = x.terminId ? o.terminy.find(y => y.id === x.terminId) : null; r.push(`  ${x.jmeno || "?"} (${x.zdroj}${x.triage ? ", " + x.triage : ""}) — ${x.potiz || x.diagnoza || "?"} → ${t ? "navržen " + hezky(t.kdy) : "bez termínu"}`); } }
    if (hovory.length) { r.push(`\n📞 Hovory z poradny za 24 h: ${hovory.length}`); for (const h of hovory.slice(-5)) r.push(`  ${praha(new Date(h.kdy)).cas} ${h.text.slice(0, 160)}`); }
    const bo = bezOdpovedi.filter(x => x.n); if (bo.length) r.push(`\n✉ Bez odpovědi: ${bo.map(x => `${x.a.card.name} ${x.n}`).join(", ")}`);
    if (extra) r.push(`\n${extra}`);
    return r.join("\n");
  }
  function posliPrehled(datum, baseUrl, extra) {
    const p = praha(); datum = datum || p.datum;
    const text = sestavPrehled(datum, extra);
    o.prehledy[datum] = { kdy: new Date().toISOString(), text };
    const org = agentJmenem(ORGANIZER_NAME);   /* jen Organizer — Fable (finance) ordinaci nedostává */
    if (org) systemovaZprava(org.id, "Ranní přehled", text);
    if (ORGANIZER_FB_PSID && org) poslatPacientovi(ORGANIZER_FB_PSID, text, org);
    const klice = Object.keys(o.prehledy).sort(); if (klice.length > 60) for (const k of klice.slice(0, klice.length - 60)) delete o.prehledy[k];
    logEvent(`ORDINACE: ranní přehled ${datum} sestaven${ORGANIZER_FB_PSID ? " a poslán do Messengeru vlastníka" : ""}`);
    save();
    return text;
  }
  /* minutový tik: v PREHLED_HODINA jednou denně; po restartu dožene dnešek, je-li po té hodině */
  function tik(extraDodavatel) {
    const p = praha();
    if (p.hh < PREHLED_HODINA || o.prehledy[p.datum]) return false;
    try { posliPrehled(p.datum, baseUrlDefault, extraDodavatel ? extraDodavatel(p.datum) : ""); } catch (e) { logEvent(`ORDINACE: přehled selhal — ${e.message}`); }
    return true;
  }

  /* ---------- odchozí hovor (přes Most → ElevenLabs/Twilio) ---------- */
  async function zavolat({ telefon, ucel, terminId, jmeno }) {
    if (!MOST_KLIC) return { error: "Odchozí hovory nejsou nastavené: na AInetu chybí MOST_KLIC (a na Mostu ELEVENLABS_PHONE_NUMBER_ID + HLAS_ORGANIZER_AGENT)." };
    const t = terminId ? o.terminy.find(x => x.id === terminId) : null;
    const tel = String(telefon || (t && t.pacient.telefon) || "").replace(/[^\d+]/g, "");
    if (tel.replace(/\D/g, "").length < 9) return { error: "Chybí telefonní číslo." };
    const telo = { telefon: tel, jmeno: jmeno || (t && t.pacient.jmeno) || "", ucel: ucel || (t ? `potvrzení termínu ${hezky(t.kdy)} (${t.misto})` : "informace z ordinace"), termin: t ? hezky(t.kdy) : "", misto: t ? t.misto : "" };
    const ctrl = new AbortController(); const tmr = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const r = await fetch(`${MOST_URL}/organizer/zavolat`, { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "x-organizer-klic": MOST_KLIC }, body: JSON.stringify(telo) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return { error: d.chyba || d.error || `Most odpověděl ${r.status}` };
      o.hovory.push({ id: crypto.randomUUID().slice(0, 8), kdy: new Date().toISOString(), od: "Organizer", text: `📤 Odchozí hovor na ${tel.replace(/\d(?=\d{3})/g, "•")}: ${telo.ucel} (${d.stav || "zahájen"})`, odchozi: true });
      if (t) t.historie.push({ kdy: new Date().toISOString(), co: `odchozí hovor: ${telo.ucel}`, kdo: "Organizer" });
      logEvent(`ORDINACE: odchozí hovor zahájen (${telo.ucel})`);
      return { ok: true, ...d };
    } catch (e) { return { error: `Most nedostupný: ${e.message}` }; }
    finally { clearTimeout(tmr); }
  }

  /* ---------- výstupy pro API ---------- */
  function prehledProApi(od, dni) {
    const p = praha(); od = od || p.datum; dni = Math.min(60, Math.max(1, Number(dni) || 14));
    const dnyOut = [];
    for (let i = 0; i < dni; i++) {
      const datum = datumPlus(od, i); const den = o.nastaveni.dny[String(denTydne(datum))];
      if (!den && !terminyDne(datum).length) continue;
      dnyOut.push({ datum, den: DEN[denTydne(datum)], misto: den ? den.misto : null, hodiny: den ? `${den.od}–${den.do}` : null, blokace: blokovano(datum), terminy: terminyDne(datum), volno: volneSloty(datum) });
    }
    return {
      dnes: p.datum, ted: p.cas, nastaveni: o.nastaveni, dny: dnyOut,
      objednavky: o.objednavky.filter(x => x.stav === "nova" || x.stav === "navrzena").map(x => ({ ...x, navrzeny: x.terminId ? o.terminy.find(t => t.id === x.terminId) : null })),
      hovory: o.hovory.slice(-20), prehled: o.prehledy[p.datum] || null,
      odchoziHovory: !!MOST_KLIC,
    };
  }

  return { praha, isoZPrahy, hezky, volneSloty, navrhniTerminy, rozeberObjednavku, zpracujObjednavku, zpracujHovor, zalozTermin, upravTermin, sestavPrehled, posliPrehled, tik, zavolat, prehledProApi, nastaveni: o.nastaveni, data: o };
};
