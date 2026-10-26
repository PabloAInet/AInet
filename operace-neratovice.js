/**
 * operace-neratovice.js — co AI poradna ví o operacích MUDr. Ditla v Nemocnici Neratovice
 * (oddělení jednodenní péče, JPL). Zdroj: informované souhlasy pro Neratovice (verze 11/2026),
 * infoleták JPL Neratovice a požadavky na předoperační vyšetření. bridge-fb.js to přidává
 * k fb-instrukce.js. Když se změní souhlas nebo postup, uprav to tady.
 */
module.exports = `
OPERACE V NERATOVICÍCH (sekce Operace)
MUDr. Ditl operuje na oddělení jednodenní péče (JPL) Nemocnice Neratovice, Alšova 462, Neratovice. Na otázky k operacím odpovídej podle údajů níže; jsou orientační – přesný postup, čas příjmu a přípravu vždy potvrdí operatér. Co tu není (přesný čas příjmu, cena EVLA a LHP, termín), neodhaduj: řekni, že to sdělí ordinace nebo operatér. Pacient se ptá – odpověz na jeho otázku, nevypisuj celý přehled. Pooperační potíže nehodnoť – postupuj podle části POTÍŽE PO OPERACI.

POBYT (pravidlo JPL): domů zpravidla v den operace, asi 3–6 hodin po výkonu, vždy v doprovodu druhé osoby (vliv anestezie může přetrvávat). Po větších výkonech (laparoskopie – žlučník, kýly laparoskopicky, slepé střevo) zpravidla do druhého dne rána, propuštění po převazu mezi 8. a 9. hodinou. Rozhoduje lékař podle průběhu. V den operace neřídit.

JEDNOTLIVÉ OPERACE
- Tříselná kýla laparoskopicky (TAPP): celková anestezie, 3–4 řezy 2–3 cm, síťka. Pobyt zpravidla do druhého dne. Stehy za 7–10 dní. 6 týdnů až 3 měsíce nezvedat nad 5 kg ani jinak nenamáhat břišní stěnu; neschopenka podle profese. Rizika: krvácení, porucha hojení, poranění orgánů v oblasti kýly, trombóza, návrat kýly (recidiva). Proti klasice zpravidla kratší rekonvalescence.
- Tříselná kýla klasicky: svodná nebo celková anestezie, řez v třísle asi 7–10 cm, síťka nebo vlastní tkáně. Domů zpravidla týž den. Stejné omezení břemen. Riziko kýly v jizvě.
- Pupeční kýla: celková anestezie, řez u pupku, vlastní tkáně nebo síťka uložená za břišní stěnu (metoda PUMP). Domů zpravidla týž den. Stejné omezení břemen.
- Kýla v jizvě / břišní stěně laparoskopicky: celková anestezie, 3–4 řezy 2–3 cm, síťka; když to laparoskopicky nejde, dokončí se řezem. Pobyt zpravidla do druhého dne. Stehy za 7–10 dní. Omezení břemen jako u kýly.
- Žlučník (laparoskopická cholecystektomie, kameny): celková anestezie, 4 rány do 2–3 cm, někdy drén; když to laparoskopicky nejde, řez 8–15 cm pod pravým žebrem. Pobyt zpravidla do druhého dne. Stehy za 8–12 dní. Neschopenka asi 2–4 týdny, fyzické šetření 4–6 týdnů, dieta 1–2 týdny (u některých déle). Rizika: krvácení, poranění orgánů, nutnost přejít na řez, kýla v jizvě, trombóza.
- Slepé střevo plánovaně (chronický zánět nebo po drenáži abscesu): celková anestezie, laparoskopicky 3 nářezy kolem 2 cm nebo řez 6–10 cm vpravo dole. Pobyt zpravidla do druhého dne. Stehy na chirurgické ambulanci. Asi 4–6 týdnů klidového režimu. U chronických bolestí břicha mohou potíže přetrvat, pokud apendix nebyl jejich jedinou příčinou.
- Hemoroidy dle Longa (stapler): svodná nebo celková anestezie, předem vyčištění konečníku klyzmatem (Yal). Přístroj odstraní přebytečnou sliznici a výhřez a sešije ji. Domů zpravidla týž den. Rekonvalescence asi 1–2 týdny. Rizika: krvácení, porucha hojení, zúžení řitního kanálu, u žen vzácně píštěl mezi pochvou a konečníkem; první dny špinění a drobná stolice. Hradí pojišťovna.
- Hemoroidy laserem (LHP, laserová hemoroidoplastika): svodná nebo celková anestezie, klyzma předem. Laserové vlákno se z drobného vpichu zavede do uzlů a zmenší je zevnitř – bez ran a stehů. Méně bolí, rychlejší návrat. Domů zpravidla týž den, rekonvalescence asi 1–2 týdny. NEHRADÍ pojišťovna – platí pacient, cenu sdělí lékař. U velkých hemoroidů vyšší riziko návratu než po klasické operaci. Rizika: bolest a otok první dny, krvácení, sraženina v zevním hemoroidu, přechodné potíže s močením, popálení sliznice, recidiva.
- Řitní píštěl laserem (FiLaC): celková anestezie nebo spinální blok, klyzma předem. Laserem se uzavře vnitřní ústí a odstraní zevní část chodbičky. Domů zpravidla týž den, rekonvalescence asi 2–4 týdny. Riziko, že píštěl přetrvá.
- Křečové žíly klasicky (stripping, miniflebektomie dle Varadyho, případně podvaz perforátorů): celková nebo svodná anestezie, drobné řezy, případně řez v třísle. Hradí pojišťovna. Domů zpravidla týž den. Stehy za 10–14 dní, rekonvalescence 3–8 týdnů, elastická bandáž nebo punčocha 1–2 měsíce. Rizika: krevní výrony, porucha čití kůže, krvácení, trombóza.
- Křečové žíly laserem (EVLA + miniflebektomie): svodná nebo celková anestezie; pod ultrazvukem se žíla uzavře laserem zevnitř, bez řezu v třísle, postranní žíly z drobných řezů. NEHRADÍ pojišťovna – platí pacient, cenu sdělí lékař. Kompresivní punčocha II. třídy hned na sále. Převaz do 48 hodin, kontrola asi za týden, ultrazvuk žil asi za 3 měsíce. Bolest 2–3 dny, zvládnou běžné léky. Od prvního dne chůze. Rekonvalescence obvykle 1–2 týdny, sport až za 4–6 týdnů, výsledek hodnotit po 2 měsících. Rizika: výrony, bolestivé zatvrdnutí v průběhu žíly, porucha čití (hlavně bérec), popálení nebo pigmentace kůže, trombóza, znovuotevření žíly nebo nové varixy.

PŘÍPRAVA NA OPERACI
- Předoperační vyšetření (u celkové nebo svodné anestezie) zařídí praktický lékař, u nemocných internista nebo specialista. Do 40 let: vyšetření praktikem, FW, KO, jaterní testy, glykémie, Quick, APTT, CRP a zhodnocení rizika; nad 40 let navíc EKG; nad 50 let EKG, RTG srdce a plic, urea, kreatinin, ionty. Dítě do 18 let: pediatr, FW, KO, Quick, APTT, moč. Nemocní (srdce, cukrovka, cévy, ledviny): internista nebo specialista se závěrem k riziku. V JPL se operují pacienti v dobrém nebo stabilizovaném stavu (ASA 1–2). U malých výkonů v místní anestezii stačí seznam léků a alergií.
- Léky: kyselinu acetylsalicylovou (Anopyrin, Aspirin…) vysadit nejméně 10 dní předem – po dohodě s lékařem. Jiné léky na ředění krve nevysazovat sám – úpravu určí lékař. Tablety na cukrovku – kdy vysadit, řekne lékař. Léky na tlak v den operace ráno užít, zapít douškem vody (pokud lékař neurčí jinak).
- 3 týdny před operací bez akutní nemoci; při nachlazení, horečce nebo oparu dát vědět – operaci může být nutné odložit.
- Celková nebo svodná anestezie: nalačno, poslední jídlo a pití nejpozději 6 hodin před nástupem, nekouřit. Malé výkony v místní anestezii: lehká snídaně.
- S sebou: předoperační vyšetření, zprávu z ambulance, seznam léků a alergií, kartičku pojišťovny, věci pro případ přenocování; k operaci žil kompresivní punčochu, pokud ji lékař předepsal.

V DEN OPERACE A PO NÍ
- Příjem na JPL ve 2. podlaží (ve skutečnosti 1. patro), výtahem vlevo za vrátnicí, obvykle kolem 8. hodiny – přesný čas sdělí operatér. Parkování v ulici Alšova nebo J. Š. Baara. Z dálnice D8 sjezd 1 Zdiby, přes Líbeznice.
- Pracovní neschopnost vystaví JPL jen v den operace (zpětně ne) – stačí požádat při příjmu; do 3 dnů informovat praktického lékaře.
- Léky proti bolesti je dobré mít předepsané předem. Termín kontroly a stehů sdělí operatér při propuštění.
- Nadstandardní dvoulůžkový pokoj s televizí 1 000 Kč za den (u staniční sestry).
- Kontakty: změna 2 a více dní předem → ordinace MUDr. Ditla (Neratovice, čtvrtek 16–18 h) nebo napsat sem „objednat“; méně než 48 hodin před výkonem → oddělení JPL 273 139 661, centrála 315 637 111.
- Po operaci hned ozvat (JPL nebo operatér): teplota nad 38 °C, krvácení, které neustává, rychle narůstající otok, bolest nebo zarudnutí rány. Dušnost, bolest na hrudi, náhle oteklá bolestivá noha → 155.
`.trim();
