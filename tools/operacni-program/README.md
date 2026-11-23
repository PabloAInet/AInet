# Operační program → informační e-maily pacientům (JPL Neratovice)

`zpracuj.py` načte operační program v Excelu (sloupce DATUM, PŘÍJMENÍ JMÉNO, ROČNÍK, DRUH OPERACE,
ČAS, POJIŠŤOVNA, TELEFON, MAIL) a vrátí JSON s pacienty, problémy k doplnění a texty
informačních e-mailů podle výkonu (příprava, klyzma, punčocha, pobyt, úhrada, odkaz na PDF k výkonu).

- Nic neodesílá a nic neukládá; e-maily jako koncepty zakládá týdenní naplánovaná úloha, odesílá je lékař.
- Program přichází na `ditl6904+program@gmail.com` (štítek Gmailu „Operační program“),
  kopie se ukládá do soukromé složky na Disku „Operační program – soukromé“.
- **Data pacientů do tohoto repozitáře nikdy nepatří** – žádné .xlsx, .json ani výstupy.

Použití: `python3 -I zpracuj.py program.xlsx [--od RRRR-MM-DD]`
