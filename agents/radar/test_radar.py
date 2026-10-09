#!/usr/bin/env python3
"""
test_radar.py — suchý běh všech smyček Radara s falešnými klienty (bez sítě, bez klíčů).

Hlídá brány, na kterých stojí bezpečnost:
  • etapa 1 → žádný příkaz (ani papírový), jen sken, karty, zprávy, deník
  • STOP ze sítě i STOP ve schránce → vstupy přeskočeny
  • veto „VETO SYM“ → titul vynechán, ostatní jedou
  • „výsledky dnes večer“ → bez výslovného ano se nevstupuje
  • denní ztráta → nic
  • limity před každým příkazem (Alpaca.prikaz): velikost pozice, počet pozic
  • živý účet bez RADAR_LIVE=1 → nejde ani založit klienta

Spuštění: python3 agents/radar/test_radar.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

SLOZKA = Path(__file__).resolve().parent
sys.path.insert(0, str(SLOZKA))
os.environ.setdefault("RADAR_ETAPA", "1")
os.environ.setdefault("RADAR_LIVE", "0")
os.environ.pop("ALPACA_PAPER_KEY", None); os.environ.pop("ALPACA_PAPER_SECRET", None)

import radar as R                       # noqa: E402
from alpaca_client import Alpaca, AlpacaChyba  # noqa: E402

KROKU = 0


def ok(podminka, text):
    global KROKU
    KROKU += 1
    if not podminka:
        print(f"✗ {KROKU}. {text}"); sys.exit(1)
    print(f"✓ {KROKU}. {text}")


# ---------- falešní klienti ----------
class FakeAInet:
    def __init__(self, stav=None):
        self.id, self.jmeno = "radar-id", "Radar"
        self.odeslane: list[tuple[str, str]] = []
        self.hlaseni_log: list[tuple] = []
        self.posta_box: list[dict] = []
        self.usnuti_log: list[dict] = []
        self._stav = stav or {"stop": False, "smi_papir": False, "smi_zivy": False}
        self.agents = [{"id": "fable-id", "name": "Fable"}, {"id": "aja-id", "name": "Aja"}]
        self.signaly: dict[str, dict] = {}

    def agent_podle_jmena(self, jm):
        return next((a for a in self.agents if a["name"].lower() == jm.lower()), None)

    def posli(self, komu, text, odpoved_na=None, verejne=False):
        self.odeslane.append((komu, text)); return {"ok": True}

    def posta(self, n=30):
        return self.posta_box[-n:]

    def stav(self):
        return dict(self._stav)

    def hlaseni(self, etapa, smycka, zprava, ucet=""):
        self.hlaseni_log.append((etapa, smycka, zprava, ucet)); return {"ok": True, "stop": self._stav.get("stop", False)}

    def signal(self, t):
        return self.signaly.get(t) or {"skore": 0.2, "jistota": "nízká", "popis": "klid", "vysledky": {}}

    def usnuti(self, shrnuti, rozdelano="", pristi="", poznamky=None):
        self.usnuti_log.append({"shrnuti": shrnuti, "rozdelano": rozdelano}); return {"ok": True}


class FakeAlpaca:
    def __init__(self, klice=True, snap=None, pozice=None, ucet=None):
        self.ma_klice, self.zivy = klice, False
        self.prikazy_log: list[dict] = []
        self._snap = snap or {}
        self._pozice = pozice or []
        self._ucet = ucet or {"equity": "1000", "last_equity": "1000"}

    def snapshoty(self, symboly):
        return self._snap

    def svicky(self, s, timeframe="1Day", dni=30):
        return [{"v": 1000}] * 21

    def pozice(self):
        return self._pozice

    def prikazy(self, stav="open"):
        return []

    def ucet(self):
        return self._ucet

    def posledni_cena(self, s):
        return 10.0

    def prikaz(self, symbol, mnozstvi, strana, limity, typ="market", limit_cena=None, stop_cena=None, tif="day", suché=False):
        self.prikazy_log.append({"symbol": symbol, "ks": mnozstvi, "strana": strana, "typ": typ, "stop": stop_cena, "suche": suché})
        return {"id": f"o-{len(self.prikazy_log)}", "suche": suché}

    def zrus_prikaz(self, oid):
        pass

    def prodej_vse(self, s, suché=False):
        self.prikazy_log.append({"zavrit": s, "suche": suché}); return {"ok": True}


def snap(**gapy):
    """gapy: SYM=(zavreni, cena, objem) → snapshot ve tvaru Alpacy."""
    out = {}
    for s, (prev, cena, objem) in gapy.items():
        out[s] = {"prevDailyBar": {"c": prev}, "dailyBar": {"c": cena, "v": objem}, "latestTrade": {"p": cena}}
    return out


def novy_radar(ainet=None, alpaca=None, suche=True):
    r = R.Radar(ainet or FakeAInet(), alpaca, None, suche=suche)
    r.zdroje = {"watchlist": ["NVDA", "AAPL", "TSLA", "PLTR", "SPY"], "gap_min_pct": 2.0, "objem_min_nasobek": 1.5, "polygon_top": 0}
    return r


tmp = tempfile.mkdtemp(prefix="radar-denik-")
R.DENIK = Path(tmp)
SNAP = snap(NVDA=(100, 105, 3000), AAPL=(200, 201, 3000), TSLA=(50, 47, 2000), PLTR=(20, 21, 900), SPY=(500, 501, 0))
# NVDA gap +5 % objem 3×  → kandidát · AAPL gap 0,5 % → ne · TSLA gap −6 % objem 2× → kandidát · PLTR objem 0,9× → ne

print("§1 etapa 1 — jen sken, karty, zprávy; žádné příkazy")
ai = FakeAInet(); al = FakeAlpaca(snap=SNAP)
r = novy_radar(ai, al)
ok(R.ETAPA == 1 and not R.ZIVY, "výchozí prostředí: RADAR_ETAPA=1, živý účet vypnutý")
t = r.rano()
ok(t.startswith("📡 Ráno") and "NVDA" in t and "TSLA" in t and "AAPL" not in t, "ráno: přes práh jen NVDA a TSLA (gap ≥ 2 %, objem ≥ 1,5×)")
ok(ai.odeslane and ai.odeslane[-1][0] == "fable-id", "ranní zpráva šla vlastníkovi přes Fabla")
ok(ai.hlaseni_log[-1][1] == "rano" and ai.hlaseni_log[-1][3] == "papir", "worker nahlásil životní znaky (smyčka rano, účet papír)")
ok(any(x.get("smycka") == "rano" for x in r.cti_denik()), "řádek v deníku dne")
t = r.kandidati()
ok("🎯 Kandidáti" in t and "VETO" in t and r.dnes["kandidati"] and r.dnes["kandidati"][0]["symbol"] == "TSLA", "kandidáti seřazeni podle |gap| (TSLA −6 % první), výzva k vetu")
ok("NVDA: gap 5.0 %" in t and "návrh 3 ks, stop 89.25" in t and "TSLA" in t and "návrh 8 ks, stop 39.95" in t, "karta: 400 $ // 105 = 3 ks NVDA (stop 89,25), 400 $ // 47 = 8 ks TSLA (stop 39,95)")
t = r.vstupy()
ok("přeskočeny" in t and "etapa" in t, "vstupy v etapě 1 přeskočeny")
ok(not al.prikazy_log, "na Alpacu neodešel ŽÁDNÝ příkaz")
t = r.vystup()
ok("přeskočen" in t and not al.prikazy_log, "výstup v etapě 1 přeskočen, bez příkazů")
t = r.vecer()
ok(t.startswith("🌙 Večer") and ai.usnuti_log and "etapa" in ai.usnuti_log[-1]["shrnuti"] or ai.usnuti_log, "večer: deník + usnutí na síti")
t = r.tyden()
ok({k for k, _ in ai.odeslane if "Týdenní" in _} == {"fable-id", "aja-id"}, "týdenní zpráva šla vlastníkovi a oponentce Aje, nikam jinam")

print("§2 SPY pod −1 % → žádní kandidáti (pravidlo 4)")
ai = FakeAInet(); al = FakeAlpaca(snap=snap(NVDA=(100, 110, 5000), SPY=(500, 490, 0)))
r = novy_radar(ai, al); t = r.rano()
ok("Žádný kandidát" in t and "SPY" in "; ".join(r.dnes["zakazy"]), "SPY −2 % → nic, důvod v zákazech")

print("§3 etapa 3 (papír) — brány školy, STOP, veto, výsledky, denní ztráta")
R.ETAPA = 3
ai = FakeAInet({"stop": False, "smi_papir": False, "smi_zivy": False}); al = FakeAlpaca(snap=SNAP)
r = novy_radar(ai, al, suche=False); r.kandidati(); t = r.vstupy()
ok("tovaryš" in t and not al.prikazy_log, "bez úrovně tovaryš (analysis < 2) papír nejede")
ai = FakeAInet({"stop": True, "stop_duvod": "zkouška", "smi_papir": True, "smi_zivy": False}); al = FakeAlpaca(snap=SNAP)
r = novy_radar(ai, al, suche=False); r.kandidati(); t = r.vstupy()
ok("STOP" in t and not al.prikazy_log, "STOP ze sítě (/api/radar/stop) → vstupy přeskočeny")
ai = FakeAInet({"stop": False, "smi_papir": True, "smi_zivy": False}); al = FakeAlpaca(snap=SNAP)
r = novy_radar(ai, al, suche=False); r.kandidati()
ted = datetime.now(timezone.utc).isoformat()
ai.posta_box = [{"to": "radar-id", "from": "fable-id", "text": "VETO TSLA", "t": ted}]
t = r.vstupy()
ok("TSLA" in r.dnes["veta"] and all(p["symbol"] != "TSLA" for p in al.prikazy_log), "veto TSLA respektováno")
nakupy = [p for p in al.prikazy_log if p["strana"] == "buy"]
stopy = [p for p in al.prikazy_log if p["typ"] == "stop"]
ok(len(nakupy) == 1 and nakupy[0]["symbol"] == "NVDA" and nakupy[0]["ks"] == 3, "NVDA koupeno: 400 $ // 105 = 3 ks")
ok(len(stopy) == 1 and stopy[0]["symbol"] == "NVDA" and stopy[0]["stop"] == 89.25, "ke každému vstupu stop 15 % (89,25)")
ok(ai.hlaseni_log[-1][1] == "vstupy" and "1 vstupů" in ai.hlaseni_log[-1][2], "hlášení: 1 vstup")
ai = FakeAInet({"stop": False, "smi_papir": True, "smi_zivy": False}); al = FakeAlpaca(snap=SNAP)
r = novy_radar(ai, al, suche=False); r.kandidati()
ai.posta_box = [{"to": "radar-id", "from": "fable-id", "text": "STOP všechno", "t": ted}]
t = r.vstupy()
ok("STOP ve schránce" in t and not al.prikazy_log, "STOP ve schránce → nic")
stara = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()
ai = FakeAInet({"stop": False, "smi_papir": True, "smi_zivy": False}); al = FakeAlpaca(snap=SNAP)
r = novy_radar(ai, al, suche=False); r.kandidati()
ai.posta_box = [{"to": "radar-id", "from": "fable-id", "text": "VETO NVDA", "t": stara}]
r.vstupy()
ok(any(p["symbol"] == "NVDA" for p in al.prikazy_log), "staré veto (před kandidáty) se nepočítá")
ai = FakeAInet({"stop": False, "smi_papir": True, "smi_zivy": False}); al = FakeAlpaca(snap=SNAP)
r = novy_radar(ai, al, suche=False); r.kandidati()
ai.posta_box = [{"to": "radar-id", "from": "aja-id", "text": "STOP", "t": ted}, {"to": "radar-id", "from": "aja-id", "text": "VETO NVDA", "t": ted}]
r.vstupy()
ok(any(p["symbol"] == "NVDA" for p in al.prikazy_log) and "*" not in r.dnes["veta"], "STOP ani veto od cizího agenta (Aja) neplatí — jen od vlastníka")
ai = FakeAInet({"stop": False, "smi_papir": True, "smi_zivy": False}); al = FakeAlpaca(snap=SNAP)
ai.signaly["NVDA"] = {"skore": 0.5, "jistota": "střední", "popis": "výsledky", "vysledky": {"vysledky_dne": datetime.now(R.NY).strftime("%Y-%m-%d")}}
r = novy_radar(ai, al, suche=False); t = r.kandidati()
ok("VÝSLEDKY DNES VEČER" in t, "karta varuje: výsledky dnes večer")
r.vstupy()
ok(all(p["symbol"] != "NVDA" for p in al.prikazy_log) and any(p["symbol"] == "TSLA" for p in al.prikazy_log), "do titulu s výsledky večer se bez ano nevstupuje, TSLA ano")
ai = FakeAInet({"stop": False, "smi_papir": True, "smi_zivy": False}); al = FakeAlpaca(snap=SNAP, ucet={"equity": "985", "last_equity": "1000"})
r = novy_radar(ai, al, suche=False); r.kandidati(); t = r.vstupy()
ok("denní ztráta" in t and not al.prikazy_log and "⛔" in ai.odeslane[-1][1], "denní ztráta 1,5 % ≥ limit 1 % → nic, vlastník ví")
ai = FakeAInet({"stop": False, "smi_papir": True, "smi_zivy": False}); al = FakeAlpaca(snap=SNAP, pozice=[{"symbol": "NVDA", "avg_entry_price": "100", "current_price": "104"}])
r = novy_radar(ai, al, suche=False); t = r.kontrola()
ok("bez stopu 1" in t and "⚠" in ai.odeslane[-1][1], "kontrola 9:25 hlásí pozici bez stopu")
t = r.vystup()
ok(al.prikazy_log and al.prikazy_log[-1].get("zavrit") == "NVDA", "výstup 9:31 prodává držené pozice")
t = r.vyhodnoceni()
ok("1 obchodů" in t and r.cti_denik()[-1]["obchody"][0]["pl_pct"] == 4.0, "vyhodnocení 10:05: P/L +4 %")

print("§4 etapa 4 (živě) — jen mistr, jen RADAR_LIVE=1, režim manual nic neposílá")
R.ETAPA = 4; R.ZIVY = True
ai = FakeAInet({"stop": False, "smi_papir": True, "smi_zivy": False}); al = FakeAlpaca(snap=SNAP)
r = novy_radar(ai, al, suche=False); r.kandidati(); t = r.vstupy()
ok("mistra" in t and not al.prikazy_log, "živě bez úrovně mistr → nic")
ai = FakeAInet({"stop": False, "smi_papir": True, "smi_zivy": True}); al = FakeAlpaca(snap=SNAP)
r = novy_radar(ai, al, suche=False); r.kandidati(); t = r.vstupy()
ok("manual" in t and not al.prikazy_log, "mistr, ale režim manual → příkazy jen připraví, neodešle")
R.ETAPA = 1; R.ZIVY = False
try:
    Alpaca(zivy=True); ok(False, "živý klient bez RADAR_LIVE=1 musí selhat")
except AlpacaChyba:
    ok(True, "živý klient Alpacy bez RADAR_LIVE=1 nejde ani založit")

print("§5 limity přímo v Alpaca.prikaz (poslední brána před penězi)")
os.environ["ALPACA_PAPER_KEY"] = "test"; os.environ["ALPACA_PAPER_SECRET"] = "test"


class AlpacaBezSite(Alpaca):
    def __init__(self):
        super().__init__(zivy=False); self.volani = []; self._poz = []

    def _req(self, url, metoda="GET", telo=None):
        self.volani.append((metoda, url.split(".markets")[-1], telo))
        if url.endswith("/trades/latest?feed=iex"):
            return {"trade": {"p": 150.0}}
        if url.endswith("/v2/positions"):
            return self._poz
        if url.endswith("/v2/orders") and metoda == "POST":
            return {"id": "ord-1", **telo}
        return {}


a = AlpacaBezSite()
limity = json.loads((SLOZKA / "limity.json").read_text("utf-8"))
try:
    a.prikaz("NVDA", 3, "buy", limity); ok(False, "3 × 150 = 450 $ > 400 $ musí odmítnout")
except AlpacaChyba as e:
    ok("přesahuje limit" in str(e), "3 ks po 150 $ = 450 $ > limit 400 $ → odmítnuto")
ok(not any(m == "POST" for m, _, _ in a.volani), "odmítnutý příkaz na Alpacu vůbec neodešel")
r2 = a.prikaz("NVDA", 2, "buy", limity)
ok(r2.get("id") == "ord-1" and r2.get("qty") == "2", "2 ks po 150 $ = 300 $ ≤ 400 $ → odesláno")
a._poz = [{"symbol": "A"}, {"symbol": "B"}, {"symbol": "C"}]
try:
    a.prikaz("TSLA", 1, "buy", limity); ok(False, "3 pozice = max_pozic musí odmítnout")
except AlpacaChyba as e:
    ok("limit" in str(e), "při max_pozic (3) další nákup odmítnut")
a._poz = []
postu_pred = sum(1 for m, _, _ in a.volani if m == "POST")
s = a.prikaz("NVDA", 2, "buy", limity, suché=True)
ok(s.get("suche") and s["prikaz"]["qty"] == "2" and sum(1 for m, _, _ in a.volani if m == "POST") == postu_pred, "suchý režim příkaz jen vrátí, na Alpacu nic neposílá")
try:
    a.prikaz("NVDA", 0, "buy", limity); ok(False, "0 ks")
except AlpacaChyba:
    ok(True, "0 ks odmítnuto")
try:
    a.prikaz("NVDA", 1, "hold", limity); ok(False, "strana hold")
except AlpacaChyba:
    ok(True, "neznámá strana odmítnuta")

print("§6 plánovač — každou smyčku jednou denně, jen v obchodní den")
ok(R.obchodni_den(datetime(2026, 10, 9, 12, tzinfo=R.NY)) and not R.obchodni_den(datetime(2026, 10, 10, 12, tzinfo=R.NY)), "pátek ano, sobota ne")
ok([n for _, _, n in R.SMYCKY] == ["rano", "kontrola", "vystup", "vyhodnoceni", "kandidati", "vstupy", "vecer"] and R.TYDENNI[0] == 4, "osm smyček v pořadí dne, týdenní v pátek")
ok((R.SMYCKY[5][0] * 60 + R.SMYCKY[5][1]) - (R.SMYCKY[4][0] * 60 + R.SMYCKY[4][1]) == 30, "mezi kandidáty a vstupy je 30 minut na veto")

print(f"\nRadar worker: {KROKU} kroků OK (deník testu v {tmp})")
