// Maximumsnelheid van de weg onder de auto, uit OpenStreetMap.
// Eerst de kaart die vooraf is gemaakt (kaart/<vak>.json, 10 x 10 tegels per bestand, voor de
// landen uit je extracten; scripts/bouw-kaart.mjs): die komt van de eigen site en de service worker bewaart
// hem offline. Alleen waar geen vooraf gemaakt vak is (buiten de vooraf gemaakte landen, of als de index niet
// te laden is) vraagt de app de tegel live op bij de Overpass API: per tegel van ca. 2 x 2 km
// één verzoek, hooguit één tegelijk, en 30 dagen in IndexedDB.
// Data: (c) OpenStreetMap-bijdragers, ODbL.
(function (w) {
  "use strict";
  var G = w.Geo;
  var TLAT = 0.02, TLON = 0.03; // tegel
  var GROEP = 10; // tegels per vak in elke richting (vooraf gemaakte kaart, ca. 22 x 20 km)
  var BLAT = 0.002, BLON = 0.003; // vakje voor het zoeken
  var BEWAAR_MS = 30 * 24 * 3600 * 1000;
  var VAK_TIJD_MS = 15000; // een vooraf gemaakt vak hoort er binnen een paar seconden te zijn
  var OVERPASS_TIJD_MS = 45000;
  var SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
  var WEGEN = "motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|road";

  var tegels = {}; // sleutel -> "laden" | { t, n, bron }
  var sinds = {}; // sleutel -> eerste keer gevraagd (ms), voor de meldingen
  var mislukt = {}; // sleutel -> aantal mislukte pogingen
  var vakjes = {}; // vaksleutel -> [ [wegIndex, aLat, aLon, bLat, bLon], ... ]
  var wegen = []; // alle geladen wegen: { id, m, mf, mb, mc, o, h, zt, zm }
  var wegIds = {}; // id of lijn -> 1: een weg over de rand van een vak staat in beide bestanden
  var rij = []; // wachtrij met tegelsleutels voor Overpass
  var db = null;
  var log = function () {};

  function tegelVan(lat, lon) { return Math.floor(lat / TLAT) + "_" + Math.floor(lon / TLON); }
  function vakVan(lat, lon) { return Math.floor(lat / BLAT) + "_" + Math.floor(lon / BLON); }
  function groepVanTegel(k) { var d = k.split("_"); return Math.floor(+d[0] / GROEP) + "_" + Math.floor(+d[1] / GROEP); }

  function metTijd(url, opties, ms) {
    var stop = typeof AbortController !== "undefined" ? new AbortController() : null;
    var klok = stop && setTimeout(function () { stop.abort(); }, ms);
    opties = opties || {};
    if (stop) opties.signal = stop.signal;
    return fetch(url, opties).then(function (r) { if (klok) clearTimeout(klok); return r; }, function (e) { if (klok) clearTimeout(klok); throw e; });
  }

  // ---------- IndexedDB (alleen voor Overpass-tegels) ----------
  function openDb() {
    return new Promise(function (ok) {
      try {
        var r = indexedDB.open("rijhulp", 1);
        r.onupgradeneeded = function () { r.result.createObjectStore("tegels"); };
        r.onsuccess = function () { db = r.result; ok(); };
        r.onerror = function () { ok(); };
        setTimeout(ok, 3000); // Safari laat open() soms hangen: dan zonder cache
      } catch (e) { ok(); }
    });
  }
  function uitDb(k) {
    return new Promise(function (ok) {
      if (!db) return ok(null);
      try {
        var r = db.transaction("tegels").objectStore("tegels").get(k);
        r.onsuccess = function () { ok(r.result || null); };
        r.onerror = function () { ok(null); };
      } catch (e) { ok(null); }
    });
  }
  function naarDb(k, v) {
    if (!db) return;
    try { db.transaction("tegels", "readwrite").objectStore("tegels").put(v, k); } catch (e) { /* vol of privé: dan zonder cache */ }
  }

  // ---------- Wegen in het zoekraster ----------
  function plaatsWegen(lijst) {
    lijst.forEach(function (wg) {
      var sleutel = wg.id || wg.lijn;
      if (sleutel && wegIds[sleutel]) return;
      if (sleutel) wegIds[sleutel] = 1;
      var idx = wegen.length;
      wegen.push(wg);
      var p = wg.p;
      for (var i = 2; i < p.length; i += 2) {
        var seg = [idx, p[i - 2], p[i - 1], p[i], p[i + 1]];
        // In elk vakje dat het lijnstuk raakt: een punt per ca. 50 m langs het stuk.
        var ks = {};
        var n = Math.max(1, Math.ceil(G.afstand(p[i - 2], p[i - 1], p[i], p[i + 1]) / 50));
        for (var f = 0; f <= n; f++) ks[vakVan(p[i - 2] + (p[i] - p[i - 2]) * f / n, p[i - 1] + (p[i + 1] - p[i - 1]) * f / n)] = 1;
        for (var v in ks) (vakjes[v] || (vakjes[v] = [])).push(seg);
      }
    });
  }
  function plaats(k, lijst, bron) {
    tegels[k] = { t: Date.now(), n: lijst.length, bron: bron };
    delete mislukt[k];
    plaatsWegen(lijst);
  }

  // ---------- Vooraf gemaakte kaart ----------
  var index = null; // { stand, g: { vak: 1 } } of null zolang onbekend
  var indexMislukt = false;
  var groepen = {}; // vak -> "laden" | "klaar" | { fout: n, opnieuw: ms }
  function laadIndex() {
    var poging = 0;
    return new Promise(function (klaar) {
      (function probeer() {
        poging++;
        metTijd("kaart/index.json", {}, 10000).then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
          .then(function (j) {
            var g = {};
            (j.g || []).forEach(function (x) { g[x] = 1; });
            index = { stand: j.stand || "", g: g };
            indexMislukt = false;
            log("kaart vooraf: " + j.g.length + " vakken, stand " + j.stand);
            klaar();
          })
          .catch(function (e) {
            log("kaartindex mislukt (" + poging + "): " + e.message);
            indexMislukt = true; // tot hij er is: Overpass als terugval
            klaar();
            setTimeout(probeer, Math.min(60000, 5000 * poging));
          });
      })();
    });
  }
  /** Google-polyline (precisie 1e-5) -> [lat, lon, lat, lon, ...]. */
  function polyline(s) {
    var p = [], i = 0, la = 0, lo = 0, n = s.length;
    while (i < n) {
      for (var k = 0; k < 2; k++) {
        var v = 0, sch = 0, b;
        do { b = s.charCodeAt(i++) - 63; v |= (b & 0x1f) << sch; sch += 5; } while (b >= 0x20 && i < n);
        var d = v & 1 ? ~(v >> 1) : v >> 1;
        if (k === 0) la += d; else lo += d;
      }
      p.push(la / 1e5, lo / 1e5);
    }
    return p;
  }
  function decodeer(j) {
    var uit = [], t = j.t || [], w = j.w || [];
    for (var i = 0; i + 1 < w.length; i += 2) {
      var tg = t[w[i]] || [], p = polyline(w[i + 1]);
      if (p.length < 4) continue;
      uit.push({ lijn: w[i + 1], h: tg[0] || "", m: tg[1] || "", mf: tg[2] || "", mb: tg[3] || "", mc: tg[4] || "", o: tg[5] || "", zt: tg[6] || "", zm: tg[7] || "", p: p });
    }
    return uit;
  }
  function tegelsVanGroep(g) {
    var d = g.split("_"), gi = +d[0], gj = +d[1], uit = [];
    for (var a = 0; a < GROEP; a++) for (var b = 0; b < GROEP; b++) uit.push((gi * GROEP + a) + "_" + (gj * GROEP + b));
    return uit;
  }
  function laadGroep(g) {
    var s = groepen[g];
    if (s === "laden" || s === "klaar" || (s && Date.now() < s.opnieuw)) return;
    groepen[g] = "laden";
    var begin = Date.now();
    metTijd("kaart/" + g + ".json?s=" + encodeURIComponent(index.stand), {}, VAK_TIJD_MS)
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (j) {
        var lijst = decodeer(j);
        tegelsVanGroep(g).forEach(function (k) { tegels[k] = { t: Date.now(), n: 0, bron: "vooraf" }; delete mislukt[k]; });
        plaatsWegen(lijst);
        groepen[g] = "klaar";
        log("vak " + g + " vooraf, " + lijst.length + " wegen, " + (Date.now() - begin) + " ms");
      })
      .catch(function (e) {
        var n = (s && s.fout || 0) + 1;
        groepen[g] = { fout: n, opnieuw: Date.now() + Math.min(30000, 2000 * n) };
        tegelsVanGroep(g).forEach(function (k) { mislukt[k] = n; });
        log("vak " + g + " mislukt (" + n + "): " + e.message);
      });
  }

  // ---------- Overpass (alleen buiten de vooraf gemaakte kaart) ----------
  function vraag(k) {
    var d = k.split("_"), i = +d[0], j = +d[1];
    var s = (i * TLAT).toFixed(4), wl = (j * TLON).toFixed(4), n = ((i + 1) * TLAT).toFixed(4), e = ((j + 1) * TLON).toFixed(4);
    return "[out:json][timeout:40];way[\"highway\"~\"^(" + WEGEN + ")$\"](" + s + "," + wl + "," + n + "," + e + ");" +
      "convert w ::id=id(),::geom=geom(),m=t[\"maxspeed\"],mf=t[\"maxspeed:forward\"],mb=t[\"maxspeed:backward\"],mc=t[\"maxspeed:conditional\"]," +
      "o=t[\"oneway\"],h=t[\"highway\"],zt=t[\"zone:traffic\"],zm=t[\"zone:maxspeed\"];out geom;";
  }
  function compact(json) {
    var uit = [];
    (json.elements || []).forEach(function (el) {
      var g = el.geometry && el.geometry.coordinates;
      if (!g || g.length < 2) return;
      var t = el.tags || {}, p = [];
      for (var i = 0; i < g.length; i++) p.push(Math.round(g[i][1] * 1e6) / 1e6, Math.round(g[i][0] * 1e6) / 1e6);
      uit.push({ id: el.id, m: t.m || "", mf: t.mf || "", mb: t.mb || "", mc: t.mc || "", o: t.o || "", h: t.h || "", zt: t.zt || "", zm: t.zm || "", p: p });
    });
    return uit;
  }
  // Eén verzoek tegelijk, naar de hoofdserver. Na een fout krijgt die server een pauze (eerst
  // 10 s, na drie keer 60 s) en gaat het volgende verzoek naar de reserve. Zo hameren we nooit.
  var actief = {}, pauze = {}, foutTeller = {};
  function vrijeServer() {
    var nu = Date.now();
    for (var i = 0; i < SERVERS.length; i++) {
      var s = SERVERS[i];
      if (nu < (pauze[s] || 0)) continue; // in pauze: probeer de volgende
      return actief[s] ? null : s; // de eerste zonder pauze, of wachten tot die vrij is
    }
    return null;
  }
  var wekker = null;
  function volgende() {
    while (rij.length) {
      var k = rij[0];
      if (tegels[k]) { rij.shift(); continue; }
      var server = vrijeServer();
      if (!server) {
        // Alle servers bezig of in pauze: straks opnieuw kijken.
        if (!wekker) wekker = setTimeout(function () { wekker = null; volgende(); }, 1000);
        return;
      }
      rij.shift();
      tegels[k] = "laden";
      actief[server] = true;
      (function (k, server) {
        uitDb(k).then(function (v) {
          if (v && Date.now() - v.t < BEWAAR_MS && v.wegen && v.wegen.length) { plaats(k, v.wegen, "cache"); log("tegel " + k + " uit cache, " + v.wegen.length + " wegen"); actief[server] = false; volgende(); return; }
          haal(k, server);
        });
      })(k, server);
    }
  }
  function haal(k, server) {
    var begin = Date.now();
    metTijd(server, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(vraag(k)) }, OVERPASS_TIJD_MS)
      .then(function (r) {
        if (!r.ok) throw new Error("http " + r.status);
        return r.json();
      })
      .then(function (json) {
        // Een drukke Overpass geeft soms 200 met een lege lijst en een "runtime error": niet bewaren.
        if (json.remark && /error|timeout|out of memory/i.test(json.remark)) throw new Error(String(json.remark).slice(0, 80));
        var lijst = compact(json);
        plaats(k, lijst, "overpass");
        if (lijst.length) naarDb(k, { t: Date.now(), wegen: lijst });
        foutTeller[server] = 0;
        log("tegel " + k + " van " + server.split("/")[2] + ", " + lijst.length + " wegen, " + (Date.now() - begin) + " ms");
      })
      .catch(function (e) {
        foutTeller[server] = (foutTeller[server] || 0) + 1;
        pauze[server] = Date.now() + (foutTeller[server] >= 3 ? 60000 : 10000);
        mislukt[k] = (mislukt[k] || 0) + 1;
        log("tegel " + k + " mislukt bij " + server.split("/")[2] + " na " + (Date.now() - begin) + " ms: " + (e.name === "AbortError" ? "geen antwoord" : e.message));
        delete tegels[k];
        if (rij.indexOf(k) < 0) rij.unshift(k); // de andere server probeert het
      })
      .then(function () { actief[server] = false; volgende(); });
  }

  /** Haalt een tegel: vooraf gemaakt als dat kan, anders (en pas als de index er niet is of het vak ontbreekt) bij Overpass. */
  function vraagTegel(k, voorop) {
    if (tegels[k] && tegels[k] !== "laden") return;
    if (!sinds[k]) sinds[k] = Date.now();
    if (index) {
      var g = groepVanTegel(k);
      if (index.g[g]) { laadGroep(g); return; }
    } else if (!indexMislukt) return; // index nog onderweg: even wachten
    if (tegels[k] === "laden") return;
    var i = rij.indexOf(k);
    if (voorop) { if (i > 0) rij.splice(i, 1); if (i !== 0) rij.unshift(k); }
    else if (i < 0) rij.push(k);
  }
  /** Zorgt dat de tegel onder de auto en die vooruit er zijn. Geeft true als de tegel onder de auto er is. */
  function vraagRond(lat, lon, koers, kmh) {
    var hier = tegelVan(lat, lon), lijst = [hier];
    if (koers != null && !isNaN(koers)) {
      // Ca. 1 en 2 minuten vooruit.
      var vooruit = Math.max(1000, Math.min(2500, (kmh || 50) * 20));
      var r = koers * Math.PI / 180;
      [vooruit, vooruit * 2].forEach(function (m) {
        var la = lat + (m * Math.cos(r)) / 110540, lo = lon + (m * Math.sin(r)) / (111320 * Math.cos(lat * Math.PI / 180));
        var k = tegelVan(la, lo);
        if (lijst.indexOf(k) < 0) lijst.push(k);
      });
    }
    // De tegel onder de auto eerst, ook als er nog tegels van vooruit in de rij staan.
    lijst.forEach(function (k, n) { vraagTegel(k, n === 0); });
    volgende();
    return !!tegels[hier] && tegels[hier] !== "laden";
  }
  /** Hoe het staat met de kaart onder de auto: { klaar, wacht (ms), mislukt (pogingen), bron }. */
  function status(lat, lon) {
    var k = tegelVan(lat, lon), t = tegels[k];
    var klaar = !!t && t !== "laden";
    var bron = klaar ? t.bron : index && index.g[groepVanTegel(k)] ? "vooraf" : index || indexMislukt ? "overpass" : "index";
    return { klaar: klaar, wacht: sinds[k] ? Date.now() - sinds[k] : 0, mislukt: mislukt[k] || 0, bron: bron };
  }

  // ---------- Maximumsnelheid ----------
  var IMPLICIET = {
    "NL:urban": 50, "NL:rural": 80, "NL:motorway": 130, "NL:zone30": 30, "NL:zone60": 60, "NL:zone15": 15,
    "BE:urban": 50, "BE-VLG:urban": 50, "BE-WAL:urban": 50, "BE-BRU:urban": 30, "BE:zone30": 30, "BE:zone": 30,
    "BE-VLG:rural": 70, "BE-WAL:rural": 90, "BE:rural": 70, "BE:motorway": 120, "BE:trunk": 120,
    "DE:urban": 50, "DE:rural": 100, "FR:urban": 50, "FR:rural": 80, "FR:motorway": 130, "LU:urban": 50, "LU:rural": 90, "LU:motorway": 130
  };
  /** "80", "50 mph", "NL:urban", "none", "signals" -> { v, impliciet, variabel } of null. */
  function leesMax(s) {
    if (!s) return null;
    s = String(s).split(";")[0].trim();
    var m = /^(\d{1,3})\s*(mph)?$/.exec(s);
    if (m) return { v: m[2] ? Math.round(+m[1] * 1.609) : +m[1] };
    if (IMPLICIET[s]) return { v: IMPLICIET[s], impliciet: true };
    if (/^[A-Z]{2}(-[A-Z]+)?:zone:?(\d+)$/.test(s)) return { v: +/(\d+)$/.exec(s)[1], impliciet: true };
    if (s === "signals" || s === "variable") return { v: null, variabel: true };
    if (s === "walk") return { v: 15, impliciet: true };
    return null;
  }
  var DAG = { Mo: 1, Tu: 2, We: 3, Th: 4, Fr: 5, Sa: 6, Su: 0 };
  // Tijdvoorwaarden gaan over de tijd op de borden, niet over de klok van het toestel (een Tesla of
  // telefoon kan op UTC of een andere zone staan). NL rekent met Europe/Amsterdam, BE met
  // Europe/Brussels (dezelfde regels, maar de juiste naam); de app zet de zone bij een ander land.
  var ZONE = "Europe/Amsterdam";
  var formaten = {};
  /** De dag (0 = zondag) en de minuut van de dag in de zone, via Intl. Zonder Intl: de klok van het toestel. */
  function tijdIn(d, zone) {
    try {
      var f = formaten[zone] || (formaten[zone] = new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }));
      var x = {};
      f.formatToParts(d).forEach(function (p) { x[p.type] = p.value; });
      var dag = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[x.weekday];
      if (dag != null && x.hour != null) return { dag: dag, min: (+x.hour % 24) * 60 + +x.minute };
    } catch (e) { /* onbekende zone of geen Intl */ }
    return { dag: d.getDay(), min: d.getHours() * 60 + d.getMinutes() };
  }
  /** Klopt een eenvoudige voorwaarde zoals "Mo-Fr 06:00-10:00,15:00-19:00" of "(19:00-06:00)" nu? Anders null (onbekend). */
  function voorwaardeNu(c, d, zone) {
    // Een voorwaarde met vrije tekst ("bij grote verkeersdrukte") kunnen we niet zien: niet toepassen.
    if (/"/.test(c)) return null;
    c = c.replace(/^\(|\)$/g, "").trim();
    var m = /^(?:((?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?(?:,(?:Mo|Tu|We|Th|Fr|Sa|Su)(?:-(?:Mo|Tu|We|Th|Fr|Sa|Su))?)*)\s+)?((?:\d{1,2}:\d{2}-\d{1,2}:\d{2},?\s*)+)$/.exec(c);
    if (!m) return null;
    var nu = tijdIn(d, zone || ZONE), dag = nu.dag;
    if (m[1]) {
      var goed = m[1].split(",").some(function (r) {
        var x = r.split("-"), a = DAG[x[0]], b = x[1] != null ? DAG[x[1]] : a;
        return a <= b ? dag >= a && dag <= b : dag >= a || dag <= b;
      });
      if (!goed) return false;
    }
    var min = nu.min;
    return m[2].split(",").some(function (r) {
      var x = /(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/.exec(r);
      if (!x) return false;
      var a = +x[1] * 60 + +x[2], b = +x[3] * 60 + +x[4];
      return a <= b ? min >= a && min < b : min >= a || min < b;
    });
  }
  /** Past maxspeed:conditional toe: "130 @ (19:00-06:00); 100 @ wet" -> de eerste die nu geldt. */
  function metVoorwaarde(basis, mc, d, zone) {
    if (!mc) return basis;
    var delen = mc.split(/;(?![^(]*\))/);
    for (var i = 0; i < delen.length; i++) {
      var x = /^\s*(\d{1,3})\s*@\s*(.+)$/.exec(delen[i]);
      if (!x) continue;
      if (voorwaardeNu(x[2].trim(), d, zone) === true) return { v: +x[1], voorwaarde: true };
    }
    return basis;
  }
  function limietVan(wg, vooruit, d) {
    var tag = (vooruit ? wg.mf : wg.mb) || wg.m;
    var basis = leesMax(tag);
    if (basis && basis.v != null) basis = metVoorwaarde(basis, wg.mc, d);
    if (!basis && wg.zm) basis = leesMax(wg.zm);
    if (!basis && wg.zt) basis = leesMax(wg.zt);
    return basis;
  }

  // ---------- De weg onder de auto ----------
  // Op de snelweg liggen afritten, opritten en verbindingswegen (motorway_link, trunk_link) vaak
  // vlak naast de hoofdrijbaan, en in OSM hebben ze soms een eigen limiet zonder de tijdvoorwaarde
  // van de hoofdrijbaan (A12 bij Nootdorp en Zoetermeer: links op 130, de hoofdrijbaan 100 en
  // 's nachts 130). Een GPS die een paar meter naast de as ligt plakte de auto dan op zo'n link.
  // Twee regels daartegen:
  // 1. Hoofdrijbaan voorrang: boven 80 km/h kiest de app de hoofdrijbaan als die er ook bij past,
  //    tenzij het een echte afslag is (de koers wijkt af van de hoofdrijbaan, of de link is
  //    duidelijk dichterbij en de snelheid zakt).
  // 2. Een link nooit hoger dan zijn snelweg: de limiet van een link is hooguit de geldende limiet
  //    (met tijdvoorwaarde) van de dichtste hoofdrijbaan in dezelfde richting binnen HOOFD_M.
  var HOOFD_M = 60; // zo ver zoekt de link naar zijn hoofdrijbaan
  var VOORRANG_KMH = 80;
  var AFSLAG_HOEK = 12; // zo ver wijkt de koers af van de hoofdrijbaan bij een echte afslag
  var huidige = null; // { idx }
  var snelheden = []; // [t, kmh] van de laatste seconden, om te zien of de snelheid zakt
  function isHoofd(h) { return h === "motorway" || h === "trunk"; }
  function isLink(h) { return h === "motorway_link" || h === "trunk_link"; }
  /** Zoekt de weg onder de auto. koers in graden (of null bij stilstand), kmh de snelheid (mag ontbreken). */
  function weg(lat, lon, koers, d, kmh) {
    d = d || new Date();
    var t = d.getTime();
    if (kmh != null && !isNaN(kmh)) {
      snelheden.push([t, kmh]);
      while (snelheden.length && (t - snelheden[0][0] > 6000 || snelheden[0][0] > t)) snelheden.shift();
    }
    var bi = Math.floor(lat / BLAT), bj = Math.floor(lon / BLON);
    var beste = null, vorige = null, hoofd = [];
    for (var a = -1; a <= 1; a++) for (var b = -1; b <= 1; b++) {
      var lijst = vakjes[(bi + a) + "_" + (bj + b)];
      if (!lijst) continue;
      for (var i = 0; i < lijst.length; i++) {
        var s = lijst[i];
        var r = G.totLijnstuk(lat, lon, s[1], s[2], s[3], s[4]);
        var wg = wegen[s[0]];
        if (r.d > (isHoofd(wg.h) ? HOOFD_M : 30)) continue;
        var hoek = 0, vooruit = true;
        var eenrichting = wg.o === "yes" || wg.o === "1" || /motorway/.test(wg.h) && wg.o !== "no";
        if (koers != null) {
          var h1 = G.verschil(koers, r.richting);
          if (wg.o === "-1") { h1 = G.verschil(koers, (r.richting + 180) % 360); vooruit = false; hoek = h1; }
          else if (eenrichting) hoek = h1;
          else { vooruit = h1 <= 90; hoek = Math.min(h1, 180 - h1); }
          if (hoek > 50) continue;
        }
        var score = r.d + hoek * 0.4;
        var kand = { idx: s[0], score: score, d: r.d, hoek: hoek, vooruit: vooruit, richting: vooruit ? r.richting : (r.richting + 180) % 360, eenrichting: eenrichting || wg.o === "-1" };
        if (isHoofd(wg.h)) hoofd.push(kand);
        if (r.d > 30) continue;
        if (!beste || score < beste.score) beste = kand;
        if (huidige && s[0] === huidige.idx && (!vorige || score < vorige.score)) vorige = kand;
      }
    }
    // Plakken: blijf op dezelfde weg zolang die er nog bij past en niet duidelijk slechter is.
    var keuze = vorige && beste && vorige.score <= beste.score + 8 ? vorige : beste;
    if (!keuze) { huidige = null; return null; }
    // Hoofdrijbaan voorrang bij twijfel (regel 1).
    if (isLink(wegen[keuze.idx].h) && kmh > VOORRANG_KMH) {
      var hb = null;
      hoofd.forEach(function (k) { if (k.d <= 30 && (!hb || k.score < hb.score)) hb = k; });
      if (hb) {
        var max = 0;
        snelheden.forEach(function (x) { if (x[1] > max) max = x[1]; });
        var zakt = max - kmh >= 8;
        var afwijkt = koers != null && hb.hoek > AFSLAG_HOEK && keuze.hoek + 5 < hb.hoek;
        var dichterbij = keuze.d + 10 < hb.d;
        if (!afwijkt && !(dichterbij && zakt)) keuze = hb;
      }
    }
    huidige = { idx: keuze.idx };
    var wg = wegen[keuze.idx];
    var lim = limietVan(wg, keuze.vooruit, d);
    // Een link nooit hoger dan zijn snelweg (regel 2): de dichtste hoofdrijbaan in dezelfde richting.
    if (isLink(wg.h) && lim && lim.v != null) {
      var hr = null;
      hoofd.forEach(function (k) {
        var verschil = G.verschil(keuze.richting, k.richting);
        if (!k.eenrichting) verschil = Math.min(verschil, 180 - verschil);
        if (verschil <= 30 && (!hr || k.d < hr.d)) hr = k;
      });
      if (hr) {
        var hoofdLim = limietVan(wegen[hr.idx], hr.vooruit, d);
        if (hoofdLim && hoofdLim.v != null && hoofdLim.v < lim.v) lim = { v: hoofdLim.v, voorwaarde: hoofdLim.voorwaarde, impliciet: hoofdLim.impliciet, begrensd: lim.v };
      }
    }
    return { id: wg.id, h: wg.h, d: Math.round(keuze.d), limiet: lim };
  }

  w.Kaart = {
    start: function (logger) { if (logger) log = logger; return Promise.all([openDb(), laadIndex()]); },
    vraagRond: vraagRond,
    status: status,
    weg: weg,
    tegelVan: tegelVan,
    stand: function () { var n = 0, l = 0; for (var k in tegels) { if (tegels[k] === "laden") l++; else n++; } var vk = 0; for (var g in groepen) if (groepen[g] === "klaar") vk++; return { tegels: n, laden: l, wachtrij: rij.length, wegen: wegen.length, vakken: vk, index: index ? "ja" : indexMislukt ? "mislukt" : "laden" }; },
    /** De zone voor tijdvoorwaarden: "Europe/Amsterdam" (standaard, NL) of "Europe/Brussels" (BE). */
    zetZone: function (z) { if (z) ZONE = z; },
    zone: function () { return ZONE; },
    _leesMax: leesMax, _metVoorwaarde: metVoorwaarde
  };
})(window);
