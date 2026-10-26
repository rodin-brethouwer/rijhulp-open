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
        });
        return { camera: j.c.length, trajecten: j.t.length, stand: j.stand };
      });
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
          zeg(keuze ? ["gong", (rood ? "rood_" : "flitser_") + keuze] : ["gong"], true);
          gemeld[i] = st = { fase: "gemeld", t: nu, d: d, min: d };
        }
      }
      if (!dichtst || d < dichtst.d) dichtst = { soort: c[2], d: d, max: c[3] };
    }
    if (dichtst && dichtst.d <= 1000) uit.camera = { soort: dichtst.soort, d: Math.round(dichtst.d / 10) * 10, max: dichtst.max };

    // ---------- Trajectcontrole ----------
    var datum = new Date(nu);
    if (traject) {
      var t = data.t[traject.i];
      var stapM = G.afstand(traject.lat, traject.lon, p.lat, p.lon);
      var dt = (nu - traject.vorigeT) / 1000;
      // Een sprong (GPS of een bevroren pagina): reken met de snelheid als de stap niet klopt.
      if (dt > 0 && stapM / dt > 70) stapM = (v / 3.6) * dt;
      traject.m += stapM; traject.lat = p.lat; traject.lon = p.lon; traject.vorigeT = nu;
      var sec = (nu - traject.t0) / 1000;
      var gem = sec > 3 ? (traject.m / sec) * 3.6 : v;
      var dEind = G.afstand(p.lat, p.lon, traject.eind[0], traject.eind[1]);
      var naast = afstandTotTraject(t, p.lat, p.lon) > 80;
      traject.naast = naast ? traject.naast || nu : 0;
      var lim = traject.limiet;
      // Gemiddelde te hoog: één keer per keer dat het erboven komt.
      if (lim && gem > lim + 1 && sec > 20 && !traject.teHoog) { traject.teHoog = true; zeg(["let", "te_hoog"], false); }
      if (lim && gem < lim - 1) traject.teHoog = false;
      // Elke 3 km het gemiddelde.
      if (traject.m - traject.laatsteMelding > 3000 && dEind > 600) {
        traject.laatsteMelding = traject.m;
        var n = w.Geluid.getal(gem);
        if (n) zeg(["zacht", "gemiddeld", n], false);
      }
      var klaar = dEind < 40 || (traject.minEind < 150 && dEind > traject.minEind + 30);
      traject.minEind = Math.min(traject.minEind, dEind);
      if (klaar || (traject.naast && nu - traject.naast > 15000)) {
        var gemEind = Math.round(gem);
        if (klaar) {
          laatsteEinde = { lat: traject.eind[0], lon: traject.eind[1], t: nu, gem: gemEind };
          var volgt = volgendTraject(p, t, traject.eind);
          var ne = w.Geluid.getal(gemEind);
          if (volgt == null) zeg(ne ? ["gong", "traject_eind", "gemiddeld", ne] : ["gong", "traject_eind"], false);
          else if (ne) zeg(["zacht", "gemiddeld", ne], false);
          traject = null;
          if (volgt != null) begin(volgt, p, true);
        } else traject = null; // van het traject af gereden: stil stoppen
      } else {
        uit.traject = { naam: t.n, gem: Math.round(gem), limiet: lim, rest: Math.max(0, Math.round((t.km * 1000 - traject.m) / 100) / 10), sec: Math.round(sec) };
      }
      return uit;
    }
    // Niet actief: aankondigen en beginnen.
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
        if (dA < 45) { begin(j, p, false, q === 1); return uit; }
        if (!vooruit(dA, bA, p.koers)) continue;
        var ag = trajectGemeld[j];
        if (ag && nu - ag > 600000) { delete trajectGemeld[j]; ag = null; }
        if (!ag) {
          var drempel = v >= 80 ? 1000 : 500;
          if (dA <= drempel) {
            zeg(["gong", dA + 60 >= 1000 ? "traject_1000" : "traject_500"], true);
            trajectGemeld[j] = nu;
          }
        }
        if (dA <= 1000) uit.traject = { komt: true, d: Math.round(dA / 10) * 10, limiet: limietVanTraject(tr, datum), naam: tr.n };
      }
    }
    return uit;
  }
  function volgendTraject(p, vorig, eind) {
    for (var j = 0; j < data.t.length; j++) {
      var t = data.t[j];
      if (t === vorig || t.r) continue;
      if (G.afstand(eind[0], eind[1], t.a[0], t.a[1]) < 60 && G.verschil(t.beginRichting, p.koers) < 50) return j;
    }
    return null;
  }
  function begin(j, p, stil, omgekeerd) {
    var t = data.t[j];
    var lim = limietVanTraject(t, new Date(p.t));
    traject = { i: j, eind: omgekeerd ? t.a : t.b, t0: p.t, m: 0, lat: p.lat, lon: p.lon, vorigeT: p.t, limiet: lim, laatsteMelding: 0, minEind: Infinity, teHoog: false, naast: 0, omgekeerd: !!omgekeerd };
    trajectGemeld[j] = p.t;
    if (!stil) {
      var n = lim && w.Geluid.getal(lim);
      zeg(n ? ["gong", "traject_start", "limiet", n] : ["gong", "traject_start"], true);
    }
  }

  w.Flitsers = {
    laad: laad,
    stap: stap,
    opZeg: function (f) { zeg = f; },
    actiefTraject: function () { return traject; },
    data: function () { return data; }
  };
})(window);
