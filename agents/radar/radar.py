#!/usr/bin/env python3
"""
radar.py — tělo Radara: plánovač a osm smyček obchodního dne.

Radar je agent sítě AInet (identita, paměť, škola a pošta jsou na serveru);
tohle je jeho worker na Renderu. Každý obchodní den podle času v New Yorku:

  7:00   RÁNO        premarket sken (gapy, objem, zprávy, short reporty, SPY)  → zpráva „Ráno“
  9:25   KONTROLA    otevřené pozice a stopy                                   → —
  9:31   VÝSTUP      prodej na otevření (papír sám, živě podle režimu)         → plnění do deníku
  10:05  VYHODNOCENÍ výstup proti 10:05, běžící statistika                     → řádek deníku
  15:15  KANDIDÁTI   výběr kandidátů na dnes, karta ke každému                 → zpráva „Kandidáti“ (30 min na veto)
  15:45  VSTUPY      vstupy a stopy (jen bez veta, jen v limitech)             → plnění do deníku
  16:15  VEČER       deník dne: P/L, odchylky od pravidel                      → zpráva „Večer“ + usnutí na síti
  pá 16:30 TÝDEN     týdenní vyhodnocení                                       → soukromě vlastníkovi a oponentům

Brány (etapy) — bez nich se peníze nedotknou:
  RADAR_ETAPA=1  sken, karty, zprávy, deník; ŽÁDNÉ příkazy (ani papír)
  RADAR_ETAPA=3  papírový účet — jen když je Radar ve škole aspoň tovaryš (analysis ≥ 2)
  RADAR_ETAPA=4  živý účet — jen mistr (analysis ≥ 3), RADAR_LIVE=1 a režim z limity.json
  STOP od vlastníka (zpráva STOP v AIMessages, /api/radar/stop) nebo RADAR_LIVE=0 → nic.

Spuštění:  python agents/radar/radar.py            (plánovač, běží pořád)
           python agents/radar/radar.py rano       (jedna smyčka hned, pro zkoušku)
Čistá standardní knihovna. Klíče jen v prostředí (viz README v této složce).
"""
from __future__ import annotations

import json
import os
import sys
import time
import traceback
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

SLOZKA = Path(__file__).resolve().parent
sys.path.insert(0, str(SLOZKA))

from ainet_client import AInet, AInetChyba  # noqa: E402
from alpaca_client import Alpaca, AlpacaChyba  # noqa: E402
from polygon_client import Polygon, PolygonChyba  # noqa: E402

NY = ZoneInfo("America/New_York")
ETAPA = int(os.environ.get("RADAR_ETAPA", "1"))
ZIVY = os.environ.get("RADAR_LIVE", "0") == "1" and ETAPA >= 4
VLASTNIK_AGENT = os.environ.get("RADAR_VLASTNIK_AGENT", "Fable")        # komu chodí zprávy pro vlastníka (čte je jako vlastník Fabla)
OPONENTI = [x.strip() for x in os.environ.get("RADAR_OPONENTI", "Aja").split(",") if x.strip()]
DENIK = SLOZKA / "denik"

SMYCKY = [  # (hh, mm, název, jen obchodní dny)
    (7, 0, "rano"), (9, 25, "kontrola"), (9, 31, "vystup"), (10, 5, "vyhodnoceni"),
    (15, 15, "kandidati"), (15, 45, "vstupy"), (16, 15, "vecer"),
]
TYDENNI = (4, 16, 30, "tyden")   # pátek


def log(m: str) -> None:
    print(f"[radar] {datetime.now(NY).strftime('%Y-%m-%d %H:%M')} {m}", flush=True)


def nacti_json(soubor: str, vychozi: dict) -> dict:
    try:
        return json.loads((SLOZKA / soubor).read_text("utf-8"))
    except Exception:
        return dict(vychozi)


class Radar:
    def __init__(self, ainet: AInet | None = None, alpaca: Alpaca | None = None, polygon: Polygon | None = None, suche: bool = False):
        self.ainet = ainet or AInet()
        self.alpaca = alpaca
        self.polygon = polygon
        self.suche = suche                      # suché = nic neposílá na Alpacu (testy, etapa 1)
        self.limity = nacti_json("limity.json", {"pozice_usd": 400, "max_pozic": 3, "denni_ztrata_pct": 1.0, "vstupu_za_den": 5, "stop_pct": 15})
        self.zdroje = nacti_json("kandidati_zdroje.json", {"watchlist": ["SPY"], "gap_min_pct": 2.0, "objem_min_nasobek": 1.5, "polygon_top": 15})
        self.dnes: dict = {"datum": None, "kandidati": [], "veta": set(), "vstupu": 0, "plneni": [], "poznamky": [], "zakazy": []}
        self.vlastnik_id: str | None = None
        self.oponenti_id: dict[str, str] = {}
        self.stav: dict = {}

    # ---------- pomocné ----------
    def den(self) -> str:
        return datetime.now(NY).strftime("%Y-%m-%d")

    def novy_den(self) -> None:
        if self.dnes["datum"] != self.den():
            self.dnes = {"datum": self.den(), "kandidati": [], "veta": set(), "vstupu": 0, "plneni": [], "poznamky": [], "zakazy": []}
            self.limity = nacti_json("limity.json", self.limity)
            self.zdroje = nacti_json("kandidati_zdroje.json", self.zdroje)

    def zapis_denik(self, radek: dict) -> None:
        DENIK.mkdir(exist_ok=True)
        with open(DENIK / f"{self.den()}.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"t": datetime.now(NY).isoformat(timespec="minutes"), **radek}, ensure_ascii=False) + "\n")

    def cti_denik(self, datum: str | None = None) -> list[dict]:
        p = DENIK / f"{datum or self.den()}.jsonl"
        if not p.exists():
            return []
        return [json.loads(r) for r in p.read_text("utf-8").splitlines() if r.strip()]

    def zprava_vlastnikovi(self, text: str) -> None:
        if not self.vlastnik_id:
            a = self.ainet.agent_podle_jmena(VLASTNIK_AGENT)
            self.vlastnik_id = a["id"] if a else None
        if self.vlastnik_id:
            self.ainet.posli(self.vlastnik_id, text)
        else:
            log(f"vlastníkův agent {VLASTNIK_AGENT} není na síti — zpráva zůstala jen v logu: {text[:80]}")

    def zprava_oponentum(self, text: str) -> None:
        for jm in OPONENTI:
            if jm not in self.oponenti_id:
                a = self.ainet.agent_podle_jmena(jm)
                if a:
                    self.oponenti_id[jm] = a["id"]
            if jm in self.oponenti_id:
                self.ainet.posli(self.oponenti_id[jm], text)

    def smi_obchodovat(self) -> tuple[bool, str]:
        """Brány: STOP, etapa, škola, živý účet. Vrací (smí, důvod)."""
        try:
            self.stav = self.ainet.stav()
        except AInetChyba as e:
            return False, f"stav sítě nedostupný ({e}) — bez něj neobchoduji"
        if self.stav.get("stop"):
            return False, f"STOP od vlastníka ({self.stav.get('stop_duvod') or ''})"
        if ETAPA < 3:
            return False, "etapa 1–2: jen sken a karty, žádné příkazy"
        if ZIVY:
            if not self.stav.get("smi_zivy"):
                return False, "živý účet jen pro mistra (analysis ≥ 3)"
            if self.limity.get("rezim_zivy", "manual") == "manual":
                return False, "režim manual: příkazy jen připravím, odklikne vlastník"
        elif not self.stav.get("smi_papir"):
            return False, "papírový účet až jako tovaryš (analysis ≥ 2) — zkouška Obchodování 2"
        if not self.alpaca or not self.alpaca.ma_klice:
            return False, "chybí klíče Alpacy"
        return True, "ok"

    # ---------- sken a karty ----------
    def sken(self) -> list[dict]:
        """Premarket sken: gap, objem vs průměr, SPY. Z Polygonu top pohyby + vlastní watchlist; z Alpacy ceny a objemy."""
        symboly = list(dict.fromkeys(self.zdroje.get("watchlist", [])))
        if self.polygon and self.polygon.zapnuto:
            try:
                for t in self.polygon.gainers("gainers")[: int(self.zdroje.get("polygon_top", 15))]:
                    s = t.get("ticker");
                    if s and s.isalpha() and len(s) <= 5:
                        symboly.append(s)
            except PolygonChyba as e:
                log(f"Polygon: {e}")
        symboly = list(dict.fromkeys(symboly))[:40]
        out = []
        if not self.alpaca or not self.alpaca.ma_klice:
            log("bez klíčů Alpacy — sken jen ze seznamu, bez cen")
            return [{"symbol": s, "gap_pct": None, "objem_nasobek": None, "duvod": "bez dat"} for s in symboly]
        try:
            snap = self.alpaca.snapshoty(symboly)
        except AlpacaChyba as e:
            log(f"Alpaca snapshoty: {e}"); snap = {}
        spy = snap.get("SPY") or {}
        for s in symboly:
            x = snap.get(s) or {}
            prev = (x.get("prevDailyBar") or {}).get("c")
            dnes_bar = x.get("dailyBar") or {}
            cena = (x.get("latestTrade") or {}).get("p") or dnes_bar.get("c")
            gap = round((cena / prev - 1) * 100, 2) if prev and cena else None
            objem = dnes_bar.get("v")
            prum = None
            try:
                sv = self.alpaca.svicky(s, "1Day", 40)
                vols = [b["v"] for b in sv[:-1]][-20:]
                prum = sum(vols) / len(vols) if vols else None
            except AlpacaChyba:
                pass
            nasobek = round(objem / prum, 2) if objem and prum else None
            out.append({"symbol": s, "cena": cena, "zavreni": prev, "gap_pct": gap, "objem_nasobek": nasobek})
        self.dnes["spy"] = {"cena": (spy.get("latestTrade") or {}).get("p"), "zavreni": (spy.get("prevDailyBar") or {}).get("c")}
        return out

    def vyber_kandidaty(self, sken: list[dict]) -> list[dict]:
        gmin = float(self.zdroje.get("gap_min_pct", 2.0)); omin = float(self.zdroje.get("objem_min_nasobek", 1.5))
        spy = self.dnes.get("spy") or {}
        spy_den = (spy["cena"] / spy["zavreni"] - 1) * 100 if spy.get("cena") and spy.get("zavreni") else None
        if spy_den is not None and spy_den < -1.0:
            self.dnes["zakazy"].append(f"SPY {spy_den:.2f} % — pravidlo 4: nevstupuje se")
            return []
        kand = [k for k in sken if k.get("gap_pct") is not None and abs(k["gap_pct"]) >= gmin and (k.get("objem_nasobek") or 0) >= omin]
        kand.sort(key=lambda k: -abs(k["gap_pct"]))
        return kand[: int(self.limity.get("vstupu_za_den", 5))]

    def karta(self, k: dict) -> str:
        """Karta kandidáta: proč, rizika, návrh velikosti. Šepot z Radaru sítě (StockTwits/Yahoo/Finnhub) je dojem, ne fakt."""
        sepot = ""
        try:
            s = self.ainet.signal(k["symbol"])
            if not s.get("error"):
                sepot = f" · šepot {s.get('skore')} ({s.get('jistota')}): {s.get('popis', '')[:90]}"
                if (s.get("vysledky") or {}).get("vysledky_dne") == self.den():
                    k["vysledky_dnes"] = True
        except AInetChyba:
            pass
        cena = k.get("cena") or 0
        ks = int(float(self.limity.get("pozice_usd", 400)) // cena) if cena else 0
        stop = round(cena * (1 - float(self.limity.get("stop_pct", 15)) / 100), 2) if cena else None
        vys = " · ⚠ VÝSLEDKY DNES VEČER — bez tvého ano nevstoupím" if k.get("vysledky_dnes") else ""
        return (f"{k['symbol']}: gap {k.get('gap_pct')} %, objem {k.get('objem_nasobek')}× průměr, cena {cena}"
                f"{sepot}{vys} → návrh {ks} ks, stop {stop}")

    # ---------- smyčky ----------
    def rano(self) -> str:
        self.novy_den()
        sken = self.sken()
        kand = self.vyber_kandidaty(sken)
        spy = self.dnes.get("spy") or {}
        text = (f"📡 Ráno {self.den()} (etapa {ETAPA}) — premarket sken {len(sken)} titulů, {len(kand)} přes práh (gap ≥ {self.zdroje.get('gap_min_pct')} %, objem ≥ {self.zdroje.get('objem_min_nasobek')}×)."
                + (f" SPY {spy.get('cena')} (závěr {spy.get('zavreni')})." if spy.get("cena") else "")
                + ("\n" + "\n".join(f"• {k['symbol']}: gap {k['gap_pct']} %, objem {k.get('objem_nasobek')}×" for k in kand[:8]) if kand else "\nŽádný kandidát přes práh.")
                + ("\n" + "; ".join(self.dnes["zakazy"]) if self.dnes["zakazy"] else ""))
        self.dnes["rano"] = kand
        self.zapis_denik({"smycka": "rano", "kandidatu": len(kand), "spy": spy})
        self.zprava_vlastnikovi(text)
        self.ainet.hlaseni(ETAPA, "rano", f"{len(kand)} kandidátů", "zivy" if ZIVY else "papir")
        return text

    def kontrola(self) -> str:
        self.novy_den()
        if not self.alpaca or not self.alpaca.ma_klice:
            return "kontrola: bez účtu"
        try:
            poz = self.alpaca.pozice(); prik = self.alpaca.prikazy("open")
        except AlpacaChyba as e:
            log(f"kontrola: {e}"); return f"kontrola: {e}"
        bez_stopu = [p["symbol"] for p in poz if not any(o.get("symbol") == p["symbol"] and o.get("side") == "sell" and o.get("type") == "stop" for o in prik)]
        if bez_stopu:
            self.dnes["zakazy"].append(f"pozice bez stopu: {', '.join(bez_stopu)}")
            self.zprava_vlastnikovi(f"⚠ Kontrola 9:25: pozice bez stopu {', '.join(bez_stopu)} — porušení pravidla „stop vždy“.")
        self.zapis_denik({"smycka": "kontrola", "pozic": len(poz), "bez_stopu": bez_stopu})
        return f"kontrola: {len(poz)} pozic, bez stopu {len(bez_stopu)}"

    def vystup(self) -> str:
        self.novy_den()
        smi, duvod = self.smi_obchodovat()
        if not smi:
            self.zapis_denik({"smycka": "vystup", "preskoceno": duvod}); return f"výstup přeskočen: {duvod}"
        try:
            poz = self.alpaca.pozice()
        except AlpacaChyba as e:
            return f"výstup: {e}"
        for p in poz:
            try:
                for o in self.alpaca.prikazy("open"):
                    if o.get("symbol") == p["symbol"]:
                        self.alpaca.zrus_prikaz(o["id"])
                r = self.alpaca.prodej_vse(p["symbol"], suché=self.suche)
                self.dnes["plneni"].append({"symbol": p["symbol"], "strana": "sell", "vstup": p.get("avg_entry_price"), "aktualni": p.get("current_price")})
                self.zapis_denik({"smycka": "vystup", "symbol": p["symbol"], "vstup": p.get("avg_entry_price"), "aktualni": p.get("current_price"), "odpoved": r})
            except AlpacaChyba as e:
                self.zapis_denik({"smycka": "vystup", "symbol": p["symbol"], "chyba": str(e)})
        return f"výstup: {len(poz)} pozic prodáno na otevření"

    def vyhodnoceni(self) -> str:
        self.novy_den()
        prodeje = [r for r in self.cti_denik() if r.get("smycka") == "vystup" and r.get("symbol")]
        radky = []
        for r in prodeje:
            try:
                c1005 = self.alpaca.posledni_cena(r["symbol"]) if self.alpaca and self.alpaca.ma_klice else None
            except AlpacaChyba:
                c1005 = None
            vstup = float(r.get("vstup") or 0); akt = float(r.get("aktualni") or 0)
            pl = round((akt / vstup - 1) * 100, 2) if vstup and akt else None
            proti = round((c1005 / akt - 1) * 100, 2) if c1005 and akt else None
            radky.append({"symbol": r["symbol"], "pl_pct": pl, "proti_10_05_pct": proti})
        self.zapis_denik({"smycka": "vyhodnoceni", "obchody": radky})
        return f"vyhodnocení: {len(radky)} obchodů"

    def kandidati(self) -> str:
        self.novy_den()
        sken = self.sken()
        kand = self.vyber_kandidaty(sken)
        self.dnes["kandidati"] = kand
        self.dnes["kandidati_t"] = time.time()
        karty = [self.karta(k) for k in kand]
        text = (f"🎯 Kandidáti {self.den()} (etapa {ETAPA}, {'ŽIVÝ' if ZIVY else 'papír'}, limit {self.limity.get('pozice_usd')} $/pozice, max {self.limity.get('vstupu_za_den')} vstupů):\n"
                + ("\n".join("• " + k for k in karty) if karty else "• žádný kandidát přes práh — dnes nic")
                + f"\nMáš {self.limity.get('veto_minut', 30)} minut na veto: odpověz „VETO SYMBOL“ (nebo STOP pro všechno)."
                + (" " + "; ".join(self.dnes["zakazy"]) if self.dnes["zakazy"] else ""))
        self.zapis_denik({"smycka": "kandidati", "kandidati": [k["symbol"] for k in kand], "karty": karty})
        self.zprava_vlastnikovi(text)
        self.ainet.hlaseni(ETAPA, "kandidati", f"{len(kand)} kandidátů", "zivy" if ZIVY else "papir")
        return text

    def nacti_veta(self) -> set[str]:
        """Veta a STOP z pošty po odeslání kandidátů — jen od vlastníka (píše jako Fable); cizí agent veto ani STOP nedá."""
        veta = set(self.dnes["veta"])
        od = self.dnes.get("kandidati_t") or 0
        if not self.vlastnik_id:
            a = self.ainet.agent_podle_jmena(VLASTNIK_AGENT)
            self.vlastnik_id = a["id"] if a else None
        try:
            for m in self.ainet.posta(40):
                if m.get("to") != self.ainet.id or not self.vlastnik_id or m.get("from") != self.vlastnik_id:
                    continue
                txt = str(m.get("text") or "").strip()
                try:
                    kdy = datetime.fromisoformat(str(m.get("t", "")).replace("Z", "+00:00")).timestamp()
                except Exception:
                    kdy = 0
                if kdy < od - 60:
                    continue
                if txt.upper().startswith("VETO"):
                    for s in txt[4:].replace(",", " ").split():
                        veta.add(s.strip().upper())
                if txt.upper().startswith("STOP"):
                    veta.add("*")
        except AInetChyba as e:
            log(f"pošta: {e}")
        self.dnes["veta"] = veta
        return veta

    def vstupy(self) -> str:
        self.novy_den()
        veta = self.nacti_veta()
        smi, duvod = self.smi_obchodovat()
        if "*" in veta:
            smi, duvod = False, "STOP ve schránce"
        kand = [k for k in self.dnes.get("kandidati", []) if k["symbol"] not in veta and not k.get("vysledky_dnes")]
        if not smi:
            self.zapis_denik({"smycka": "vstupy", "preskoceno": duvod, "kandidati": [k["symbol"] for k in kand]})
            if ETAPA >= 3:
                self.zprava_vlastnikovi(f"Vstupy 15:45 přeskočeny: {duvod}.")
            return f"vstupy přeskočeny: {duvod}"
        try:
            ucet = self.alpaca.ucet()
            equity = float(ucet.get("equity") or 0); last = float(ucet.get("last_equity") or equity)
            if last and (equity / last - 1) * 100 <= -float(self.limity.get("denni_ztrata_pct", 1.0)):
                self.zapis_denik({"smycka": "vstupy", "preskoceno": "denní ztráta dosažena"})
                self.zprava_vlastnikovi("⛔ Denní ztráta dosažena — do zítřka nic."); return "vstupy: denní ztráta"
        except AlpacaChyba as e:
            return f"vstupy: {e}"
        provedeno = 0
        for k in kand:
            if self.dnes["vstupu"] >= int(self.limity.get("vstupu_za_den", 5)):
                break
            cena = k.get("cena") or 0
            ks = int(float(self.limity.get("pozice_usd", 400)) // cena) if cena else 0
            if ks <= 0:
                continue
            try:
                r = self.alpaca.prikaz(k["symbol"], ks, "buy", self.limity, suché=self.suche)
                stop = round(cena * (1 - float(self.limity.get("stop_pct", 15)) / 100), 2)
                rs = self.alpaca.prikaz(k["symbol"], ks, "sell", self.limity, typ="stop", stop_cena=stop, tif="gtc", suché=self.suche)
                self.dnes["vstupu"] += 1; provedeno += 1
                self.dnes["plneni"].append({"symbol": k["symbol"], "strana": "buy", "ks": ks, "cena": cena, "stop": stop})
                self.zapis_denik({"smycka": "vstupy", "symbol": k["symbol"], "ks": ks, "cena": cena, "stop": stop, "odpoved": r, "stop_odpoved": rs})
            except AlpacaChyba as e:
                self.zapis_denik({"smycka": "vstupy", "symbol": k["symbol"], "chyba": str(e)})
        self.ainet.hlaseni(ETAPA, "vstupy", f"{provedeno} vstupů", "zivy" if ZIVY else "papir")
        return f"vstupy: {provedeno} ({'suché' if self.suche else 'odeslané'}), veto {sorted(veta)}"

    def vecer(self) -> str:
        self.novy_den()
        d = self.cti_denik()
        vstupy = [r for r in d if r.get("smycka") == "vstupy" and r.get("symbol") and not r.get("chyba")]
        vyh = next((r for r in d if r.get("smycka") == "vyhodnoceni"), {}) or {}
        obchody = vyh.get("obchody") or []
        pl = [o["pl_pct"] for o in obchody if o.get("pl_pct") is not None]
        odchylky = list(dict.fromkeys(self.dnes["zakazy"] + [r.get("preskoceno") for r in d if r.get("preskoceno")]))
        text = (f"🌙 Večer {self.den()} — vstupů {len(vstupy)}, uzavřených obchodů {len(obchody)}"
                + (f", P/L průměr {sum(pl) / len(pl):.2f} %" if pl else "")
                + (f"\nOdchylky/zprávy: {'; '.join(x for x in odchylky if x)}" if odchylky else "\nBez odchylek od pravidel."))
        self.zapis_denik({"smycka": "vecer", "vstupu": len(vstupy), "obchodu": len(obchody), "pl": pl, "odchylky": odchylky})
        self.zprava_vlastnikovi(text)
        try:
            self.ainet.usnuti(shrnuti=text.split("\n")[0], rozdelano=f"{len(vstupy)} otevřených pozic do rána" if vstupy else "",
                              pristi="7:00 premarket sken, 9:31 výstup na otevření", poznamky=self.dnes["poznamky"])
        except AInetChyba as e:
            log(f"usnutí: {e}")
        self.ainet.hlaseni(ETAPA, "vecer", text.split("\n")[0][:200], "zivy" if ZIVY else "papir")
        return text

    def tyden(self) -> str:
        dnes = date.today()
        dny = [(dnes - timedelta(days=i)).isoformat() for i in range(7)]
        vsechny = []
        for dd in dny:
            vsechny += [r for r in self.cti_denik(dd) if r.get("smycka") == "vyhodnoceni"]
        obchody = [o for r in vsechny for o in (r.get("obchody") or [])]
        pl = [o["pl_pct"] for o in obchody if o.get("pl_pct") is not None]
        kladne = sum(1 for x in pl if x > 0)
        text = (f"📒 Týdenní zpráva Radara (týden do {dnes.isoformat()}, etapa {ETAPA}): {len(obchody)} obchodů"
                + (f", průměr {sum(pl) / len(pl):.2f} %, kladných {kladne}/{len(pl)}" if pl else ", bez uzavřených obchodů")
                + ". Posíláno soukromě vlastníkovi a oponentům, ne na Wonderwall.")
        self.zapis_denik({"smycka": "tyden", "obchodu": len(obchody), "pl": pl})
        self.zprava_vlastnikovi(text)
        self.zprava_oponentum(text)
        return text

    SMYCKA = {"rano": rano, "kontrola": kontrola, "vystup": vystup, "vyhodnoceni": vyhodnoceni, "kandidati": kandidati, "vstupy": vstupy, "vecer": vecer, "tyden": tyden}

    def spust(self, nazev: str) -> str:
        fn = self.SMYCKA.get(nazev)
        if not fn:
            raise ValueError(f"neznámá smyčka {nazev}")
        return fn(self)


def obchodni_den(d: datetime) -> bool:
    return d.weekday() < 5     # svátky NYSE řeší Alpaca clock; bez účtu bereme pracovní dny


def planovac(radar: Radar) -> None:
    """Minutový plánovač v čase New Yorku. Každá smyčka jednou denně; po restartu se nedohání (burza nečeká)."""
    log(f"worker Radara běží — etapa {ETAPA}, {'ŽIVÝ účet' if ZIVY else 'papír/suché'}, vlastník přes {VLASTNIK_AGENT}, oponenti {OPONENTI}")
    hotovo: set[str] = set()
    while True:
        ted = datetime.now(NY)
        klic_dne = ted.strftime("%Y-%m-%d")
        hotovo = {h for h in hotovo if h.startswith(klic_dne)}
        if obchodni_den(ted):
            plan = [(h, m, n) for h, m, n in SMYCKY]
            if ted.weekday() == TYDENNI[0]:
                plan.append((TYDENNI[1], TYDENNI[2], TYDENNI[3]))
            for hh, mm, nazev in plan:
                klic = f"{klic_dne}:{nazev}"
                if klic in hotovo or (ted.hour, ted.minute) != (hh, mm):
                    continue
                hotovo.add(klic)
                try:
                    log(f"→ {nazev}: {radar.spust(nazev)[:160]}")
                except Exception as e:   # smyčka nesmí shodit plánovač
                    log(f"✗ {nazev}: {e}\n{traceback.format_exc()[-600:]}")
        time.sleep(20)


def main() -> None:
    ainet = AInet()
    try:
        me = ainet.prihlasit()
        log(f"přihlášen jako {me['jmeno']} ({me['id'][:8]}…)")
        prob = ainet.probuzeni()
        log(f"probuzení: {prob.get('vitej', '')[:80]} · co dělat: {' | '.join(prob.get('co_mas_delat', [])[:3])}")
    except AInetChyba as e:
        log(f"síť: {e}"); sys.exit(1)
    alpaca = None
    try:
        alpaca = Alpaca(zivy=ZIVY)
        if not alpaca.ma_klice:
            log("Alpaca: bez klíčů — jen sken ze seznamu, žádné ceny ani příkazy")
    except AlpacaChyba as e:
        log(f"Alpaca: {e}")
    radar = Radar(ainet, alpaca, Polygon(), suche=ETAPA < 3)
    if len(sys.argv) > 1:
        print(radar.spust(sys.argv[1]))
        return
    planovac(radar)


if __name__ == "__main__":
    main()
