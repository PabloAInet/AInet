"""
strategie_dsl.py — strategie roje v PEVNÉM FORMÁTU a jejich měření (Projekty roje, 12. 10. 2026).

Agenti v projektu nepíšou kód, který by běžel s penězi. Strategii navrhnou jako JSON (pole níž),
server ji ZAPÍŠE i s kritériem PŘED měřením (registrace) a worker ji tady změří:
  backtest  vývojová data (signál před holdout_od) + odložený holdout (od holdout_od do dne registrace)
            → verdikt podle kritéria zapsaného předem
  stín      obchody se signálem PO dni registrace (dopředu, bez peněz) — tohle rozhoduje
  signály   pro papír: co by strategie vzala dnes (vstup na zítřejším otevření)

Bez dívání dopředu: pole dne D se počítají jen z dat do zavření D. Události z EDGARu se u vstupu
na close D berou jen podané PŘED dnem D, u vstupu na otevření D+1 i podané v den D (do večera jsou známé).
Výsledky (earnings) jsou plánované dopředu, takže „dnes večer“ a „zítra ráno“ se znát smějí.
Panel jsou dnešní tituly (přeživší) → backtest je spíš horní odhad; proto rozhoduje stín.

Čistá standardní knihovna.
"""
from __future__ import annotations

import bisect
import math
import re
import statistics
import unicodedata
from collections import defaultdict, deque

# ---------------------------------------------------------------- slovník formátu
POLE = {   # název: (popis, typ, zdroj)
    "cena": ("close dne D v $", "cislo", "panel"),
    "pohyb_pct": ("close D / close D−1 − 1, v %", "cislo", "panel"),
    "gap_pct": ("open D / close D−1 − 1, v %", "cislo", "panel"),
    "den_pct": ("close D / open D − 1, v %", "cislo", "panel"),
    "rozsah_pct": ("(high − low) / close dne D, v %", "cislo", "panel"),
    "objem_x": ("objem D / průměr objemu D−20…D−1", "cislo", "panel"),
    "obrat_musd": ("průměrný denní obrat D−20…D−1 v mil. $", "cislo", "panel"),
    "vynos_5d_pct": ("close D / close D−5 − 1, v %", "cislo", "panel"),
    "vynos_20d_pct": ("close D / close D−20 − 1, v %", "cislo", "panel"),
    "ma20_pct": ("close D / MA20 − 1, v %", "cislo", "panel"),
    "ma50_pct": ("close D / MA50 − 1, v %", "cislo", "panel"),
    "od_max20_pct": ("close D / max(high D−19…D) − 1, v % (≤ 0)", "cislo", "panel"),
    "atr14_pct": ("ATR14 / close D, v %", "cislo", "panel"),
    "spy_pohyb_pct": ("SPY close D / close D−1 − 1, v %", "cislo", "panel"),
    "spy_ma50_pct": ("SPY close D / MA50 − 1, v %", "cislo", "panel"),
    "spy_vynos_5d_pct": ("SPY close D / close D−5 − 1, v %", "cislo", "panel"),
    "spy_nad_vwap": ("SPY close D nad (H+L+C)/3 dne D (náhrada VWAP)", "bool", "panel"),
    "vysledky_reakce": ("D je reakční den na výsledky (ráno D nebo večer D−1)", "bool", "vysledky"),
    "vysledky_dnes_vecer": ("výsledky po zavření dne D", "bool", "vysledky"),
    "vysledky_zitra_rano": ("výsledky před otevřením D+1", "bool", "vysledky"),
    "dni_od_vysledku": ("obchodních dní od posledního reakčního dne (999 = žádný)", "cislo", "vysledky"),
}
UDALOSTI = {   # kategorie EDGAR (jako kniha událostí v Earnings Radaru)
    "A1": "emise oceněná (424B4/424B5)",
    "A2": "PIPE (8-K 3.02)",
    "A3": "shelf / S-1 (S-3, S-3ASR, S-1, F-1, F-3)",
    "A4": "reverse split / delisting notice (8-K 5.03, 3.01, 25-NSE)",
    "B1": "aktivista long (SC 13D, 13D/A, DEFC14A, PREC14A)",
    "B3": "pasivní podíl (SC 13G, 13G/A)",
    "E1": "odchod vedení (8-K 5.02)",
    "F1": "bankrot / delisting (8-K 1.03, 3.01)",
    "G3": "M&A (8-K 1.01, 2.01, SC TO, DEFM14A)",
    "G4": "ukončení podstatné smlouvy (8-K 1.02)",
    "V": "výsledky (8-K 2.02)",
    "X1": "jiná tiskovka (8-K 7.01/8.01 bez 2.02)",
}
OPERATORY = (">", ">=", "<", "<=", "==", "!=")
VSTUPY = {"close_D": "nákup na zavření dne signálu D", "open_D1": "nákup na otevření D+1 (signál známý večer D)"}
HOLDOUT_OD = "2025-07-01"
VYCHOZI_VESMIR = {"cena_min": 2.0, "obrat_musd_min": 1.0}


def kategorie(forma: str, polozky: str) -> set[str]:
    """Kategorie podání EDGAR podle formy a položek 8-K — bez čtení textu."""
    f = str(forma or "").upper().strip()
    it = {x.strip() for x in str(polozky or "").split(",") if x.strip()}
    k: set[str] = set()
    if f.startswith("424B4") or f.startswith("424B5"):
        k.add("A1")
    if f.startswith("8-K"):
        if "3.02" in it: k.add("A2")
        if "5.03" in it or "3.01" in it: k.add("A4")
        if "5.02" in it: k.add("E1")
        if "1.03" in it or "3.01" in it: k.add("F1")
        if "1.01" in it or "2.01" in it: k.add("G3")
        if "1.02" in it: k.add("G4")
        if "2.02" in it: k.add("V")
        if ("7.01" in it or "8.01" in it) and "2.02" not in it: k.add("X1")
    if f in ("S-3", "S-3ASR", "S-1", "F-1", "F-3"):
        k.add("A3")
    if f.startswith("25-NSE"):
        k.add("A4")
    if f.startswith("SC 13D") or f in ("DEFC14A", "PREC14A"):
        k.add("B1")
    if f.startswith("SC 13G"):
        k.add("B3")
    if f.startswith("SC TO") or f == "DEFM14A":
        k.add("G3")
    return k


def kriterium_s_podlahou(k: dict | None, pokus: int) -> dict:
    """Agenti smějí kritérium jen zpřísnit. Práh t roste s počtem pokusů projektu (víc zkoušených variant = víc náhodných úspěchů)."""
    k = k or {}
    num = lambda x, d: float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else d   # noqa: E731
    t_podlaha = round(2.0 + 0.25 * math.log2(max(1, int(pokus or 1))), 2)
    return {
        "alfa_min": max(0.10, num(k.get("alfa_min"), 0.0)),
        "naklad_pct": max(0.10, num(k.get("naklad_pct"), 0.0)),
        "t_min": round(max(t_podlaha, num(k.get("t_min"), 0.0)), 2),
        "n_min": int(max(200, num(k.get("n_min"), 0))),
        "roky_podil": max(0.75, min(1.0, num(k.get("roky_podil"), 0.0))),
        "holdout_od": HOLDOUT_OD,
        "holdout_n_min": int(max(30, num(k.get("holdout_n_min"), 0))),
        "pokus": int(pokus or 1),
    }


# ---------------------------------------------------------------- validace
def _slug(s: str) -> str:
    s = unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")[:60]


def validuj(spec: dict, dostupne_zdroje: set[str] | None = None) -> tuple[dict | None, list[str]]:
    """Vrátí (normalizovaná strategie, chyby). dostupne_zdroje: {"panel", "vysledky", "udalosti"} — co worker má."""
    ch: list[str] = []
    if not isinstance(spec, dict):
        return None, ["strategie musí být JSON objekt"]
    zdroje = dostupne_zdroje if dostupne_zdroje is not None else {"panel", "vysledky", "udalosti"}
    nazev = _slug(spec.get("nazev") or spec.get("name") or "")
    if len(nazev) < 3:
        ch.append("nazev: aspoň 3 znaky (písmena, čísla, pomlčky)")
    smer = spec.get("smer", "long")
    if smer not in ("long", "short"):
        ch.append("smer: long nebo short")
    vstup = spec.get("vstup", "open_D1")
    if vstup not in VSTUPY:
        ch.append(f"vstup: {' | '.join(VSTUPY)}")
    vy = spec.get("vystup") or {}
    if not isinstance(vy, dict):
        vy = {}
    dni, cena = vy.get("dni", 1), vy.get("cena", "close")
    if not isinstance(dni, int) or isinstance(dni, bool) or not (0 <= dni <= 20):
        ch.append("vystup.dni: celé číslo 0–20 (obchodních dní po vstupu)")
        dni = 1
    if cena not in ("open", "close"):
        ch.append("vystup.cena: open nebo close")
    if vstup == "close_D" and dni < 1:
        ch.append("vstup close_D: vystup.dni aspoň 1")
    if vstup == "open_D1" and dni == 0 and cena != "close":
        ch.append("vstup open_D1 s vystup.dni 0: výstup jen na close téhož dne")
    stop = spec.get("stop_pct")
    if stop is not None and (not isinstance(stop, (int, float)) or isinstance(stop, bool) or not (1 <= stop <= 50)):
        ch.append("stop_pct: null nebo číslo 1–50")
    filtry_out = []
    filtry = spec.get("filtry")
    if not isinstance(filtry, list) or not filtry:
        ch.append("filtry: aspoň jeden filtr (strategie „kup všechno“ se neměří)")
        filtry = []
    if len(filtry) > 15:
        ch.append("filtry: nejvýš 15")
    for i, f in enumerate(filtry[:15]):
        if not isinstance(f, dict):
            ch.append(f"filtry[{i}]: objekt"); continue
        if "udalost" in f or "bez_udalosti" in f:
            klic = "udalost" if "udalost" in f else "bez_udalosti"
            kat = str(f.get(klic) or "").upper()
            okno = f.get("okno", 5)
            if kat not in UDALOSTI:
                ch.append(f"filtry[{i}].{klic}: jedna z {', '.join(UDALOSTI)}")
            if not isinstance(okno, int) or isinstance(okno, bool) or not (1 <= okno <= 365):
                ch.append(f"filtry[{i}].okno: celé číslo 1–365 (obchodních dní zpět)")
            if "udalosti" not in zdroje:
                ch.append(f"filtry[{i}]: události EDGAR teď worker nemá (chybí kniha podání)")
            filtry_out.append({klic: kat, "okno": okno if isinstance(okno, int) else 5})
            continue
        pole, op, hod = f.get("pole"), f.get("op"), f.get("hodnota")
        if pole not in POLE:
            ch.append(f"filtry[{i}].pole „{pole}“ neznám — povolená: {', '.join(POLE)}"); continue
        if op not in OPERATORY:
            ch.append(f"filtry[{i}].op: {' '.join(OPERATORY)}"); continue
        typ, zdroj = POLE[pole][1], POLE[pole][2]
        if zdroj not in zdroje:
            ch.append(f"filtry[{i}]: pole {pole} potřebuje data „{zdroj}“, která worker teď nemá")
        if typ == "bool":
            if not isinstance(hod, bool) or op not in ("==", "!="):
                ch.append(f"filtry[{i}]: {pole} je ano/ne — op == nebo != a hodnota true/false"); continue
        elif not isinstance(hod, (int, float)) or isinstance(hod, bool):
            ch.append(f"filtry[{i}].hodnota: číslo"); continue
        filtry_out.append({"pole": pole, "op": op, "hodnota": hod})
    raz = spec.get("razeni") or {"pole": "objem_x", "smer": "desc"}
    if not isinstance(raz, dict) or raz.get("pole") not in POLE or POLE[raz.get("pole")][1] != "cislo" or raz.get("smer", "desc") not in ("desc", "asc"):
        ch.append("razeni: {\"pole\": číselné pole, \"smer\": \"desc\"|\"asc\"}")
        raz = {"pole": "objem_x", "smer": "desc"}
    md = spec.get("max_denne", 3)
    if not isinstance(md, int) or isinstance(md, bool) or not (1 <= md <= 10):
        ch.append("max_denne: celé číslo 1–10")
        md = 3
    ves = dict(VYCHOZI_VESMIR)
    for k2, v2 in (spec.get("vesmir") or {}).items():
        if k2 in ves and isinstance(v2, (int, float)) and not isinstance(v2, bool):
            ves[k2] = max(ves[k2], float(v2))      # vesmír jde jen zúžit
    norm = {"nazev": nazev, "popis": str(spec.get("popis") or "")[:500], "smer": smer, "vstup": vstup,
            "vystup": {"dni": dni, "cena": cena}, "stop_pct": stop, "filtry": filtry_out,
            "razeni": {"pole": raz["pole"], "smer": raz.get("smer", "desc")}, "max_denne": md, "vesmir": ves}
    return (None if ch else norm), ch


def potrebna_pole(spec: dict) -> set[str]:
    p = {f["pole"] for f in spec["filtry"] if "pole" in f}
    p.add(spec["razeni"]["pole"])
    p.update(("cena", "obrat_musd"))
    return p


def potrebne_zdroje(spec: dict) -> set[str]:
    z = {"panel"}
    for f in spec["filtry"]:
        if "pole" in f:
            z.add(POLE[f["pole"]][2])
        else:
            z.add("udalosti")
    z.add(POLE[spec["razeni"]["pole"]][2])
    return z


# ---------------------------------------------------------------- data
class Titul:
    """Svíčky jednoho titulu zarovnané na hlavní kalendář (index dne v Data.dny)."""
    __slots__ = ("t", "di", "o", "h", "l", "c", "v")

    def __init__(self, t, di, o, h, l, c, v):
        self.t, self.di, self.o, self.h, self.l, self.c, self.v = t, di, o, h, l, c, v


class Data:
    """Panel pro měření: hlavní kalendář (dny SPY), tituly, SPY, výsledky, události a jejich pokrytí."""

    def __init__(self, bary: dict[str, list[dict]], spy: list[dict], vysledky: dict[str, set] | None = None,
                 vysledky_do: str | None = None, udalosti: dict[str, dict[str, list[str]]] | None = None, udalosti_do: str | None = None):
        spy = sorted((b for b in spy if b.get("c")), key=lambda b: b["d"])
        self.dny: list[str] = [b["d"] for b in spy]
        self.ix: dict[str, int] = {d: i for i, d in enumerate(self.dny)}
        self.so = [float(b["o"]) for b in spy]; self.sh = [float(b["h"]) for b in spy]
        self.sl = [float(b["l"]) for b in spy]; self.sc = [float(b["c"]) for b in spy]
        self.tituly: dict[str, Titul] = {}
        for t, bb in bary.items():
            if t == "SPY":
                continue
            di, o, h, l, c, v = [], [], [], [], [], []
            for b in sorted(bb, key=lambda x: x["d"]):
                k = self.ix.get(b["d"])
                if k is None or not b.get("c") or b["c"] <= 0:
                    continue
                if di and di[-1] == k:
                    continue
                di.append(k); o.append(float(b.get("o") or b["c"])); h.append(float(b.get("h") or b["c"]))
                l.append(float(b.get("l") or b["c"])); c.append(float(b["c"])); v.append(float(b.get("v") or 0))
            if len(c) >= 25:
                self.tituly[t] = Titul(t, di, o, h, l, c, v)
        self.vysledky = vysledky
        self.vysledky_do = vysledky_do
        self.udalosti = udalosti
        self.udalosti_do = udalosti_do
        self._spy_pole: dict[str, list] = {}

    @property
    def od(self) -> str | None:
        return self.dny[0] if self.dny else None

    @property
    def do(self) -> str | None:
        return self.dny[-1] if self.dny else None

    def zdroje(self) -> set[str]:
        z = {"panel"} if self.dny else set()
        if self.vysledky is not None:
            z.add("vysledky")
        if self.udalosti is not None:
            z.add("udalosti")
        return z

    def pokryti(self, zdroj: str) -> str | None:
        return {"panel": self.do, "vysledky": self.vysledky_do, "udalosti": self.udalosti_do}.get(zdroj)

    def dalsi_den(self, d: str) -> str:
        k = self.ix.get(d)
        if k is not None and k + 1 < len(self.dny):
            return self.dny[k + 1]
        from datetime import date, timedelta
        x = date.fromisoformat(d) + timedelta(days=1)
        while x.weekday() >= 5:
            x += timedelta(days=1)
        return x.isoformat()

    def spy_pole(self, nazev: str) -> list:
        if nazev in self._spy_pole:
            return self._spy_pole[nazev]
        c, h, l = self.sc, self.sh, self.sl
        n = len(c)
        out: list = [None] * n
        if nazev == "spy_pohyb_pct":
            for i in range(1, n):
                out[i] = (c[i] / c[i - 1] - 1) * 100
        elif nazev == "spy_vynos_5d_pct":
            for i in range(5, n):
                out[i] = (c[i] / c[i - 5] - 1) * 100
        elif nazev == "spy_ma50_pct":
            s = 0.0
            for i in range(n):
                s += c[i]
                if i >= 50:
                    s -= c[i - 50]
                if i >= 49:
                    out[i] = (c[i] / (s / 50) - 1) * 100
        elif nazev == "spy_nad_vwap":
            for i in range(n):
                out[i] = c[i] > (h[i] + l[i] + c[i]) / 3
        self._spy_pole[nazev] = out
        return out


# ---------------------------------------------------------------- pole titulu
def _pole_titulu(data: Data, T: Titul, potreba: set[str]) -> dict[str, list]:
    o, h, l, c, v, di = T.o, T.h, T.l, T.c, T.v, T.di
    n = len(c)
    out: dict[str, list] = {}
    if "cena" in potreba:
        out["cena"] = c
    if "pohyb_pct" in potreba:
        out["pohyb_pct"] = [None] + [(c[i] / c[i - 1] - 1) * 100 for i in range(1, n)]
    if "gap_pct" in potreba:
        out["gap_pct"] = [None] + [(o[i] / c[i - 1] - 1) * 100 for i in range(1, n)]
    if "den_pct" in potreba:
        out["den_pct"] = [(c[i] / o[i] - 1) * 100 if o[i] > 0 else None for i in range(n)]
    if "rozsah_pct" in potreba:
        out["rozsah_pct"] = [(h[i] - l[i]) / c[i] * 100 for i in range(n)]
    if "objem_x" in potreba or "obrat_musd" in potreba:
        ox: list = [None] * n; ob: list = [None] * n
        sv = sdv = 0.0
        for i in range(n):
            if i >= 20:
                pv, pdv = sv / 20, sdv / 20
                ox[i] = v[i] / pv if pv > 0 else None
                ob[i] = pdv / 1e6
            sv += v[i]; sdv += c[i] * v[i]
            if i >= 20:
                sv -= v[i - 20]; sdv -= c[i - 20] * v[i - 20]
        out["objem_x"], out["obrat_musd"] = ox, ob
    for nm, k in (("vynos_5d_pct", 5), ("vynos_20d_pct", 20)):
        if nm in potreba:
            out[nm] = [None] * k + [(c[i] / c[i - k] - 1) * 100 for i in range(k, n)]
    for nm, k in (("ma20_pct", 20), ("ma50_pct", 50)):
        if nm in potreba:
            x: list = [None] * n; s = 0.0
            for i in range(n):
                s += c[i]
                if i >= k:
                    s -= c[i - k]
                if i >= k - 1:
                    x[i] = (c[i] / (s / k) - 1) * 100
            out[nm] = x
    if "od_max20_pct" in potreba:
        x = [None] * n; dq: deque = deque()
        for i in range(n):
            while dq and h[dq[-1]] <= h[i]:
                dq.pop()
            dq.append(i)
            if dq[0] <= i - 20:
                dq.popleft()
            if i >= 19:
                x[i] = (c[i] / h[dq[0]] - 1) * 100
        out["od_max20_pct"] = x
    if "atr14_pct" in potreba:
        x = [None] * n; s = 0.0; tr = [0.0] * n
        for i in range(1, n):
            tr[i] = max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
            s += tr[i]
            if i > 14:
                s -= tr[i - 14]
            if i >= 14:
                x[i] = s / 14 / c[i] * 100
        out["atr14_pct"] = x
    for nm in ("spy_pohyb_pct", "spy_ma50_pct", "spy_vynos_5d_pct", "spy_nad_vwap"):
        if nm in potreba:
            sp = data.spy_pole(nm)
            out[nm] = [sp[k] for k in di]
    vys = [p for p in ("vysledky_reakce", "vysledky_dnes_vecer", "vysledky_zitra_rano", "dni_od_vysledku") if p in potreba]
    if vys:
        E = (data.vysledky or {}).get(T.t, set())
        do = data.vysledky_do or ""
        dny = data.dny
        re_, dv, zr, dod = [None] * n, [None] * n, [None] * n, [None] * n
        posledni = None
        for i in range(n):
            d = dny[di[i]]
            pred = dny[di[i - 1]] if i else None
            reakce = (d, "B") in E or (pred is not None and (pred, "A") in E)
            if reakce:
                posledni = i
            if d > do:
                continue          # mimo pokrytí kalendáře výsledků → neznámo
            re_[i] = reakce
            dv[i] = (d, "A") in E
            zr[i] = (data.dalsi_den(d), "B") in E
            dod[i] = (i - posledni) if posledni is not None else 999
        out.update({"vysledky_reakce": re_, "vysledky_dnes_vecer": dv, "vysledky_zitra_rano": zr, "dni_od_vysledku": dod})
    return out


def _cmp(a, op: str, b) -> bool:
    if a is None:
        return False
    if op == ">": return a > b
    if op == ">=": return a >= b
    if op == "<": return a < b
    if op == "<=": return a <= b
    if op == "==": return a == b
    return a != b


def _udalost(data: Data, T: Titul, i: int, kat: str, okno: int, vstup: str) -> bool | None:
    """Byla v okně podaná událost kategorie kat? None = mimo pokrytí knihy (neznámo)."""
    d = data.dny[T.di[i]]
    if data.udalosti is None or not data.udalosti_do or d > data.udalosti_do:
        return None
    seznam = (data.udalosti.get(T.t) or {}).get(kat) or []
    if not seznam:
        return False
    lo = data.dny[T.di[max(0, i - okno)]]
    j = bisect.bisect_left(seznam, lo)
    if j >= len(seznam):
        return False
    f = seznam[j]
    return f < d if vstup == "close_D" else f <= d


# ---------------------------------------------------------------- signály a obchody
def kandidati(data: Data, spec: dict, od: str | None = None, do: str | None = None, tituly: list[str] | None = None) -> dict[str, list]:
    """{den: [(rank, ticker, i)]} — tituly, které ve dni prošly vesmírem a všemi filtry (před výběrem max_denne)."""
    potreba = potrebna_pole(spec)
    ves = spec["vesmir"]
    raz = spec["razeni"]["pole"]
    out: dict[str, list] = defaultdict(list)
    for t in (tituly or list(data.tituly)):
        T = data.tituly.get(t)
        if T is None:
            continue
        P = _pole_titulu(data, T, potreba)
        cena, obrat = P["cena"], P["obrat_musd"]
        for i in range(20, len(T.c)):
            d = data.dny[T.di[i]]
            if (od and d < od) or (do and d > do):
                continue
            if cena[i] < ves["cena_min"] or obrat[i] is None or obrat[i] < ves["obrat_musd_min"]:
                continue
            prosel = True
            for f in spec["filtry"]:
                if "pole" in f:
                    if not _cmp(P[f["pole"]][i], f["op"], f["hodnota"]):
                        prosel = False; break
                else:
                    kat = f.get("udalost") or f.get("bez_udalosti")
                    u = _udalost(data, T, i, kat, f["okno"], spec["vstup"])
                    if u is None or (u if "bez_udalosti" in f else not u):
                        prosel = False; break
            if prosel:
                out[d].append((P[raz][i], t, i))
    return out


def vyber(kand: dict[str, list], spec: dict) -> list[tuple[str, str, int]]:
    """Každý den nejvýš max_denne titulů podle řazení. Vrací [(den, ticker, i)]."""
    desc = spec["razeni"]["smer"] == "desc"
    out = []
    for d in sorted(kand):
        rr = sorted(kand[d], key=lambda x: (x[0] is None, -(x[0] or 0) if desc else (x[0] or 0), x[1]))
        out += [(d, t, i) for _, t, i in rr[:spec["max_denne"]]]
    return out


def obchod(data: Data, spec: dict, T: Titul, i: int, naklad: float) -> dict | None:
    """Jeden obchod ze signálu v baru i. None = výstup ještě nemá data (otevřený)."""
    o, h, l, c, di = T.o, T.h, T.l, T.c, T.di
    n = len(c)
    N, cena_v, s = spec["vystup"]["dni"], spec["vystup"]["cena"], spec["stop_pct"]
    short = spec["smer"] == "short"
    if spec["vstup"] == "close_D":
        e, vstup, typ_v = i, c[i], "close"
    else:
        e = i + 1
        if e >= n:
            return None
        vstup, typ_v = o[e], "open"
    x = e + N
    if x >= n or vstup <= 0:
        return None
    vystup, jak, xb = (o[x] if cena_v == "open" else c[x]), cena_v, x
    if s:
        stop = vstup * (1 + s / 100) if short else vstup * (1 - s / 100)
        for b in range(e + 1 if typ_v == "close" else e, x + 1):
            if b == x and cena_v == "open":
                break                                    # plánovaný výstup na otevření přijde dřív než stop v seanci
            if typ_v == "open" and b == e:               # den vstupu na otevření: jen seance po otevření
                if (not short and l[b] <= stop) or (short and h[b] >= stop):
                    vystup, jak, xb = stop, "stop", b
                    break
                continue
            if not short:
                if o[b] <= stop:
                    vystup, jak, xb = o[b], "stop (gap)", b; break
                if l[b] <= stop:
                    vystup, jak, xb = stop, "stop", b; break
            else:
                if o[b] >= stop:
                    vystup, jak, xb = o[b], "stop (gap)", b; break
                if h[b] >= stop:
                    vystup, jak, xb = stop, "stop", b; break
    r = (vstup - vystup) / vstup * 100 if short else (vystup / vstup - 1) * 100
    ke, kx = di[e], di[xb]
    s_in = data.sc[ke] if typ_v == "close" else data.so[ke]
    s_out = data.so[kx] if jak == "open" else data.sc[kx]
    rs = (s_out / s_in - 1) * 100 if s_in > 0 else 0.0
    alfa = r + rs if short else r - rs
    return {"t": T.t, "d": data.dny[di[i]], "vstup_den": data.dny[ke], "vystup_den": data.dny[kx], "vstup": round(vstup, 4),
            "vystup": round(vystup, 4), "jak": jak, "r": round(r, 4), "rs": round(rs, 4), "a": round(alfa - naklad, 4)}


def souhrn(tr: list[dict]) -> dict:
    if not tr:
        return {"n": 0, "dni": 0, "vynos": 0.0, "alfa": 0.0, "median": 0.0, "t": 0.0, "kladnych_pct": 0.0, "roky": {}}
    a = [x["a"] for x in tr]
    po_dnech: dict[str, list] = defaultdict(list)
    for x in tr:
        po_dnech[x["d"]].append(x["a"])
    xs = [sum(v) / len(v) for v in po_dnech.values()]
    t = 0.0
    if len(xs) >= 3:
        sd = statistics.stdev(xs)
        if sd > 0:
            t = statistics.fmean(xs) / (sd / math.sqrt(len(xs)))
    roky: dict[str, dict] = {}
    for y in sorted({x["d"][:4] for x in tr}):
        ay = [x["a"] for x in tr if x["d"][:4] == y]
        roky[y] = {"alfa": round(statistics.fmean(ay), 4), "n": len(ay)}
    return {"n": len(tr), "dni": len(xs), "vynos": round(statistics.fmean(x["r"] for x in tr), 4),
            "alfa": round(statistics.fmean(a), 4), "median": round(statistics.median(a), 4), "t": round(t, 2),
            "kladnych_pct": round(sum(1 for z in a if z > 0) / len(a) * 100, 1), "roky": roky}


def _kryti(data: Data, spec: dict) -> str | None:
    """Do kdy jsou data pro všechna pole strategie (pro stín a papír)."""
    pk = [data.pokryti(z) for z in potrebne_zdroje(spec)]
    if any(p is None for p in pk):
        return None
    return min(pk)


def mer(data: Data, spec: dict, kriterium: dict, registrovano: str) -> dict:
    """Backtest (vývoj + holdout do dne registrace) a stín (signály po dni registrace) jedním během."""
    reg_d = str(registrovano)[:10]
    naklad = kriterium["naklad_pct"]
    kryti = _kryti(data, spec)
    dev, hold, fwd, otevrene = [], [], [], 0
    for d, t, i in vyber(kandidati(data, spec, do=kryti), spec):
        tr = obchod(data, spec, data.tituly[t], i, naklad)
        if tr is None:
            if d > reg_d:
                otevrene += 1
            continue
        (dev if d < kriterium["holdout_od"] else hold if d <= reg_d else fwd).append(tr)
    S_dev, S_hold, S_fwd = souhrn(dev), souhrn(hold), souhrn(fwd)
    duvody = []
    if S_dev["n"] < kriterium["n_min"]:
        duvody.append(f"málo obchodů ve vývoji ({S_dev['n']} < {kriterium['n_min']})")
    if S_dev["alfa"] < kriterium["alfa_min"]:
        duvody.append(f"alfa po nákladech {S_dev['alfa']:+.3f} % < {kriterium['alfa_min']:.2f} %")
    if S_dev["t"] < kriterium["t_min"]:
        duvody.append(f"t po dnech {S_dev['t']:.2f} < {kriterium['t_min']:.2f} (pokus č. {kriterium.get('pokus', 1)})")
    roky = [v for v in S_dev["roky"].values() if v["n"] >= 20]
    podil = (sum(1 for v in roky if v["alfa"] > 0) / len(roky)) if roky else 0.0
    if podil < kriterium["roky_podil"]:
        duvody.append(f"kladná jen v {podil * 100:.0f} % let (potřeba {kriterium['roky_podil'] * 100:.0f} %)")
    if S_hold["n"] < kriterium["holdout_n_min"]:
        duvody.append(f"málo obchodů v holdoutu ({S_hold['n']} < {kriterium['holdout_n_min']})")
    elif S_hold["alfa"] <= 0:
        duvody.append(f"holdout nekladný ({S_hold['alfa']:+.3f} %)")
    return {"verdikt": "PROŠLO" if not duvody else "NEPROŠLO", "duvody": duvody, "kriterium": kriterium,
            "vyvoj": S_dev, "holdout": S_hold, "stin": {**S_fwd, "otevrenych": otevrene, "od": reg_d},
            "data": {"od": data.od, "do": data.do, "kryti": kryti, "titulu": len(data.tituly)},
            "poznamka": "Panel = dnešní tituly (přeživší) → backtest je horní odhad. Holdout se s každou verzí opotřebuje; rozhoduje stín."}


def stin(data: Data, spec: dict, naklad: float, registrovano: str) -> dict:
    """Jen dopředné obchody (signál po dni registrace) — denní dopočet stínu."""
    reg_d = str(registrovano)[:10]
    kryti = _kryti(data, spec)
    fwd, otevrene = [], 0
    for d, t, i in vyber(kandidati(data, spec, od=data.dalsi_den(reg_d), do=kryti), spec):
        tr = obchod(data, spec, data.tituly[t], i, naklad)
        if tr is None:
            otevrene += 1
        else:
            fwd.append(tr)
    return {**souhrn(fwd), "otevrenych": otevrene, "od": reg_d, "kryti": kryti, "obchody": fwd[-60:]}


def signaly_dne(data: Data, spec: dict, den: str) -> dict:
    """Co by strategie vzala v den signálu `den` (pro papír: nákup na otevření dalšího dne)."""
    kryti = _kryti(data, spec)
    if not kryti or den > kryti:
        return {"den": den, "signaly": [], "duvod": f"data pro pole strategie jsou jen do {kryti or '—'}"}
    vy = [x for x in vyber(kandidati(data, spec, od=den, do=den), spec) if x[0] == den]
    return {"den": den, "signaly": [{"t": t, "cena": round(data.tituly[t].c[i], 4)} for _, t, i in vy], "duvod": None}


def manifest(data: Data | None) -> dict:
    """Co worker umí — jde do plánování roje (ruce workeru)."""
    zd = data.zdroje() if data else set()
    return {
        "typy_jobu": {
            "backtest": "změří zapsanou strategii (parametry: strategie, kriterium) — vývoj do holdout_od, holdout do registrace, pak sám pokračuje stínem",
            "udalosti": "seznam podání EDGAR v období (parametry: kategorie, od, do, tickery?) — max 300 řádků",
            "erp_registrace": "výtah z registrací Earnings Radaru (co už bylo testováno) — jen když to vlastník u projektu povolil",
        },
        "strategie": {
            "tvar": {"nazev": "slovo-slovo", "smer": "long|short", "vstup": "|".join(VSTUPY), "vystup": {"dni": "0–20", "cena": "open|close"},
                     "stop_pct": "null|1–50", "filtry": [{"pole": "…", "op": " ".join(OPERATORY), "hodnota": "číslo|true|false"}, {"udalost": "B1", "okno": 10}, {"bez_udalosti": "A1", "okno": 7}],
                     "razeni": {"pole": "číselné pole", "smer": "desc|asc"}, "max_denne": "1–10", "vesmir": {"cena_min": 2, "obrat_musd_min": 1}},
            "vstupy": VSTUPY,
            "pole": {k: v[0] for k, v in POLE.items() if v[2] in zd} if data else {k: v[0] for k, v in POLE.items()},
            "udalosti": UDALOSTI if "udalosti" in zd or not data else {},
        },
        "kriterium_podlaha": {"alfa_min": 0.10, "naklad_pct": 0.10, "t_min": "2 + 0,25·log2(pokus)", "n_min": 200, "roky_podil": 0.75,
                              "holdout_od": HOLDOUT_OD, "holdout_n_min": 30},
        "data": {"od": data.od if data else None, "do": data.do if data else None, "titulu": len(data.tituly) if data else 0,
                 "vysledky_do": data.vysledky_do if data else None, "udalosti_do": data.udalosti_do if data else None},
        "omezeni": ["papír zatím jen long se vstupem open_D1 (vstup na close potřebuje živá data celého trhu)",
                    "guidance zatím není pole pro backtest (krátká historie dat) — výzkum guidance dělají ruce agentů",
                    "panel = dnešní tituly (přeživší)"],
    }
