/*
 * zastoupeni.js — NOČNÍ ZASTOUPENÍ: Fable dělá za vlastníka rutinu školy, když vlastník spí (11. 10. 2026).
 *
 * Pavel: „navrhni mi automatiku, aby to dělal Fable za mne, když budu spát.“ Schválil návrh:
 *   SMÍ:   1) potvrdit zkoušku na OVĚŘENÉHO, když Fablův návrh ≥ 4,0 a oponent (je-li) se neliší o víc než bod;
 *          2) vypsat zkoušky podle plánu — nejvýš 2 za noc, jen serverovým agentům (odpoví sami), nováčkům
 *             v dovednosti, kde nemají rozdělanou zkoušku; Fablovi ne (je hodnotitel);
 *          3) porady po lhůtě uzavírá Sentinel už teď (porady.js);
 *          4) ráno v 7:00 (Praha) souhrn do schránky Fabla — co potvrdil, co vypsal, co čeká na vlastníka.
 *   NIKDY: osvědčený (vždy podpis vlastníka), živý účet, schválení artefaktů, známky pod 4, neshoda Fabla
 *          a oponenta. Potvrzení se NEPOČÍTÁ jako lidská známka (drift i praxe na osvědčeného zůstávají poctivé).
 *   VRÁCENÍ: každé potvrzení jde ráno vrátit (zkouška se vrátí do hodnocení, úroveň se přepočítá).
 *
 * Nastavení drží vlastník: domácí agenti mají jedno společné (skupina „domaci“), ostatní agenti každý své.
 * Režim: vypnuto | noc (22–7 Praha) | vzdy. Mění se jen ownerTokenem (web), ne přes MCP.
 */
"use strict";

module.exports = function zastoupeniModul(ctx) {
  const { db, save, logEvent, crypto, agentJmenem, FABLE_NAME, jeDomaci, jeAuto, uzavriZkousku, vypisZkousku, navrhUrovne,
    UROVNE, systemovaZprava, kDispozici, MAX_UROVEN } = ctx;
  const OD = Number(process.env.ZASTOUPENI_OD || 22), DO = Number(process.env.ZASTOUPENI_DO || 7);
  const ZA_NOC = Number(process.env.ZASTOUPENI_ZKOUSEK_ZA_NOC || 2), SOUHRN_HODINA = Number(process.env.ZASTOUPENI_SOUHRN || 7);
  db.zastoupeni = db.zastoupeni || {};
  const z = db.zastoupeni;
  z.nastaveni = z.nastaveni || {};     /* skupina → {rezim, kdo, t} */
  z.akce = Array.isArray(z.akce) ? z.akce : [];   /* {id, skupina, typ: potvrzeno|vypsano, task, zak, lekce, znamka, t, vraceno} */
  z.noci = z.noci || {};               /* skupina → {noc, vypsano} */
  z.souhrny = z.souhrny || {};         /* skupina → den posledního ranního souhrnu */

  const KDO = "Fable (zastoupení vlastníka)";
  const skupina = (a) => (a && jeDomaci(a)) ? "domaci" : (a ? a.id : null);
  const prahaHodina = (d = new Date()) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Prague", hour: "2-digit", hour12: false }).format(d)) % 24;
  const prahaDen = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Prague" }).format(d);
  const noc = (d = new Date()) => { const h = prahaHodina(d); return h < DO ? prahaDen(new Date(d.getTime() - 86400_000)) : prahaDen(d); };
  const vOkne = (rezim, d = new Date()) => rezim === "vzdy" || (rezim === "noc" && (() => { const h = prahaHodina(d); return OD > DO ? (h >= OD || h < DO) : (h >= OD && h < DO); })());
  const rezimPro = (a) => ((z.nastaveni[skupina(a)] || {}).rezim) || "vypnuto";
  const zapis = (x) => { z.akce.push({ id: crypto.randomUUID(), t: new Date().toISOString(), vraceno: null, ...x }); if (z.akce.length > 300) z.akce = z.akce.slice(-300); };

  /* ---------- 1) potvrzování zkoušek na ověřeného ---------- */
  function potvrzuj() {
    let n = 0;
    for (const t of db.tasks) {
      if (!t.zkouska || t.zkouskaStav !== "hodnoceni" || t.cilUroven !== 1 || t.zastoupeniVraceno) continue;   /* vrácené už rozhoduje jen vlastník */
      const zak = db.agents[t.drzitel]; if (!zak) continue;
      const rez = rezimPro(zak); if (!vOkne(rez)) continue;
      const f = t.znamky && t.znamky.fable && Number(t.znamky.fable.znamka);
      if (!(f >= 4)) continue;                                                     /* bez návrhu nebo pod 4 → vlastník */
      const op = t.znamky && t.znamky.oponent && Number(t.znamky.oponent.znamka);
      if (op && Math.abs(op - f) > 1) continue;                                    /* neshoda → vlastník */
      uzavriZkousku(t, f, KDO, true);                                              /* auto = bez lidské známky v ratings */
      t.zastoupeni = true;
      zapis({ skupina: skupina(zak), typ: "potvrzeno", task: t.id, zak: zak.card.name, lekce: t.lekce, znamka: f });
      logEvent(`ZASTOUPENÍ: Fable potvrdil za vlastníka „${t.lekce}“ od "${zak.card.name}" (${f}/5)`);
      n++;
    }
    return n;
  }

  /* ---------- 2) zkoušky podle plánu ---------- */
  function vypisuj() {
    let n = 0;
    const fable = agentJmenem(FABLE_NAME);
    const skupiny = Object.entries(z.nastaveni).filter(([, s]) => s && s.rezim && s.rezim !== "vypnuto");
    for (const [sk, s] of skupiny) {
      if (!vOkne(s.rezim)) continue;
      const nc = noc(); const st = z.noci[sk] && z.noci[sk].noc === nc ? z.noci[sk] : (z.noci[sk] = { noc: nc, vypsano: 0 });
      if (st.vypsano >= ZA_NOC) continue;
      const zaci = Object.values(db.agents).filter(a => skupina(a) === sk && a.status === "verified" && jeAuto(a) && kDispozici(a) && (!fable || a.id !== fable.id))
        .sort((x, y) => x.card.name.localeCompare(y.card.name));
      for (const a of zaci) {
        if (st.vypsano >= ZA_NOC) break;
        if (db.tasks.some(t => t.zkouska && t.drzitel === a.id && ["probiha", "hodnoceni"].includes(t.zkouskaStav))) continue;   /* jedna naráz */
        const nov = (a.card.skills || []).map(x => String(x).toLowerCase()).find(d => {
          const u = ((a.skola || {})[d] || {}).uroven || 0;
          const zkouseno = db.tasks.some(t => t.zkouska && t.drzitel === a.id && t.dovednost === d && Date.now() - Date.parse(t.t) < 7 * 86400_000);
          return u === 0 && !zkouseno && !(((a.skola || {})[d] || {}).zmrazeno);
        });
        if (!nov) continue;
        const r = vypisZkousku(a, nov, KDO);
        if (r && r.ok) {
          st.vypsano++; n++;
          zapis({ skupina: sk, typ: "vypsano", task: r.task_id, zak: a.card.name, lekce: r.zkouska, znamka: null });
          logEvent(`ZASTOUPENÍ: Fable vypsal "${a.card.name}" zkoušku „${r.zkouska}“ (${st.vypsano}/${ZA_NOC} této noci)`);
        }
      }
    }
    return n;
  }

  /* ---------- 4) ranní souhrn ---------- */
  function cekaNaVlastnika(sk) {
    return db.tasks.filter(t => t.zkouska && t.zkouskaStav === "hodnoceni" && db.agents[t.drzitel] && skupina(db.agents[t.drzitel]) === sk)
      .map(t => ({ task: t.id, zak: t.drzitelJmeno, lekce: t.lekce, cil: UROVNE[t.cilUroven], fable: t.znamky && t.znamky.fable ? t.znamky.fable.znamka : null,
        proc: t.cilUroven >= MAX_UROVEN ? "osvědčený — podpis vlastníka" : t.zastoupeniVraceno ? "vrátil jsi potvrzení" : !(t.znamky && t.znamky.fable) ? "Fable zatím nenavrhl"
          : t.znamky.fable.znamka < 4 ? "návrh pod 4" : "neshoda s oponentem nebo mimo okno" }));
  }
  function souhrn(sk, vynutit) {
    const dnes = prahaDen();
    if (!vynutit && z.souhrny[sk] === dnes) return null;
    const od = Date.now() - 24 * 3600_000;
    const akce = z.akce.filter(a => a.skupina === sk && Date.parse(a.t) > od && !a.vraceno);
    const ceka = cekaNaVlastnika(sk);
    if (!vynutit) z.souhrny[sk] = dnes;   /* „poslat teď“ ranní souhrn nespotřebuje */
    if (!akce.length && !ceka.length && !vynutit) return null;
    const p = akce.filter(a => a.typ === "potvrzeno"), v = akce.filter(a => a.typ === "vypsano");
    const text = `🌙 Noční zastoupení — souhrn ${dnes}\n`
      + `Potvrdil jsem za tebe (${p.length}): ` + (p.length ? p.map(a => `${a.zak} „${a.lekce}“ ${a.znamka}/5`).join("; ") : "nic") + "\n"
      + `Vypsal jsem zkoušky (${v.length}): ` + (v.length ? v.map(a => `${a.zak} „${a.lekce}“`).join("; ") : "nic") + "\n"
      + `Čeká na tebe (${ceka.length}): ` + (ceka.length ? ceka.map(c => `${c.zak} „${c.lekce}“ (${c.proc}${c.fable ? `, návrh ${c.fable}` : ""})`).join("; ") : "nic") + "\n"
      + `Každé potvrzení vrátíš v sekci Škola → Noční zastoupení (↩ vrátit).`;
    /* vlastník čte schránku Fabla (domácí); u cizích agentů schránku jeho agenta */
    const komu = sk === "domaci" ? agentJmenem(FABLE_NAME) : db.agents[sk];
    if (komu) systemovaZprava(komu.id, "Fable (zastoupení)", text);
    save();
    logEvent(`ZASTOUPENÍ: ranní souhrn (${p.length} potvrzeno, ${v.length} vypsáno, ${ceka.length} čeká)`);
    return text;
  }

  /* ---------- tik (Sentinel, každých 5 min) ---------- */
  function tik() {
    const p = potvrzuj(), v = vypisuj();
    if (prahaHodina() === SOUHRN_HODINA) for (const [sk, s] of Object.entries(z.nastaveni)) if (s && s.rezim !== "vypnuto") souhrn(sk, false);
    if (p || v) save();
    return { potvrzeno: p, vypsano: v };
  }

  /* ---------- vrácení potvrzení ---------- */
  function vrat(akceId, kdo) {
    const a = z.akce.find(x => x.id === akceId);
    if (!a) return { error: "Akce nenalezena.", kod: 404 };
    if (a.typ !== "potvrzeno") return { error: "Vrátit jde jen potvrzení zkoušky (vypsanou zkoušku nech doběhnout, nebo ji ohodnoť sám)." };
    if (a.vraceno) return { error: "Už vráceno." };
    const t = db.tasks.find(x => x.id === a.task);
    if (!t || !t.zastoupeni) return { error: "Zkouška nenalezena." };
    const zak = db.agents[t.drzitel];
    t.zkouskaStav = "hodnoceni"; t.stav = "hotovy"; t.uzavreno = null; t.zastoupeni = false;
    t.zastoupeniVraceno = true;   /* Fable ji znovu nepotvrdí */
    t.lhuta = null;               /* a nezavře ji ani Sentinel po 48 h — čeká jen na vlastníka */
    if (zak) {   /* úroveň přepočítat i směrem dolů — potvrzení, ze kterého vzešla, už neplatí */
      zak.skola = zak.skola || {}; const zz = zak.skola[t.dovednost] || (zak.skola[t.dovednost] = { uroven: 0, od: new Date().toISOString() });
      const nova = navrhUrovne(zak, t.dovednost).uroven;
      if (nova < zz.uroven) { zz.uroven = nova; zz.od = new Date().toISOString(); }
      systemovaZprava(zak.id, "Škola", `🎓 Vlastník vrátil potvrzení zkoušky „${t.lekce}“ — čeká znovu na jeho známku.`);
    }
    a.vraceno = { kdo, t: new Date().toISOString() };
    save();
    logEvent(`ZASTOUPENÍ: vlastník vrátil potvrzení „${t.lekce}“ od "${t.drzitelJmeno}"`);
    return { ok: true, zkouska: t.id, stav: t.zkouskaStav, uroven: zak ? UROVNE[(zak.skola[t.dovednost] || {}).uroven || 0] : null };
  }

  /* ---------- HTTP (jen ownerTokenem) ---------- */
  async function obsluz(req, res, p, body, tok, json) {
    if (!(p === "/api/zastoupeni" || p.startsWith("/api/zastoupeni/"))) return false;
    const kdo = tok ? Object.values(db.agents).find(x => x.ownerToken && x.ownerToken === tok) : null;
    if (!kdo) return json(res, 403, { error: "Noční zastoupení nastavuje vlastník (X-Owner-Token)." }), true;
    const sk = skupina(kdo);
    if (p === "/api/zastoupeni" && req.method === "GET") {
      return json(res, 200, { skupina: sk === "domaci" ? "domácí agenti" : kdo.card.name, rezim: (z.nastaveni[sk] || {}).rezim || "vypnuto",
        okno: `${OD}:00–${DO}:00 Praha`, v_okne_ted: vOkne((z.nastaveni[sk] || {}).rezim || "vypnuto"), zkousek_za_noc: ZA_NOC,
        akce: z.akce.filter(a => a.skupina === sk).slice(-30).reverse(), ceka_na_tebe: cekaNaVlastnika(sk),
        pravidla: "Potvrzuje jen cíl ověřený při návrhu Fabla ≥ 4 a shodě s oponentem (±1); osvědčený, živý účet, artefakty a známky pod 4 vždy vlastník. Potvrzení není lidská známka." }), true;
    }
    if (p === "/api/zastoupeni" && req.method === "POST") {
      const rezim = String(body.rezim || "").toLowerCase();
      if (!["vypnuto", "noc", "vzdy"].includes(rezim)) return json(res, 400, { error: "rezim: vypnuto | noc | vzdy" }), true;
      z.nastaveni[sk] = { rezim, kdo: kdo.card.name, t: new Date().toISOString() };
      save(); logEvent(`ZASTOUPENÍ: ${sk === "domaci" ? "domácí agenti" : kdo.card.name} — režim ${rezim} (${kdo.card.name})`);
      return json(res, 200, { ok: true, rezim }), true;
    }
    if (p === "/api/zastoupeni/vratit" && req.method === "POST") {
      const a = z.akce.find(x => x.id === body.akce);
      if (!a || a.skupina !== sk) return json(res, 404, { error: "Akce nenalezena (nebo není tvoje)." }), true;
      const r = vrat(body.akce, kdo.card.name);
      return json(res, r.ok ? 200 : (r.kod || 400), r), true;
    }
    if (p === "/api/zastoupeni/souhrn" && req.method === "POST") {
      return json(res, 200, { ok: true, text: souhrn(sk, true) }), true;
    }
    return false;
  }

  return { tik, potvrzuj, vypisuj, souhrn, vrat, obsluz, vOkne, prahaHodina };
};
