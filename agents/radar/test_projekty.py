#!/usr/bin/env python3
"""
test_projekty.py — ruce projektů roje nasucho: formát strategie, měření bez dívání dopředu, panel,
joby od serveru, stín a papír na samostatném účtu (falešná Alpaca, falešný server, žádná síť).

Hlídá hlavně to, na čem stojí poctivost a bezpečnost:
  • kritérium jde jen zpřísnit; práh t roste s počtem pokusů
  • žádné dívání dopředu (události z EDGARu, výsledky mimo pokrytí, dnešní signál bez zítřka)
  • stín = jen signály PO dni registrace
  • papír jen se schválením vlastníka, jen long + vstup na otevření, v limitech, STOP = žádné nové vstupy
  • papír jen na samostatném účtu (stejný klíč jako TradeRadarův = chyba)

Spuštění: python3 agents/radar/test_projekty.py
"""
from __future__ import annotations

import csv
import json
import os
import random
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

SLOZKA = Path(__file__).resolve().parent
sys.path.insert(0, str(SLOZKA))
os.environ.pop("PROJEKT_VESMIR", None)

import strategie_dsl as S          # noqa: E402
from panel import Panel             # noqa: E402
from projekty_worker import ProjektyWorker   # noqa: E402
from alpaca_client import AlpacaProjekt, AlpacaChyba   # noqa: E402

KROKU = 0


def ok(podminka, text, detail=None):
    global KROKU
    KROKU += 1
    if not podminka:
        print(f"✗ {KROKU}. {text}" + (f"\n    {json.dumps(detail, ensure_ascii=False, default=str)[:700]}" if detail is not None else ""))
        sys.exit(1)
    print(f"✓ {KROKU}. {text}")


# ---------------------------------------------------------------- syntetická data
def obchodni_dny(od="2021-09-13", do="2026-10-09"):
    d, out = date.fromisoformat(od), []
    while d.isoformat() <= do:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d += timedelta(days=1)
    return out


def synteticky_panel(n=40, seed=7, efekt=0.8, do="2026-10-09"):
    """Náhodná procházka; po „skoku s objemem“ (≥ +3 %, 3× objem) přijde zítřejší otevření s náskokem `efekt` %."""
    random.seed(seed)
    D = obchodni_dny(do=do)
    p, spy = 400.0, []
    for d in D:
        o = p * (1 + random.gauss(0, 0.002)); c = o * (1 + random.gauss(0.0003, 0.008))
        spy.append({"d": d, "o": round(o, 4), "h": round(max(o, c) * 1.002, 4), "l": round(min(o, c) * 0.998, 4), "c": round(c, 4), "v": 8e7}); p = c
    bary = {}
    for k in range(n):
        t, p, boost, bb = f"T{k:02d}", random.uniform(10, 200), False, []
        for d in D:
            o = p * (1 + random.gauss(0, 0.004) + (efekt / 100 if boost else 0)); boost = False
            ch = random.gauss(0, 0.02); skok = random.random() < 0.04
            if skok:
                ch = abs(ch) + 0.03
            c = o * (1 + ch)
            bb.append({"d": d, "o": round(o, 4), "h": round(max(o, c) * (1 + abs(random.gauss(0, 0.005))), 4),
                       "l": round(min(o, c) * (1 - abs(random.gauss(0, 0.005))), 4), "c": round(c, 4), "v": round(random.uniform(8e5, 1.2e6) * (3 if skok else 1))})
            boost = skok; p = c
        bary[t] = bb
    return bary, spy


SKOK = {"nazev": "Skok s objemem", "vstup": "open_D1", "vystup": {"dni": 0, "cena": "close"},
        "filtry": [{"pole": "pohyb_pct", "op": ">=", "hodnota": 3}, {"pole": "objem_x", "op": ">=", "hodnota": 2}],
        "razeni": {"pole": "objem_x", "smer": "desc"}, "max_denne": 3}
OVERNIGHT = {**SKOK, "nazev": "skok-overnight", "vstup": "close_D", "vystup": {"dni": 1, "cena": "open"}}


# ---------------------------------------------------------------- falešní klienti
class FakeAInet:
    def __init__(self):
        self.worker = {"joby": [], "strategie": [], "stop": False}
        self.joby_log, self.metriky, self.manifesty = [], [], []

    def projekty_worker(self):
        return json.loads(json.dumps(self.worker))

    def projekty_job(self, job_id, stav, vysledek=None, chyba=None):
        self.joby_log.append((job_id, stav, vysledek, chyba)); return {"ok": True}

    def projekty_metriky(self, reg, typ, souhrn, obchody=None):
        self.metriky.append((reg, typ, souhrn, obchody or [])); return {"ok": True}

    def projekty_manifest(self, m):
        self.manifesty.append(m); return {"ok": True}


class FakeAlpacaData:
    """svicky_vic z připraveného panelu (jako /v2/stocks/bars s adjustment=all)."""
    def __init__(self, bary, spy):
        self.ma_klice = True
        self.zdroj = dict(bary); self.zdroj["SPY"] = spy
        self.volani = []

    def svicky_vic(self, symboly, start, end=None, feed="sip", adjustment="all"):
        self.volani.append((tuple(symboly), start, feed))
        return {s: [{"t": b["d"] + "T04:00:00Z", **{k: b[k] for k in "ohlcv"}} for b in self.zdroj.get(s, []) if b["d"] >= start[:10]] for s in symboly}


class FakePapir:
    def __init__(self, ceny=None):
        self.ma_klice = True
        self.prikazy_log, self.zruseno = [], []
        self.stavy: dict[str, dict] = {}
        self.ceny = ceny or {}
        self.n = 0
        self.ucet_data = {"equity": "100000", "last_equity": "100000"}

    def hodiny(self):
        return {"is_open": False, "next_open": W_DNES + "T09:30:00-04:00"}

    def ucet(self):
        return dict(self.ucet_data)

    def posledni_cena(self, s):
        return self.ceny.get(s, 50.0)

    def prikaz(self, symbol, mnozstvi, strana, limity, typ="market", limit_cena=None, stop_cena=None, tif="day", suché=False):
        self.n += 1
        oid = f"o{self.n}"
        self.prikazy_log.append({"id": oid, "symbol": symbol, "qty": mnozstvi, "strana": strana, "typ": typ, "stop": stop_cena, "tif": tif})
        self.stavy[oid] = {"status": "accepted"}
        return {"id": oid}

    def prikaz_detail(self, oid):
        return self.stavy.get(oid, {"status": "canceled"})

    def zrus_prikaz(self, oid):
        self.zruseno.append(oid); self.stavy[oid] = {"status": "canceled"}

    def vypln(self, oid, cena, qty):
        self.stavy[oid] = {"status": "filled", "filled_avg_price": str(cena), "filled_qty": str(qty)}


W_DNES = "2026-10-09"


def zaloz_erp(koren: Path, bary: dict, spy: list, ledger: dict | None = None, vysledky: list | None = None):
    td = koren / "Tickers DATA" / "data5y_alpaca"; td.mkdir(parents=True)
    for t, bb in {**bary, "SPY": spy}.items():
        (td / f"{t}.json").write_text(json.dumps({"symbol": t, "zdroj": "test", "bary": bb}))
    with open(koren / "Tickers DATA" / "earnings_edgar_5y.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["ticker", "datum", "session", "cas_prijeti", "forma"])
        for t, d, s in (vysledky or []):
            w.writerow([t, d, s, "", "8-K/2.02"])
    (koren / "laborator_vah").mkdir()
    (koren / "laborator_vah" / "edgar_ledger.json").write_text(json.dumps(ledger or {}))
    with open(koren / "registrace_kriterii.csv", "w", newline="") as f:
        w = csv.writer(f); w.writerow(["klic", "vetev", "metrika", "delta_pp", "design", "typ", "sd_zdroj", "datum_cteni", "poznamka"])
        w.writerow(["stin_insider", "Runner", "drift po insider nakupu", "0.8", "", "uzavreno", "", "", "neprošlo: Ø −5,45 %"])


# ==================================================================== testy
def main():
    print("1) Formát strategie a kritérium")
    n, ch = S.validuj(SKOK, {"panel"})
    ok(n and not ch and n["nazev"] == "skok-s-objemem" and n["vesmir"] == {"cena_min": 2.0, "obrat_musd_min": 1.0}, "platná strategie se normalizuje (název, výchozí vesmír)", ch)
    _, ch = S.validuj({"nazev": "x", "vstup": "close_D", "vystup": {"dni": 0, "cena": "open"}, "filtry": [{"pole": "zitrejsi_cena", "op": ">", "hodnota": 1}]}, {"panel"})
    ok(any("nazev" in c for c in ch) and any("vystup.dni aspoň 1" in c for c in ch) and any("neznám" in c for c in ch), "chyby: krátký název, výstup dřív než vstup, neznámé pole", ch)
    _, ch = S.validuj({**SKOK, "filtry": [{"udalost": "B1", "okno": 10}]}, {"panel"})
    ok(any("události EDGAR teď worker nemá" in c for c in ch), "filtr na události bez knihy podání neprojde", ch)
    _, ch = S.validuj({**SKOK, "filtry": [{"pole": "spy_nad_vwap", "op": ">", "hodnota": 1}]}, {"panel"})
    ok(any("ano/ne" in c for c in ch), "ano/ne pole jen s == / != a true/false", ch)
    _, ch = S.validuj({**SKOK, "filtry": []}, {"panel"})
    ok(any("kup všechno" in c for c in ch), "strategie bez filtru se neměří")
    n2, _ = S.validuj({**SKOK, "vesmir": {"cena_min": 0.5, "obrat_musd_min": 5}}, {"panel"})
    ok(n2["vesmir"] == {"cena_min": 2.0, "obrat_musd_min": 5.0}, "vesmír jde jen zúžit (penny akcie ne)", n2["vesmir"])
    k1 = S.kriterium_s_podlahou({"t_min": 1.5, "naklad_pct": 0.05, "n_min": 50, "holdout_od": "2026-09-01"}, 1)
    k16 = S.kriterium_s_podlahou({}, 16)
    ok(k1["t_min"] == 2.0 and k1["naklad_pct"] == 0.10 and k1["n_min"] == 200 and k1["holdout_od"] == S.HOLDOUT_OD, "kritérium se zmírnit nedá (t, náklad, n, holdout)", k1)
    ok(k16["t_min"] == 3.0 and S.kriterium_s_podlahou({"t_min": 4}, 1)["t_min"] == 4, "práh t roste s pokusy (16. pokus → 3,0); zpřísnit jde", k16)

    print("\n2) Pole bez dívání dopředu")
    dny = obchodni_dny("2026-01-01", "2026-03-31")
    bb = [{"d": d, "o": 10.0, "h": 10.5, "l": 9.5, "c": 10.0, "v": 1000.0} for d in dny]
    bb[30] = {**bb[30], "o": 10.2, "c": 11.0, "h": 11.2, "v": 3000.0}
    spy = [{"d": d, "o": 100.0, "h": 101.0, "l": 99.0, "c": 100.0, "v": 1.0} for d in dny]
    D = S.Data({"AAA": bb}, spy)
    P = S._pole_titulu(D, D.tituly["AAA"], {"pohyb_pct", "gap_pct", "objem_x", "ma20_pct", "od_max20_pct", "atr14_pct", "obrat_musd"})
    ok(abs(P["pohyb_pct"][30] - 10.0) < 1e-9 and abs(P["gap_pct"][30] - 2.0) < 1e-9, "pohyb a gap dne D z close D−1", (P["pohyb_pct"][30], P["gap_pct"][30]))
    ok(abs(P["objem_x"][30] - 3.0) < 1e-9 and P["objem_x"][19] is None, "objem_x = objem D / průměr D−20…D−1 (bez dne D); bez 20 dní historie nic", P["objem_x"][30])
    ok(abs(P["obrat_musd"][31] - (10.0 * 1000 * 19 + 11.0 * 3000) / 20 / 1e6) < 1e-12, "obrat z předchozích 20 dní (D se nepočítá)")
    ok(abs(P["ma20_pct"][30] - (11.0 / ((10.0 * 19 + 11.0) / 20) - 1) * 100) < 1e-9 and abs(P["od_max20_pct"][30] - (11.0 / 11.2 - 1) * 100) < 1e-9, "MA20 a vzdálenost od maxima 20 dní včetně dne D")
    ok(P["atr14_pct"][13] is None and P["atr14_pct"][20] is not None, "ATR14 až se 14 dny historie")
    led = {"AAA": {"B1": [dny[30]]}}
    D2 = S.Data({"AAA": bb}, spy, udalosti=led, udalosti_do=dny[-1])
    T = D2.tituly["AAA"]
    ok(S._udalost(D2, T, 30, "B1", 5, "close_D") is False and S._udalost(D2, T, 30, "B1", 5, "open_D1") is True,
       "13D podané v den D: pro vstup na close D ještě ne, pro vstup na otevření D+1 už ano")
    ok(S._udalost(D2, T, 31, "B1", 5, "close_D") is True and S._udalost(D2, T, 40, "B1", 5, "close_D") is False, "okno: den po podání ano, po 10 dnech ne")
    D3 = S.Data({"AAA": bb}, spy, udalosti=led, udalosti_do=dny[35])
    ok(S._udalost(D3, D3.tituly["AAA"], 40, "B1", 30, "open_D1") is None, "za koncem knihy podání = neznámo (filtr neprojde ani „bez události“)")
    D4 = S.Data({"AAA": bb}, spy, vysledky={"AAA": {(dny[30], "A"), (dny[40], "B")}}, vysledky_do=dny[45])
    P4 = S._pole_titulu(D4, D4.tituly["AAA"], {"vysledky_reakce", "vysledky_dnes_vecer", "vysledky_zitra_rano", "dni_od_vysledku"})
    ok(P4["vysledky_dnes_vecer"][30] is True and P4["vysledky_reakce"][31] is True and P4["vysledky_zitra_rano"][39] is True and P4["vysledky_reakce"][40] is True,
       "výsledky: večer D, reakce D+1, ráno D+1 známé předem")
    ok(P4["dni_od_vysledku"][35] == 4 and P4["vysledky_reakce"][50] is None, "dny od reakce; za pokrytím kalendáře neznámo", (P4["dni_od_vysledku"][35], P4["vysledky_reakce"][50]))

    print("\n3) Obchod: vstup, výstup, stop, short")
    bb2 = [{"d": d, "o": 100.0, "h": 101.0, "l": 99.0, "c": 100.0, "v": 1000.0} for d in dny]
    bb2[31] = {**bb2[31], "o": 100.0, "l": 90.0, "c": 95.0}
    bb2[32] = {**bb2[32], "o": 80.0, "l": 79.0, "c": 82.0}
    D5 = S.Data({"BBB": bb2}, spy)
    TB = D5.tituly["BBB"]
    base = S.validuj({**SKOK, "stop_pct": 5, "vystup": {"dni": 2, "cena": "close"}}, {"panel"})[0]
    o1 = S.obchod(D5, base, TB, 30, 0.1)
    ok(o1["jak"] == "stop" and o1["vystup"] == 95.0 and o1["vstup_den"] == dny[31], "vstup na otevření D+1, stop v seanci dne vstupu na −5 %", o1)
    base2 = S.validuj({**OVERNIGHT, "stop_pct": 10, "vystup": {"dni": 3, "cena": "close"}}, {"panel"})[0]
    o2 = S.obchod(D5, base2, TB, 30, 0.1)
    ok(o2["jak"] == "stop" and o2["vystup"] == 90.0 and o2["vystup_den"] == dny[31], "vstup na close D, stop zasažen další den (low 90)", o2)
    base3 = S.validuj({**OVERNIGHT, "stop_pct": 15, "vystup": {"dni": 3, "cena": "close"}}, {"panel"})[0]
    o3 = S.obchod(D5, base3, TB, 30, 0.1)
    ok(o3["jak"] == "stop (gap)" and o3["vystup"] == 80.0 and o3["vystup_den"] == dny[32], "mezera přes stop → plnění na otevření (80), ne na stopu", o3)
    sh = S.validuj({**OVERNIGHT, "smer": "short", "vystup": {"dni": 2, "cena": "open"}}, {"panel"})[0]
    o4 = S.obchod(D5, sh, TB, 30, 0.1)
    ok(o4["r"] == 20.0 and abs(o4["a"] - 19.9) < 1e-9 and o4["jak"] == "open", "short: pokles 100 → 80 = +20 %, výstup na otevření", o4)
    ok(S.obchod(D5, base, TB, len(TB.c) - 1, 0.1) is None, "dnešní signál bez zítřejšího baru = otevřený, ne obchod")

    print("\n4) Měření: backtest, holdout, stín")
    bary, spy = synteticky_panel()
    data = S.Data(bary, spy)
    sk = S.validuj(OVERNIGHT, data.zdroje())[0]
    r = S.mer(data, sk, S.kriterium_s_podlahou({}, 1), "2026-09-30T14:00:00Z")
    ok(r["verdikt"] == "PROŠLO" and r["vyvoj"]["n"] >= 200 and r["holdout"]["n"] >= 30 and r["vyvoj"]["alfa"] > 0.5, "zasazený efekt (+0,8 % na zítřejším otevření) projde: close D → open D+1", {k: r[k] for k in ("verdikt", "duvody")})
    r0 = S.mer(data, S.validuj(SKOK, data.zdroje())[0], S.kriterium_s_podlahou({}, 1), "2026-09-30T14:00:00Z")
    ok(r0["vyvoj"]["alfa"] < 0.3, "tentýž signál se vstupem až na otevření D+1 efekt nechytí (už je v ceně otevření)", r0["vyvoj"]["alfa"])
    ok(all(x["d"] > "2026-09-30" for x in S.stin(data, sk, 0.1, "2026-09-30T14:00:00Z")["obchody"]) and r["stin"]["od"] == "2026-09-30", "stín = jen signály po dni registrace")
    nah = S.validuj({**OVERNIGHT, "nazev": "nahoda", "filtry": [{"pole": "pohyb_pct", "op": "<=", "hodnota": -1}]}, data.zdroje())[0]
    r2 = S.mer(data, nah, S.kriterium_s_podlahou({}, 4), "2026-09-30")
    ok(r2["verdikt"] == "NEPROŠLO" and any("pokus č. 4" in d for d in r2["duvody"]), "náhodná strategie neprojde; důvod zmiňuje číslo pokusu", r2["duvody"])
    r3 = S.mer(data, sk, S.kriterium_s_podlahou({"alfa_min": 5.0}, 1), "2026-09-30")
    ok(r3["verdikt"] == "NEPROŠLO" and any("alfa po nákladech" in d for d in r3["duvody"]), "přísnější kritérium agenta platí")
    sig = S.signaly_dne(data, sk, data.do)
    ok(sig["duvod"] is None and len(sig["signaly"]) <= 3, "signály dne pro papír (nejvýš max_denne)", sig)

    with tempfile.TemporaryDirectory() as tmp:
        koren = Path(tmp)
        erp, wdir = koren / "research", koren / "worker"
        erp.mkdir()
        led = {"T01": {"cik": "1", "n": 1, "f": [["2023-05-02", "SC 13D", "", "acc", "doc", ""]]}}
        zaloz_erp(erp, {t: bb for t, bb in bary.items() if t < "T10"}, spy, led, [("T01", "2026-10-07", "A")])

        print("\n5) Panel: ERP jen čtení, vlastní data z Alpacy")
        p = Panel(wdir, erp)
        d0 = p.nacti()
        ok(getattr(d0, "zdroj", "") == "erp" and len(d0.tituly) == 10 and d0.udalosti["T01"]["B1"] == ["2023-05-02"], "bez vlastních dat se měří na panelu ERP; kniha podání → kategorie (13D = B1)")
        ok(d0.vysledky_do == "2026-10-07" and ("2026-10-07", "A") in d0.vysledky["T01"], "výsledky z CSV ERP, pokrytí do posledního data")
        fa = FakeAlpacaData({t: [b for b in bb if b["d"] <= "2026-10-08"] for t, bb in bary.items() if t < "T10"}, [b for b in spy if b["d"] <= "2026-10-08"])
        snimek = {str(x): x.stat().st_mtime_ns for x in erp.rglob("*")}
        a1 = p.aktualizuj(fa, dnes="2026-10-08")
        d1 = p.nacti()
        ok(a1["ok"] and getattr(d1, "zdroj", "") == "worker" and d1.do == "2026-10-08" and len(d1.tituly) == 10, "první běh: celá historie z Alpacy do vlastní složky", a1)
        ok(snimek == {str(x): x.stat().st_mtime_ns for x in erp.rglob("*")}, "do složek Earnings Radaru se nic nezapisuje (ani cache)")
        fa.zdroj = {t: bb for t, bb in bary.items() if t < "T10"}; fa.zdroj["SPY"] = spy
        T03 = fa.zdroj["T03"] = [dict(b, c=round(b["c"] * 0.98, 4), o=round(b["o"] * 0.98, 4), h=round(b["h"] * 0.98, 4), l=round(b["l"] * 0.98, 4)) for b in bary["T03"]]   # dividenda → celá historie jinak upravená
        a2 = p.aktualizuj(fa, dnes="2026-10-09")
        d2 = p.nacti()
        ok(a2["novych_baru"] >= 10 and d2.do == "2026-10-09" and a2["znovu_stazeno"] == 1, "další den: jen chybějící den; po dividendě (nesedí překryv) titul celý znovu", a2)
        prvni = d2.dny[d2.tituly["T03"].di[0]]
        ok(abs(d2.tituly["T03"].c[-1] - T03[-1]["c"]) < 1e-9 and abs(d2.tituly["T03"].c[0] - next(b["c"] for b in T03 if b["d"] == prvni)) < 1e-9, "znovu stažený titul má jednotnou úpravu cen od začátku")

        print("\n6) Joby od roje")
        ai = FakeAInet()
        w = ProjektyWorker(ai, None, None, p)
        ai.worker["joby"] = [
            {"id": "job-bt", "typ": "backtest", "parametry": {"strategie": SKOK, "kriterium": {"pokus": 2}, "registrovano": "2026-09-30T10:00:00Z"}},
            {"id": "job-spatny", "typ": "backtest", "parametry": {"strategie": {"nazev": "x"}}},
            {"id": "job-ud", "typ": "udalosti", "parametry": {"kategorie": ["B1"], "od": "2023-01-01", "do": "2023-12-31"}},
            {"id": "job-erp", "typ": "erp_registrace", "parametry": {}},
            {"id": "job-neznam", "typ": "vyrob_penize", "parametry": {}},
        ]
        w.joby()
        L = {j: (s, v, c) for j, s, v, c in ai.joby_log if s != "bezi"}
        ok(L["job-bt"][0] == "hotovo" and L["job-bt"][1]["verdikt"] in ("PROŠLO", "NEPROŠLO") and L["job-bt"][1]["kriterium"]["t_min"] == 2.25, "backtest: výsledek s verdiktem a kritériem (2. pokus → t 2,25)", L["job-bt"][1]["kriterium"] if L["job-bt"][1] else L["job-bt"])
        ok(L["job-spatny"][0] == "chyba" and "kontrolou formátu" in L["job-spatny"][2], "špatná strategie → chyba s důvodem, nic se neměří", L["job-spatny"])
        ok(L["job-ud"][0] == "hotovo" and L["job-ud"][1]["celkem"] == 1 and L["job-ud"][1]["radky"][0]["t"] == "T01", "události EDGAR: výpis 13D za rok", L["job-ud"][1])
        ok(L["job-erp"][0] == "hotovo" and "stin_insider" in L["job-erp"][1]["dokument"]["text"], "výtah z registrací ERP jako dokument do knihovny")
        ok(L["job-neznam"][0] == "chyba" and "neznámý typ" in L["job-neznam"][2], "neznámý job → chyba")
        ok(sum(1 for _, s, _, _ in ai.joby_log if s == "bezi") == 5, "každý job se nejdřív převezme (bezi), ať ho nevezme dvakrát")

        print("\n7) Večer: stín")
        ai.worker["joby"] = []
        ai.worker["strategie"] = [
            {"id": "reg-a", "projekt": "p1", "nazev": "skok-s-objemem", "verze": 1, "strategie": SKOK, "kriterium": {"pokus": 1}, "registrovano": "2026-09-30T10:00:00Z", "stin": True, "papir": False, "stop": False},
            {"id": "reg-b", "projekt": "p1", "nazev": "jiny", "verze": 1, "strategie": SKOK, "kriterium": {"pokus": 1}, "registrovano": "2026-09-30T10:00:00Z", "stin": False, "papir": False, "stop": False},
        ]
        w.alpaca_data = fa
        w.vecer()
        st = [m for m in ai.metriky if m[1] == "stin"]
        ok(len(st) == 1 and st[0][0] == "reg-a" and st[0][2]["od"] == "2026-09-30" and all(o["d"] > "2026-09-30" for o in st[0][3]), "stín jen pro strategie, které prošly (reg-a), jen obchody po registraci", st[0][2] if st else None)
        ok(ai.manifesty and "backtest" in ai.manifesty[-1]["typy_jobu"] and ai.manifesty[-1]["data"]["do"] == "2026-10-09", "worker ohlásí serveru, co umí a do kdy má data")

        print("\n8) Papír na samostatném účtu")
        global W_DNES
        os.environ["ALPACA_PAPER_KEY"] = "STEJNY"; os.environ["ALPACA_PROJEKT_KEY"] = "STEJNY"; os.environ["ALPACA_PROJEKT_SECRET"] = "x"
        try:
            AlpacaProjekt(); ok(False, "stejný klíč jako TradeRadar musí selhat")
        except AlpacaChyba:
            ok(True, "účet projektů nesmí být TradeRadarův papírový účet (stejný klíč = chyba)")
        os.environ["ALPACA_PROJEKT_KEY"] = "JINY"
        ok(AlpacaProjekt().base == "https://paper-api.alpaca.markets", "účet projektů je vždy paper-api")
        for k in ("ALPACA_PAPER_KEY", "ALPACA_PROJEKT_KEY", "ALPACA_PROJEKT_SECRET"):
            os.environ.pop(k, None)
        w0 = ProjektyWorker(ai, None, None, p)
        ok(w0.rano() == "papír: bez klíčů účtu projektů", "bez klíčů projektů žádný papír")

        fp = FakePapir()
        w = ProjektyWorker(ai, None, fp, p)
        W_DNES = "2026-10-09"
        w.dnes = lambda: W_DNES
        dd = p.nacti()
        sk2 = {**SKOK, "nazev": "papir-test", "max_denne": 10, "filtry": [{"pole": "objem_x", "op": ">=", "hodnota": 0}]}   # každý den hodně signálů
        ai.worker["strategie"] = [
            {"id": "reg-p", "projekt": "p1", "nazev": "papir-test", "strategie": {**sk2, "vystup": {"dni": 1, "cena": "open"}, "stop_pct": 10}, "kriterium": {}, "registrovano": "2026-01-01", "stin": True, "papir": True, "stop": False},
            {"id": "reg-close", "projekt": "p1", "nazev": "na-close", "strategie": {**sk2, "nazev": "na-close", "vstup": "close_D", "vystup": {"dni": 1, "cena": "open"}}, "kriterium": {}, "registrovano": "2026-01-01", "stin": True, "papir": True, "stop": False},
            {"id": "reg-short", "projekt": "p1", "nazev": "short", "strategie": {**sk2, "nazev": "short", "smer": "short"}, "kriterium": {}, "registrovano": "2026-01-01", "stin": True, "papir": True, "stop": False},
            {"id": "reg-ne", "projekt": "p1", "nazev": "bez-brany", "strategie": {**sk2, "nazev": "bez-brany"}, "kriterium": {}, "registrovano": "2026-01-01", "stin": True, "papir": False, "stop": False},
        ]
        txt = w.planuj_papir(dd, ai.projekty_worker())
        ps = w.cti_stav()
        ok(ps["planovane"] and all(x["reg"] == "reg-p" for x in ps["planovane"]) and ps["planovane"][0]["vstup_den"] == "2026-10-12", "plán jen pro schválenou long strategii se vstupem na otevření (ne close, ne short, ne bez brány)", txt)
        W_DNES = "2026-10-12"
        fp.ceny = {t: 40.0 for t in dd.tituly}
        t1 = w.rano()
        buys = [o for o in fp.prikazy_log if o["strana"] == "buy"]
        ok(len(buys) == 4 and all(o["tif"] == "opg" and o["qty"] == 7 for o in buys), "ráno: vstupy příkazem na otevření (OPG), nejvýš 4 za den, 300 $ / 40 $ = 7 ks", t1)
        ok("limit" in t1, "zbylé signály vynechány kvůli limitu", t1)
        for o in buys:
            fp.vypln(o["id"], 40.0, 7)
        t2 = w.kontrola()
        ps = w.cti_stav()
        stopy = [o for o in fp.prikazy_log if o["typ"] == "stop"]
        ok(len(ps["otevrene"]) == 4 and len(stopy) == 4 and all(o["stop"] == 36.0 and o["tif"] == "gtc" for o in stopy), "kontrola: plnění → pozice + stop −10 % (GTC)", t2)
        W_DNES = "2026-10-13"
        n_pred = len(fp.prikazy_log)
        t3 = w.rano()
        sells = [o for o in fp.prikazy_log[n_pred:] if o["strana"] == "sell"]
        ok(len(sells) == 4 and all(o["tif"] == "opg" for o in sells) and len(fp.zruseno) == 4, "další den: výstup na otevření (OPG) a stop se nejdřív zruší", t3)
        for o in sells:
            fp.vypln(o["id"], 42.0, 7)
        w.kontrola()
        ps = w.cti_stav()
        ok(not ps["otevrene"] and len(ps["uzavrene"]) == 4 and ps["uzavrene"][0]["jak"] == "plán", "plnění výstupů → uzavřené obchody")

        print("\n9) Papír: STOP, denní ztráta, metriky")
        ps = w.cti_stav(); ps["planovane"] = [{"id": "x1", "reg": "reg-p", "projekt": "p1", "t": "T05", "signal_den": "2026-10-12", "vstup_den": "2026-10-13", "drzet_dni": 1, "vystup_cena": "open", "stop_pct": None, "cena_signal": 40.0}]
        ps["odpocet"] = None; w.pis_stav(ps)
        ai.worker["stop"] = True
        n_pred = len(fp.prikazy_log)
        t4 = w.rano()
        ok(len(fp.prikazy_log) == n_pred and "globální STOP" in t4, "globální STOP TradeRadara → žádný nový vstup", t4)
        ai.worker["stop"] = False
        ai.worker["strategie"][0]["stop"] = True
        ps = w.cti_stav(); ps["planovane"] = [{"id": "x2", "reg": "reg-p", "projekt": "p1", "t": "T05", "signal_den": "2026-10-12", "vstup_den": "2026-10-13", "drzet_dni": 1, "vystup_cena": "open", "stop_pct": None, "cena_signal": 40.0}]
        w.pis_stav(ps)
        t5 = w.rano()
        ok(len(fp.prikazy_log) == n_pred and "zastavený" in t5, "zastavený projekt → žádný nový vstup", t5)
        ai.worker["strategie"][0]["stop"] = False
        fp.ucet_data = {"equity": "97000", "last_equity": "100000"}
        ps = w.cti_stav(); ps["planovane"] = [{"id": "x3", "reg": "reg-p", "projekt": "p1", "t": "T05", "signal_den": "2026-10-12", "vstup_den": "2026-10-13", "drzet_dni": 1, "vystup_cena": "open", "stop_pct": None, "cena_signal": 40.0}]
        w.pis_stav(ps)
        t6 = w.rano()
        ok(len(fp.prikazy_log) == n_pred and "denní ztráta" in t6, "denní ztráta účtu −3 % (limit 2 %) → žádný nový vstup", t6)
        fp.ucet_data = {"equity": "100000", "last_equity": "100000"}
        ai.metriky.clear()
        W_DNES = "2026-10-13"
        dd2 = S.Data(*synteticky_panel(n=10, do="2026-10-13"))      # večer 13. 10.: panel už má dny vstupu i výstupu
        w.planuj_papir(dd2, ai.projekty_worker())
        pap = [m for m in ai.metriky if m[1] == "papir"]
        ok(pap and pap[0][0] == "reg-p" and pap[0][2]["n"] == 4 and abs(pap[0][2]["pl_usd"] - 4 * 7 * 2.0) < 1e-6 and "a" in pap[0][3][0], "večer: metriky papíru za strategii (4 obchody, +56 $, alfa proti SPY)", pap[0][2] if pap else None)

        print("\n10) Uzavření na close a zavření")
        ps = w.cti_stav(); ps["otevrene"] = [{"id": "c1", "reg": "reg-p", "projekt": "p1", "t": "T07", "qty": 5, "vstup_den": "2026-10-13", "vstup_cena": 40.0, "zbyva_dni": 0, "vystup_cena": "close", "stop_pct": 10, "stop_prikaz": "o-stop", "vystup_prikaz": None}]
        w.pis_stav(ps)
        n_pred = len(fp.prikazy_log)
        t7 = w.zavreni()
        ok(len(fp.prikazy_log) == n_pred + 1 and fp.prikazy_log[-1]["tif"] == "cls" and "o-stop" in fp.zruseno, "15:30: výstup na zavření (CLS), stop zrušen předem", t7)

    print(f"\nProjekty roje — worker: {KROKU} kroků OK")


if __name__ == "__main__":
    main()
