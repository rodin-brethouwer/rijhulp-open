// Geluid voor de rijhulp. De Tesla-browser heeft wel speechSynthesis, maar zonder één
// stem (gemeten 24 okt 2026: 0 stemmen, synthesis-failed). Daarom gaan de zinnen als
// vooraf gemaakte audio mee (geluid/<taal>.json: Ogg Opus als base64 plus een tabel met
// begin en duur per clip), en speelt Web Audio ze af. Web Audio werkt in de auto (48 kHz).
(function (w) {
  "use strict";
  var ctx = null, buffer = null, clips = null, taal = "nl";
  var rij = [], speelt = false, stil = false;
  var gesproken = []; // voor de proefrit en ?debug=1
  var luisteraar = function () {};
  var spreekt = function () {}; // het motorgeluid duikt weg zolang er iets gezegd wordt
  var voorloop = function () { return 0; };

  function base64NaarBuffer(b64) {
    var bin = atob(b64), n = bin.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }
  function laad(t) {
    taal = t;
    return fetch("geluid/" + t + ".json").then(function (r) { if (!r.ok) throw new Error("geluid " + r.status); return r.json(); })
      .then(function (j) {
        clips = j.clips;
        return new Promise(function (ok, fout) { ctx.decodeAudioData(base64NaarBuffer(j.ogg), ok, fout); });
      })
      .then(function (b) { buffer = b; return true; });
  }
  /** Moet binnen een tik van de gebruiker: anders mag de browser geen geluid maken. */
  function ontgrendel() {
    var AC = w.AudioContext || w.webkitAudioContext;
    if (!AC) return false;
    if (!ctx) ctx = new AC();
    if (ctx.resume) ctx.resume();
    // Een stille buffer starten ontgrendelt het geluid ook in strengere browsers.
    var s = ctx.createBufferSource(); s.buffer = ctx.createBuffer(1, 1, 22050); s.connect(ctx.destination); s.start(0);
    return true;
  }
  function toon(freqs, duur, volume, t) {
    var bronnen = [];
    freqs.forEach(function (f, i) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      var b = t + i * duur;
      g.gain.setValueAtTime(0.0001, b);
      g.gain.exponentialRampToValueAtTime(volume, b + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, b + duur * 0.95);
      o.connect(g); g.connect(ctx.destination);
      o.start(b); o.stop(b + duur);
      bronnen.push({ s: o, g: g, begin: b, eind: b + duur, naam: "toon" });
    });
    return { duur: freqs.length * duur + 0.05, bronnen: bronnen };
  }
  var TONEN = {
    gong: function (t) { return toon([660, 880], 0.16, 0.22, t); }, // vooraf aan een melding
    let: function (t) { return toon([1046, 1046, 1046], 0.11, 0.25, t); }, // te hard
    zacht: function (t) { return toon([523], 0.12, 0.12, t); }
  };

  // ---------- De wachtrij ----------
  // Een melding gaat in zijn geheel op de klok van Web Audio (zonder gaten, en hij speelt door
  // als de pagina even bevriest, zoals de Tesla-browser tot 32 s doet). Maar die klok kan ook
  // stilstaan: een AudioContext die niet loopt (suspended) of een hapering van het geluid zelf.
  // Tot 26 okt 2026 liep de wachtrij dan op de wandklok door: de rest van de zin bleef op de
  // stilstaande klok staan, de volgende meldingen kwamen erachter op hetzelfde moment, en zodra
  // de klok weer liep kwam alles laat en door elkaar ("de stem bleef hangen"). Nu:
  // - spelen pas als de klok loopt (anders eerst resume, hooguit tot de melding 6 s oud is);
  // - elke clip moet binnen zijn duur plus MARGE klaar zijn; lukt dat niet, dan stopt de rest
  //   van de zin (liever een halve zin dan een zin die later door de volgende heen praat);
  // - een clip die niet bestaat, niet past of niet start, wordt overgeslagen en de zin gaat door;
  // - wat er ook gebeurt, na de duur van de zin plus VANGNET_MS is de wachtrij weer vrij.
  var MARGE = 0.6; // s per clip, bovenop de duur
  var VANGNET_MS = 3000;
  var beurt = 0, lopend = null, wachtOpKlok = false;
  var teller = { gespeeld: 0, afgebroken: 0, overgeslagen: 0, teOud: 0 };
  var log = function () {};

  function stopBronnen(bronnen) {
    bronnen.forEach(function (b) {
      try { b.s.onended = null; b.s.stop(0); } catch (e) { /* al gestopt of nooit gestart */ }
      try { b.g.disconnect(); } catch (e) { /* weg */ }
    });
  }
  function klaar(id, reden) {
    if (!lopend || lopend.id !== id) return;
    var l = lopend;
    lopend = null; speelt = false;
    clearInterval(l.wacht); clearTimeout(l.vangnet);
    if (reden) {
      teller.afgebroken++;
      // Wat nog niet gespeeld is mag niet later alsnog klinken.
      stopBronnen(l.bronnen);
      log("geluid: " + reden + " (" + l.delen.join(" + ") + ")");
    } else teller.gespeeld++;
    // Even ademhalen tussen twee meldingen, en nooit vanuit de stapel van de vorige.
    setTimeout(speelVolgende, reden ? 0 : 120);
  }
  function speelVolgende() {
    // Vangnet: een melding die veel langer duurt dan kan, laat de rij nooit vastzitten.
    if (speelt && lopend && performance.now() > lopend.uiterst) klaar(lopend.id, "vangnet");
    if (speelt || !rij.length || !ctx) return;
    var item = rij[0];
    if (performance.now() - item.sinds > 6000) { rij.shift(); teller.teOud++; log("geluid: te oud, overgeslagen (" + item.delen.join(" + ") + ")"); return speelVolgende(); }
    if (ctx.state !== "running") {
      // Niet spelen op een klok die stilstaat: eerst hervatten, dan opnieuw proberen.
      if (!wachtOpKlok) {
        wachtOpKlok = true;
        var weer = function () { if (!wachtOpKlok) return; wachtOpKlok = false; speelVolgende(); };
        // Na resume alleen meteen verder als de klok echt loopt; anders over 400 ms opnieuw
        // (een resume die slaagt zonder dat de klok loopt mag geen lus zonder pauze worden).
        try { var p = ctx.resume && ctx.resume(); if (p && p.then) p.then(function () { if (ctx.state === "running") weer(); }, function () {}); } catch (e) { /* volgende poging */ }
        setTimeout(weer, 400);
      }
      return;
    }
    rij.shift();
    var id = ++beurt;
    speelt = true;
    var bronnen = [], nu, eind;
    try {
      // Speelt het motorgeluid, dan eerst even dat zachter (voorloop), dan pas de melding.
      var voor = 0; try { voor = Math.max(0, Math.min(0.4, +voorloop() || 0)); } catch (e) { voor = 0; }
      nu = ctx.currentTime;
      var t0 = nu + 0.03 + voor;
      item.delen.forEach(function (d) {
        try {
          if (TONEN[d]) {
            var r = TONEN[d](t0);
            bronnen.push.apply(bronnen, r.bronnen);
            t0 += r.duur + 0.03;
            return;
          }
          var c = clips && clips[d];
          if (!c || !buffer || !(c[0] >= 0 && c[1] > 0) || c[0] + c[1] > buffer.duration + 0.05) { teller.overgeslagen++; if (buffer) log("geluid: clip " + d + " ontbreekt, overgeslagen"); return; }
          var s = ctx.createBufferSource();
          s.buffer = buffer;
          var g = ctx.createGain(); g.gain.value = 1;
          s.connect(g); g.connect(ctx.destination);
          s.start(t0, c[0], c[1]);
          bronnen.push({ s: s, g: g, begin: t0, eind: t0 + c[1], naam: d });
          t0 += c[1] + 0.04;
        } catch (e) {
          teller.overgeslagen++;
          log("geluid: clip " + d + " start niet (" + (e && e.message || e) + "), overgeslagen");
        }
      });
      eind = t0;
    } catch (e) {
      stopBronnen(bronnen);
      speelt = false;
      log("geluid: melding mislukt (" + (e && e.message || e) + ")");
      return speelVolgende();
    }
    var duur = eind - nu;
    var l = lopend = { id: id, delen: item.delen, bronnen: bronnen, start: performance.now(), uiterst: performance.now() + duur * 1000 + VANGNET_MS };
    try { spreekt(duur); } catch (e) { /* het geluid gaat voor */ }
    // De wacht: klaar als de klok voorbij het eind is; te laat met een clip (duur plus MARGE) dan
    // stopt de rest van de zin. Kijkt eerst naar de klok: na een bevroren pagina die gewoon
    // doorspeelde is de zin dan al uit, en is er niets aan de hand.
    l.wacht = setInterval(function () {
      if (lopend !== l) { clearInterval(l.wacht); return; }
      var klok = ctx.currentTime, verstreken = (performance.now() - l.start) / 1000;
      if (klok >= eind) return klaar(id);
      for (var i = 0; i < bronnen.length; i++) {
        var b = bronnen[i];
        if (klok >= b.eind) continue;
        if (verstreken > b.eind - nu + MARGE) { return klaar(id, "vastgelopen bij " + b.naam + ", rest van de zin overgeslagen"); }
        break;
      }
      if (performance.now() > l.uiterst) klaar(id, "vangnet");
    }, 100);
    l.vangnet = setTimeout(function () { klaar(id, "vangnet"); }, duur * 1000 + VANGNET_MS);
  }
  /**
   * Zegt een reeks: tonen ("gong", "let") en clips ("flitser_300", "n97").
   * dringend: wist wat nog in de rij staat (een nieuwe flitser gaat voor een oud gemiddelde).
   * forceer: ook als het geluid uit staat (de knop Test geluid).
   */
  function zeg(delen, dringend, forceer) {
    var item = { delen: delen, sinds: performance.now() };
    gesproken.push({ t: new Date().toISOString(), delen: delen.slice(), stil: stil, klaar: !!buffer });
    if (gesproken.length > 200) gesproken.shift();
    luisteraar(delen);
    if ((stil && !forceer) || !ctx) return;
    // Dezelfde zin die nu klinkt of al in de rij staat, niet nog een keer.
    var sleutel = delen.join("+");
    if (lopend && lopend.delen.join("+") === sleutel) return;
    for (var i = 0; i < rij.length; i++) if (rij[i].delen.join("+") === sleutel) return;
    if (dringend) rij.length = 0;
    rij.push(item);
    if (rij.length > 3) rij.splice(0, rij.length - 3);
    speelVolgende();
  }
  w.Geluid = {
    ontgrendel: ontgrendel,
    laad: laad,
    zeg: zeg,
    getal: function (n) { n = Math.round(n); return clips && clips["n" + n] ? "n" + n : null; },
    zetStil: function (s) { stil = !!s; if (stil) { rij.length = 0; if (lopend) klaar(lopend.id, "geluid uit"); } },
    isStil: function () { return stil; },
    klaar: function () { return !!buffer; },
    staat: function () { return ctx ? ctx.state : "geen"; },
    gesproken: gesproken,
    opZeg: function (f) { luisteraar = f; },
    opSpreek: function (f, voor) { spreekt = f; if (voor) voorloop = voor; },
    context: function () { return ctx; },
    opLog: function (f) { log = f; },
    /** Voor de proef en ?debug=1: speelt er iets, hoe lang is de rij, en de tellers. */
    rij: function () { return { speelt: speelt, wacht: rij.length, wachtOpKlok: wachtOpKlok, lopend: lopend ? lopend.delen.slice() : null, teller: teller }; },
    MARGE: MARGE
  };
})(window);
