// Toetst het lezen van maxspeed en maxspeed:conditional. node test/limiet.mjs
import fs from "node:fs";
import vm from "node:vm";
const site = new URL("../site/", import.meta.url);
const window = {}; window.window = window;
const ctx = vm.createContext({ window, Math, Date, JSON, Intl });
for (const f of ["js/geo.js", "js/kaart.js"]) vm.runInContext(fs.readFileSync(new URL(f, site), "utf8"), ctx);
const K = window.Kaart;
let fout = 0;
const is = (naam, a, b) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) fout++; console.log(ok ? "ok  " : "FOUT", naam, JSON.stringify(a)); };
const di = new Date("2026-10-27T11:00:00+01:00"), avond = new Date("2026-10-27T21:00:00+01:00"), za = new Date("2026-10-31T08:00:00+01:00"), ochtend = new Date("2026-10-27T08:00:00+01:00");
is("80", K._leesMax("80"), { v: 80 });
is("50 mph", K._leesMax("50 mph"), { v: 80 });
is("NL:urban", K._leesMax("NL:urban"), { v: 50, impliciet: true });
is("signals", K._leesMax("signals"), { v: null, variabel: true });
is("onzin", K._leesMax("none"), null);
is("A4 overdag 100", K._metVoorwaarde({ v: 100 }, "130 @ (19:00-06:00)", di).v, 100);
is("A4 avond 130", K._metVoorwaarde({ v: 100 }, "130 @ (19:00-06:00)", avond).v, 130);
is("Mo-Fr spits di 08:00", K._metVoorwaarde({ v: 80 }, "100 @ (Mo-Fr 06:00-10:00,15:00-19:00)", ochtend).v, 100);
is("Mo-Fr spits za", K._metVoorwaarde({ v: 80 }, "100 @ (Mo-Fr 06:00-10:00,15:00-19:00)", za).v, 80);
// Tekst tussen aanhalingstekens telt niet mee: dag en tijd gelden wel.
const spits = '100 @ Mo-Fr 06:00-10:00,15:00-19:00 "bij grote verkeersdrukte"';
is("vrije tekst: di 08:00 wel", K._metVoorwaarde({ v: 80 }, spits, ochtend).v, 100);
is("vrije tekst: di 11:00 niet", K._metVoorwaarde({ v: 80 }, spits, di).v, 80);
is("vrije tekst: za 08:00 niet", K._metVoorwaarde({ v: 80 }, spits, za).v, 80);
is("vrije tekst: zo 17:00 niet", K._metVoorwaarde({ v: 80 }, spits, new Date("2026-11-01T17:00:00+01:00")).v, 80);
is("vrije tekst: vr 17:00 wel", K._metVoorwaarde({ v: 80 }, spits, new Date("2026-10-30T17:00:00+01:00")).v, 100);
// Dagen: lijsten, bereiken over het weekend, meer regels, PH en SH.
const wo12 = new Date("2026-10-28T12:10:00+01:00"), di15 = new Date("2026-10-27T15:30:00+01:00");
is("Mo,Tu ma-di wel", K._metVoorwaarde({ v: 50 }, "30 @ (Mo,Tu 15:20-15:55)", di15).v, 30);
is("Mo,Tu wo niet", K._metVoorwaarde({ v: 50 }, "30 @ (Mo,Tu 15:20-15:55)", new Date("2026-10-28T15:30:00+01:00")).v, 50);
is("Fr-Mo za wel", K._metVoorwaarde({ v: 50 }, "30 @ (Fr-Mo 08:00-09:00)", za).v, 30);
is("Fr-Mo di niet", K._metVoorwaarde({ v: 50 }, "30 @ (Fr-Mo 08:00-09:00)", ochtend).v, 50);
is("meer regels: wo 12:10", K._metVoorwaarde({ v: 50 }, "30 @ (Mo-Fr 08:20-08:35, Mo,Tu 15:20-15:55, We 11:20-12:30; PH off; SH off)", wo12).v, 30);
is("meer regels: di 12:10 niet", K._metVoorwaarde({ v: 50 }, "30 @ (Mo-Fr 08:20-08:35, Mo,Tu 15:20-15:55, We 11:20-12:30; PH off; SH off)", new Date("2026-10-27T12:10:00+01:00")).v, 50);
is("vervolg zonder @", K._metVoorwaarde({ v: 50 }, "5 @ Mo-Fr 08:10-08:40,15:20-15:50; We 08:10-08:40,11:55-12:25", wo12).v, 5);
is("alleen dagen: za", K._metVoorwaarde({ v: 30 }, "30 @ flashing; 50 @ (Sa,Su,PH,SH)", za).v, 50);
is("alleen dagen: di niet", K._metVoorwaarde({ v: 30 }, "30 @ flashing; 50 @ (Sa,Su,PH,SH)", di).v, 30);
is("alleen SH telt niet", K._metVoorwaarde({ v: 30 }, "50 @ (SH)", di).v, 30);
is("Sa off", K._metVoorwaarde({ v: 50 }, "30 @ (08:00-09:00; Sa off)", za).v, 50);
is("spaties rond streepje", K._metVoorwaarde({ v: 50 }, "30 @ (Mo-Fr 07:50-08:45,11:00 - 13:00, 14:50 - 16:00; ", wo12).v, 30);
is("maanden: onbekend, basis", K._metVoorwaarde({ v: 90 }, "70 @ (Apr 1-Oct 31)", di).v, 90);
is("wet niet", K._metVoorwaarde({ v: 130 }, "100 @ wet", di).v, 130);
// Tijdzone: de voorwaarde volgt de tijd in Europe/Amsterdam, niet de klok van het toestel.
// 18:30 UTC is 19:30 in Amsterdam (wintertijd): al 130, ook als het toestel op UTC of New York staat.
is("zone standaard Amsterdam", K.zone(), "Europe/Amsterdam");
is("19:30 Amsterdam is 130", K._metVoorwaarde({ v: 100 }, "130 @ (19:00-06:00)", new Date("2026-10-26T18:30:00Z")).v, 130);
is("18:30 Amsterdam is 100", K._metVoorwaarde({ v: 100 }, "130 @ (19:00-06:00)", new Date("2026-10-26T17:30:00Z")).v, 100);
is("05:30 Amsterdam zomertijd is 130", K._metVoorwaarde({ v: 100 }, "130 @ (19:00-06:00)", new Date("2026-07-01T03:30:00Z")).v, 130);
is("06:30 Amsterdam zomertijd is 100", K._metVoorwaarde({ v: 100 }, "130 @ (19:00-06:00)", new Date("2026-07-01T04:30:00Z")).v, 100);
// Dag van de week in Amsterdam: vrijdag 23:30 UTC is zaterdag 00:30 in Amsterdam.
is("za 00:30 Amsterdam geen Mo-Fr", K._metVoorwaarde({ v: 80 }, "100 @ (Mo-Fr 00:00-10:00)", new Date("2026-10-30T23:30:00Z")).v, 80);
is("vr 23:30 Amsterdam wel Mo-Fr", K._metVoorwaarde({ v: 80 }, "100 @ (Mo-Fr 23:00-24:00)", new Date("2026-10-30T22:30:00Z")).v, 100);
K.zetZone("Europe/Brussels");
is("zone Brussel", K.zone(), "Europe/Brussels");
is("19:30 Brussel is 130", K._metVoorwaarde({ v: 100 }, "130 @ (19:00-06:00)", new Date("2026-10-26T18:30:00Z")).v, 130);
K.zetZone("Europe/Amsterdam");
// A12 Zoetermeer richting Den Haag (27 okt 2026, 17:20): de trajectcontrole in de echte data heeft
// 100 en "130 @ (19:00-06:00)". De voorwaarde zelf klopt; de 130 kwam uit een begin op een andere
// tijd. Alleen als de data gebouwd is (site/data/ staat niet in de repo).
const flBestand = new URL("data/flitsers.json", site);
const fl = fs.existsSync(flBestand) ? JSON.parse(fs.readFileSync(flBestand, "utf8")) : null;
const a12z = fl && fl.t.find((t) => Math.abs(t.a[0] - 52.05041) < 1e-4 && Math.abs(t.a[1] - 4.44402) < 1e-4);
if (a12z) {
  is("A12 Zoetermeer-traject in de data", [a12z.m, a12z.mc, a12z.km], [100, "130 @ (19:00-06:00)", 2.4]);
  is("A12 traject 17:20 is 100", K._metVoorwaarde({ v: a12z.m }, a12z.mc, new Date("2026-10-27T17:20:00+01:00")).v, 100);
  is("A12 traject 18:59 is 100", K._metVoorwaarde({ v: a12z.m }, a12z.mc, new Date("2026-10-27T18:59:00+01:00")).v, 100);
  is("A12 traject 19:00 is 130", K._metVoorwaarde({ v: a12z.m }, a12z.mc, new Date("2026-10-27T19:00:00+01:00")).v, 130);
  is("A12 traject 05:59 is 130", K._metVoorwaarde({ v: a12z.m }, a12z.mc, new Date("2026-10-27T05:59:00+01:00")).v, 130);
} else console.log("--   A12 met echte data overgeslagen (site/data/flitsers.json nog niet gebouwd)");
console.log(fout ? `${fout} fout` : "alles goed");
process.exit(fout ? 1 : 0);
