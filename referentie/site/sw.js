// Offline voor de rijhulp: de site, de flitsers, de grenzen en het geluid uit de cache,
// en op de achtergrond verversen (stale-while-revalidate). De vooraf gemaakte kaart
// (kaart/<vak>.json?s=<stand>) gaat cache-first in een eigen cache: een vak verandert pas
// met een nieuwe stand, en dan is de URL anders. Overpass gaat niet via de cache: die
// tegels bewaart de app zelf in IndexedDB. /api/ (de gemelde
// flitsers en de matrixborden) gaat nooit via deze cache.
var CACHE = "rijhulp-v11"; // ophogen bij elke wijziging van de app: dan herlaadt een open startscherm vanzelf
var KAART = "kaart-v1";
var BESTANDEN = ["./", "index.html", "rijhulp.css", "over.html", "js/geo.js", "js/sim.js", "js/geluid.js", "js/kaart.js", "js/flitsers.js", "js/gemeld.js", "js/matrix.js", "js/motor.js", "js/rijhulp.js", "data/flitsers.json", "data/grenzen.json", "data/landen.json", "geluid/nl.json", "geluid/en.json", "kaart/index.json", "msi/index.json"];
self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(BESTANDEN); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE && k.indexOf("rijhulp-") === 0; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.indexOf("/api/") === 0) return; // /api: de meldingen, altijd vers
  // De borden per vak (msi/<vak>.json?s=<stand>) gaan net als de kaart cache-first.
  if ((url.pathname.indexOf("/kaart/") === 0 && url.pathname !== "/kaart/index.json") || (url.pathname.indexOf("/msi/") === 0 && url.pathname !== "/msi/index.json")) {
    e.respondWith(caches.open(KAART).then(function (c) {
      return c.match(e.request).then(function (oud) {
        if (oud) return oud;
        return fetch(e.request).then(function (r) {
          if (r.ok) {
            var kopie = r.clone();
            // Oudere standen van hetzelfde vak weg, dan de nieuwe erin.
            e.waitUntil(c.keys().then(function (ks) {
              return Promise.all(ks.filter(function (k) { return new URL(k.url).pathname === url.pathname; }).map(function (k) { return c.delete(k); }));
            }).then(function () { return c.put(e.request, kopie); }).catch(function () {}));
          }
          return r;
        });
      });
    }));
    return;
  }
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(e.request, { ignoreSearch: true }).then(function (oud) {
      var nieuw = fetch(e.request).then(function (r) { if (r.ok) c.put(e.request, r.clone()); return r; });
      if (oud) { e.waitUntil(nieuw.catch(function () {})); return oud; }
      return nieuw.catch(function () { return c.match("index.html"); });
    });
  }));
});
