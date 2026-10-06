/**
 * opravy.js — Pavlovy opravy a doplňky pravidel AI poradny. Node 18+, bez závislostí.
 *
 * Ukládají se trvale na AInet (disk serveru AInet) pod agentem FB-Most: /api/lite/poznamky?token=AINET_TOKEN
 * Používají se:
 *   - v chatu (Messenger + web): připojí se na konec systémového promptu (textProPrompt)
 *   - v hlasovém asistentovi (ElevenLabs): po každé změně se přepíše blok oprav v jeho promptu (syncHlas)
 */
const AINET = (process.env.AINET_BASE || "https://ainet-1e2y.onrender.com").replace(/\/$/, "");
const { AINET_TOKEN, ELEVENLABS_API_KEY } = process.env;
const HLAS_AGENT_ID = process.env.HLAS_AGENT_ID || "agent_2501m42za8c0f1m83g0r92ajwavv";
const ZACATEK = "=== OPRAVY OD MUDr. DITLA ===", KONEC = "=== KONEC OPRAV ===";
const log = (m) => console.log(`[opravy] ${new Date().toISOString()} ${m}`);

let seznam = [];          // [{ id, text, kdy, zdroj }]
let nacteno = false;
let posledniSync = null;  // { ok, kdy, chyba }

async function nacti() {
  if (!AINET_TOKEN) return seznam;
  const r = await fetch(`${AINET}/api/lite/poznamky?token=${encodeURIComponent(AINET_TOKEN)}`);
  if (!r.ok) throw new Error(`AInet poznamky ${r.status}`);
  const j = await r.json();
  seznam = Array.isArray(j.poznamky) ? j.poznamky : [];
  nacteno = true;
  return seznam;
}
async function uloz(list) {
  if (!AINET_TOKEN) throw new Error("chybí AINET_TOKEN");
  const r = await fetch(`${AINET}/api/lite/poznamky?token=${encodeURIComponent(AINET_TOKEN)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ poznamky: list }) });
  if (!r.ok) throw new Error(`AInet uložení ${r.status}: ${(await r.text()).slice(0, 120)}`);
  seznam = list;
}

function blokOprav() {
  if (!seznam.length) return "";
  return seznam.map((o) => `- ${o.text.replace(/\s+/g, " ").trim()}`).join("\n");
}
/* doplněk systémového promptu pro chat */
function textProPrompt() {
  const b = blokOprav();
  return b ? `\n\nOPRAVY A DOPLŇKY OD MUDr. DITLA (mají přednost před vším výše; pacientovi je necituj, jen se jimi řiď):\n${b}` : "";
}

/* přepíše blok oprav v promptu hlasového asistenta v ElevenLabs */
async function syncHlas() {
  if (!ELEVENLABS_API_KEY) { posledniSync = { ok: false, kdy: new Date().toISOString(), chyba: "chybí ELEVENLABS_API_KEY" }; return posledniSync; }
  try {
    const url = `https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(HLAS_AGENT_ID)}`;
    const h = { "xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json" };
    const r = await fetch(url, { headers: h });
    if (!r.ok) throw new Error(`čtení agenta ${r.status}: ${(await r.text()).slice(0, 150)}`);
    const agent = await r.json();
    const puvodni = agent?.conversation_config?.agent?.prompt?.prompt;
    if (typeof puvodni !== "string") throw new Error("agent nemá textový prompt");
    const zaklad = puvodni.includes(ZACATEK) ? puvodni.slice(0, puvodni.indexOf(ZACATEK)).trimEnd() : puvodni.trimEnd();
    const b = blokOprav();
    const novy = b ? `${zaklad}\n\n${ZACATEK}\nTyto opravy mají přednost před vším výše:\n${b}\n${KONEC}` : zaklad;
    if (novy === puvodni) { posledniSync = { ok: true, kdy: new Date().toISOString(), beze_zmeny: true }; return posledniSync; }
    const p = await fetch(url, { method: "PATCH", headers: h, body: JSON.stringify({ conversation_config: { agent: { prompt: { prompt: novy } } } }) });
    if (!p.ok) throw new Error(`zápis agenta ${p.status}: ${(await p.text()).slice(0, 150)}`);
    posledniSync = { ok: true, kdy: new Date().toISOString() };
  } catch (e) {
    posledniSync = { ok: false, kdy: new Date().toISOString(), chyba: e.message };
    log(`sync hlasu: ${e.message}`);
  }
  return posledniSync;
}

async function pridej(text, zdroj = "") {
  if (!nacteno) await nacti();
  const o = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), text: String(text).slice(0, 2000).trim(), kdy: new Date().toISOString(), zdroj: String(zdroj).slice(0, 200) };
  if (!o.text) throw new Error("prázdná oprava");
  await uloz([...seznam, o]);
  log(`nová oprava (${seznam.length})`);
  await syncHlas();
  return o;
}
async function smaz(id) {
  if (!nacteno) await nacti();
  await uloz(seznam.filter((o) => o.id !== id));
  await syncHlas();
}

/* načíst při startu a pak každých 10 minut (kdyby se změnily jinde) */
setTimeout(() => nacti().then((l) => log(`načteno ${l.length} oprav`)).catch((e) => log(`načtení: ${e.message}`)), 2000);
setInterval(() => nacti().catch(() => {}), 10 * 60e3);

module.exports = { nacti, uloz, pridej, smaz, textProPrompt, syncHlas, seznam: () => seznam, stavSync: () => posledniSync, HLAS_AGENT_ID };
