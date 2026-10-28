// Gemelde mobiele flitsers: melden met één tik, ophalen per kaartvak, een melding vooraf zoals bij
// een vaste paal, en na het langsrijden de vraag "Staat hij er nog?". De server staat onder /api op
// dezelfde site (referentie/server/server.mjs). Geen account: een toestel-id dat de server uitgeeft
// (POST api/toestel, ondertekend, bij de eerste melding of stem) en dat in deze browser blijft; de
// server bewaart het alleen gehasht met een dagzout.
(function (w) {
  "use strict";
  var G = w.Geo;
  var VAK_LAT = 0.2, VAK_LON = 0.3; // gelijk aan server/server.mjs
  var VERVERS_MS = 60000; // per vak elke minuut opnieuw
  var EIGEN_NA_MS = 20 * 60000, EIGEN_TUSSEN_MS = 20 * 60000; // gelijk aan REGELS.eigenNaMin en eigenTussenMin
  var q = new URLSearchParams(location.search);
  // L6 (review 26 okt): een proefrit speelt een nep-GPS af. Op de echte site gaan melden en stemmen
  // dan niet naar de server, zodat een gedeelde proefritlink geen meldingen of stemmen maakt;
  // lokaal (scripts/lokaal.mjs) wel, om twee gebruikers na te spelen.
  var proefOpLive = q.has("sim") && !/^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/.test(location.hostname);
  var meldingen = {}; // id -> melding van de server
  var vakken = {}; // vak -> { t, laden }
  var fase = {}; // id -> { fase: "gemeld" | "voorbij", d, min, t }
  var gevraagd = {}; // id -> 1: de vraag is al gesteld (bij een eigen melding telt elke passage apart)
  var zeg = function () {}, vraag = function () {}, log = function () {};
  var klokVerschil = 0; // servertijd min eigen tijd

  function opslag(k, v) {
    try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || "null"); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; }
  }
  // Een tweede "gebruiker" in de proefrit: ?toestel=<naam> (alleen samen met ?sim=) krijgt een eigen id.
  var ID = /^b\d{5}[0-9a-f]{40}$/; // gelijk aan TOESTEL_SERVER in server/server.mjs
  var toestelSleutel = "rijhulp-toestel" + (q.has("sim") && /^[A-Za-z0-9_-]{1,64}$/.test(q.get("toestel") || "") ? "-" + q.get("toestel") : "");
  var toestel = opslag(toestelSleutel);
  if (!ID.test(toestel || "")) toestel = null; // een oud, zelf gekozen id neemt de server niet meer aan
  var toestelVraag = null;
  /** Het id van de server, één keer gevraagd en daarna uit localStorage. */
  function zorgToestel(opnieuw) {
    if (toestel && !opnieuw) return Promise.resolve(toestel);
    if (toestelVraag) return toestelVraag;
    toestelVraag = fetch("api/toestel", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok || !ID.test(j.toestel || "")) throw new Error(j.fout || "http_" + r.status); return j.toestel; }); })
      .then(function (id) { toestel = id; opslag(toestelSleutel, id); toestelVraag = null; return id; }, function (e) { toestelVraag = null; throw e; });
    return toestelVraag;
  }
  /** POST met het toestel-id; weigert de server het id, dan één keer een nieuw vragen. */
  function postMetToestel(pad, velden) {
    function stuur(id) {
      var b = { toestel: id }; for (var k in velden) b[k] = velden[k];
      return fetch(pad, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, j: j }; }); });
    }
    return zorgToestel().then(stuur).then(function (x) {
      if (x.status === 400 && x.j && x.j.fout === "toestel") return zorgToestel(true).then(stuur);
      return x;
    });
  }
  var eigenSleutel = "rijhulp-eigen" + (q.has("sim") && q.get("toestel") ? "-" + q.get("toestel") : "");
  var eigen = opslag(eigenSleutel) || {}; // id -> verloopt: eigen meldingen (vraag pas na 20 min, de server weigert ook eerder)
  var gestemdSleutel = "rijhulp-gestemd" + (q.has("sim") && q.get("toestel") ? "-" + q.get("toestel") : "");
  var gestemd = opslag(gestemdSleutel) || {}; // id -> tijd van de laatste stem

  function nu() { return Date.now() + klokVerschil; }
  function vakVan(lat, lon) { return Math.floor(lat / VAK_LAT) + "_" + Math.floor(lon / VAK_LON); }

  function haalVak(vak) {
    var v = vakken[vak] || (vakken[vak] = { t: 0, laden: false });
    if (v.laden || Date.now() - v.t < VERVERS_MS) return;
    v.laden = true;
    fetch("api/meldingen?vak=" + vak, { cache: "no-store" }).then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); }).then(function (j) {
      v.t = Date.now(); v.laden = false;
      if (j.nu) klokVerschil = j.nu - Date.now();
      // Wat de server in dit vak niet meer heeft, is verlopen of weggestemd.
      for (var id in meldingen) if (meldingen[id].vak === vak && !j.meldingen.some(function (m) { return String(m.id) === id; })) delete meldingen[id];
      j.meldingen.forEach(function (m) { m.vak = vak; meldingen[m.id] = m; });
      log("gemeld: vak " + vak + " " + j.meldingen.length);
    }).catch(function (e) { v.laden = false; v.t = Date.now() - VERVERS_MS + 15000; log("gemeld ophalen: " + e.message); });
  }
  /** Het vak onder de auto, en de buren als de rand dichter dan ca. 3 km is. */
  function vraagRond(lat, lon) {
    var a = Math.floor(lat / VAK_LAT), b = Math.floor(lon / VAK_LON);
    var fl = lat / VAK_LAT - a, fo = lon / VAK_LON - b;
    var rl = 0.03 / VAK_LAT, ro = 0.045 / VAK_LON;
    var dl = [0], dO = [0];
    if (fl < rl) dl.push(-1); else if (fl > 1 - rl) dl.push(1);
    if (fo < ro) dO.push(-1); else if (fo > 1 - ro) dO.push(1);
    dl.forEach(function (x) { dO.forEach(function (y) { haalVak((a + x) + "_" + (b + y)); }); });
  }

  function vooruit(d, b, koers) {
    var hoek = G.verschil(koers, b);
    var opzij = d * Math.sin(Math.min(hoek, 90) * Math.PI / 180);
    if (hoek > 60) return false;
    return opzij < 35 || hoek < 12;
  }

  /** Eigen melding: één vraag per passage, maar niet binnen 20 min na het melden en niet binnen
   *  20 min na de vorige stem (mobiele flitsers staan niet vast, en soms rijdt alleen de melder er). */
  function eigenVraag(m, t) {
    return t - m.gemaakt >= EIGEN_NA_MS && !(gestemd[m.id] && Date.now() - gestemd[m.id] < EIGEN_TUSSEN_MS);
  }

  /** Eén stap, net als Flitsers.stap: { gemeld: { d, min, id } | null }. */
  function stap(p, aan) {
    var uit = { gemeld: null };
    if (!aan) return uit;
    vraagRond(p.lat, p.lon);
    if (p.koers == null || p.kmh < 8) return uit;
    var t = nu(), dichtst = null;
    for (var id in meldingen) {
      var m = meldingen[id];
      if (m.verloopt <= t) { delete meldingen[id]; continue; }
      if (Math.abs(m.lat - p.lat) > 0.012 || Math.abs(m.lon - p.lon) > 0.02) continue;
      var d = G.afstand(p.lat, p.lon, m.lat, m.lon);
      if (d > 1200) continue;
      var st = fase[id];
      if (st && p.t - st.t > 600000) { delete fase[id]; st = null; }
      if (st && st.fase === "voorbij") continue;
      if (st && st.fase === "gemeld") {
        st.min = Math.min(st.min, d);
        if (d < 30 || (st.min < 150 && d > st.min + 25) || d > st.d + 300) {
          st.fase = "voorbij"; st.t = p.t;
          if (eigen[id] ? eigenVraag(m, t) : !gestemd[id] && !gevraagd[id]) { gevraagd[id] = 1; vraag(m); }
          continue;
        }
      } else {
        var b = G.peiling(p.lat, p.lon, m.lat, m.lon);
        var ziet = d < 25 || vooruit(d, b, p.koers);
        var goedeKant = m.koers == null || G.verschil(p.koers, m.koers) < 50;
        if (!ziet || !goedeKant) continue;
        var grens = p.kmh >= 80 ? 500 : p.kmh >= 50 ? 300 : 150;
        if (d <= grens) {
          var stappen = [500, 300, 150], keuze = null;
          for (var k = 0; k < stappen.length; k++) if (d + 40 >= stappen[k]) { keuze = stappen[k]; break; }
          // Hooguit een keer per plek, ook na herladen of met een tweede tabblad (Flitsers.eenKeer).
          var mag = !w.Flitsers || !w.Flitsers.eenKeer || w.Flitsers.eenKeer("gemeld", m.lat, m.lon, m.koers, p.t, 240000, 60);
          if (mag) zeg(keuze ? ["gong", "gemeld_" + keuze] : ["gong"], true);
          fase[id] = st = { fase: "gemeld", t: p.t, d: d, min: d };
        }
      }
      if (st && st.fase === "gemeld" && (!dichtst || d < dichtst.d)) dichtst = { d: d, id: m.id, min: Math.max(0, Math.round((t - m.gemaakt) / 60000)), bevestigd: m.laatste_ja ? Math.max(0, Math.round((t - m.laatste_ja) / 60000)) : null };
    }
    if (dichtst) uit.gemeld = { d: Math.round(dichtst.d / 10) * 10, min: dichtst.min, bevestigd: dichtst.bevestigd, id: dichtst.id };
    return uit;
  }

  /** Eén tik op "Flitser hier". p: { lat, lon, koers, acc }. Geeft een belofte met { ok, code }. */
  function meld(p) {
    if (!p) return Promise.resolve({ ok: false, code: "geen_positie" });
    if (proefOpLive) { log("proefrit: melding niet verstuurd"); return Promise.resolve({ ok: false, code: "proefrit" }); }
    return postMetToestel("api/meldingen", { lat: p.lat, lon: p.lon, koers: p.koers == null ? null : Math.round(p.koers), nauwkeurig: p.acc == null ? null : Math.round(p.acc) })
      .then(function (x) {
        if (x.status === 201 || x.status === 200) {
          var m = x.j.melding; m.vak = vakVan(m.lat, m.lon); meldingen[m.id] = m;
          // Samengevoegd is een ja op die melding (van een ander of van jezelf), anders een eigen melding.
          if (x.j.samengevoegd) { gestemd[m.id] = Date.now(); opslag(gestemdSleutel, gestemd); }
          else { eigen[m.id] = m.verloopt; opslag(eigenSleutel, eigen); }
          fase[m.id] = { fase: "voorbij", t: Date.now(), d: 0, min: 0 }; // je staat er net: niet aankondigen
          return { ok: true, samengevoegd: !!x.j.samengevoegd, id: m.id };
        }
        return { ok: false, code: x.j.fout || "http_" + x.status };
      }, function (e) { return { ok: false, code: e && /^(dag_vol|te_snel|te_veel)$/.test(e.message) ? (e.message === "dag_vol" ? "dag_vol" : "te_snel") : "netwerk" }; });
  }
  function stem(id, ja) {
    gestemd[id] = Date.now(); opslag(gestemdSleutel, gestemd);
    if (proefOpLive) { log("proefrit: stem niet verstuurd"); return Promise.resolve({ status: 0, proefrit: true }); }
    return postMetToestel("api/meldingen/" + id + "/stem", { ja: !!ja })
      .then(function (x) {
        if (x.j && x.j.melding) { if (x.j.melding.weg) delete meldingen[id]; else if (meldingen[id]) { x.j.melding.vak = meldingen[id].vak; meldingen[id] = x.j.melding; } }
        return x;
      }, function () { return { status: 0 }; });
  }
  // Oude eigen ids en stemmen opruimen.
  (function () { var t = Date.now(); for (var k in eigen) if (eigen[k] < t - 86400000) delete eigen[k]; for (var s in gestemd) if (gestemd[s] < t - 86400000) delete gestemd[s]; })();

  w.Gemeld = {
    stap: stap, meld: meld, stem: stem, vraagRond: vraagRond,
    opZeg: function (f) { zeg = f; }, opVraag: function (f) { vraag = f; }, opLog: function (f) { log = f; },
    lijst: function () { return meldingen; }, toestel: function () { return toestel; },
    _ververs: function () { for (var v in vakken) vakken[v].t = 0; }
  };
})(window);
