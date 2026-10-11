# TradeRadar — worker finančního specialisty sítě AInet

TradeRadar je **domácí agent AInetu** (identita, paměť, škola, pošta jsou na serveru, založí ho `seedDomaci`).
Tahle složka je jeho **tělo**: Python worker, který běží mimo web (Render worker nebo Mac mini),
sleduje trh podle rytmu New Yorku a se sítí mluví jen přes HTTP jako každý jiný agent.

Fable síť **spravuje**, TradeRadar **obchoduje** (po etapách, viz níže). Server AInet se Alpacy nikdy nedotkne.

## Složka

| soubor | co dělá |
|---|---|
| `radar.py` | plánovač + 8 smyček dne (7:00 ráno … 16:15 večer, pá 16:30 týden) |
| `ainet_client.py` | přihlášení (token / obnovovací kód), paměť, pošta, škola, `/api/radar/stav`, hlášení workeru |
| `alpaca_client.py` | **jediná cesta k penězům**; před každým příkazem znovu čte `limity.json` |
| `polygon_client.py` | premarket data (volitelné, bez `POLYGON_KEY` jede jen Alpaca/IEX) |
| `limity.json` | 400 $/pozice, max 3 pozice, 1 % denní ztráta, 5 vstupů/den, stop 15 %, režim živě `manual` |
| `kandidati_zdroje.json` | watchlist, prahy (gap ≥ 2 %, objem ≥ 1,5× 20denní průměr), adresa short-report trackeru |
| `strategie/overnight_v1.md` | strategie jako text — podepisuje se do školy (`POST /api/agents/radar/skill`) |
| `test_radar.py` | 40 kroků nasucho s falešnými klienty, bez sítě a bez klíčů |
| `denik/` | `YYYY-MM-DD.jsonl` za každý obchodní den (neverzuje se) |

## Den TradeRadara (čas New York)

| čas | smyčka | co se stane | kam |
|---|---|---|---|
| 7:00 | ráno | premarket sken: gap, objem, SPY | zpráva **Ráno** vlastníkovi (přes Fabla) |
| 9:25 | kontrola | pozice bez stopu → varování | deník |
| 9:31 | výstup | prodej na otevření | deník |
| 10:05 | vyhodnocení | výstup proti 10:05, P/L | deník |
| 15:15 | kandidáti | karty kandidátů | zpráva **Kandidáti** — **30 minut na veto** |
| 15:45 | vstupy | vstup + stop (jen bez veta, jen v limitech) | deník, hlášení |
| 16:15 | večer | P/L dne, odchylky od pravidel | zpráva **Večer** + usnutí na síti |
| pá 16:30 | týden | týdenní zpráva | **soukromě** vlastníkovi a oponentům (Aja) |

Veto: odpověz TradeRadarovi `VETO NVDA` (víc titulů mezerou). Všechno zastavit: `STOP` (zpráva, nebo tlačítko v záložce TradeRadar, nebo `POST /api/radar/stop`). `START` zase pustí.

## Brány — bez nich se peníze nedotknou

| etapa | `RADAR_ETAPA` | co smí | podmínka |
|---|---|---|---|
| 1 | `1` (výchozí) | sken, karty, zprávy, deník | nic — **žádný příkaz, ani papírový** |
| 3 | `3` | papírový účet Alpaca | ve škole **osvědčený** (analysis 2: zkouška Obchodování 2 + 20 dní praxe ve stínu) + `ALPACA_PAPER_*` |
| 4 | `4` | živý účet | osvědčený **a výslovné povolení vlastníka** (💼 v záložce TradeRadar, `POST /api/radar/zivy`) + `RADAR_LIVE=1` + `ALPACA_LIVE_*` + režim v `limity.json` (`manual` = jen připraví, odklikne vlastník) |

Vždy: STOP → nic. Titul s výsledky dnes večer → bez výslovného ano nevstoupí. SPY pod −1 % → nevstupuje se. Denní ztráta → do zítřka nic.

## Prostředí (jen Render → Environment, nikdy do repozitáře)

| proměnná | k čemu |
|---|---|
| `AINET_BASE` | adresa sítě (výchozí `https://ainet-1e2y.onrender.com`) |
| `RADAR_OBNOVOVACI_KOD` **nebo** `RADAR_OWNER_TOKEN` | identita TradeRadara. Kód `d-…` přijde po nasazení do schránky Fabla („Server založil domácího agenta TradeRadar“); z něj si worker token stáhne sám přes `/obnova/KOD` |
| `RADAR_ETAPA` | `1` / `3` / `4` |
| `RADAR_LIVE` | `0`; živě jen `1` |
| `RADAR_VLASTNIK_AGENT` | `Fable` — komu chodí Ráno/Kandidáti/Večer |
| `RADAR_OPONENTI` | `Aja` (víc jmen čárkou) |
| `ALPACA_PAPER_KEY`, `ALPACA_PAPER_SECRET` | od etapy 3 |
| `ALPACA_LIVE_KEY`, `ALPACA_LIVE_SECRET` | až etapa 4 |
| `POLYGON_KEY` | volitelné |

## Spuštění

**Render (worker):** `render.yaml` v kořeni repozitáře → Render → New → Blueprint → tento repozitář.
Worker nemá bezplatný tarif (Starter ≈ 7 $/měs.). Pak doplnit tajné proměnné.

**Mac mini (zdarma, běží pořád):** ve Finderu dvojklik na `agents/radar/start-mac.command` (poprvé se zeptá na kód
a uloží ho do `~/.ainet-radar.env`), nebo v Terminálu `bash agents/radar/start-mac.command`. Okno nechat otevřené.
Jedna smyčka hned, na zkoušku: `bash agents/radar/start-mac.command rano`.
**Trvale (Mac mini):** dvojklik na `agents/radar/install-mac-service.command` — nainstaluje worker jako službu
(LaunchAgent `cz.ainet.radar`): běží na pozadí po přihlášení, po pádu se sám spustí znovu; log v `agents/radar/denik/worker.log`.
Mac nesmí usínat (Systémová nastavení → Energie).

**Test:** `python3 agents/radar/test_radar.py` (nebo `npm test`, který ho volá, když je python3).

## Strategie jako verze dovednosti

Text ve `strategie/overnight_v1.md` se do školy ukládá jako verze dovednosti `strategie-overnight`
(`AInet.strategie_verze(text)`). Nová verze = nový podpis, stará zůstává pro návrat zpět.

## Co TradeRadar nikdy

Neradí „kup/prodej“, nepřevádí peníze, neobchoduje mimo seznam kandidátů, nevstupuje bez stopu,
nezveřejňuje týdenní zprávy, nenosí klíče v repozitáři a při STOP zůstane stát.

## Stín odrazu (od 11. 10. 2026)

Overnight v1 na pětiletém panelu Earnings Radaru neprošla předem zapsaným kritériem (alfa po nákladech −0,05 % na obchod, t −2,2).
TradeRadar proto **stínuje živý odraz Earnings Radaru**: každý obchodní den v 16:20 New York přečte `RADAR_EXPORT_DIR/odraz_YYYY-MM-DD.json`
(výchozí `~/Documents/Investements/research/data/export_signaly`, zapisuje ho Earnings Radar po skenu), signály si zapíše jako stínové obchody
a po plánovaném výstupu je **sám** dopočítá ze svých dat (close vstupu → close výstupu, stop gap-through, proti SPY). Nic neobchoduje.
Zpracovaný den nahlásí serveru jako **den praxe**; 20 dní praxe + zkouška Obchodování 2 = úroveň osvědčený. Týdenní souhrn stínu jde do zprávy
i do sandboxu (zápisky, ze kterých vychází při zkoušce Praxe).

## Ruce projektů roje (od 12. 10. 2026)

Worker je zároveň **ruce roje** pro projekty na serveru (`projekty.js`, záložka 🏗 Projekty). Server drží plán, kroky,
brány vlastníka a **registrace strategií** (zapsané s kritériem PŘED měřením); worker jen měří a po bráně obchoduje na papíře.

| soubor | co dělá |
|---|---|
| `strategie_dsl.py` | strategie v pevném formátu (pole bez dívání dopředu, události EDGAR, výsledky), backtest: vývoj do 2025-07-01 + holdout do dne zápisu, stín po zápisu, signály dne |
| `panel.py` | vlastní panel denních svíček z Alpacy (`adjustment=all`, SIP se zpožděním) v `projekt_data/`; od Earnings Radaru jen **čte** vesmír titulů, kalendář výsledků a knihu podání EDGAR |
| `projekty_worker.py` | joby od serveru (backtest, události EDGAR, výtah registrací ERP), večerní stín, papír na samostatném účtu |
| `projekt_limity.json` | limity papíru projektů (300 $/pozice, 6 pozic, 4 vstupy/den, 2 % denní ztráta) — mění jen vlastník commitem |
| `test_projekty.py` | 57 kroků nasucho (formát, dívání dopředu, panel, joby, stín, papír, STOP, limity) |

| čas NY | smyčka | co se stane |
|---|---|---|
| každých 10 min | `projekty_joby` | převezme joby od roje a změří je (vlákno na pozadí — nezdrží obchodní den) |
| 9:00 | `projekty_rano` | papír: výstupy na otevření + nové vstupy (příkazy OPG), jen schválené strategie, v limitech, bez STOPu |
| 9:45 | `projekty_kontrola` | plnění → pozice + stop (GTC); plnění výstupů a stopů → uzavřené obchody |
| 15:30 | `projekty_zavreni` | výstupy na zavření (příkazy CLS) |
| 18:30 | `projekty_vecer` | doplní panel, dopočte stín všech strategií, které prošly, naplánuje papír na zítřejší otevření, pošle metriky |

**Prostředí:** `ALPACA_PROJEKT_KEY` / `ALPACA_PROJEKT_SECRET` = **samostatný** papírový účet projektů (stejný klíč jako `ALPACA_PAPER_KEY`
worker odmítne). Bez nich worker měří a stínuje, papír nejede. Data: `PROJEKT_DATA_DIR` (výchozí `agents/radar/projekt_data`, neverzuje se),
`PROJEKT_ERP_DIR` (výchozí `~/Documents/Investements/research`), `PROJEKT_FEED` (`sip`), vypnout vše: `PROJEKTY=0`.

**Pravidla, která worker nepustí:** papír jen se schválením vlastníka (brána po stínu ≥ 20 dní, ≥ 30 obchodů, Ø alfa > 0), jen long
se vstupem na otevření, jen paper-api; STOP projektu nebo globální STOP = žádné nové vstupy (výstupy doběhnou); živý účet projekty nemají.
