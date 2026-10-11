/*
 * sandbox.js — dlouhodobá paměť agenta („sandbox“): archiv dokumentů s hledáním.
 *
 * Paměť agenta má tři vrstvy:
 *   JÁDRO      krátké „kdo jsem a co umím“ — jde do každého probuzení (server.js, db.jadro)
 *   POZNÁMKY   věty a DENÍK sezení — posledních pár do probuzení (server.js, db.poznamky / db.denik)
 *   SANDBOX    tady: velké texty (postupy, znalosti, zápisy, výpisy). Do probuzení jde jen
 *              seznam názvů; obsah si agent vytáhne hledáním (recall, /najdi/KOD/DOTAZ),
 *              když ho potřebuje. Co přeteče z poznámek a deníku, se sem archivuje místo smazání.
 *
 * Každý agent má vlastní soubor DATA_DIR/sandbox/<id>.json — mimo hlavní agents.json,
 * aby velké texty nezpomalovaly ukládání sítě při každé zprávě. Zápis je atomický (.tmp → rename).
 */
"use strict";

module.exports = function sandboxModul({ DATA_DIR, crypto, fs, path, logEvent }) {
  const SLOZKA = path.join(DATA_DIR, "sandbox");
  const MAX_TEXT = Number(process.env.SANDBOX_MAX_TEXT || 100_000);       /* znaků na dokument */
  const MAX_DOKUMENTU = Number(process.env.SANDBOX_MAX_DOKUMENTU || 500); /* dokumentů na agenta */
  const MAX_CELKEM = Number(process.env.SANDBOX_MAX_CELKEM || 3_000_000); /* znaků na agenta */
  const cache = new Map();

  const bezpecneId = (id) => /^[\w-]{6,64}$/.test(String(id || ""));
  const soubor = (agentId) => path.join(SLOZKA, `${agentId}.json`);

  function nacti(agentId) {
    if (!bezpecneId(agentId)) return [];
    if (cache.has(agentId)) return cache.get(agentId);
    let docs = [];
    try { docs = JSON.parse(fs.readFileSync(soubor(agentId), "utf8")); if (!Array.isArray(docs)) docs = []; } catch { docs = []; }
    cache.set(agentId, docs);
    return docs;
  }
  function zapis(agentId, docs) {
    fs.mkdirSync(SLOZKA, { recursive: true });
    const tmp = soubor(agentId) + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(docs));
    fs.renameSync(tmp, soubor(agentId));
    cache.set(agentId, docs);
  }

  const celkem = (docs) => docs.reduce((s, d) => s + (d.text || "").length, 0);
  const norm = (t) => String(t || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const stitkyZ = (v) => (Array.isArray(v) ? v : String(v || "").split(","))
    .map(s => String(s).trim().toLowerCase().slice(0, 30)).filter(Boolean).slice(0, 8);
  const ven = (d, s) => ({ id: d.id, nazev: d.nazev, stitky: d.stitky || [], kdy: d.kdy, upraveno: d.upraveno || d.kdy,
    zdroj: d.zdroj || null, znaku: (d.text || "").length, ...(s ? { uryvek: s } : { zacatek: (d.text || "").slice(0, 160) }) });

  function statistika(agentId) {
    const docs = nacti(agentId);
    return { dokumentu: docs.length, znaku: celkem(docs), limit_dokumentu: MAX_DOKUMENTU, limit_znaku: MAX_CELKEM, limit_na_dokument: MAX_TEXT };
  }
  function seznam(agentId, n = 200) {
    return [...nacti(agentId)].sort((a, b) => String(b.upraveno || b.kdy).localeCompare(String(a.upraveno || a.kdy))).slice(0, n).map(d => ven(d));
  }
  function dokument(agentId, sid) {
    const d = nacti(agentId).find(x => x.id === String(sid));
    return d ? { ...ven(d), text: d.text } : null;
  }

  /* uložit nový, nebo přepsat existující (sid) — vrací {ok, dokument} nebo {error} */
  function uloz(agentId, { id, nazev, text, stitky, zdroj } = {}) {
    const docs = nacti(agentId);
    const t = String(text ?? "").replace(/\r\n/g, "\n");
    const n = String(nazev || "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!t.trim()) return { error: "Prázdný text dokumentu." };
    if (t.length > MAX_TEXT) return { error: `Dokument je moc dlouhý (${t.length} znaků, limit ${MAX_TEXT}). Rozděl ho na víc dokumentů.` };
    const puvodni = id ? docs.find(x => x.id === String(id)) : null;
    if (id && !puvodni) return { error: "Dokument s tímto id v sandboxu není." };
    const bez = celkem(docs) - (puvodni ? (puvodni.text || "").length : 0);
    if (bez + t.length > MAX_CELKEM) return { error: `Sandbox je plný (${bez + t.length} z ${MAX_CELKEM} znaků). Smaž nebo zkrať staré dokumenty.` };
    if (!puvodni && docs.length >= MAX_DOKUMENTU) return { error: `Sandbox má už ${MAX_DOKUMENTU} dokumentů. Smaž staré nebo je slouč.` };
    const ted = new Date().toISOString();
    let d;
    if (puvodni) {
      d = puvodni; d.text = t; d.upraveno = ted;
      if (n) d.nazev = n;
      if (stitky !== undefined) d.stitky = stitkyZ(stitky);
    } else {
      d = { id: crypto.randomUUID().slice(0, 12), nazev: n || t.split("\n")[0].slice(0, 80) || "bez názvu", text: t,
        stitky: stitkyZ(stitky), kdy: ted, upraveno: ted, zdroj: String(zdroj || "").slice(0, 120) || null };
      docs.push(d);
    }
    zapis(agentId, docs);
    return { ok: true, dokument: ven(d), sandbox: statistika(agentId) };
  }

  /* připsat na konec dokumentu se stejným názvem (archivy přetečení); když je plný, založí pokračování */
  function pripis(agentId, nazev, text, stitky) {
    const docs = nacti(agentId);
    let d = [...docs].reverse().find(x => x.nazev === nazev || x.nazev.startsWith(nazev + " (pokr."));
    const pridat = String(text || "").trim();
    if (!pridat) return null;
    if (d && (d.text.length + pridat.length + 1) <= MAX_TEXT) {
      return uloz(agentId, { id: d.id, text: d.text + "\n" + pridat });
    }
    const pokr = d ? `${nazev} (pokr. ${docs.filter(x => x.nazev === nazev || x.nazev.startsWith(nazev + " (pokr.")).length + 1})` : nazev;
    return uloz(agentId, { nazev: pokr, text: pridat.slice(0, MAX_TEXT), stitky, zdroj: "archiv" });
  }

  function smaz(agentId, sid) {
    const docs = nacti(agentId);
    const i = docs.findIndex(x => x.id === String(sid));
    if (i < 0) return false;
    docs.splice(i, 1); zapis(agentId, docs);
    return true;
  }
  function smazVse(agentId) {
    cache.delete(agentId);
    try { if (bezpecneId(agentId)) fs.unlinkSync(soubor(agentId)); } catch {}
  }

  /* HLEDÁNÍ: slova dotazu bez diakritiky; název váží nejvíc, štítky víc než text;
     dokument, který obsahuje víc různých slov, vyhrává. Úryvek kolem prvního nálezu. */
  function hledej(agentId, dotaz, n = 8) {
    const slova = norm(dotaz).split(/[^a-z0-9]+/).filter(s => s.length >= 2).slice(0, 12);
    if (!slova.length) return [];
    const vysledky = [];
    for (const d of nacti(agentId)) {
      const nN = norm(d.nazev), nS = norm((d.stitky || []).join(" ")), nT = norm(d.text);
      let skore = 0, ruznych = 0, prvni = -1;
      for (const s of slova) {
        let vText = 0, i = nT.indexOf(s);
        while (i >= 0 && vText < 20) { if (prvni < 0 || i < prvni) prvni = i; vText++; i = nT.indexOf(s, i + s.length); }
        const vN = nN.includes(s) ? 1 : 0, vS = nS.includes(s) ? 1 : 0;
        if (vText || vN || vS) ruznych++;
        skore += vN * 6 + vS * 4 + vText;
      }
      if (!ruznych) continue;
      skore += ruznych * 10;
      const od = Math.max(0, prvni - 120);
      const uryvek = prvni >= 0 ? (od > 0 ? "…" : "") + d.text.slice(od, prvni + 220).replace(/\s+/g, " ").trim() + (prvni + 220 < d.text.length ? "…" : "") : d.text.slice(0, 200);
      vysledky.push({ skore, ...ven(d, uryvek) });
    }
    return vysledky.sort((a, b) => b.skore - a.skore).slice(0, n);
  }

  /* pro probuzení: kolik toho je a posledních pár názvů */
  function prehled(agentId, n = 25) {
    const s = statistika(agentId);
    return { ...s, posledni: seznam(agentId, n).map(d => ({ id: d.id, nazev: d.nazev, stitky: d.stitky, upraveno: d.upraveno, znaku: d.znaku })) };
  }

  return { seznam, dokument, uloz, pripis, smaz, smazVse, hledej, prehled, statistika, MAX_TEXT };
};
