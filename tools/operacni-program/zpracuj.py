#!/usr/bin/env python3
"""Operační program (Excel) -> koncepty informačních e-mailů pacientům, JPL Nemocnice Neratovice.

Nic neodesílá a nic neukládá. Vstup: cesta k .xlsx (sloupce DATUM, PŘÍJMENÍ JMÉNO, ROČNÍK,
DRUH OPERACE, ČAS, POJIŠŤOVNA, TELEFON, MAIL). Výstup: JSON na stdout.
Soubor neobsahuje žádná data pacientů – ta jsou jen ve vstupním Excelu.

Použití:  python3 -I zpracuj.py program.xlsx [--od RRRR-MM-DD]
          (--od: zpracuje jen výkony od tohoto data; výchozí = dnešek)
"""
import datetime as dt
import html
import json
import re
import sys
import unicodedata

import openpyxl

WEB = "https://pabloainet.github.io/AInet/souhlasy/"
VOLANI_ZAPNUTO = False  # až bude asistent volat, doplní se věta o hovoru

DEN = ["v pondělí", "v úterý", "ve středu", "ve čtvrtek", "v pátek", "v sobotu", "v neděli"]

POBYT_TYZ_DEN = "domů obvykle týž den asi 3–6 hodin po výkonu, jen s doprovodem; ten den neřiďte."
POBYT_VECER_RANO = "domů večer v den výkonu, nebo druhý den ráno; jen s doprovodem a ten den neřiďte."
POBYT_LONGO = "domů podle Vašeho stavu večer v den výkonu, nebo druhý den ráno; jen s doprovodem a ten den neřiďte."
POBYT_NOC = ("pobyt obvykle do druhého dne; domů ráno po převazu mezi 8:00 a 9:00, jen s doprovodem. "
             "Nadstandardní pokoj si můžete objednat u staniční sestry (1 000 Kč za den).")
POBYT_NEJASNE = ("domů obvykle týž den, podle výkonu a Vašeho stavu případně druhý den ráno; "
                 "jen s doprovodem a ten den neřiďte.")
POBYT_LA = "domů hned po výkonu."

# klíč: (pdf, název odkazu, klyzma, punčocha, pobyt, hradí pacient, místní znecitlivění)
PROFILY = {
    "zily-klasicky": (["zily-klasicky"], "operace křečových žil", False, True, POBYT_VECER_RANO, False, False),
    "zily-mala-safena": (["zily-mala-safena"], "operace křečových žil – malá safena", False, True, POBYT_VECER_RANO, False, False),
    "zily-evla": (["zily-evla"], "laserové uzavření žíly (EVLA)", False, True, POBYT_TYZ_DEN, True, False),
    "hemoroidy-lhp": (["hemoroidy-lhp"], "laserová hemoroidoplastika (LHP)", True, False, POBYT_TYZ_DEN, True, False),
    "hemoroidy-longo": (["hemoroidy-longo"], "operace hemoroidů podle Longa", True, False, POBYT_LONGO, False, False),
    "hemoroidy-nejasne": (["hemoroidy-lhp", "hemoroidy-longo"], None, True, False, POBYT_NEJASNE, False, False),
    "zlucnik": (["zlucnik"], "laparoskopické odstranění žlučníku", False, False, POBYT_NOC, False, False),
    "slepe-strevo": (["slepe-strevo"], "laparoskopické odstranění slepého střeva", False, False, POBYT_NOC, False, False),
    "kyla-tapp": (["kyla-tapp"], "laparoskopická operace kýly (TAPP)", False, False, POBYT_NOC, False, False),
    "kyla-trislo-otevrene": (["kyla-trislo-otevrene"], "operace tříselné kýly se síťkou", False, False, POBYT_TYZ_DEN, False, False),
    "kyla-pupecni": (["kyla-pupecni"], "operace pupeční kýly se síťkou", False, False, POBYT_TYZ_DEN, False, False),
    "kyla-v-jizve": (["kyla-v-jizve"], "laparoskopická operace kýly v jizvě", False, False, POBYT_NOC, False, False),
    "polyp-konecniku": (["polyp-konecniku"], "odstranění polypu řitního kanálu", True, False, POBYT_TYZ_DEN, False, False),
    "pistel-filac": (["pistel-filac"], "laserové uzavření řitní píštěle (FiLaC)", True, False, POBYT_TYZ_DEN, False, False),
    "pilonidalni-sinus": (["pilonidalni-sinus"], "laserové ošetření pilonidálního sinu", False, False, POBYT_TYZ_DEN, True, False),
    "kozni-utvar": (["kozni-utvar"], "odstranění kožního útvaru v místním znecitlivění", False, False, POBYT_LA, False, True),
}
NAZEV_PDF = {
    "hemoroidy-lhp": "laserová hemoroidoplastika (LHP)",
    "hemoroidy-longo": "operace podle Longa",
}


def bez_diakritiky(s):
    s = unicodedata.normalize("NFKD", s)
    return "".join(c for c in s if not unicodedata.combining(c)).lower()


def rozpoznej(text):
    """Vrátí (klíč profilu nebo None, poznámka)."""
    t = bez_diakritiky(text or "")
    tok = set(re.findall(r"[a-z]+", t))
    if "longo" in t and "lhp" in t:
        return "hemoroidy-nejasne", "metoda nerozhodnutá (Longo/LHP)"
    if "lhp" in t:
        return "hemoroidy-lhp", ""
    if "longo" in t:
        return "hemoroidy-longo", ""
    if "evla" in t:
        return "zily-evla", ""
    if "spj" in tok or "parva" in t or "mala safena" in t:
        return "zily-mala-safena", ""
    if "varic" in t or "stripping" in t:
        return "zily-klasicky", ""
    if "filac" in t or "fistul" in t or "pistel" in t:
        return "pistel-filac", ""
    if "silac" in t or "pilonid" in t:
        return "pilonidalni-sinus", ""
    if "polyp" in t:
        return "polyp-konecniku", ""
    if "chole" in t or "lchce" in t:
        return "zlucnik", ""
    if "append" in t or "lape" in tok:
        return "slepe-strevo", ""
    if "tapp" in tok:
        return "kyla-tapp", ""
    if "lichtenstein" in t:
        return "kyla-trislo-otevrene", ""
    if "cicatr" in t or "incis" in t or "ipom" in tok or "jizv" in t:
        return "kyla-v-jizve", ""
    if "humb" in t or "umbilic" in t or "pupec" in t:
        return "kyla-pupecni", ""
    if any(k in t for k in ("fibrom", "lipom", "aterom", "nevus", "naevus", "verruc", "cysta")):
        return "kozni-utvar", ""
    return None, "výkon nerozpoznán"


def datum_cz(d):
    return f"{d.day}. {d.month}. {d.year}"


def predoperacni_text():
    return ("předoperační vyšetření od praktického lékaře, ne starší než 3 týdny. Rozsah: do 40 let FW, KO, "
            "jaterní testy, glykémie, Quick, APTT, CRP a zhodnocení rizika; nad 40 let navíc EKG; nad 50 let "
            "navíc RTG plic, urea, kreatinin a ionty. Kdo se léčí s nemocí srdce, cév, ledvin nebo s cukrovkou, "
            "jde na vyšetření k internistovi nebo specialistovi")


def sestav(datum, klic):
    pdfs, nazev, klyzma, puncocha, pobyt, hradi, la = PROFILY[klic]
    den = DEN[datum.weekday()]
    pred = []
    if la:
        pred.append("jde o malý výkon v místním znecitlivění – klasické předoperační vyšetření není potřeba; "
                    "přijďte po lehké snídani")
        pred.append("léky na ředění krve (např. Warfarin) vysaďte jen po dohodě s praktickým lékařem")
    else:
        pred.append(predoperacni_text())
        pred.append("Anopyrin nebo Aspirin vysaďte 10 dní před výkonem po domluvě s lékařem; jiné léky na ředění "
                    "krve a léky na cukrovku proberte předem s lékařem; léky na tlak ráno užijte")
        if klyzma:
            pred.append("vyprázdnění konečníku: salinické klyzma (volně prodejné v lékárně) večer před výkonem "
                        "a ráno hodinu před výkonem")
        pred.append("6 hodin před příchodem nejezte a nepijte")
        pred.append("nejméně 3 týdny před výkonem byste neměl(a) prodělat žádnou akutní nemoc (např. virózu)")
    sebou = "zprávu z ambulance, seznam léků a alergií, občanský průkaz a kartu pojištěnce, léky na bolest předepsané předem"
    if not la:
        sebou = "předoperační vyšetření, " + sebou
    if puncocha:
        sebou += ", stehenní kompresní punčochu 2. kompresní třídy (nasadí se při propuštění místo obinadla) a volné kalhoty"

    if len(pdfs) == 1:
        odkazy_txt = f"Informace o výkonu (co obnáší, možné komplikace a režim po operaci): {WEB}{pdfs[0]}.pdf"
        odkazy_html = (f'<b>Informace o výkonu</b> (co obnáší, možné komplikace a režim po operaci): '
                       f'<a href="{WEB}{pdfs[0]}.pdf">{html.escape(nazev)} – PDF</a>')
        uvod_metoda = ""
    else:
        odkazy_txt = "Informace k oběma výkonům:\n" + "\n".join(f"– {NAZEV_PDF[p]}: {WEB}{p}.pdf" for p in pdfs)
        odkazy_html = "<b>Informace k oběma výkonům:</b> " + " · ".join(
            f'<a href="{WEB}{p}.pdf">{html.escape(NAZEV_PDF[p])} – PDF</a>' for p in pdfs)
        uvod_metoda = "Způsob výkonu (laserem, nebo podle Longa) ještě upřesníme. "

    radky = [
        "Dobrý den,",
        "",
        f"jsem AI asistent MUDr. Pavla Ditla a posílám Vám informace k plánovanému výkonu {den} {datum_cz(datum)} "
        "na oddělení jednodenní péče Nemocnice Neratovice.",
        "",
        "Kam: Nemocnice Neratovice, Alšova 462, oddělení jednodenní péče ve 2. podlaží – výtahem hned vlevo za "
        "vrátnicí. Parkovat můžete v ulici Alšova nebo J. Š. Baara.",
        "Kdy: přesný čas příchodu Vám ještě sdělíme, příjem bývá kolem 8:00.",
        "",
        "Před výkonem:",
    ] + [f"– {p};" if i < len(pred) - 1 else f"– {p}." for i, p in enumerate(pred)] + [
        "",
        f"S sebou: {sebou}.",
        "",
        f"Po výkonu: {pobyt} O neschopenku si řekněte při příjmu – vystavit ji lze jen v den výkonu.",
    ]
    if hradi:
        radky += ["", "Výkon není hrazen z veřejného zdravotního pojištění; cenu Vám sdělí lékař předem."]
    radky += [
        "",
        "Pokud onemocníte nebo nebudete moci přijít, dejte nám vědět. Méně než 48 hodin předem volejte přímo "
        "oddělení jednodenní péče: 273 139 661.",
        "",
        uvod_metoda + odkazy_txt,
        "Souhlas s výkonem stvrzujete podpisem u lékaře. Na otázky Vám odpoví MUDr. Ditl – stačí odpovědět na tento e-mail.",
        "",
        "S pozdravem",
        "AI asistent MUDr. Pavla Ditla",
        "chirurgie ORTHOMED, Nemocnice Neratovice",
    ]
    body = "\n".join(radky)

    e = html.escape
    h = [
        "<p>Dobrý den,</p>",
        f"<p>jsem AI asistent MUDr. Pavla Ditla a posílám Vám informace k plánovanému výkonu "
        f"<b>{e(den)} {e(datum_cz(datum))}</b> na oddělení jednodenní péče Nemocnice Neratovice.</p>",
        "<p><b>Kam:</b> Nemocnice Neratovice, Alšova 462, oddělení jednodenní péče ve 2. podlaží – výtahem hned "
        "vlevo za vrátnicí. Parkovat můžete v ulici Alšova nebo J. Š. Baara.<br><b>Kdy:</b> přesný čas příchodu "
        "Vám ještě sdělíme, příjem bývá kolem 8:00.</p>",
        "<p><b>Před výkonem:</b></p><ul>" + "".join(f"<li>{e(p)}</li>" for p in pred) + "</ul>",
        f"<p><b>S sebou:</b> {e(sebou)}.</p>",
        f"<p><b>Po výkonu:</b> {e(pobyt)} O neschopenku si řekněte při příjmu – vystavit ji lze jen v den výkonu.</p>",
    ]
    if hradi:
        h.append("<p>Výkon není hrazen z veřejného zdravotního pojištění; cenu Vám sdělí lékař předem.</p>")
    h += [
        "<p>Pokud onemocníte nebo nebudete moci přijít, dejte nám vědět. Méně než 48 hodin předem volejte přímo "
        "oddělení jednodenní péče: 273 139 661.</p>",
        f"<p>{e(uvod_metoda)}{odkazy_html}.<br>Souhlas s výkonem stvrzujete podpisem u lékaře. Na otázky Vám "
        "odpoví MUDr. Ditl – stačí odpovědět na tento e-mail.</p>",
        "<p>S pozdravem<br>AI asistent MUDr. Pavla Ditla<br>chirurgie ORTHOMED, Nemocnice Neratovice</p>",
    ]
    return body, "".join(h)


EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[a-z]{2,}$", re.I)


def nacti(cesta, od):
    wb = openpyxl.load_workbook(cesta, data_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    hlav = [bez_diakritiky(str(c or "")).strip() for c in rows[0]]

    def sl(*nazvy):
        for i, h in enumerate(hlav):
            if any(n in h for n in nazvy):
                return i
        return None

    i_dat, i_jm, i_roc, i_vyk = sl("datum"), sl("prijmeni", "jmeno"), sl("rocnik"), sl("druh", "operace")
    i_cas, i_tel, i_mail = sl("cas"), sl("telefon", "tel"), sl("mail")
    vysledek, preskoceno = [], 0
    for n, r in enumerate(rows[1:], start=2):
        d = r[i_dat] if i_dat is not None else None
        if isinstance(d, dt.datetime):
            d = d.date()
        if not isinstance(d, dt.date):
            continue  # nadpis měsíce, prázdný řádek
        if d < od:
            preskoceno += 1
            continue
        jm = str(r[i_jm] or "").strip()
        roc = str(r[i_roc] or "").strip()
        vyk = str(r[i_vyk] or "").strip()
        tel = re.sub(r"\D", "", str(r[i_tel] or "")) if i_tel is not None else ""
        mail = str(r[i_mail] or "").strip() if i_mail is not None else ""
        klic, pozn = rozpoznej(vyk)
        problemy = []
        if pozn:
            problemy.append(pozn)
        if "?" in vyk and klic != "hemoroidy-nejasne":
            problemy.append("výkon s otazníkem")
        if not mail:
            problemy.append("chybí e-mail")
        elif not EMAIL_RE.match(mail):
            problemy.append("neplatný e-mail")
        if len(tel) < 9:
            problemy.append("chybí telefon")
        if not roc.isdigit():
            problemy.append("chybí ročník")
        p = {"radek": n, "datum": d.isoformat(), "jmeno": jm, "rocnik": roc, "vykon": vyk,
             "delka": str(r[i_cas]) if i_cas is not None and r[i_cas] is not None else "",
             "telefon": tel, "email": mail, "profil": klic, "problemy": problemy}
        if klic and mail and EMAIL_RE.match(mail) and "výkon s otazníkem" not in problemy:
            body, h = sestav(d, klic)
            p["koncept"] = {"to": mail, "subject": f"Plánovaný výkon {datum_cz(d)} – Nemocnice Neratovice",
                            "body": body, "htmlBody": h}
        vysledek.append(p)
    return {"pacienti": vysledek, "preskoceno_minule": preskoceno}


if __name__ == "__main__":
    args = sys.argv[1:]
    od = dt.date.today()
    if "--od" in args:
        od = dt.date.fromisoformat(args[args.index("--od") + 1])
    print(json.dumps(nacti(args[0], od), ensure_ascii=False, indent=1))
