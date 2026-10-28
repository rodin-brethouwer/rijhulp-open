// Rekenwerk op de bol en in een plat vlak rond de auto. Geen afhankelijkheden.
(function (w) {
  "use strict";
  var R = 6371000, rad = Math.PI / 180;
  function afstand(aLat, aLon, bLat, bLon) {
    var dLat = (bLat - aLat) * rad, dLon = (bLon - aLon) * rad;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function peiling(aLat, aLon, bLat, bLon) {
    var y = Math.sin((bLon - aLon) * rad) * Math.cos(bLat * rad);
    var x = Math.cos(aLat * rad) * Math.sin(bLat * rad) - Math.sin(aLat * rad) * Math.cos(bLat * rad) * Math.cos((bLon - aLon) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }
  /** Kleinste hoek tussen twee richtingen, 0 t/m 180. */
  function verschil(a, b) { return Math.abs(((a - b + 540) % 360) - 180); }
  /** Afstand in meter van punt p tot lijnstuk a-b, plus de richting van a naar b. Plat vlak, goed tot een paar km. */
  function totLijnstuk(pLat, pLon, aLat, aLon, bLat, bLon) {
    var kx = Math.cos(pLat * rad) * 111320, ky = 110540;
    var ax = (aLon - pLon) * kx, ay = (aLat - pLat) * ky, bx = (bLon - pLon) * kx, by = (bLat - pLat) * ky;
    var dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    var t = l2 ? -(ax * dx + ay * dy) / l2 : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var x = ax + t * dx, y = ay + t * dy;
    return { d: Math.sqrt(x * x + y * y), t: t, richting: (Math.atan2(dx, dy) / rad + 360) % 360 };
  }
  /** Punt in veelhoek met een straal naar het oosten, over losse lijnen [lat, lon, lat, lon, ...]. */
  function binnen(lat, lon, lijnen) {
    var telling = 0;
    for (var i = 0; i < lijnen.length; i++) {
      var l = lijnen[i];
      for (var j = 2; j < l.length; j += 2) {
        var y1 = l[j - 2], x1 = l[j - 1], y2 = l[j], x2 = l[j + 1];
        if ((y1 > lat) !== (y2 > lat)) {
          var x = x1 + ((lat - y1) * (x2 - x1)) / (y2 - y1);
          if (x > lon) telling++;
        }
      }
    }
    return telling % 2 === 1;
  }
  /**
   * De klok van de rit (28 okt 2026): pos.timestamp is niet te vertrouwen (in de Tesla liep hij soms
   * terug of kwam hij uit een andere klok, en dan begon een trajectcontrole telkens opnieuw). De rit
   * loopt daarom op de monotone klok van de pagina (performance.now), vanaf de wandklok bij de eerste
   * positie, en nooit terug. Slaapt het toestel (performance.now staat dan soms stil), dan telt de
   * wandklok als die verder liep. perf en wand zijn functies, voor de proef.
   */
  function maakKlok(perf, wand) {
    var vorig = null;
    return function () {
      var p = perf(), d = wand();
      if (!vorig) { vorig = { t: d, p: p, d: d }; return d; }
      var dp = p - vorig.p, dd = d - vorig.d, stap = Math.max(0, dp);
      if (dd > stap + 2000 && dd < 86400000) stap = dd;
      vorig = { t: vorig.t + stap, p: p, d: d };
      return vorig.t;
    };
  }
  w.Geo = { afstand: afstand, peiling: peiling, verschil: verschil, totLijnstuk: totLijnstuk, binnen: binnen, maakKlok: maakKlok };
})(typeof window !== "undefined" ? window : globalThis);
