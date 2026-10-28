// In de Tesla, 28 okt 2026: het gemiddelde in een trajectcontrole klopte niet,
// en de stem herhaalde zich ("500 m, 500 m, 500 m" en telkens opnieuw "trajectcontrole begint").
// Oorzaak: de app rekende met pos.timestamp, en een tijd die even terugliep maakte de meting
// ongeldig; dan begon hetzelfde traject opnieuw, met de aankondiging en een gemiddelde vanaf nul.
// Hier de A12 bij Zoetermeer (sim/a12-zn.json, echte trajectdata) met GPS zoals in de auto:
// tijden die heen en weer springen, twee klokken door elkaar, herhaalde coordinaten, ruis opzij,
// sprongen, stiltes zonder posities, rond de drempels heen en weer, herladen en twee tabbladen.
// node test/ruis.mjs
import fs from "node:fs";
import vm from "node:vm";
const site = new URL("../site/", import.meta.url);
const route = JSON.parse(fs.readFileSync(new URL("sim/a12-zn.json", site))).route;
const n209 = JSON.parse(fs.readFileSync(new URL("sim/n209.json", site))).route;

/** Een opslag zoals localStorage, te delen tussen "tabbladen" en "herladen". */
function nieuweOpslag() { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; }
function nieuweApp(opslag) {
  const zin = [];
  const window = { Geluid: { getal: (n) => (n >= 30 && n <= 140 ? "n" + Math.round(n) : null) } };
  window.window = window;
  if (opslag) window.localStorage = opslag;
  const ctx = vm.createContext({ window, globalThis: window, Math, Date, JSON, Intl, fetch: async (p) => ({ ok: true, json: async () => JSON.parse(fs.readFileSync(new URL(p, site))) }), console });
  for (const f of ["js/geo.js", "js/kaart.js", "js/flitsers.js"]) vm.runInContext(fs.readFileSync(new URL(f, site), "utf8"), ctx, { filename: f });
  window.Flitsers.opZeg((d) => zin.push(d.join("+")));
  if (opslag && window.Flitsers.bewaarGezegd) window.Flitsers.bewaarGezegd(true);
  return { F: window.Flitsers, G: window.Geo, zin };
}
const { G } = nieuweApp();
function maakRoute(r) {
  const L = [0];
  for (let i = 1; i < r.length; i++) L.push(L[i - 1] + G.afstand(r[i - 1][0], r[i - 1][1], r[i][0], r[i][1]));
  return (m) => {
    let k = 1; while (k < L.length - 1 && L[k] < m) k++;
    const a = r[k - 1], b = r[k], f = Math.max(0, Math.min(1, (m - L[k - 1]) / (L[k] - L[k - 1])));
    return { lat: a[0] + (b[0] - a[0]) * f, lon: a[1] + (b[1] - a[1]) * f, koers: G.peiling(a[0], a[1], b[0], b[1]) };
  };
}
const punt = maakRoute(route);
let mA = 0, best = Infinity;
for (let m = 0; m < 6000; m += 1) { const p = punt(m); const d = G.afstand(p.lat, p.lon, 52.05041, 4.44402); if (d < best) { best = d; mA = m; } }

let zaad = 1;
const toeval = () => { zaad = (zaad * 16807) % 2147483647; return zaad / 2147483647; };
/** Verschuif een punt opzij (meter, haaks op de koers) en vooruit. */
function schuif(p, opzij, vooruit) {
  const r = (p.koers * Math.PI) / 180;
  const dn = vooruit * Math.cos(r) - opzij * Math.sin(r), de = vooruit * Math.sin(r) + opzij * Math.cos(r);
  return { ...p, lat: p.lat + dn / 110540, lon: p.lon + de / (111320 * Math.cos((p.lat * Math.PI) / 180)) };
}
/**
 * Een rit met tien posities per seconde. snelheid(m, sec): km/h. Opties: tijd(t): de tijd die de app
 * krijgt; vastS: dezelfde coordinaten tot zoveel s; opzij: ruis in m; sprong: kans per positie op
 * een sprong van 40 m; stilte: [van, tot] in s zonder posities; koersRuis in graden.
 * Geeft per positie { m (vanaf het begin van het traject), echt (echte gemiddelde), traject }.
 */
async function rijd(app, o) {
  await (app.geladen ||= app.F.laad());
  const uit = [];
  let m = o.m0, t = o.t, sec = 0, vast = null, vastTot = -1, tBegin = null, mBegin = null, mDeel = null, tDeel = null;
  const pt = o.punt || punt;
  while (m <= o.m1) {
    const kmh = o.snelheid ? o.snelheid(m - (o.mA ?? mA), sec) : o.kmh;
    m += (kmh / 3.6) * 0.1; t += 100; sec += 0.1;
    if (tBegin == null && m - (o.mA ?? mA) >= 0) { tBegin = t; mBegin = m; }
    if (o.stilte && sec >= o.stilte[0] && sec < o.stilte[1]) continue;
    let p;
    if (vast && sec < vastTot) p = vast;
    else {
      p = pt(m);
      if (o.opzij) p = schuif(p, (toeval() - 0.5) * 2 * o.opzij, (toeval() - 0.5) * o.opzij);
      if (o.sprong && toeval() < o.sprong) p = schuif(p, (toeval() - 0.5) * 80, (toeval() - 0.3) * 80);
      if (o.koersRuis) p = { ...p, koers: (p.koers + (toeval() - 0.5) * 2 * o.koersRuis + 360) % 360 };
      if (o.vastS) { vast = p; vastTot = sec + toeval() * o.vastS; }
    }
    const tijd = o.tijd ? o.tijd(t, sec) : t;
    const r = app.F.stap({ lat: p.lat, lon: p.lon, kmh: kmh + (o.kmhRuis ? (toeval() - 0.5) * 2 * o.kmhRuis : 0), koers: p.koers, t: tijd }, true);
    const tr = r.traject && !r.traject.komt ? r.traject : null;
    if (tr && tr.deels && mDeel == null) { mDeel = m; tDeel = t; }
    const echt = tr ? (tr.deels ? (m - mDeel) / ((t - tDeel) / 1000) : (m - mBegin) / ((t - tBegin) / 1000)) * 3.6 : null;
    uit.push({ m: m - (o.mA ?? mA), echt, tr });
  }
  return { uit, t };
}
let fouten = 0;
const zie = (ok, ...tekst) => { if (!ok) fouten++; console.log(ok ? "ok  " : "FOUT", ...tekst); };
const tel = (zin, deel) => zin.filter((z) => z.split("+").includes(deel)).length;
const aankondigingen = (zin) => tel(zin, "traject_1000") + tel(zin, "traject_500");
/** Het gemiddelde moet bij elke positie met een getal binnen 2 km/h van het echte zitten. */
function gemiddeldKlopt(uit, marge = 2) {
  let slechtste = null, getallen = 0;
  for (const s of uit) {
    if (!s.tr || s.tr.gem == null) continue;
    getallen++;
    const af = Math.abs(s.tr.gem - s.echt);
    if (!slechtste || af > slechtste.af) slechtste = { af: Math.round(af * 10) / 10, m: Math.round(s.m), gem: s.tr.gem, echt: Math.round(s.echt) };
  }
  return { ok: getallen > 100 && slechtste && slechtste.af <= marge, getallen, slechtste };
}
const T0 = Date.parse("2026-10-28T17:19:00+01:00");
const basis = { m0: mA - 1500, m1: mA + 2600, t: T0 };
function eenVanElk(zin, wat) {
  zie(aankondigingen(zin) === 1, wat + ": een aankondiging vooraf:", zin.join(", "));
  zie(tel(zin, "traject_start") === 1, wat + ": een keer 'trajectcontrole begint'");
  zie(tel(zin, "traject_eind") === 1, wat + ": een keer het einde");
}

{ // 1. De tijd in de positie springt tot 0,4 s heen en weer (de fout van vandaag).
  const app = nieuweApp();
  const { uit } = await rijd(app, { ...basis, kmh: 81, tijd: (t) => t + Math.round((toeval() - 0.5) * 800) });
  eenVanElk(app.zin, "tijd heen en weer");
  const g = gemiddeldKlopt(uit); zie(g.ok, "tijd heen en weer: gemiddelde klopt", JSON.stringify(g));
  zie(app.zin.includes("gong+traject_eind+gemiddeld+n81"), "einde met gemiddeld 81");
}
{ // 2. Wisselende snelheid (60 tot 110) met herhaalde coordinaten tot 2 s, 3 m ruis opzij en sprongen.
  const app = nieuweApp();
  const { uit } = await rijd(app, { ...basis, snelheid: (m, s) => 85 + 25 * Math.sin(s / 9), vastS: 2, opzij: 3, sprong: 0.01, kmhRuis: 2 });
  eenVanElk(app.zin, "ruis en sprongen");
  const g = gemiddeldKlopt(uit, 2.5); zie(g.ok, "ruis en sprongen: gemiddelde klopt", JSON.stringify(g));
}
{ // 3. Twintig seconden geen posities midden in het traject (de Tesla bevriest de pagina).
  const app = nieuweApp();
  const { uit } = await rijd(app, { ...basis, kmh: 90, stilte: [95, 115] });
  eenVanElk(app.zin, "stilte van 20 s");
  const g = gemiddeldKlopt(uit); zie(g.ok, "stilte van 20 s: gemiddelde klopt", JSON.stringify(g));
}
{ // 4. Twee klokken door elkaar in pos.timestamp (12 uur verschil): de klok van de rit (Geo.maakKlok)
  //    ziet alleen de tijd van aankomst.
  const app = nieuweApp();
  let perf = 0, wand = T0;
  // pos.timestamp wisselt per seconde tussen de goede klok en een die 12 uur achterloopt.
  const posTijd = (t) => (Math.floor(t / 1000) % 2 ? t : t - 12 * 3600e3);
  const klok = app.G.maakKlok ? app.G.maakKlok(() => perf, () => wand) : null;
  const { uit } = await rijd(app, { ...basis, kmh: 81, tijd: (t) => { perf = t - T0; wand = t; return klok ? klok() : posTijd(t); } });
  eenVanElk(app.zin, "twee klokken");
  const g = gemiddeldKlopt(uit); zie(g.ok, "twee klokken: gemiddelde klopt", JSON.stringify(g));
  // En de klok zelf: monotoon, ook als de wandklok terugspringt, en mee met een slaap.
  if (!klok) zie(false, "geen Geo.maakKlok");
  else {
    perf = 0; wand = 1e12; const k2 = app.G.maakKlok(() => perf, () => wand);
    const a = k2(); perf = 1000; wand -= 3600e3; const b = k2(); perf = 2000; wand += 3600e3 + 60000; const c = k2();
    zie(b - a === 1000 && c - b > 50000, "klok van de rit: loopt door bij een terugspringende wandklok en telt een slaap", a, b, c);
  }
}
{ // 5. Rond de drempels: snelheid 76 tot 84 (drempel 500 of 1000 m), koers 40 graden heen en weer,
  //    en de GPS die 30 m vooruit en achteruit springt.
  const app = nieuweApp();
  await rijd(app, { ...basis, snelheid: (m, s) => 80 + 4 * Math.sin(s * 2), koersRuis: 40, sprong: 0.05 });
  eenVanElk(app.zin, "rond de drempel");
}
{ // 6. De pagina laadt opnieuw 300 m voor het begin, en later midden in het traject.
  const opslag = nieuweOpslag();
  const a = nieuweApp(opslag);
  const r1 = await rijd(a, { ...basis, m1: mA - 300, kmh: 70 });
  const b = nieuweApp(opslag);
  const r2 = await rijd(b, { m0: mA - 300, m1: mA + 900, t: r1.t + 5000, kmh: 70 });
  const c = nieuweApp(opslag);
  const r3 = await rijd(c, { m0: mA + 920, m1: mA + 2600, t: r2.t + 5000, kmh: 70 });
  const zin = [...a.zin, ...b.zin, ...c.zin];
  zie(aankondigingen(zin) === 1 && tel(zin, "traject_start") === 1, "herladen: een aankondiging en een begin:", a.zin.join(", "), "|", b.zin.join(", "), "|", c.zin.join(", "));
  zie(tel(c.zin, "traject_eind") === 1, "na herladen midden in het traject toch het einde, zonder getal:", c.zin.join(", "));
  const g = gemiddeldKlopt(r3.uit); zie(g.ok, "na herladen: eerlijk gemiddelde over het gemeten deel", JSON.stringify(g));
}
{ // 7. Twee tabbladen tegelijk met dezelfde posities: samen een keer.
  const opslag = nieuweOpslag();
  const a = nieuweApp(opslag), b = nieuweApp(opslag);
  await a.F.laad(); await b.F.laad();
  let t = T0, m = mA - 1500;
  while (m < mA + 2600) {
    m += (81 / 3.6) * 0.1; t += 100;
    const p = punt(m);
    a.F.stap({ ...p, kmh: 81, t }, true);
    b.F.stap({ ...p, kmh: 81, t: t + 30 }, true);
  }
  const zin = [...a.zin, ...b.zin];
  zie(aankondigingen(zin) === 1 && tel(zin, "traject_start") === 1 && tel(zin, "traject_eind") === 1, "twee tabbladen: alles een keer:", a.zin.join(", "), "|", b.zin.join(", "));
}
{ // 8. Flitspaal N209 met ruis en tijd heen en weer, en herladen vlak na de melding: "flitser" een keer.
  const pn = maakRoute(n209);
  const L = n209.reduce((s, p, i) => (i ? s + G.afstand(n209[i - 1][0], n209[i - 1][1], p[0], p[1]) : 0), 0);
  // Eerst zonder ruis: waar klinkt de melding? Daar 30 m na herladen.
  let mF = null; { const app = nieuweApp(); await app.F.laad(); let m = 0, t = T0; while (m < L && !app.zin.length) { m += (62 / 3.6) * 0.1; t += 100; const p = pn(m); app.F.stap({ ...p, kmh: 62, t }, true); } mF = m; }
  const opslag = nieuweOpslag();
  const a = nieuweApp(opslag), b = nieuweApp(opslag);
  const ruis = { punt: pn, mA: 0, kmh: 62, opzij: 3, sprong: 0.03, koersRuis: 30, tijd: (t) => t + Math.round((toeval() - 0.5) * 800) };
  const r1 = await rijd(a, { ...ruis, m0: 0, m1: mF + 30, t: T0 });
  await rijd(b, { ...ruis, m0: mF + 30, m1: L, t: r1.t + 3000 });
  const zin = [...a.zin, ...b.zin];
  zie(zin.filter((z) => z.includes("flitser_")).length === 1, "flitspaal N209 met ruis en herladen 30 m na de melding: een keer:", a.zin.join(", "), "|", b.zin.join(", "));
}
console.log(fouten ? fouten + " fout" + (fouten > 1 ? "en" : "") + " met ruis" : "alles goed met ruis");
process.exit(fouten ? 1 : 0);
