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
is("vrije tekst niet", K._metVoorwaarde({ v: 80 }, '100 @ Mo-Fr 06:00-10:00,15:00-19:00 "bij grote verkeersdrukte"', ochtend).v, 80);
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
console.log(fout ? `${fout} fout` : "alles goed");
process.exit(fout ? 1 : 0);
