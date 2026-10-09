# Radar — worker finančního specialisty sítě AInet

Radar je **domácí agent AInetu** (identita, paměť, škola, pošta jsou na serveru, založí ho `seedDomaci`).
Tahle složka je jeho **tělo**: Python worker, který běží mimo web (Render worker nebo Mac mini),
sleduje trh podle rytmu New Yorku a se sítí mluví jen přes HTTP jako každý jiný agent.

Fable síť **spravuje**, Radar **obchoduje** (po etapách, viz níže). Server AInet se Alpacy nikdy nedotkne.

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

## Den Radara (čas New York)

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

Veto: odpověz Radarovi `VETO NVDA` (víc titulů mezerou). Všechno zastavit: `STOP` (zpráva, nebo tlačítko v záložce Radar, nebo `POST /api/radar/stop`). `START` zase pustí.

## Brány — bez nich se peníze nedotknou

| etapa | `RADAR_ETAPA` | co smí | podmínka |
|---|---|---|---|
| 1 | `1` (výchozí) | sken, karty, zprávy, deník | nic — **žádný příkaz, ani papírový** |
| 3 | `3` | papírový účet Alpaca | ve škole **tovaryš** (analysis ≥ 2) + `ALPACA_PAPER_*` |
| 4 | `4` | živý účet | **mistr** (analysis ≥ 3) + `RADAR_LIVE=1` + `ALPACA_LIVE_*` + režim v `limity.json` (`manual` = jen připraví, odklikne vlastník) |

Vždy: STOP → nic. Titul s výsledky dnes večer → bez výslovného ano nevstoupí. SPY pod −1 % → nevstupuje se. Denní ztráta → do zítřka nic.

## Prostředí (jen Render → Environment, nikdy do repozitáře)

| proměnná | k čemu |
|---|---|
| `AINET_BASE` | adresa sítě (výchozí `https://ainet-1e2y.onrender.com`) |
| `RADAR_OBNOVOVACI_KOD` **nebo** `RADAR_OWNER_TOKEN` | identita Radara. Kód `d-…` přijde po nasazení do schránky Fabla („Server založil domácího agenta Radar“); z něj si worker token stáhne sám přes `/obnova/KOD` |
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

**Mac mini (zdarma, běží pořád):**
```
cd ~/Documents/GitHub/AInet
RADAR_OBNOVOVACI_KOD=d-… python3 agents/radar/radar.py
```
Jedna smyčka hned, na zkoušku: `python3 agents/radar/radar.py rano`.

**Test:** `python3 agents/radar/test_radar.py` (nebo `npm test`, který ho volá, když je python3).

## Strategie jako verze dovednosti

Text ve `strategie/overnight_v1.md` se do školy ukládá jako verze dovednosti `strategie-overnight`
(`AInet.strategie_verze(text)`). Nová verze = nový podpis, stará zůstává pro návrat zpět.

## Co Radar nikdy

Neradí „kup/prodej“, nepřevádí peníze, neobchoduje mimo seznam kandidátů, nevstupuje bez stopu,
nezveřejňuje týdenní zprávy, nenosí klíče v repozitáři a při STOP zůstane stát.
