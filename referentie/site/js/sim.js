// Proefrit zonder auto: ?sim=n209 (of a12) speelt een nep-GPS-reeks af langs een echte weg
// uit OSM (sim/<naam>.json, gemaakt door scripts/maak-simroute.mjs). &x=4 rijdt vier keer zo
// snel (de tijd in de posities loopt mee, dus gemiddelden kloppen), &kmh=70 kiest een snelheid.
// &uur=17:20 rijdt op dat uur van vandaag in Europe/Amsterdam (de tijd in de posities, dus ook de
// tijdvoorwaarden zoals "130 @ (19:00-06:00)"); een route kan zelf een "uur" hebben (sim/a12-dag.json).
// &op=1 trekt op vanuit stilstand (2,2 m/s2) tot die snelheid, voor het motorgeluid.
// &op=2 is een rit voor de turbo: flink optrekken, 5 s gas los (kruisen), afremmen tot de helft,
// 3 s kruisen, opnieuw flink optrekken, en dan kruisen.
// Tien posities per seconde, zoals de Tesla (gemeten 10 tot 12,5 per seconde).
// &ruis=1 doet de Tesla na zoals op 28 okt 2026: een tijd in de positie die tot 0,4 s heen en weer
// springt, dezelfde coordinaten tot 1,5 s herhaald, 2 m ruis opzij, af en toe een sprong van 40 m en
// na 60 s een stilte van 20 s zonder posities.
(function (w) {
  "use strict";
  var q = new URLSearchParams(location.search);
  var naam = q.get("sim");
  if (!naam || !/^[a-z0-9-]{1,30}$/.test(naam)) return;
  var x = Math.max(0.25, Math.min(20, +q.get("x") || 1));
  var op = q.get("op") === "1", op2 = q.get("op") === "2", ruis = q.get("ruis") === "1";
  var zaad = 7; function toeval() { zaad = (zaad * 16807) % 2147483647; return zaad / 2147483647; }
  var vast = null, vastTot = 0;
  var G = w.Geo;
  var kijkers = {}, volgnr = 0, route = null, kmh = 60, loopt = null, uur = null;
  var klaar = fetch("sim/" + naam + ".json").then(function (r) { return r.json(); }).then(function (j) { route = j.route; kmh = +q.get("kmh") || j.kmh; uur = q.get("uur") || j.uur || null; });
  /** Nu, verschoven naar uur ("17:20") van vandaag in Europe/Amsterdam. */
  function startTijd() {
    var m = uur && /^(\d{1,2}):(\d{2})$/.exec(uur), nu = Date.now();
    if (!m) return nu;
    try {
      var x = {};
      new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Amsterdam", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(nu)).forEach(function (p) { x[p.type] = p.value; });
      return nu + ((+m[1] * 60 + +m[2]) - ((+x.hour % 24) * 60 + +x.minute)) * 60000;
    } catch (e) { return nu; }
  }

  function start() {
    if (loopt) return;
    var begin = performance.now(), simT0 = startTijd();
    var lengtes = [0];
    for (var i = 1; i < route.length; i++) lengtes.push(lengtes[i - 1] + G.afstand(route[i - 1][0], route[i - 1][1], route[i][0], route[i][1]));
    var totaal = lengtes[lengtes.length - 1];
    var p2 = { sec: 0, m: 0, v: 0, fase: 0, sinds: 0 };
    function stap2(sec, vmax) { // de rit van op=2, stap voor stap
      var dt = sec - p2.sec; p2.sec = sec;
      var doel = [vmax, vmax, vmax * 0.45, vmax * 0.45, vmax, vmax][p2.fase], A = p2.v < doel ? 2.6 : -1.5;
      var houd = [0, 5, 0, 3, 0, 1e9][p2.fase];
      if (houd) { p2.v = doel; if (sec - p2.sinds > houd) { p2.fase++; p2.sinds = sec; } }
      else { p2.v += A * dt; if ((A > 0 && p2.v >= doel) || (A < 0 && p2.v <= doel)) { p2.v = doel; p2.fase++; p2.sinds = sec; } }
      p2.m += p2.v * dt;
      return p2;
    }
    loopt = setInterval(function () {
      var sec = ((performance.now() - begin) / 1000) * x;
      var vmax = kmh / 3.6, A = 2.2, T1 = op ? vmax / A : 0;
      var m = Math.min(totaal, sec < T1 ? 0.5 * A * sec * sec : 0.5 * A * T1 * T1 + vmax * (sec - T1));
      var v = sec < T1 ? A * sec : vmax;
      if (op2) { var r2 = stap2(sec, vmax); m = Math.min(totaal, r2.m); v = r2.v; }
      var k = 1; while (k < lengtes.length - 1 && lengtes[k] < m) k++;
      var a = route[k - 1], b = route[k], f = (m - lengtes[k - 1]) / Math.max(0.01, lengtes[k] - lengtes[k - 1]);
      var lat = a[0] + (b[0] - a[0]) * f, lon = a[1] + (b[1] - a[1]) * f;
      var ts = simT0 + sec * 1000;
      if (ruis) {
        if (sec > 60 && sec < 80) return; // stilte: de pagina of de GPS geeft niets
        if (vast && sec < vastTot) { lat = vast[0]; lon = vast[1]; }
        else {
          var kr = G.peiling(a[0], a[1], b[0], b[1]) + 90, z = (toeval() - 0.5) * 4 + (toeval() < 0.01 ? 40 : 0);
          lat += (z * Math.cos(kr * Math.PI / 180)) / 110540; lon += (z * Math.sin(kr * Math.PI / 180)) / (111320 * Math.cos(lat * Math.PI / 180));
          vast = [lat, lon]; vastTot = sec + toeval() * 1.5;
        }
        ts += (toeval() - 0.5) * 800;
      }
      var pos = { coords: { latitude: lat, longitude: lon, accuracy: 3, speed: m >= totaal ? 0 : v, heading: G.peiling(a[0], a[1], b[0], b[1]), altitude: 0, altitudeAccuracy: null }, timestamp: ts };
      for (var id in kijkers) kijkers[id](pos);
      if (m >= totaal) { clearInterval(loopt); w.__simKlaar = true; }
    }, 100);
  }
  var nep = {
    watchPosition: function (ok) { var id = ++volgnr; kijkers[id] = ok; klaar.then(start); return id; },
    clearWatch: function (id) { delete kijkers[id]; },
    getCurrentPosition: function (ok) { klaar.then(function () { ok({ coords: { latitude: route[0][0], longitude: route[0][1], accuracy: 3, speed: 0, heading: null }, timestamp: Date.now() }); }); }
  };
  try { Object.defineProperty(navigator, "geolocation", { value: nep, configurable: true }); } catch (e) { w.__nepGeo = nep; }
  w.__sim = { naam: naam, x: x };
})(window);
