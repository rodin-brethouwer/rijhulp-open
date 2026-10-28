// Flitspalen, roodlichtcamera's en trajectcontroles uit OpenStreetMap (data/flitsers.json,
// gemaakt door scripts/bouw-flitsers.mjs; (c) OpenStreetMap-bijdragers, ODbL).
// Alleen vaste punten uit OSM; geen ANWB, Flitsmeister of flitspalen.nl.
(function (w) {
  "use strict";
  var G = w.Geo;
  var data = null;
  var gemeld = {}; // camera-index -> { fase, t }
  var traject = null; // actieve trajectcontrole
  var trajectGemeld = {}; // index -> t van de aankondiging
  var laatsteEinde = null; // { b, t } om aaneengesloten trajecten stil door te laten lopen
  var zeg = function () {};
  // Trajectmeting (28 okt 2026, rijhulp-v19): het gemiddelde is de afstand langs de weg van het
  // traject (vanaf het begin, of vanaf waar de app aansloot) gedeeld door de tijd sinds dat punt.
  // De afstand komt uit de plek op de weg (projectie op de lijn van begin naar einde), niet uit
  // opgetelde GPS-stapjes, dus ruis, herhaalde coordinaten en sprongen tellen niet mee.
  // GAT_S: langer zonder posities maakt de meting ongeldig. STIL_S: zo lang rekent de app door met de
  // snelheid als de positie niet verandert. VOL_S/VOL_M: pas dan een getal bij een hele meting;
  // DEEL_S/DEEL_M: idem als de app halverwege aansloot. AANSLUIT_M: aansluiten tot zo ver van de weg.
  var GAT_S = 300, STIL_S = 3, VOL_S = 15, VOL_M = 300, DEEL_S = 30, DEEL_M = 500, AANSLUIT_M = 20, VMAX = 70;
  var herstart = {}; // index -> t: deze meting werd ongeldig, aansluiten mag dan opnieuw

  // ---------- Een keer zeggen ----------
  // Elke aankondiging hooguit een keer per plek: ook als de GPS rond een drempel heen en weer
  // springt, de pagina opnieuw laadt of er een tweede tabblad meeloopt. In het geheugen op de klok
  // van de rit, en (buiten de proefrit) in localStorage op de wandklok, gedeeld tussen tabbladen.
  var spoor = [], bewaren = false, SPOOR_SLEUTEL = "rijhulp-gezegd";
  function leesSpoor() {
    if (!bewaren) return [];
    try { var l = JSON.parse(w.localStorage.getItem(SPOOR_SLEUTEL) || "[]"); return Array.isArray(l) ? l : []; } catch (e) { return []; }
  }
  function lijkt(x, soort, lat, lon, r, straal) {
    return x.s === soort && G.afstand(lat, lon, x.lat, x.lon) <= straal && (r == null || x.r == null || G.verschil(r, x.r) <= 50);
  }
  /**
   * Mag deze aankondiging (soort op plek lat/lon, richting r)? Nee als dezelfde soort binnen straal
   * meter en ttl ms al klonk. Zo ja, dan staat hij meteen genoteerd.
   */
  function eenKeer(soort, lat, lon, r, nu, ttl, straal) {
    straal = straal || 150;
    var wand = Date.now(), i;
    spoor = spoor.filter(function (x) { return Math.abs(nu - x.t) < 3600000; });
    for (i = 0; i < spoor.length; i++) if (lijkt(spoor[i], soort, lat, lon, r, straal) && nu - spoor[i].t < ttl) return false;
    var bewaard = leesSpoor().filter(function (x) { return x && wand - x.w < 3600000 && x.w - wand < 60000; });
    for (i = 0; i < bewaard.length; i++) if (lijkt(bewaard[i], soort, lat, lon, r, straal) && wand - bewaard[i].w < ttl) return false;
    var x = { s: soort, lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, r: r == null ? null : Math.round(r), t: nu, w: wand };
    spoor.push(x);
    if (bewaren) { bewaard.push({ s: x.s, lat: x.lat, lon: x.lon, r: x.r, w: wand }); try { w.localStorage.setItem(SPOOR_SLEUTEL, JSON.stringify(bewaard.slice(-60))); } catch (e) { /* vol of uit: dan alleen in het geheugen */ } }
    return true;
  }

  function laad() {
    return fetch("data/flitsers.json").then(function (r) { if (!r.ok) throw new Error("flitsers " + r.status); return r.json(); })
      .then(function (j) {
        data = j;
        // Per traject de richting bij het begin, voor de herkenning van de rijrichting.
        data.t.forEach(function (t) {
          t.richting = G.peiling(t.a[0], t.a[1], t.b[0], t.b[1]);
          var beste = null;
          t.s.forEach(function (l) {
            for (var i = 2; i < l.length; i += 2) {
              var r = G.totLijnstuk(t.a[0], t.a[1], l[i - 2], l[i - 1], l[i], l[i + 1]);
              if (!beste || r.d < beste.d) beste = r;
            }
          });
          if (beste && beste.d < 60) {
            // De wegdelen kunnen beide kanten op getekend zijn: kies de kant die naar b wijst.
            var r1 = beste.richting, r2 = (beste.richting + 180) % 360;
            t.beginRichting = G.verschil(r1, t.richting) <= G.verschil(r2, t.richting) ? r1 : r2;
          } else t.beginRichting = t.richting;
          t.keten = maakKeten(t);
        });
        return { camera: j.c.length, trajecten: j.t.length, stand: j.stand };
      });
  }

  /**
   * De weg van het traject als een lijn van begin a naar einde b: de wegdelen uit OSM aan elkaar
   * (kortste pad tussen hun eindpunten, die binnen 3 m als hetzelfde punt gelden). Lukt dat niet,
   * dan de rechte lijn, opgerekt naar t.km. pts [lat, lon, ...], cum de afstand langs de lijn per punt.
   */
  function maakKeten(t) {
    var knopen = [];
    function knoop(lat, lon) {
      for (var i = 0; i < knopen.length; i++) if (G.afstand(lat, lon, knopen[i][0], knopen[i][1]) < 3) return i;
      knopen.push([lat, lon]); return knopen.length - 1;
    }
    var randen = t.s.map(function (l) {
      var len = 0;
      for (var i = 2; i < l.length; i += 2) len += G.afstand(l[i - 2], l[i - 1], l[i], l[i + 1]);
      return { u: knoop(l[0], l[1]), v: knoop(l[l.length - 2], l[l.length - 1]), l: l, len: len };
    });
    function dichtst(p) { var b = -1, bd = Infinity; knopen.forEach(function (k, i) { var d = G.afstand(p[0], p[1], k[0], k[1]); if (d < bd) { bd = d; b = i; } }); return { i: b, d: bd }; }
    var s = dichtst(t.a), e = dichtst(t.b), pts = null;
    if (s.d < 60 && e.d < 60 && s.i !== e.i) {
      var dist = knopen.map(function () { return Infinity; }), vorig = knopen.map(function () { return null; }), klaar = {};
      dist[s.i] = 0;
      for (;;) {
        var u = -1;
        for (var k = 0; k < dist.length; k++) if (!klaar[k] && dist[k] < Infinity && (u < 0 || dist[k] < dist[u])) u = k;
        if (u < 0 || u === e.i) break;
        klaar[u] = true;
        randen.forEach(function (r, ri) {
          var v = r.u === u ? r.v : r.v === u ? r.u : -1;
          if (v >= 0 && dist[u] + r.len < dist[v]) { dist[v] = dist[u] + r.len; vorig[v] = { u: u, r: ri }; }
        });
      }
      if (dist[e.i] < Infinity) {
        var stukken = [], x = e.i;
        while (x !== s.i) { var vg = vorig[x], r = randen[vg.r], l = r.l.slice(); if (r.u !== vg.u) { var om = []; for (var q = l.length - 2; q >= 0; q -= 2) om.push(l[q], l[q + 1]); l = om; } stukken.unshift(l); x = vg.u; }
        pts = [];
        stukken.forEach(function (l, n) { for (var i = n ? 2 : 0; i < l.length; i++) pts.push(l[i]); });
      }
    }
    var pad = !!pts;
    if (!pad) pts = [t.a[0], t.a[1], t.b[0], t.b[1]];
    var cum = [0];
    for (var j = 2; j < pts.length; j += 2) cum.push(cum[cum.length - 1] + G.afstand(pts[j - 2], pts[j - 1], pts[j], pts[j + 1]));
    var len = cum[cum.length - 1], doel = (t.km || 0) * 1000;
    // Langs het pad telt de lengte van het pad zelf (t.km telt alle wegdelen van de relatie op en is
    // afgerond); alleen bij de rechte lijn de verhouding met t.km.
    var schaal = !pad && len > 0 && doel > 0 && doel / len > 1 && doel / len < 1.6 ? doel / len : 1;
    return { pts: pts, cum: cum, len: len, schaal: schaal, lengte: len * schaal };
  }
  /**
   * Waar staat de auto langs de weg van het traject? s in meter vanaf het begin (in de rijrichting;
   * voor het begin negatief), d de afstand tot de weg. vorig: de vorige s, om bij een weg die naast
   * zichzelf terugloopt het goede stuk te kiezen.
   */
  function langs(t, lat, lon, omgekeerd, vorig) {
    var k = t.keten, pts = k.pts, kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540;
    var beste = null, besteVrij = null, n = k.cum.length;
    for (var i = 1; i < n; i++) {
      var ax = (pts[2 * i - 1] - lon) * kx, ay = (pts[2 * i - 2] - lat) * ky, bx = (pts[2 * i + 1] - lon) * kx, by = (pts[2 * i] - lat) * ky;
      var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, f = l2 ? -(ax * dx + ay * dy) / l2 : 0;
      // Voor het begin en na het einde verder langs het eerste en laatste stuk.
      var fc = i === 1 ? Math.min(f, 1) : i === n - 1 ? Math.max(f, 0) : Math.max(0, Math.min(1, f));
      if (n === 2) fc = f;
      var x = ax + fc * dx, y = ay + fc * dy, d = Math.sqrt(x * x + y * y);
      var s = (k.cum[i - 1] + fc * (k.cum[i] - k.cum[i - 1])) * k.schaal;
      if (omgekeerd) s = k.lengte - s;
      var r = { s: s, d: d };
      if (!besteVrij || d < besteVrij.d) besteVrij = r;
      if (vorig != null && (s < vorig - 100 || s > vorig + 3000)) continue;
      if (!beste || d < beste.d) beste = r;
    }
    return beste && beste.d < besteVrij.d + 40 ? beste : besteVrij;
  }

  /** Ligt het punt recht voor ons op de weg? Afstand d, peiling b vanaf de auto. */
  function vooruit(d, b, koers) {
    var hoek = G.verschil(koers, b);
    var opzij = d * Math.sin(Math.min(hoek, 90) * Math.PI / 180);
    if (hoek > 60) return false;
    return opzij < 35 || hoek < 12;
  }
  function afstandTotTraject(t, lat, lon) {
    var min = Infinity;
    t.s.forEach(function (l) {
      for (var i = 2; i < l.length; i += 2) {
        var r = G.totLijnstuk(lat, lon, l[i - 2], l[i - 1], l[i], l[i + 1]);
        if (r.d < min) min = r.d;
      }
    });
    return min;
  }
  function limietVanTraject(t, d) {
    var basis = { v: t.m || null };
    if (t.mc && w.Kaart) { var x = w.Kaart._metVoorwaarde(basis, t.mc, d); if (x) return x.v; }
    return basis.v;
  }

  /**
   * Eén stap met een nieuwe positie. p: { lat, lon, kmh, koers, t (ms), nauwkeurig }.
   * Geeft terug wat het scherm toont: { camera: {soort, d, max} | null, traject: {...} | null }.
   */
  function stap(p, aan) {
    var uit = { camera: null, traject: null };
    if (!data || !aan || p.koers == null || p.kmh < 8) {
      if (traject && !aan) traject = null;
      // Stilstand in de file: de tijd loopt door (het gemiddelde zakt, net als bij de echte meting),
      // en het scherm houdt het traject vast.
      if (traject && data) {
        var tS = Math.max(p.t, traject.vT);
        if (tS - traject.vT > GAT_S * 1000) ongeldig(tS);
        else { traject.vT = tS; uit.traject = toonTraject(p, tS, 0); }
      }
      return uit;
    }
    var v = p.kmh, nu = p.t;

    // ---------- Vaste camera's ----------
    var dichtst = null;
    for (var i = 0; i < data.c.length; i++) {
      var c = data.c[i];
      if (Math.abs(c[0] - p.lat) > 0.012 || Math.abs(c[1] - p.lon) > 0.02) continue;
      var d = G.afstand(p.lat, p.lon, c[0], c[1]);
      if (d > 1200) continue;
      var st = gemeld[i];
      if (st && nu - st.t > 300000) { delete gemeld[i]; st = null; }
      if (st && st.fase === "voorbij") continue;
      if (st && st.fase === "gemeld") {
        // Eenmaal gemeld blijft hij staan tot we erlangs zijn, ook in een bocht.
        st.min = Math.min(st.min, d);
        if (d < 30 || (st.min < 150 && d > st.min + 25) || d > st.d + 300) { st.fase = "voorbij"; continue; }
      } else {
        var b = G.peiling(p.lat, p.lon, c[0], c[1]);
        var ziet = d < 25 || vooruit(d, b, p.koers);
        var goedeKant = c[4] < 0 || G.verschil(p.koers, c[4]) < 50;
        if (!ziet || !goedeKant) continue;
        var rood = c[2] === 1;
        var grens = rood ? (v >= 50 ? 300 : 150) : v >= 80 ? 500 : v >= 50 ? 300 : 150;
        if (d <= grens) {
          var stappen = rood ? [300, 150] : [500, 300, 150];
          var keuze = null;
          for (var k = 0; k < stappen.length; k++) if (d + 40 >= stappen[k]) { keuze = stappen[k]; break; }
          if (eenKeer("camera", c[0], c[1], c[4] < 0 ? p.koers : c[4], nu, 240000, 60)) zeg(keuze ? ["gong", (rood ? "rood_" : "flitser_") + keuze] : ["gong"], true);
          gemeld[i] = st = { fase: "gemeld", t: nu, d: d, min: d };
        }
      }
      if (!dichtst || d < dichtst.d) dichtst = { soort: c[2], d: d, max: c[3] };
    }
    if (dichtst && dichtst.d <= 1000) uit.camera = { soort: dichtst.soort, d: Math.round(dichtst.d / 10) * 10, max: dichtst.max };

    // ---------- Trajectcontrole ----------
    // De tijd van de dag (voor "130 @ (19:00-06:00)") komt uit p.datum als rijhulp.js die geeft
    // (de klok van het toestel als pos.timestamp sterk afwijkt), anders uit p.t.
    var datum = p.datum || new Date(nu);
    if (traject) {
      var t = data.t[traject.i];
      // De klok van de rit loopt nooit terug: een positie met een oudere tijd telt als nu.
      var tNu = Math.max(nu, traject.vT), dt = (tNu - traject.vT) / 1000;
      traject.vT = tNu;
      if (dt > GAT_S) ongeldig(tNu);
      else {
        // Alleen een positie die echt veranderde zegt iets over de afstand.
        var L = traject.laatste;
        if (G.afstand(L.lat, L.lon, p.lat, p.lon) > 0.5) {
          var pr = langs(t, p.lat, p.lon, traject.omgekeerd, L.s), dtr = (tNu - L.t) / 1000, ds = pr.s - L.s;
          traject.naast = pr.d > 80 ? traject.naast || tNu : 0;
          if (pr.d <= 60 && ds >= -25 && ds <= VMAX * dtr + 15) {
            // Na een lange tijd zonder posities (de pagina stond stil) moet de afstand bij de snelheid
            // passen, anders klopt de tijd niet. Stilstand in de file geeft wel posities, dus telt niet.
            if (dt > 40 && v >= 30 && ds < (v / 3.6) * dt * 0.3) { ongeldig(tNu); }
            else {
              traject.weiger = 0;
              var sN = Math.max(pr.s, L.s);
              // Het begin gepasseerd: de tijd daar, tussen de twee posities in.
              if (!traject.ref && L.s <= 0 && sN > 0) traject.ref = { s: 0, t: L.t + (tNu - L.t) * (-L.s / (sN - L.s)) };
              traject.laatste = { lat: p.lat, lon: p.lon, s: sN, t: tNu };
            }
          } else if (pr.d <= 60 && ++traject.weiger >= 10) ongeldig(tNu); // tien sprongen achter elkaar: de meting is kwijt
        }
      }
      if (traject) {
        var tt = toonTraject(p, tNu, v);
        var gem = tt.gemRuw, lim = traject.limiet, sec = tt.sec, sNu = tt.sNu;
        // De limiet volgt de tijd, maar gaat binnen een traject nooit omhoog: bij twijfel de laagste.
        var limNu = limietVanTraject(t, datum);
        if (limNu && (!traject.limiet || limNu < traject.limiet)) { traject.limiet = lim = limNu; tt.limiet = lim; }
        // Gemiddelde te hoog: één keer per keer dat het erboven komt.
        if (lim && gem != null && gem > lim + 1 && sec > 20 && !traject.teHoog) { traject.teHoog = true; zeg(["let", "te_hoog"], false); }
        if (lim && gem != null && gem < lim - 1) traject.teHoog = false;
        var dEind = G.afstand(p.lat, p.lon, traject.eind[0], traject.eind[1]);
        // Elke 3 km het gemiddelde.
        if (sNu - traject.laatsteMelding > 3000 && dEind > 600 && gem != null) {
          traject.laatsteMelding = sNu;
          var n = w.Geluid.getal(gem);
          if (n) zeg(["zacht", "gemiddeld", n], false);
        }
        var klaar = dEind < 40 || (traject.minEind < 150 && dEind > traject.minEind + 30);
        traject.minEind = Math.min(traject.minEind, dEind);
        if (klaar || (traject.naast && tNu - traject.naast > 15000)) {
          // Een gedeeltelijke meting noemt bij het einde geen getal: dat is niet wat de camera meet.
          var gemEind = gem != null && !traject.deels ? Math.round(gem) : null;
          if (klaar) {
            laatsteEinde = { lat: traject.eind[0], lon: traject.eind[1], t: tNu, gem: gemEind };
            var volgt = volgendTraject(p, t, traject.eind), wasTeHoog = traject.teHoog, eind = traject.eind;
            var ne = gemEind != null && w.Geluid.getal(gemEind);
            traject = null;
            if (eenKeer("traject_eind", eind[0], eind[1], p.koers, tNu, 300000, 300)) {
              if (volgt == null) zeg(ne ? ["gong", "traject_eind", "gemiddeld", ne] : ["gong", "traject_eind"], false);
              else if (ne) zeg(["zacht", "gemiddeld", ne], false);
            }
            if (volgt != null) begin(volgt, p, true, false, wasTeHoog, datum);
          } else traject = null; // van het traject af gereden: stil stoppen
        } else uit.traject = tt;
        return uit;
      }
    }
    // Niet actief: aankondigen en beginnen.
    // OSM heeft vaak meer trajecten op dezelfde plek (hoofdrijbaan en parallelrijbaan, of twee
    // delen die op hetzelfde punt beginnen, zoals de A12 bij Utrecht en de A20 bij Rotterdam).
    // Eén aankondiging per plek: wie er een aankondigt, markeert de buren als gemeld. Beginnen
    // doet het traject waarvan de weg het dichtst bij de auto ligt.
    var start = null;
    for (var j = 0; j < data.t.length; j++) {
      var tr = data.t[j];
      var richtingen = tr.r ? [[tr.a, tr.b, tr.beginRichting], [tr.b, tr.a, (tr.beginRichting + 180) % 360]] : [[tr.a, tr.b, tr.beginRichting]];
      for (var q = 0; q < richtingen.length; q++) {
        var A = richtingen[q][0], rr = richtingen[q][2];
        if (Math.abs(A[0] - p.lat) > 0.02 || Math.abs(A[1] - p.lon) > 0.03) continue;
        var dA = G.afstand(p.lat, p.lon, A[0], A[1]);
        if (dA > 1200) continue;
        if (G.verschil(p.koers, rr) > 50) continue;
        var bA = G.peiling(p.lat, p.lon, A[0], A[1]);
        if (dA < 45) {
          var dl = afstandTotTraject(tr, p.lat, p.lon);
          if (!start || dl < start.dl) start = { j: j, dl: dl, omgekeerd: q === 1 };
          continue;
        }
        if (!vooruit(dA, bA, p.koers)) continue;
        var ag = trajectGemeld[j];
        if (ag && nu - ag > 600000) { delete trajectGemeld[j]; ag = null; }
        if (!ag) {
          var drempel = v >= 80 ? 1000 : 500;
          if (dA <= drempel) {
            if (eenKeer("traject_komt", A[0], A[1], rr, nu, 600000, 300)) zeg(["gong", dA + 60 >= 1000 ? "traject_1000" : "traject_500"], true);
            trajectGemeld[j] = nu;
            markeerBuren(A, rr, nu);
          }
        }
        if (dA <= 1000 && (!uit.traject || dA < uit.traject.d)) uit.traject = { komt: true, d: Math.round(dA / 10) * 10, limiet: limietVanTraject(tr, datum), naam: tr.n };
      }
    }
    if (start) { begin(start.j, p, false, start.omgekeerd, false, datum); uit.traject = null; }
    else {
      var aan2 = aansluiten(p, nu);
      if (aan2) { begin(aan2.j, p, true, aan2.omgekeerd, false, datum, true); uit.traject = null; }
    }
    return uit;
  }
  /**
   * De auto rijdt al op een traject zonder dat de app het begin zag (de app ging halverwege aan, of
   * de pagina stond stil). Alleen als het zeker is: hooguit AANSLUIT_M van de weg van het traject,
   * de koers langs die weg en naar het einde toe, meer dan 45 m na het begin en 300 m voor het
   * einde, en niet een traject dat net al liep of is aangekondigd (zo pakt de app na het einde van
   * de hoofdrijbaan niet alsnog de parallelrijbaan), behalve het traject waarvan de meting net
   * ongeldig werd. Geeft { j, omgekeerd } of null.
   */
  function aansluiten(p, nu) {
    if (p.kmh < 30) return null;
    var beste = null;
    for (var j = 0; j < data.t.length; j++) {
      var tr = data.t[j];
      var ag = trajectGemeld[j];
      if (ag && nu - ag >= 0 && nu - ag <= 600000 && herstart[j] == null) continue;
      if (p.lat < Math.min(tr.a[0], tr.b[0]) - 0.01 || p.lat > Math.max(tr.a[0], tr.b[0]) + 0.01) continue;
      if (p.lon < Math.min(tr.a[1], tr.b[1]) - 0.015 || p.lon > Math.max(tr.a[1], tr.b[1]) + 0.015) continue;
      var dichtst = null;
      tr.s.forEach(function (l) {
        for (var i = 2; i < l.length; i += 2) {
          var r = G.totLijnstuk(p.lat, p.lon, l[i - 2], l[i - 1], l[i], l[i + 1]);
          if (!dichtst || r.d < dichtst.d) dichtst = r;
        }
      });
      if (!dichtst || dichtst.d > AANSLUIT_M) continue;
      if (Math.min(G.verschil(dichtst.richting, p.koers), G.verschil((dichtst.richting + 180) % 360, p.koers)) > 30) continue;
      var kanten = tr.r ? [[tr.a, tr.b, false], [tr.b, tr.a, true]] : [[tr.a, tr.b, false]];
      for (var q = 0; q < kanten.length; q++) {
        var A = kanten[q][0], B = kanten[q][1];
        var dA = G.afstand(A[0], A[1], p.lat, p.lon), dB = G.afstand(p.lat, p.lon, B[0], B[1]);
        if (dA < 45 || dB < 300) continue;
        if (G.verschil(p.koers, G.peiling(p.lat, p.lon, B[0], B[1])) > 45 || G.verschil(p.koers, G.peiling(A[0], A[1], p.lat, p.lon)) > 45) continue;
        if (!beste || dichtst.d < beste.d) beste = { j: j, omgekeerd: kanten[q][2], d: dichtst.d };
      }
    }
    return beste;
  }
  /** Alle trajecten die binnen BUREN_M van dit begin starten, in dezelfde richting, tellen als gemeld. */
  var BUREN_M = 300;
  function markeerBuren(A, rr, nu) {
    for (var k = 0; k < data.t.length; k++) {
      var t = data.t[k];
      var r = t.r ? [[t.a, t.beginRichting], [t.b, (t.beginRichting + 180) % 360]] : [[t.a, t.beginRichting]];
      for (var q = 0; q < r.length; q++) {
        if (Math.abs(r[q][0][0] - A[0]) > 0.005 || Math.abs(r[q][0][1] - A[1]) > 0.008) continue;
        if (G.afstand(A[0], A[1], r[q][0][0], r[q][0][1]) <= BUREN_M && G.verschil(r[q][1], rr) <= 50) trajectGemeld[k] = nu;
      }
    }
  }
  function volgendTraject(p, vorig, eind) {
    for (var j = 0; j < data.t.length; j++) {
      var t = data.t[j];
      if (t === vorig || t.r) continue;
      if (G.afstand(eind[0], eind[1], t.a[0], t.a[1]) < 60 && G.verschil(t.beginRichting, p.koers) < 50) return j;
    }
    return null;
  }
  /**
   * Wat het scherm toont van het actieve traject, op tijd tNu met snelheid v (km/h). Het gemiddelde
   * is de afstand langs de weg sinds het referentiepunt (het begin, of waar de app aansloot) gedeeld
   * door de tijd sinds dat punt. Herhaalt de browser dezelfde plek, dan rekent de app hooguit STIL_S
   * door met de snelheid; daarna telt alleen de tijd (bij stilstand zakt het gemiddelde, zoals bij de
   * echte meting). Geen getal (gem: null) zolang er te weinig gemeten is.
   */
  function toonTraject(p, tNu, v) {
    var t = data.t[traject.i], L = traject.laatste, ref = traject.ref;
    var sNu = L.s + (v / 3.6) * Math.min(STIL_S, Math.max(0, (tNu - L.t) / 1000));
    var gem = null, sec = 0;
    if (ref) {
      sec = (tNu - ref.t) / 1000;
      var m = sNu - ref.s;
      var genoeg = traject.deels ? sec >= DEEL_S && m >= DEEL_M : sec >= VOL_S && m >= VOL_M;
      if (genoeg && sec > 0) gem = (m / sec) * 3.6;
    }
    var lengte = t.keten.lengte || t.km * 1000;
    return { naam: t.n, gem: gem == null ? null : Math.round(gem), gemRuw: gem, limiet: traject.limiet, rest: Math.max(0, Math.round((lengte - Math.max(0, sNu)) / 100) / 10), sec: Math.round(sec), deels: traject.deels, sNu: sNu };
  }
  /** De meting klopt niet meer (lange stilte, klok of sprongen): stil stoppen; aansluiten mag weer. */
  function ongeldig(tNu) {
    if (!traject) return;
    herstart[traject.i] = tNu;
    traject = null;
  }
  /** deels: de app sloot halverwege aan (dan geldt het gemiddelde alleen voor het gemeten deel). */
  function begin(j, p, stil, omgekeerd, teHoog, datum, deels) {
    var t = data.t[j];
    var lim = limietVanTraject(t, datum || new Date(p.t));
    var pr = langs(t, p.lat, p.lon, !!omgekeerd, null), v = p.kmh / 3.6;
    // Het referentiepunt van de meting. Een hele meting begint op s = 0: al net voorbij het begin
    // (hooguit 60 m), dan terug gerekend met de snelheid; nog ervoor, dan zodra de auto het passeert.
    var ref = null;
    if (deels) ref = { s: pr.s, t: p.t };
    else if (pr.s > 0 && pr.s <= 60 && v > 0) ref = { s: 0, t: p.t - (pr.s / v) * 1000 };
    else if (pr.s > 60) { ref = { s: pr.s, t: p.t }; deels = true; }
    // teHoog gaat mee naar een aansluitend traject: "let op, gemiddelde te hoog" niet bij elk deel opnieuw.
    traject = { i: j, eind: omgekeerd ? t.a : t.b, omgekeerd: !!omgekeerd, deels: !!deels, ref: ref, laatste: { lat: p.lat, lon: p.lon, s: pr.s, t: p.t }, vT: p.t, weiger: 0, limiet: lim, laatsteMelding: Math.max(0, pr.s), minEind: Infinity, teHoog: !!teHoog, naast: 0 };
    delete herstart[j];
    trajectGemeld[j] = p.t;
    var A = omgekeerd ? t.b : t.a;
    markeerBuren(A, omgekeerd ? (t.beginRichting + 180) % 360 : t.beginRichting, p.t);
    // "Trajectcontrole begint" hooguit een keer per begin, ook na een herstart of herladen.
    if (!stil && eenKeer("traject_start", A[0], A[1], p.koers, p.t, 600000, 300)) {
      var n = lim && w.Geluid.getal(lim);
      zeg(n ? ["gong", "traject_start", "limiet", n] : ["gong", "traject_start"], true);
    }
  }

  w.Flitsers = {
    laad: laad,
    stap: stap,
    opZeg: function (f) { zeg = f; },
    // Buiten de proefrit onthoudt localStorage wat er al gezegd is (herladen, tweede tabblad).
    bewaarGezegd: function (b) { bewaren = !!b && !!w.localStorage; },
    eenKeer: eenKeer,
    actiefTraject: function () { return traject; },
    data: function () { return data; }
  };
})(window);
