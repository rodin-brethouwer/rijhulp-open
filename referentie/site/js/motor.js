// Motorgeluid (verborgen: vijf keer op de snelheid tikken). Helemaal zelf gemaakt met Web Audio,
// zonder samples: een oscillator met eigen boventonen op de ontstekingsfrequentie, een subtoon,
// ruis die op het ritme van de motor klopt, een filter dat opengaat met het gas en een zachte
// begrenzer. Toerental en versnelling volgen uit de GPS-snelheid, het gas uit de versnelling.
//
// Veiligheid: een vast maximaal volume (MAX), bij elke gesproken melding automatisch bijna uit
// (Motor.duik, aangeroepen door Geluid), en uit na een tijdje stilstand. Na een hapering van de
// pagina (de Tesla-browser bevroor 19 tot 32 s) of van het geluid zelf komt het geluid zacht
// terug in plaats van met een klik: alle waarden gaan via setTargetAtTime, nooit met een sprong.
//
// Turbo (karakter Turbo, of de schakelaar voor V8 en Sportauto): een fluittoon die opbouwt met de
// druk, en een blow-off (gefilterde ruis met een snelle aanzet en uitsterven) als het gas na flink
// optrekken wegvalt. De druk volgt het gas en het toerental met een vertraging; een blow-off pas
// boven DRUK_BLAAS en hooguit eens per BLAAS_RUST_MS (na een korte sis bij het schakelen mag die bij gas
// los al na 1 s). Motor en turbo gaan samen door een zachte
// knik (plafond) voor de duik: wat er ook gebeurt, de uitgang blijft onder MAX.
(function (w) {
  "use strict";
  var MAX = 0.2; // vast plafond van het motorgeluid; een melding speelt op 1
  var STIL_MS = 45000; // zo lang stilstaan, dan gaat de motor uit
  var TIK_MS = 100;
  var DRUK_BLAAS = 0.45; // zoveel opgebouwde druk (0 tot 1) is nodig voor een blow-off
  var BLAAS_RUST_MS = 2500; // daarna even niet

  var KARAKTERS = {
    v8: { cyl: 8, stationair: 750, rood: 6200, k: [110, 65, 44, 32, 24, 18], omhoog: [2000, 5600], omlaag: 1250,
      boventonen: [0, 1, 0.65, 0.5, 0.32, 0.22, 0.16, 0.1, 0.07, 0.05, 0.03], sub: 0.55, subDeel: 2, ruis: 0.22, filter: [320, 2600], drive: 2.2, niveau: 0.95,
      tb: { f: [950, 5200], fluit: 0.2, lucht: 0.1, bov: 0.75, flutter: false, lag: 0.9 } },
    sport: { cyl: 6, stationair: 950, rood: 8200, k: [125, 82, 60, 46, 36, 28, 22], omhoog: [2600, 7600], omlaag: 1700,
      boventonen: [0, 1, 0.8, 0.7, 0.55, 0.45, 0.4, 0.3, 0.25, 0.18, 0.14, 0.1, 0.08], sub: 0.12, subDeel: 2, ruis: 0.32, filter: [700, 5200], drive: 3, niveau: 0.8,
      tb: { f: [1400, 7400], fluit: 0.2, lucht: 0.1, bov: 0.7, flutter: false, lag: 0.7 } },
    // Een viercilinder met turbo: gedempte uitlaat, en de turbo zelf als hoofdrol (met flutter).
    turbo: { cyl: 4, stationair: 850, rood: 6800, k: [118, 72, 50, 39, 32, 27], omhoog: [2200, 6300], omlaag: 1300,
      boventonen: [0, 1, 0.5, 0.38, 0.25, 0.16, 0.1, 0.06, 0.04], sub: 0.25, subDeel: 2, ruis: 0.3, filter: [380, 2800], drive: 2.2, niveau: 0.8,
      tb: { f: [1600, 8200], fluit: 0.28, lucht: 0.14, bov: 0.9, flutter: true, lag: 0.8 }, altijdTurbo: true },
    kever: { cyl: 4, stationair: 880, rood: 4600, k: [165, 92, 58, 37], omhoog: [2300, 4200], omlaag: 1300,
      boventonen: [0, 1, 0.35, 0.6, 0.2, 0.42, 0.12, 0.3, 0.08, 0.2], sub: 0.45, subDeel: 2, ruis: 0.45, filter: [450, 2100], drive: 2.6, niveau: 0.9, rammel: true },
    ruimte: { ruimte: true, niveau: 0.75 }
  };

  var ctx = null, uit = null; // uit: master -> analyser -> destination
  var keten = null; // { duik, herstel, aan, stem: {...}, stop() }
  var karakter = "";
  var turboKeuze = false; // de schakelaar: turbo op V8 en Sportauto
  var staat = { kmh: 0, kmhT: 0, a: 0, gas: 0.15, druk: 0, gasPiek: 0, laatsteBlaas: 0, blazen: 0, rpm: 0, versnelling: 0, laatsteSchakel: 0, stilSinds: 0, slaapt: false, vorigeTik: 0, vorigeAudio: 0, metingen: [] };
  var bron = function () { return { kmh: 0, t: Date.now() }; };
  var mag = function () { return true; };
  var log = function () {};
  var klok = null;

  function ruisBuffer() {
    var n = ctx.sampleRate * 2, b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }
  function begrenzer(drive) {
    var s = ctx.createWaveShaper(), n = 2048, c = new Float32Array(n);
    for (var i = 0; i < n; i++) { var x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * drive) / Math.tanh(drive); }
    s.curve = c; s.oversample = "2x";
    return s;
  }
  // Lineair tot 0,7, daarboven een zachte knik naar hooguit 0,93: samen met de master (MAX) is dat
  // een hard plafond, want een WaveShaper geeft nooit meer dan het uiterste van zijn curve.
  function plafondCurve() {
    var s = ctx.createWaveShaper(), n = 4096, c = new Float32Array(n);
    for (var i = 0; i < n; i++) { var x = (i / (n - 1)) * 2 - 1, a = Math.abs(x); c[i] = (x < 0 ? -1 : 1) * (a < 0.7 ? a : 0.7 + 0.3 * Math.tanh((a - 0.7) / 0.3)); }
    s.curve = c;
    return s;
  }
  var korteRuis = null;
  function naar(param, waarde, tau, op) { param.setTargetAtTime(waarde, op != null ? op : ctx.currentTime, tau); }

  // ---------- De keten per karakter ----------
  function bouw(naam) {
    var K = KARAKTERS[naam];
    var aan = ctx.createGain(); aan.gain.value = 0; // in- en uitfaden (start, stilstand)
    var duik = ctx.createGain(); duik.gain.value = 1; // zachter bij een melding
    var herstel = ctx.createGain(); herstel.gain.value = 1; // zacht terug na een hapering
    var niveau = ctx.createGain(); niveau.gain.value = 0;
    var filter = ctx.createBiquadFilter(); filter.type = "lowpass"; filter.frequency.value = 400; filter.Q.value = K.ruimte ? 5 : 0.9;
    var grens = begrenzer(K.ruimte ? 1.6 : K.drive);
    var mix = ctx.createGain(); mix.gain.value = 0.5;
    var som = ctx.createGain(); som.gain.value = 1; // motor plus turbo
    var plafond = plafondCurve();
    mix.connect(filter); filter.connect(grens); grens.connect(niveau); niveau.connect(som); som.connect(plafond); plafond.connect(duik); duik.connect(herstel); herstel.connect(aan); aan.connect(uit);
    var bronnen = [], k = { aan: aan, duik: duik, herstel: herstel, niveau: niveau, filter: filter, naam: naam };
    if (K.tb) bouwTurbo(K.tb, som, bronnen, k);

    var ruis = ctx.createBufferSource(); ruis.buffer = ruisBuffer(); ruis.loop = true; bronnen.push(ruis);
    if (K.ruimte) {
      var a = ctx.createOscillator(); a.type = "triangle";
      var b = ctx.createOscillator(); b.type = "sawtooth"; b.detune.value = 7;
      var c = ctx.createOscillator(); c.type = "sine";
      var gb = ctx.createGain(); gb.gain.value = 0.18;
      var gc = ctx.createGain(); gc.gain.value = 0.35;
      var lfo = ctx.createOscillator(); lfo.frequency.value = 0.35;
      var lfoDiep = ctx.createGain(); lfoDiep.gain.value = 220;
      lfo.connect(lfoDiep); lfoDiep.connect(filter.frequency);
      var vib = ctx.createGain(); vib.gain.value = 9; lfo.connect(vib); vib.connect(b.detune);
      var hp = ctx.createBiquadFilter(); hp.type = "bandpass"; hp.Q.value = 0.7; hp.frequency.value = 900;
      var gr = ctx.createGain(); gr.gain.value = 0.05;
      a.connect(mix); b.connect(gb); gb.connect(mix); c.connect(gc); gc.connect(mix); ruis.connect(hp); hp.connect(gr); gr.connect(mix);
      bronnen.push(a, b, c, lfo);
      k.zet = function (rpm, gas, kmh, tau) {
        var f = 46 + kmh * 0.9 + gas * 18;
        naar(a.frequency, f, tau); naar(b.frequency, f * 1.5, tau); naar(c.frequency, f / 2, tau);
        naar(lfo.frequency, 0.35 + kmh / 60, 0.5);
        naar(filter.frequency, 380 + kmh * 18 + gas * 1400, tau);
        naar(hp.frequency, 700 + kmh * 28, tau); naar(gr.gain, 0.04 + Math.min(0.25, kmh / 600) + gas * 0.08, tau);
        naar(niveau.gain, K.niveau * (0.55 + 0.25 * gas + Math.min(0.2, kmh / 600)), tau);
      };
    } else {
      var hoofd = ctx.createOscillator();
      var echt = new Float32Array(K.boventonen.length), beeld = new Float32Array(K.boventonen);
      hoofd.setPeriodicWave(ctx.createPeriodicWave(echt, beeld));
      var sub = ctx.createOscillator(); sub.type = K.rammel ? "square" : "triangle";
      var gSub = ctx.createGain(); gSub.gain.value = K.sub;
      // De ruis klopt op het ritme van de ontsteking: de hoofdtoon stuurt de versterking van de ruis.
      var bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 0.8;
      var gRuis = ctx.createGain(); gRuis.gain.value = K.ruis * 0.5;
      var am = ctx.createGain(); am.gain.value = K.ruis * 0.5;
      hoofd.connect(am); am.connect(gRuis.gain);
      var gHoofd = ctx.createGain(); gHoofd.gain.value = 0.7;
      hoofd.connect(gHoofd); gHoofd.connect(mix); sub.connect(gSub); gSub.connect(mix); ruis.connect(bp); bp.connect(gRuis); gRuis.connect(mix);
      bronnen.push(hoofd, sub);
      // Een V8 met een ongelijke ontsteking "lopet": de subtoon zweeft een beetje.
      var zweef = ctx.createOscillator(); zweef.frequency.value = 1.7; var gZweef = ctx.createGain(); gZweef.gain.value = K.rammel ? 25 : 12;
      zweef.connect(gZweef); gZweef.connect(sub.detune); bronnen.push(zweef);
      k.zet = function (rpm, gas, kmh, tau) {
        var f = (rpm / 60) * (K.cyl / 2);
        naar(hoofd.frequency, f, tau); naar(sub.frequency, f / K.subDeel, tau);
        naar(bp.frequency, Math.min(8000, f * 3.2), tau);
        naar(gSub.gain, K.sub * (1 - gas * 0.45), tau);
        var r = Math.min(1, rpm / K.rood);
        naar(filter.frequency, K.filter[0] + gas * (K.filter[1] - K.filter[0]) + f * 1.2, tau);
        naar(gRuis.gain, K.ruis * (0.25 + gas * 0.6), tau); naar(am.gain, K.ruis * (0.25 + gas * 0.5), tau);
        naar(niveau.gain, K.niveau * (0.35 + 0.4 * gas + 0.25 * r), tau);
      };
    }
    var t0 = ctx.currentTime + 0.02;
    bronnen.forEach(function (s) { s.start(t0); });
    k.stop = function () {
      var t = ctx.currentTime;
      naar(aan.gain, 0, 0.15, t);
      bronnen.forEach(function (s) { try { s.stop(t + 1.2); } catch (e) { /* al gestopt */ } });
      setTimeout(function () { try { aan.disconnect(); } catch (e) { /* weg */ } }, 1500);
    };
    return k;
  }

  // ---------- Turbo: fluit en blow-off ----------
  function bouwTurbo(T, som, bronnen, k) {
    var poort = ctx.createGain(); poort.gain.value = 0; // de schakelaar, zacht aan en uit
    var hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 500; hp.Q.value = 0.7;
    hp.connect(poort); poort.connect(som);
    // De fluit: de bladfrequentie van het compressorwiel (sinus) met een zachte tweede boventoon,
    // een klein beetje vibrato, en lucht (ruis in een smalle band rond de toon).
    var f1 = ctx.createOscillator(); f1.type = "sine"; f1.frequency.value = T.f[0];
    var f2 = ctx.createOscillator(); f2.type = "sine"; f2.frequency.value = T.f[0] * 2;
    var g2 = ctx.createGain(); g2.gain.value = 0.22;
    var gFluit = ctx.createGain(); gFluit.gain.value = 0;
    f1.connect(gFluit); f2.connect(g2); g2.connect(gFluit); gFluit.connect(hp);
    var vib = ctx.createOscillator(); vib.frequency.value = 5.3; var vibDiep = ctx.createGain(); vibDiep.gain.value = 6;
    vib.connect(vibDiep); vibDiep.connect(f1.detune); vibDiep.connect(f2.detune);
    var lucht = ctx.createBufferSource(); lucht.buffer = ruisBuffer(); lucht.loop = true;
    var bpL = ctx.createBiquadFilter(); bpL.type = "bandpass"; bpL.Q.value = 2.5; bpL.frequency.value = T.f[0];
    var gLucht = ctx.createGain(); gLucht.gain.value = 0;
    lucht.connect(bpL); bpL.connect(gLucht); gLucht.connect(hp);
    bronnen.push(f1, f2, vib, lucht);
    k.turboPoort = poort;
    k.turbo = function (druk, gas, tau) {
      var f = T.f[0] + druk * (T.f[1] - T.f[0]);
      naar(f1.frequency, f, tau); naar(f2.frequency, f * 2, tau); naar(bpL.frequency, f * 0.85, tau);
      var d2 = druk * druk;
      naar(gFluit.gain, T.fluit * d2 * (0.4 + 0.6 * gas), tau);
      naar(gLucht.gain, T.lucht * d2 * (0.3 + 0.7 * gas), tau);
    };
    // De blow-off: korte ruis, een bandfilter dat van hoog naar laag zakt, snelle aanzet en een
    // uitsterven dat langer is bij meer druk. Met flutter een snelle trilling in de eerste 0,2 s.
    k.blaas = function (sterkte) {
      if (!korteRuis) { var n = Math.round(ctx.sampleRate * 1.6); korteRuis = ctx.createBuffer(1, n, ctx.sampleRate); var d = korteRuis.getChannelData(0); for (var i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; }
      var t = ctx.currentTime + 0.01, A = T.bov * Math.min(1, sterkte), uitst = 0.1 + 0.14 * Math.min(1, sterkte);
      var r = ctx.createBufferSource(); r.buffer = korteRuis;
      var bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 1.1; bp.frequency.value = 4600;
      naar(bp.frequency, 1700, 0.16, t);
      var hp2 = ctx.createBiquadFilter(); hp2.type = "highpass"; hp2.frequency.value = 700;
      var env = ctx.createGain(); env.gain.value = 0;
      naar(env.gain, A, 0.007, t);
      naar(env.gain, 0, uitst, t + 0.035);
      r.connect(bp); bp.connect(hp2); hp2.connect(env);
      var extra = [r];
      if (T.flutter) {
        var fl = ctx.createGain(); fl.gain.value = 0.7; // basis, de trilling erbovenop
        var lfo = ctx.createOscillator(); lfo.type = "triangle"; lfo.frequency.value = 23;
        naar(lfo.frequency, 15, 0.15, t);
        var diep = ctx.createGain(); diep.gain.value = 0;
        naar(diep.gain, 0.3, 0.01, t); naar(diep.gain, 0, 0.09, t + 0.12);
        lfo.connect(diep); diep.connect(fl.gain); env.connect(fl); fl.connect(poort);
        extra.push(lfo);
      } else env.connect(poort);
      extra.forEach(function (s) { s.start(t); s.stop(t + 1.5); });
      setTimeout(function () { try { env.disconnect(); } catch (e) { /* weg */ } }, 1800);
    };
  }
  function turboAan() { var K = KARAKTERS[karakter]; return !!(K && K.tb && (K.altijdTurbo || turboKeuze)); }
  function blaas(sterkte, nu, waarom) {
    if (!keten || !keten.blaas || !turboAan()) return;
    staat.blaasBijSchakel = false; // een sis bij het schakelen houdt de sis bij gas los maar 1 s tegen
    staat.laatsteBlaas = nu; staat.blazen++;
    keten.blaas(sterkte);
    log("turbo: blow-off (" + waarom + ", druk " + Math.round(sterkte * 100) / 100 + ")");
  }
  // De druk bouwt op met het gas boven kruisen en met het toerental, met een vertraging (lag), en
  // zakt langzaam als je het gas licht laat staan. Na een blow-off is hij weg.
  function rekenTurbo(K, rpm, nu, dt, hapering, schakelt) {
    var T = K.tb;
    if (!T || !keten.turbo) return;
    var aanNu = turboAan();
    naar(keten.turboPoort.gain, aanNu ? 1 : 0, 0.25);
    if (!aanNu) { staat.druk = 0; staat.gasPiek = staat.gas; return; }
    var rpmF = Math.max(0, Math.min(1, (rpm - K.stationair) / (K.rood * 0.55 - K.stationair)));
    var vraag = schakelt ? 0 : Math.max(0, Math.min(1, (staat.gas - 0.3) / 0.45)) * (0.3 + 0.7 * rpmF);
    var tau = vraag > staat.druk ? T.lag : 1.6;
    staat.druk += (vraag - staat.druk) * (1 - Math.exp(-dt / tau));
    staat.gasPiek = Math.max(staat.gas, staat.gasPiek - dt * 0.12);
    if (hapering) staat.gasPiek = staat.gas; // na een stilte niet sissen op oude gegevens
    else if (staat.druk >= DRUK_BLAAS && staat.gas < 0.45 && staat.gasPiek - staat.gas > 0.3 && nu - staat.laatsteBlaas > (staat.blaasBijSchakel ? 1000 : BLAAS_RUST_MS)) {
      blaas(staat.druk, nu, "gas los");
      staat.druk *= 0.1; staat.gasPiek = staat.gas;
    }
    keten.turbo(staat.druk, schakelt ? 0.05 : staat.gas, hapering ? 0.05 : 0.12);
  }

  // ---------- Rijden: toerental, versnelling en gas ----------
  function versnellingen(K) { return K.k ? K.k.length : 0; }
  function rekenToeren(K, kmh, gas, nu) {
    if (K.ruimte) return 0;
    var g = staat.versnelling, n = versnellingen(K);
    var toerenIn = function (i) { return kmh * K.k[i]; };
    // Schakelpunten volgen de versnelling, niet het gas bij constante snelheid: rustig rijden
    // gaat vroeg naar de hoogste versnelling, flink optrekken trekt de motor door.
    var trek = Math.max(0, Math.min(1, staat.a / 2));
    var omhoog = K.omhoog[0] + trek * (K.omhoog[1] - K.omhoog[0]);
    var omlaag = K.omlaag + trek * 900;
    if (kmh < 3) g = 0;
    else if (nu - staat.laatsteSchakel > 900) {
      if (g < n - 1 && toerenIn(g) > omhoog) { g++; schakel(nu, true); }
      else if (g > 0 && toerenIn(g) < omlaag && toerenIn(g - 1) < K.rood * 0.82) { g--; schakel(nu, false); }
    }
    staat.versnelling = g;
    var rpm = toerenIn(g);
    // Wegrijden: de koppeling slipt, het toerental hangt iets boven stationair.
    var weg = K.stationair + 300 + gas * 1300;
    if (rpm < weg && g === 0) rpm = Math.max(rpm, kmh < 1 ? K.stationair + gas * 200 : weg * Math.min(1, 0.6 + kmh / 25));
    return Math.max(K.stationair, Math.min(K.rood, rpm));
  }
  function schakel(nu, op) {
    staat.laatsteSchakel = nu;
    if (!keten) return;
    // Even gas eraf bij het schakelen: een korte dip in het niveau, zonder klik.
    var t = ctx.currentTime;
    keten.niveau.gain.cancelScheduledValues(t);
    naar(keten.niveau.gain, op ? 0.12 : 0.3, 0.035, t);
    staat.schakelTot = nu + (op ? 180 : 120);
    // Opschakelen met het gas nog op de plank en veel druk: een kortere blow-off, de druk zakt maar
    // is niet weg. Schakelt hij op omdat je het gas loslaat, dan is de sis voor het gas los.
    if (op && turboAan() && staat.gasDoel >= 0.8 && staat.druk >= DRUK_BLAAS + 0.15 && nu - staat.laatsteBlaas > BLAAS_RUST_MS) { blaas(staat.druk * 0.6, nu, "schakelen"); staat.druk *= 0.75; staat.blaasBijSchakel = true; }
  }

  function tik() {
    if (!ctx) return;
    var nu = performance.now(), wand = nu - (staat.vorigeTik || nu), audio = ctx.currentTime - (staat.vorigeAudio || ctx.currentTime);
    staat.vorigeTik = nu; staat.vorigeAudio = ctx.currentTime;
    if (!karakter || !mag()) { if (keten) { keten.stop(); keten = null; } return; }
    if (ctx.state !== "running") { if (ctx.resume) ctx.resume().catch(function () {}); staat.wasStil = true; return; }
    var b = bron(), kmh = Math.max(0, b.kmh || 0);
    // Versnelling uit de GPS-snelheid (m/s per s), afgevlakt over ongeveer een seconde.
    var m = staat.metingen;
    if (!m.length || b.t !== m[m.length - 1].t) { m.push({ t: b.t, v: kmh / 3.6 }); if (m.length > 30) m.shift(); }
    var oud = null; for (var i = m.length - 1; i >= 0; i--) if (b.t - m[i].t >= 900) { oud = m[i]; break; }
    var a = oud && b.t - oud.t < 4000 ? (kmh / 3.6 - oud.v) / ((b.t - oud.t) / 1000) : 0;
    staat.a += (a - staat.a) * 0.3;
    var doel = kmh < 1 ? 0.05 : staat.a < -0.6 ? 0.02 : Math.max(0, Math.min(1, 0.14 + kmh / 500 + staat.a / 2.2));
    staat.gas += (doel - staat.gas) * 0.25;
    staat.gasDoel = doel;
    staat.kmh = kmh;

    // Stilstand: na STIL_MS uit, weer aan zodra je rijdt.
    if (kmh < 2) { if (!staat.stilSinds) staat.stilSinds = nu; } else staat.stilSinds = 0;
    if (staat.stilSinds && nu - staat.stilSinds > STIL_MS) {
      if (keten) { keten.stop(); keten = null; staat.slaapt = true; log("motor slaapt (stilstand)"); }
      return;
    }
    if (!keten) {
      if (staat.slaapt && kmh < 4) return;
      staat.slaapt = false;
      keten = bouw(karakter);
      naar(keten.aan.gain, 1, 0.5); // zacht aan
      log("motor " + karakter);
    }
    // Na een hapering (de pagina of het geluid stond stil): eerst zacht, dan rustig terug.
    var hapering = wand > 1200 || (wand > 600 && audio < (wand / 1000) * 0.5) || staat.wasStil;
    staat.wasStil = false;
    var K = KARAKTERS[karakter];
    var rpm = rekenToeren(K, kmh, staat.gas, nu);
    var tau = 0.12;
    if (hapering) {
      var t = ctx.currentTime;
      keten.herstel.gain.cancelScheduledValues(t);
      naar(keten.herstel.gain, 0, 0.03, t);
      naar(keten.herstel.gain, 1, 0.6, t + 0.25);
      tau = 0.05; // onder de stilte mag het toerental snel naar de nieuwe snelheid
      staat.herstellingen = (staat.herstellingen || 0) + 1;
      log("motor: hapering van " + Math.round(wand) + " ms, zacht terug");
    }
    staat.rpm = rpm;
    rekenTurbo(K, rpm, nu, Math.min(0.5, Math.max(0, wand) / 1000), hapering, !!(staat.schakelTot && nu < staat.schakelTot));
    if (staat.schakelTot && nu < staat.schakelTot) { keten.zet(rpm, 0.05, kmh, 0.05); return; }
    staat.schakelTot = 0;
    keten.zet(rpm, staat.gas, kmh, tau);
  }

  /** Bijna uit tijdens een gesproken melding (duur in s), daarna rustig terug. */
  function duik(duur) {
    if (!keten || !ctx) return;
    var t = ctx.currentTime;
    keten.duik.gain.cancelScheduledValues(t);
    naar(keten.duik.gain, 0.04, 0.05, t);
    naar(keten.duik.gain, 1, 0.5, t + Math.max(0.3, duur) + 0.5);
    staat.duiken = (staat.duiken || 0) + 1;
  }

  function zet(naam) {
    karakter = KARAKTERS[naam] ? naam : "";
    if (keten) { keten.stop(); keten = null; }
    staat.versnelling = 0; staat.stilSinds = 0; staat.slaapt = false; staat.druk = 0; staat.gasPiek = 0;
    if (karakter && !klok) klok = setInterval(tik, TIK_MS);
    if (!karakter && klok) { clearInterval(klok); klok = null; }
  }
  /** De turbo-schakelaar voor V8 en Sportauto (Turbo zelf heeft hem altijd). */
  function zetTurbo(b) { turboKeuze = !!b; if (!turboKeuze) staat.druk = 0; }
  function heeftTurbo(naam) { var K = KARAKTERS[naam]; return !!(K && K.tb && !K.altijdTurbo); }
  function verbind(audioCtx) {
    if (ctx || !audioCtx) return;
    ctx = audioCtx;
    var master = ctx.createGain(); master.gain.value = MAX;
    var an = ctx.createAnalyser(); an.fftSize = 2048;
    master.connect(an); an.connect(ctx.destination);
    uit = master; staat.analyser = an;
  }
  /** Het niveau aan de uitgang (RMS en piek), voor de proef. */
  function meet() {
    var an = staat.analyser; if (!an) return null;
    var d = new Float32Array(an.fftSize); an.getFloatTimeDomainData(d);
    var s = 0, p = 0, sprong = 0;
    for (var i = 0; i < d.length; i++) { s += d[i] * d[i]; p = Math.max(p, Math.abs(d[i])); if (i) sprong = Math.max(sprong, Math.abs(d[i] - d[i - 1])); }
    return { rms: Math.sqrt(s / d.length), piek: p, sprong: sprong };
  }

  w.Motor = {
    KARAKTERS: Object.keys(KARAKTERS), MAX: MAX, STIL_MS: STIL_MS,
    DRUK_BLAAS: DRUK_BLAAS, BLAAS_RUST_MS: BLAAS_RUST_MS,
    verbind: verbind, zet: zet, duik: duik, meet: meet, zetTurbo: zetTurbo, heeftTurbo: heeftTurbo, turbo: function () { return turboKeuze; },
    karakter: function () { return karakter; },
    opBron: function (f) { bron = f; }, opMag: function (f) { mag = f; }, opLog: function (f) { log = f; },
    staat: function () { return { karakter: karakter, aan: !!keten, slaapt: staat.slaapt, kmh: Math.round(staat.kmh), rpm: Math.round(staat.rpm), versnelling: staat.versnelling + 1, gas: Math.round(staat.gas * 100) / 100, duiken: staat.duiken || 0, turbo: turboAan(), druk: Math.round(staat.druk * 100) / 100, blazen: staat.blazen, herstellingen: staat.herstellingen || 0, duik: keten ? keten.duik.gain.value : null, herstel: keten ? keten.herstel.gain.value : null }; },
    _tik: tik, _stilMs: function (ms) { STIL_MS = ms; }, _blaas: function (s) { blaas(s, performance.now(), "proef"); }
  };
})(window);
