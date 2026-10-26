// Matrixborden (MSI) op de snelweg: de maximumsnelheid en de rode kruizen die nu boven de weg
// staan. Open data van NDW (CC0 1.0). De plek van elk bord staat vooraf in msi/<vak>.json
// (scripts/bouw-msi.mjs, uit de locatietabel van NDW); wat er nu op staat haalt de app elke
// minuut bij de eigen servercode (api/msi?vak=, server/server.mjs), want de feed van NDW heeft geen
// CORS en geen coordinaten.
//
// Hoe het werkt: de borden van één portaal (zelfde plek, één per rijstrook) vormen samen een
// portaal. Rijdt de auto onder een portaal door in dezelfde richting, dan geldt wat daar staat:
// een getal met rode rand is de limiet tot het volgende portaal (dat een ander getal kan tonen,
// of niets, en dan geldt weer de vaste limiet). Een getal zonder rode rand is een advies. Na
// 2,5 km zonder portaal, of als de auto de weg verlaat, vervalt de matrixlimiet ook.
// Een gesproken melding alleen als het portaal dat eraan komt een lagere limiet toont dan nu geldt.
(function (w) {
  "use strict";
  var G = w.Geo;
  var VAK_LAT = 0.2, VAK_LON = 0.3; // gelijk aan de kaart, de meldingen en server/server.mjs
  var VERVERS_MS = 60000; // wat er op de borden staat: elke minuut
  var OUD_MS = 10 * 60000; // een feed ouder dan tien minuten telt niet
  var MAX_NA_M = 2500; // zo ver na het laatste portaal vervalt de matrixlimiet
  var ZEG_M = 350; // de melding vooraf: zo ver voor het portaal
  var TOON_M = 600; // de stroken van het portaal dat eraan komt: vanaf zo ver
  var rad = Math.PI / 180;
  var index = null, indexBezig = false, indexNa = 0;
  var vakken = {}; // vak -> { portalen: [...] } | "laden" | "mislukt"
  var beelden = {}; // vak -> { t, bron, borden: { id: code }, laden }
  var vorig = {}; // portaal-sleutel -> voor (m) bij de vorige stap
  var gezegd = {}; // portaal-sleutel -> tijd van de melding vooraf
  var actief = null; // { v, advies, g, m, uitT }
  var laatst = null; // { g, b, m }: het laatst gepasseerde portaal, om de stroken nog even te tonen
  var vorigePos = null;
  var wacht = []; // net gepasseerde portalen: { g, opzij, m }; na 40 m telt de dichtste
  var zeg = function () {}, log = function () {};

  function vakVan(lat, lon) { return Math.floor(lat / VAK_LAT) + "_" + Math.floor(lon / VAK_LON); }

  function laadIndex() {
    if (index || indexBezig || Date.now() < indexNa) return;
    indexBezig = true;
    fetch("msi/index.json").then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (j) { index = { stand: j.stand, vakken: {} }; j.vakken.forEach(function (v) { index.vakken[v] = 1; }); indexBezig = false; log("matrix: " + j.vakken.length + " vakken, stand " + j.stand); })
      .catch(function (e) { indexBezig = false; indexNa = Date.now() + 30000; log("matrix index: " + e.message); });
  }

  /** De borden van een vak, gegroepeerd per portaal (zelfde plek, baan en richting). */
  function laadVak(vak) {
    if (!index || !index.vakken[vak] || vakken[vak]) return;
    vakken[vak] = "laden";
    fetch("msi/" + vak + ".json?s=" + encodeURIComponent(index.stand)).then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (j) {
        var per = {};
        j.b.forEach(function (b) {
          // [id, lat, lon, peiling, weg, baan, strook, km]
          var k = b[1] + "," + b[2] + "," + b[5] + "," + b[3];
          var g = per[k] || (per[k] = { k: k, vak: vak, lat: b[1], lon: b[2], peiling: b[3], weg: b[4], baan: b[5], km: b[7], borden: [] });
          g.borden.push({ id: b[0], strook: b[6] });
        });
        var lijst = [];
        for (var k in per) { per[k].borden.sort(function (a, c) { return a.strook - c.strook; }); lijst.push(per[k]); }
        vakken[vak] = { portalen: lijst };
        log("matrix: vak " + vak + " " + lijst.length + " portalen");
      })
      .catch(function (e) { vakken[vak] = "mislukt"; log("matrix vak " + vak + ": " + e.message); setTimeout(function () { if (vakken[vak] === "mislukt") delete vakken[vak]; }, 30000); });
  }

  function haalBeelden(vak) {
    if (!index || !index.vakken[vak]) return;
    var b = beelden[vak] || (beelden[vak] = { t: 0, bron: 0, borden: null, laden: false });
    if (b.laden || Date.now() - b.t < VERVERS_MS) return;
    b.laden = true;
    fetch("api/msi?vak=" + vak, { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (j) {
        b.laden = false; b.t = Date.now(); b.borden = j.borden || {};
        // De tijd van de feed naar de eigen klok: de server geeft zijn eigen tijd mee.
        b.bron = j.bron ? Date.now() - Math.max(0, (j.nu || j.bron) - j.bron) : 0;
        log("matrix: beelden " + vak + " " + Object.keys(b.borden).length);
      })
      .catch(function (e) { b.laden = false; b.t = Date.now() - VERVERS_MS + 20000; log("matrix beelden: " + e.message); });
  }

  /** Het vak onder de auto, en de buren als de rand dichter dan ca. 2 km is. */
  function vakkenRond(lat, lon) {
    var a = Math.floor(lat / VAK_LAT), c = Math.floor(lon / VAK_LON);
    var fl = lat / VAK_LAT - a, fo = lon / VAK_LON - c;
    var dl = [0], dO = [0];
    if (fl < 0.09) dl.push(-1); else if (fl > 0.91) dl.push(1);
    if (fo < 0.1) dO.push(-1); else if (fo > 0.9) dO.push(1);
    var uit = [];
    dl.forEach(function (x) { dO.forEach(function (y) { uit.push((a + x) + "_" + (c + y)); }); });
    return uit;
  }

  /** De auto ten opzichte van een portaal, langs de richting van het portaal: voor > 0 is het
   *  portaal nog voor de auto, opzij is de afstand tot de lijn door het portaal. */
  function tov(p, g) {
    var kx = Math.cos(g.lat * rad) * 111320, ky = 110540;
    var x = (p.lon - g.lon) * kx, y = (p.lat - g.lat) * ky;
    var ux = Math.sin(g.peiling * rad), uy = Math.cos(g.peiling * rad);
    return { voor: -(x * ux + y * uy), opzij: Math.abs(x * uy - y * ux) };
  }

  /** Wat het portaal nu toont: { bekend, v (rode rand, laagste), advies, stroken: [code per strook] }. */
  function beeldVan(g) {
    var b = beelden[g.vak];
    if (!b || !b.borden || !b.bron || Date.now() - b.bron > OUD_MS || Date.now() - b.t > 3 * VERVERS_MS) return { bekend: false, stroken: [] };
    var v = null, advies = null, iets = false;
    var stroken = g.borden.map(function (x) {
      var c = b.borden[x.id] || "";
      var m = /^(a?)(\d+)/.exec(c);
      if (m && m[1]) advies = advies == null ? +m[2] : Math.min(advies, +m[2]);
      else if (m) v = v == null ? +m[2] : Math.min(v, +m[2]);
      if (c) iets = true;
      return c;
    });
    return { bekend: true, v: v, advies: advies, iets: iets, stroken: stroken };
  }

  function portalenRond(p) {
    var uit = [];
    vakkenRond(p.lat, p.lon).forEach(function (vak) {
      var v = vakken[vak];
      if (!v || !v.portalen) return;
      for (var i = 0; i < v.portalen.length; i++) {
        var g = v.portalen[i];
        if (Math.abs(g.lat - p.lat) < 0.009 && Math.abs(g.lon - p.lon) < 0.014) uit.push(g);
      }
    });
    return uit;
  }

  /**
   * Eén stap, net als Flitsers.stap. p: { lat, lon, kmh, koers, t, limiet (wat nu op het bord staat) }.
   * aan: alleen in NL. Geeft { limiet: { v, matrix } | null, advies, portaal: { stroken, d, voorbij } | null }.
   */
  function stap(p, aan) {
    var uit = { limiet: null, advies: null, portaal: null };
    if (!aan) { actief = null; laatst = null; vorigePos = null; wacht = []; return uit; }
    laadIndex();
    if (!index) return uit;
    vakkenRond(p.lat, p.lon).forEach(function (v) { laadVak(v); haalBeelden(v); });
    var stapM = vorigePos ? G.afstand(vorigePos.lat, vorigePos.lon, p.lat, p.lon) : 0;
    vorigePos = { lat: p.lat, lon: p.lon };
    if (actief) {
      actief.m += stapM;
      // De weg verlaten (een afrit) of lang geen portaal: dan geldt weer de vaste limiet.
      if (p.koers != null && p.kmh > 10 && G.verschil(p.koers, actief.g.peiling) > 60) { if (!actief.uitT) actief.uitT = p.t; }
      else actief.uitT = 0;
      if (actief.m > MAX_NA_M || (actief.uitT && p.t - actief.uitT > 4000)) { log("matrix: limiet " + actief.v + " vervalt na " + Math.round(actief.m) + " m"); actief = null; }
    }
    if (laatst) laatst.m += stapM;
    wacht.forEach(function (x) { x.m += stapM; });
    if (p.koers == null || p.kmh < 10) { vul(uit, null); return uit; }

    var komend = null, nu = {};
    portalenRond(p).forEach(function (g) {
      var hoek = G.verschil(p.koers, g.peiling);
      if (hoek > 25) return;
      var r = tov(p, g);
      nu[g.k] = r.voor;
      var was = vorig[g.k];
      // Onder het portaal door: van voor naar achter, dicht bij de lijn door het portaal en in
      // zijn richting. Een portaal staat haaks op de weg, met het punt op de as van zijn baan;
      // een afrit of verbindingsweg ernaast wijkt in richting of afstand af. Staan er twee vlak
      // na elkaar (een verbindingsweg die naast de hoofdbaan loopt), dan telt na 40 m de dichtste.
      if (was != null && was > 0 && r.voor <= 0 && r.opzij < 16 && hoek < 20) wacht.push({ g: g, opzij: r.opzij + hoek * 0.3, m: 0 });
      if (r.voor > 0 && r.voor < 900 && r.opzij < 16 + 0.08 * r.voor) {
        // Het eerstvolgende portaal, maar een portaal vlak naast de weg (een verbindingsweg die
        // ernaast loopt) telt zwaar mee: per meter opzij vijf meter verder weg.
        var score = r.voor + 5 * r.opzij;
        if (!komend || score < komend.score) komend = { g: g, voor: r.voor, opzij: r.opzij, score: score };
      }
    });
    vorig = nu;
    if (wacht.length && wacht[0].m >= 40) {
      var beste = wacht.reduce(function (a, c) { return c.opzij < a.opzij ? c : a; });
      if (wacht.length > 1) log("matrix: " + wacht.length + " portalen vlak na elkaar, " + beste.g.weg + " " + beste.g.baan + " telt (" + wacht.map(function (x) { return x.g.weg + x.g.baan + " " + x.opzij.toFixed(1); }).join(", ") + ")");
      wacht = [];
      doorgang(beste.g, p);
    }

    if (komend && komend.voor <= ZEG_M && !gezegd[komend.g.k]) {
      var b = beeldVan(komend.g);
      if (b.bekend) {
        gezegd[komend.g.k] = p.t;
        var huidig = actief && actief.v ? actief.v : p.limiet;
        if (b.v && huidig && b.v < huidig) {
          var n = w.Geluid && w.Geluid.getal ? w.Geluid.getal(b.v) : "n" + b.v;
          zeg(n ? ["gong", "matrix_limiet", n] : ["gong", "matrix_limiet"], true);
          log("matrix: " + b.v + " over " + Math.round(komend.voor) + " m (nu " + huidig + ")");
        }
      }
    }
    for (var k in gezegd) if (p.t - gezegd[k] > 600000) delete gezegd[k];
    vul(uit, komend);
    return uit;
  }

  function doorgang(g, p) {
    var b = beeldVan(g);
    laatst = { g: g, b: b, m: 0 };
    if (!b.bekend) { if (actief) log("matrix: portaal " + g.weg + " " + g.baan + " km " + g.km + " onbekend, terug naar de vaste limiet"); actief = null; return; }
    if (b.v || b.advies) {
      if (!actief || actief.v !== b.v || actief.advies !== b.advies) log("matrix: portaal " + g.weg + " " + g.baan + " km " + g.km + ": " + (b.v ? b.v : "advies " + b.advies));
      actief = { v: b.v, advies: b.advies, g: g, m: 0, uitT: 0 };
    } else {
      if (actief) log("matrix: portaal " + g.weg + " " + g.baan + " km " + g.km + " zonder limiet, einde matrixlimiet");
      actief = null;
    }
  }

  function vul(uit, komend) {
    if (actief && actief.v) uit.limiet = { v: actief.v, matrix: true };
    if (actief && actief.advies && (!actief.v || actief.advies < actief.v)) uit.advies = actief.advies;
    // De stroken: het portaal dat eraan komt, of het vorige nog 150 m na het doorrijden.
    if (komend && komend.voor <= TOON_M) {
      var b = beeldVan(komend.g);
      if (b.bekend && b.iets) uit.portaal = { stroken: b.stroken, d: Math.round(komend.voor / 10) * 10, weg: komend.g.weg, km: komend.g.km };
    }
    if (!uit.portaal && laatst && laatst.m < 150 && laatst.b.bekend && laatst.b.iets) uit.portaal = { stroken: laatst.b.stroken, d: 0, voorbij: true, weg: laatst.g.weg, km: laatst.g.km };
  }

  w.Matrix = {
    stap: stap,
    opZeg: function (f) { zeg = f; }, opLog: function (f) { log = f; },
    staat: function () { return { index: !!index, vakken: Object.keys(vakken).length, actief: actief ? { v: actief.v, advies: actief.advies, weg: actief.g.weg, km: actief.g.km, m: Math.round(actief.m) } : null }; },
    _ververs: function () { for (var v in beelden) beelden[v].t = 0; }
  };
})(window);
