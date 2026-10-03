/**
 * literatura.js — odborné zdroje pro Doctora (Pavel Ditl MD). Node 18+, bez závislostí.
 *
 *   Europe PMC  – celý PubMed (MEDLINE) + PubMed Central, vrací rovnou abstrakta
 *   ClinicalTrials.gov – registr klinických studií (API v2)
 *
 * Exportuje nástroje pro model (Anthropic tool use) a smyčku askWithTools(),
 * kterou používá poradna (bridge-fb.js) i soukromá sekce (pavel.js).
 */
const EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest/search";
const CTG = "https://clinicaltrials.gov/api/v2/studies";
const UA = { "User-Agent": "PavelDitlMD-Doctor/1.0 (fb-most.onrender.com)" };
const strip = (h) => String(h || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const zkrat = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/* ---------- Europe PMC (PubMed) ---------- */
async function hledejClanky(dotaz, { max = 5, odRoku, doRoku, odData, doData, typ = "vse", razeni = "relevance" } = {}) {
  let q = `(${dotaz}) AND SRC:MED`;
  if (odRoku || doRoku) q += ` AND PUB_YEAR:[${odRoku || 1900} TO ${doRoku || 2100}]`;
  if (odData || doData) q += ` AND FIRST_PDATE:[${odData || "1900-01-01"} TO ${doData || "2100-12-31"}]`;
  if (typ === "prehledy") q += ` AND (PUB_TYPE:"Review" OR PUB_TYPE:"Systematic Review" OR PUB_TYPE:"Meta-Analysis" OR PUB_TYPE:"Randomized Controlled Trial" OR PUB_TYPE:"Practice Guideline")`;
  const p = new URLSearchParams({ query: q, format: "json", resultType: "core", pageSize: String(Math.min(Math.max(max, 1), 20)) });
  if (razeni === "nejnovejsi") p.set("sort", "P_PDATE_D desc");
  if (razeni === "citace") p.set("sort", "CITED desc");
  const r = await fetch(`${EPMC}?${p}`, { headers: UA });
  if (!r.ok) throw new Error(`Europe PMC ${r.status}`);
  const j = await r.json();
  return {
    celkem: j.hitCount || 0,
    clanky: (j.resultList?.result || []).map((a) => {
      const autori = (a.authorString || "").split(", ");
      const oa = (a.fullTextUrlList?.fullTextUrl || []).find((u) => u.availabilityCode === "OA" && u.documentStyle === "html");
      return {
        pmid: a.pmid, pmcid: a.pmcid || null, doi: a.doi || null,
        nazev: strip(a.title),
        autori: autori.length > 3 ? autori.slice(0, 3).join(", ") + " et al." : autori.join(", "),
        casopis: a.journalInfo?.journal?.isoabbreviation || a.journalInfo?.journal?.title || "",
        rok: a.pubYear, datum: a.firstPublicationDate,
        typy: (a.pubTypeList?.pubType || []).filter((t) => !/journal article|research-article/i.test(t)),
        abstrakt: zkrat(strip(a.abstractText).replace(/(Seguimiento|ANTECEDENTES|RESUMEN)[\s\S]*$/, "").trim(), 1800),
        citovano: a.citedByCount || 0,
        odkaz: a.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${a.pmid}/` : (a.doi ? `https://doi.org/${a.doi}` : ""),
        plnyText: oa ? oa.url : null,
      };
    }),
  };
}

/* ---------- ClinicalTrials.gov ---------- */
async function hledejStudie(dotaz, { max = 5, jenNabor = false } = {}) {
  const p = new URLSearchParams({ "query.term": dotaz, pageSize: String(Math.min(Math.max(max, 1), 20)), countTotal: "true",
    fields: "NCTId,BriefTitle,OverallStatus,StartDate,PrimaryCompletionDate,Phase,EnrollmentCount,LocationCountry,LeadSponsorName,StudyType,Condition,InterventionName" });
  if (jenNabor) p.set("filter.overallStatus", "RECRUITING");
  const r = await fetch(`${CTG}?${p}`, { headers: UA });
  if (!r.ok) throw new Error(`ClinicalTrials.gov ${r.status}`);
  const j = await r.json();
  return {
    celkem: j.totalCount ?? (j.studies || []).length,
    studie: (j.studies || []).map((s) => {
      const ps = s.protocolSection || {};
      const nct = ps.identificationModule?.nctId;
      return {
        nct, nazev: ps.identificationModule?.briefTitle || "",
        stav: ps.statusModule?.overallStatus || "", zacatek: ps.statusModule?.startDateStruct?.date || "",
        typ: ps.designModule?.studyType || "", faze: (ps.designModule?.phases || []).join("/"),
        pocet: ps.designModule?.enrollmentInfo?.count ?? null,
        sponzor: ps.sponsorCollaboratorsModule?.leadSponsor?.name || "",
        zeme: [...new Set((ps.contactsLocationsModule?.locations || []).map((l) => l.country))].slice(0, 5).join(", "),
        intervence: (ps.armsInterventionsModule?.interventions || []).map((i) => i.name).slice(0, 4).join("; "),
        odkaz: nct ? `https://clinicaltrials.gov/study/${nct}` : "",
      };
    }),
  };
}

/* ---------- formát pro model ---------- */
function textClanky(v) {
  if (!v.clanky.length) return "Nic nenalezeno. Zkus obecnější anglický dotaz.";
  return `Nalezeno ${v.celkem}, zobrazeno ${v.clanky.length}:\n\n` + v.clanky.map((a, i) =>
    `[${i + 1}] PMID ${a.pmid} – ${a.nazev} ${a.autori}. ${a.casopis} ${a.rok}.${a.typy.length ? " Typ: " + a.typy.join(", ") + "." : ""} Citováno: ${a.citovano}.\n` +
    `Abstrakt: ${a.abstrakt || "(bez abstraktu)"}\nOdkaz: ${a.odkaz}${a.plnyText ? " | plný text: " + a.plnyText : ""}`).join("\n\n");
}
function textStudie(v) {
  if (!v.studie.length) return "Žádné studie nenalezeny.";
  return `Nalezeno ${v.celkem}, zobrazeno ${v.studie.length}:\n\n` + v.studie.map((s) =>
    `${s.nct} – ${s.nazev}. Stav: ${s.stav}, start ${s.zacatek}, ${s.typ}${s.faze ? " " + s.faze : ""}, n=${s.pocet ?? "?"}, sponzor: ${s.sponzor}${s.zeme ? ", země: " + s.zeme : ""}${s.intervence ? ", intervence: " + s.intervence : ""}. ${s.odkaz}`).join("\n");
}

/* ---------- nástroje pro model ---------- */
const NASTROJE = [
  { name: "hledej_literaturu",
    description: "Vyhledá odborné články v PubMed (přes Europe PMC) a vrátí názvy, PMID, typ studie a abstrakta. Dotaz piš anglicky, odborně (MeSH termíny, název metody).",
    input_schema: { type: "object", properties: {
      dotaz: { type: "string", description: "anglický vyhledávací dotaz, např. 'laser hemorrhoidoplasty recurrence'" },
      od_roku: { type: "integer", description: "jen články od tohoto roku" },
      typ: { type: "string", enum: ["vse", "prehledy"], description: "'prehledy' = jen přehledy, metaanalýzy, RCT a guidelines" },
      razeni: { type: "string", enum: ["relevance", "nejnovejsi", "citace"] },
      max: { type: "integer", description: "počet článků (1–10), výchozí 5" } }, required: ["dotaz"] } },
  { name: "hledej_klinicke_studie",
    description: "Vyhledá registrované klinické studie na ClinicalTrials.gov (stav, fáze, počet pacientů, sponzor, země).",
    input_schema: { type: "object", properties: {
      dotaz: { type: "string", description: "anglický dotaz, např. 'pilonidal sinus laser'" },
      jen_nabor: { type: "boolean", description: "jen studie, které právě nabírají" },
      max: { type: "integer" } }, required: ["dotaz"] } },
];
async function spustNastroj(name, input = {}) {
  if (name === "hledej_literaturu") return textClanky(await hledejClanky(String(input.dotaz || ""), { max: Math.min(input.max || 5, 10), odRoku: input.od_roku, typ: input.typ, razeni: input.razeni }));
  if (name === "hledej_klinicke_studie") return textStudie(await hledejStudie(String(input.dotaz || ""), { max: Math.min(input.max || 5, 10), jenNabor: !!input.jen_nabor }));
  return `Neznámý nástroj ${name}`;
}

/* Smyčka s nástroji: volá model, dokud chce hledat (max maxKol hledání), vrací text. Bez tools = obyčejné volání. */
async function askWithTools({ apiKey, model, system, messages, tools = NASTROJE, maxTokens = 1500, maxKol = 3, log = () => {} }) {
  const msgs = messages.slice();
  const pouzite = [];
  for (let kolo = 0; ; kolo++) {
    const body = { model, max_tokens: maxTokens, system, messages: msgs };
    if (tools && tools.length && kolo < maxKol) body.tools = tools;
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`model ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    const bloky = data.content || [];
    const volani = bloky.filter((b) => b.type === "tool_use");
    if (data.stop_reason !== "tool_use" || !volani.length) {
      return { text: bloky.filter((b) => b.type === "text").map((b) => b.text).join("").trim(), pouzite };
    }
    msgs.push({ role: "assistant", content: bloky });
    const vysledky = [];
    for (const v of volani) {
      let out;
      try { out = await spustNastroj(v.name, v.input); } catch (e) { out = `Chyba zdroje: ${e.message}`; }
      pouzite.push({ name: v.name, input: v.input });
      log(`literatura: ${v.name} ${JSON.stringify(v.input).slice(0, 80)}`);
      vysledky.push({ type: "tool_result", tool_use_id: v.id, content: zkrat(out, 12000) });
    }
    msgs.push({ role: "user", content: vysledky });
  }
}

/* doplněk systémového promptu pro poradnu (pacienti) */
const PORADNA_DODATEK = `

OVĚŘOVÁNÍ V LITERATUŘE
- Máš nástroj hledej_literaturu (PubMed). Použij ho jen tehdy, když si u konkrétního faktu nejsi jistý (úspěšnost a recidivy metod, doba hojení, rizika), ne u běžných dotazů a nikdy u červených praporků.
- Pacientovi studie necituj, neuváděj PMID ani názvy časopisů. Odpověď zůstává krátká (do 50 slov), lidská a česky.`;

module.exports = { hledejClanky, hledejStudie, textClanky, textStudie, NASTROJE, spustNastroj, askWithTools, PORADNA_DODATEK };
