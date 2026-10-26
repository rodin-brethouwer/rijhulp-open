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
    freqs.forEach(function (f, i) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "sine"; o.frequency.value = f;
      var b = t + i * duur;
      g.gain.setValueAtTime(0.0001, b);
      g.gain.exponentialRampToValueAtTime(volume, b + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, b + duur * 0.95);
      o.connect(g); g.connect(ctx.destination);
      o.start(b); o.stop(b + duur);
    });
    return freqs.length * duur + 0.05;
  }
  var TONEN = {
    gong: function (t) { return toon([660, 880], 0.16, 0.22, t); }, // vooraf aan een melding
    let: function (t) { return toon([1046, 1046, 1046], 0.11, 0.25, t); }, // te hard
    zacht: function (t) { return toon([523], 0.12, 0.12, t); }
  };
  function speelVolgende() {
    if (speelt || !rij.length) return;
    var item = rij.shift();
    if (performance.now() - item.sinds > 6000) return speelVolgende(); // te oud, niet meer zeggen
    speelt = true;
    if (ctx.state === "suspended" && ctx.resume) ctx.resume();
    // Speelt het motorgeluid, dan eerst even dat zachter (voorloop), dan pas de melding.
    var voor = 0; try { voor = Math.max(0, Math.min(0.4, +voorloop() || 0)); } catch (e) { voor = 0; }
    var duur = 0, t0 = ctx.currentTime + 0.03 + voor;
    item.delen.forEach(function (d) {
      if (TONEN[d]) {
        t0 += TONEN[d](t0) + 0.03;
        duur = t0 - ctx.currentTime;
        return;
      }
      var c = clips && clips[d];
      if (!c || !buffer) return;
      var s = ctx.createBufferSource();
      s.buffer = buffer;
      var g = ctx.createGain(); g.gain.value = 1;
      s.connect(g); g.connect(ctx.destination);
      s.start(t0, c[0], c[1]);
      t0 += c[1] + 0.04;
      duur = t0 - ctx.currentTime;
    });
    try { spreekt(duur); } catch (e) { /* het geluid gaat voor */ }
    setTimeout(function () { speelt = false; speelVolgende(); }, Math.max(150, duur * 1000 + 120));
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
    zetStil: function (s) { stil = !!s; if (stil) rij.length = 0; },
    isStil: function () { return stil; },
    klaar: function () { return !!buffer; },
    staat: function () { return ctx ? ctx.state : "geen"; },
    gesproken: gesproken,
    opZeg: function (f) { luisteraar = f; },
    opSpreek: function (f, voor) { spreekt = f; if (voor) voorloop = voor; },
    context: function () { return ctx; }
  };
})(window);
