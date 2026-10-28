// Rijhulp voor de Tesla-browser: snelheid, maximumsnelheid uit OpenStreetMap en
// meldingen bij flitspalen en trajectcontroles. Geluid voorop, het scherm groot en rustig.
(function () {
  "use strict";
  var q = new URLSearchParams(location.search);
  var G = window.Geo, Geluid = window.Geluid, Kaart = window.Kaart, Flitsers = window.Flitsers, Gemeld = window.Gemeld, Motor = window.Motor, Matrix = window.Matrix;
  var eerste = ((navigator.languages && navigator.languages[0]) || navigator.language || "en").slice(0, 2).toLowerCase();
  var taal = q.get("taal") === "en" || q.get("taal") === "nl" ? q.get("taal") : eerste === "nl" ? "nl" : "en";
  document.documentElement.lang = taal;

  // Flitsers alleen waar het mag: de tabel komt uit data/landen.json (een kopie van landen.json in
  // de wortel van de repo, zie PROTOCOL.md). Tot die geladen is, en in elk land dat er niet in staat,
  // staat de laag uit. De grenzen in data/grenzen.json bevatten alleen de landen die aan staan.
  var FLITSERS_PER_LAND = {};
  // De tijdzone per land voor tijdvoorwaarden op de borden (IANA-naam, via Intl). Een land dat hier
  // niet in staat rekent met Europe/Amsterdam; vul aan als je app in andere landen rijdt.
  var ZONE_PER_LAND = { NL: "Europe/Amsterdam", BE: "Europe/Brussels", LU: "Europe/Luxembourg", DE: "Europe/Berlin", FR: "Europe/Paris", IT: "Europe/Rome", ES: "Europe/Madrid", AT: "Europe/Vienna", CH: "Europe/Zurich" };

  var T = {
    nl: {
      titel: "Rijhulp", uitleg: "Je snelheid, de limiet van de weg en een melding vooraf bij flitspalen en trajectcontroles. Met geluid, zodat je op de weg kunt blijven letten.",
      start: "Start", klein: "Gratis, zonder account. Je positie gaat alleen mee als je zelf een flitser meldt.", kmh: "km/h",
      flitser: "Flitser", rood: "Roodlichtcamera", flitserRood: "Flitser en rood licht", max: "max",
      traject: "Trajectcontrole", gemiddeld: "gemiddeld", gem: "gem.", gemVolgt: "gem. volgt", nog: "nog", over: "over", km: "km",
      aan: "flitsers aan", uit: "flitsers uit", buiten: "Ander land", gpsZoekt: "GPS zoekt", gps: "GPS",
      geluidAan: "Geluid aan", geluidUit: "Geluid uit", test: "Test geluid", scherm: "Volledig scherm", info: "Info",
      laden: "Kaart ophalen", geenLimiet: "Limiet onbekend", geenGps: "Deze browser geeft geen positie.", gpsGeweigerd: "Locatie staat uit voor deze site.",
      wachtLocatie: "Wacht op je locatie", nogGeenLocatie: "Nog geen locatie. Staat locatie aan?", kaartWeg: "Kaart niet beschikbaar, alleen snelheid",
      zoAan: "Zo zet je hem aan:", daarna: "Tik daarna opnieuw op Start.",
      hulpIos: ["Open Instellingen, Privacy en beveiliging, Locatievoorzieningen en zet Locatievoorzieningen aan.", "Tik in dezelfde lijst op {app} en kies Bij gebruik van app. Zet Exacte locatie aan.", "Terug in {browser}: tik op aA in de adresbalk, Website-instellingen, Locatie, en kies Sta toe of Vraag.", "Herlaad de pagina."],
      hulpAndroid: ["Tik op het icoon links van het adres (slotje of schuifjes), Machtigingen of Site-instellingen, Locatie, en kies Toestaan.", "Staat locatie op de telefoon uit? Veeg vanaf boven omlaag en zet Locatie aan.", "Herlaad de pagina."],
      hulpAnders: ["Klik op het icoon links van het adres (slotje of schuifjes), Locatie, en kies Toestaan.", "Staat locatie van het apparaat uit? Zet die aan in de instellingen van het systeem.", "Herlaad de pagina."],
      safariSites: "Safari-websites",
      bron: "Kaartdata",
      flitserHier: "Flitser hier", gemeldFlitser: "Gemelde flitser", gemeldGeleden: "gemeld {n} min geleden", gemeldNet: "net gemeld", bevestigd: "bevestigd {n} min geleden", bevestigdNet: "net bevestigd",
      gemeldOk: "Gemeld, dank je", gemeldSamen: "Bevestigd, dank je", gemeldBezig: "Even...", gemeldTeSnel: "Net al gemeld", gemeldVol: "Genoeg voor vandaag", gemeldBuiten: "Niet in dit land", gemeldGeenPos: "Nog geen locatie", gemeldNetwerk: "Geen verbinding", gemeldProef: "Proefrit: niet verstuurd",
      nogDaar: "Staat hij er nog?", ja: "Ja", nee: "Nee", dank: "Dank je",
      matrixbord: "Matrixbord", advies: "Advies {n}", matrixBron: "Matrixborden", strookDicht: "dicht", strookOpen: "open", strookLinks: "naar links", strookRechts: "naar rechts", strookEinde: "einde", strookLeeg: "leeg", stroken: "Rijstroken",
      motor: "Motorgeluid", sport: "Sportauto", ruimte: "Ruimteschip", kever: "Oude Kever", turbo: "Turbo", turboSchakel: "Turbo op V8 en Sportauto", motorUit: "Uit", motorUitleg: "Zachter bij elke melding, uit als je stilstaat."
    },
    en: {
      titel: "Drive assist", uitleg: "Your speed, the speed limit of the road and an alert ahead of speed cameras and average speed checks. With sound, so your eyes stay on the road.",
      start: "Start", klein: "Free, no account. Your position is only sent when you report a camera yourself.", kmh: "km/h",
      flitser: "Speed camera", rood: "Red light camera", flitserRood: "Speed and red light camera", max: "max",
      traject: "Average speed check", gemiddeld: "average", gem: "avg", gemVolgt: "avg follows", nog: "left", over: "in", km: "km",
      aan: "camera alerts on", uit: "camera alerts off", buiten: "Other country", gpsZoekt: "GPS searching", gps: "GPS",
      geluidAan: "Sound on", geluidUit: "Sound off", test: "Test sound", scherm: "Full screen", info: "Info",
      laden: "Getting the map", geenLimiet: "Limit unknown", geenGps: "This browser gives no position.", gpsGeweigerd: "Location is off for this site.",
      wachtLocatie: "Waiting for your location", nogGeenLocatie: "No location yet. Is location on?", kaartWeg: "Map not available, speed only",
      zoAan: "How to turn it on:", daarna: "Then tap Start again.",
      hulpIos: ["Open Settings, Privacy & Security, Location Services and turn Location Services on.", "In the same list, tap {app} and choose While Using the App. Turn Precise Location on.", "Back in {browser}: tap aA in the address bar, Website Settings, Location, and choose Allow or Ask.", "Reload the page."],
      hulpAndroid: ["Tap the icon left of the address (lock or sliders), Permissions or Site settings, Location, and choose Allow.", "Is location off on the phone? Swipe down from the top and turn Location on.", "Reload the page."],
      hulpAnders: ["Click the icon left of the address (lock or sliders), Location, and choose Allow.", "Is location off on the device? Turn it on in the system settings.", "Reload the page."],
      safariSites: "Safari Websites",
      bron: "Map data",
      flitserHier: "Camera here", gemeldFlitser: "Reported camera", gemeldGeleden: "reported {n} min ago", gemeldNet: "just reported", bevestigd: "confirmed {n} min ago", bevestigdNet: "just confirmed",
      gemeldOk: "Reported, thanks", gemeldSamen: "Confirmed, thanks", gemeldBezig: "One moment...", gemeldTeSnel: "Just reported", gemeldVol: "Enough for today", gemeldBuiten: "Not in this country", gemeldGeenPos: "No location yet", gemeldNetwerk: "No connection", gemeldProef: "Test drive: not sent",
      nogDaar: "Is it still there?", ja: "Yes", nee: "No", dank: "Thanks",
      matrixbord: "Overhead sign", advies: "Advised {n}", matrixBron: "Overhead signs", strookDicht: "closed", strookOpen: "open", strookLinks: "move left", strookRechts: "move right", strookEinde: "end", strookLeeg: "blank", stroken: "Lanes",
      motor: "Engine sound", sport: "Sports car", ruimte: "Spaceship", kever: "Old Beetle", turbo: "Turbo", turboSchakel: "Turbo on V8 and Sports car", motorUit: "Off", motorUitleg: "Quieter for every alert, off when you stand still."
    }
  }[taal];
  document.querySelectorAll("[data-t]").forEach(function (el) { var k = el.getAttribute("data-t"); if (T[k]) el.textContent = T[k]; });
  document.querySelectorAll("[data-t-label]").forEach(function (el) { var k = el.getAttribute("data-t-label"); if (T[k]) { el.setAttribute("aria-label", T[k]); el.title = T[k]; } });

  var $ = function (id) { return document.getElementById(id); };
  var el = { start: $("startscherm"), startKnop: $("startKnop"), startFout: $("startFout"), startHulp: $("startHulp"), rit: $("rit"), v: $("v"), bord: $("bord"), lim: $("lim"), limTekst: $("limTekst"), stroken: $("stroken"),
    land: $("land"), gps: $("gps"), geluid: $("geluidKnop"), test: $("testKnop"), scherm: $("schermKnop"), melding: $("melding"), mWat: $("mWat"), mDetail: $("mDetail"), mAfstand: $("mAfstand"), debug: $("debug"),
    meldKnop: $("meldKnop"), meldTekst: $("meldTekst"), vraag: $("vraag"), vraagJa: $("vraagJa"), vraagNee: $("vraagNee"), snelheid: document.querySelector(".snelheid"), motorKeuze: $("motorKeuze"), turboKnop: $("turboKnop") };

  var instelling = { teHard: true, stil: false, motor: "", turbo: false };
  try { var opgeslagen = JSON.parse(localStorage.getItem("rijhulp") || "{}"); if (typeof opgeslagen.teHard === "boolean") instelling.teHard = opgeslagen.teHard; if (typeof opgeslagen.stil === "boolean") instelling.stil = opgeslagen.stil; if (typeof opgeslagen.motor === "string" && Motor.KARAKTERS.indexOf(opgeslagen.motor) >= 0) instelling.motor = opgeslagen.motor; if (typeof opgeslagen.turbo === "boolean") instelling.turbo = opgeslagen.turbo; } catch (e) { /* zonder opslag */ }
  function bewaar() { try { var oud = JSON.parse(localStorage.getItem("rijhulp") || "{}"); for (var k in instelling) oud[k] = instelling[k]; localStorage.setItem("rijhulp", JSON.stringify(oud)); } catch (e) { /* zonder opslag */ } }

  var staat = { gestart: false, wegT: 0, pos: null, kmh: null, koers: null, weg: null, land: undefined, flitsersAan: false, laatsteFix: 0, gpsKwijt: false, stilTikken: 0, teHardSinds: 0, teHardGemeld: 0, teHardGewapend: true, laatsteStap: 0, vorigeVoorKoers: null, vorigeVoorSnelheid: null, scherm: {} };
  var grenzen = null;
  var logRegels = [];
  function log(t) { logRegels.push(new Date().toISOString().slice(11, 19) + " " + t); if (logRegels.length > 60) logRegels.shift(); }

  // Data meteen laden; het geluid kan pas na de tik op Start.
  var dataKlaar = Promise.all([
    fetch("data/grenzen.json").then(function (r) { return r.json(); }).then(function (j) { grenzen = j.landen; }),
    fetch("data/landen.json").then(function (r) { return r.json(); }).then(function (j) { for (var cc in j.landen) FLITSERS_PER_LAND[cc] = j.landen[cc].flitsers === "aan"; }),
    Flitsers.laad().then(function (s) { log("flitsers: " + s.camera + " camera's, " + s.trajecten + " trajecten, stand " + s.stand); }),
    Kaart.start(log)
  ]).catch(function (e) { log("data: " + e.message); });

  Flitsers.opZeg(function (delen, dringend) { Geluid.zeg(delen, dringend); });
  // Wat al gezegd is blijft bewaard bij herladen en geldt ook voor een tweede tabblad; in de proefrit
  // alleen met &geheugen=1.
  Flitsers.bewaarGezegd(!q.has("sim") || q.get("geheugen") === "1");
  Gemeld.opZeg(function (delen, dringend) { Geluid.zeg(delen, dringend); });
  Gemeld.opLog(log);
  Matrix.opZeg(function (delen, dringend) { Geluid.zeg(delen, dringend); });
  Matrix.opLog(log);
  Gemeld.opVraag(function (m) { toonVraag(m); });
  Motor.opLog(log);
  Motor.opBron(function () { return { kmh: staat.kmh || 0, t: staat.pos ? staat.pos.t : Date.now() }; });
  Motor.opMag(function () { return staat.gestart && !instelling.stil; });
  // Bij elke melding gaat het motorgeluid eerst bijna uit, en daarna rustig terug.
  Geluid.opSpreek(function (duur) { Motor.duik(duur); }, function () { return Motor.staat().aan ? 0.18 : 0; });
  Geluid.opZeg(function (delen) { log("zeg " + delen.join(" + ")); });
  Geluid.zetStil(instelling.stil);

  function landVan(lat, lon) {
    if (!grenzen) return undefined;
    for (var cc in grenzen) if (G.binnen(lat, lon, grenzen[cc])) return cc;
    return null;
  }

  // ---------- Start ----------
  el.startKnop.addEventListener("click", function () {
    Geluid.ontgrendel();
    Motor.verbind(Geluid.context());
    Motor.zetTurbo(instelling.turbo);
    if (instelling.motor) Motor.zet(instelling.motor);
    if (!staat.gestart) {
      staat.gestart = true;
      Geluid.laad(taal).then(function () { Geluid.zeg(["start"]); log("geluid geladen"); }).catch(function (e) { log("geluid: " + e.message); Geluid.zeg(["gong"]); });
    }
    if (!("geolocation" in navigator)) { el.startFout.textContent = T.geenGps; return; }
    el.start.hidden = true; el.rit.hidden = false;
    schermAan();
    try { var d = document.documentElement; var f = d.requestFullscreen || d.webkitRequestFullscreen; if (f && !q.has("sim")) { var p = f.call(d); if (p && p.catch) p.catch(function () {}); } } catch (e) { /* mag niet: dan zonder */ }
    el.startHulp.hidden = true; el.startFout.textContent = "";
    staat.startT = Date.now();
    meldKaart();
    // Niet op de data wachten: de snelheid kan meteen, de kaart en de flitsers volgen.
    startGps();
  });

  // ---------- Uitleg bij geen toestemming ----------
  function platform() {
    var ua = navigator.userAgent || "";
    if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)) {
      var naam = /CriOS/.test(ua) ? "Chrome" : /FxiOS/.test(ua) ? "Firefox" : /EdgiOS/.test(ua) ? "Edge" : "Safari";
      return { soort: "ios", app: naam === "Safari" ? T.safariSites : naam, browser: naam };
    }
    if (/Android/.test(ua)) return { soort: "android" };
    return { soort: "anders" };
  }
  function toonHulp() {
    var p = platform();
    var stappen = p.soort === "ios" ? T.hulpIos : p.soort === "android" ? T.hulpAndroid : T.hulpAnders;
    el.startFout.textContent = T.gpsGeweigerd;
    el.startHulp.textContent = "";
    var kop = document.createElement("p"); kop.textContent = T.zoAan; el.startHulp.appendChild(kop);
    var ol = document.createElement("ol");
    stappen.forEach(function (t) { var li = document.createElement("li"); li.textContent = t.replace("{app}", p.app || "").replace("{browser}", p.browser || ""); ol.appendChild(li); });
    el.startHulp.appendChild(ol);
    var na = document.createElement("p"); na.textContent = T.daarna; el.startHulp.appendChild(na);
    el.startHulp.hidden = false;
  }
  var watchId = null;
  function startGps() {
    if (watchId != null) navigator.geolocation.clearWatch(watchId);
    watchId = navigator.geolocation.watchPosition(opPositie, function (e) {
      log("gps fout " + e.code + " " + e.message);
      if (e.code === 1) { el.start.hidden = false; el.rit.hidden = true; toonHulp(); }
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }

  // ---------- Scherm aan ----------
  var lock = null;
  function schermAan() {
    if (!("wakeLock" in navigator) || (lock && !lock.released)) return;
    navigator.wakeLock.request("screen").then(function (l) { lock = l; log("scherm blijft aan"); }).catch(function (e) { log("wake lock: " + e.name); });
  }
  document.addEventListener("visibilitychange", function () { if (!document.hidden && staat.gestart) schermAan(); });

  // ---------- Knoppen ----------
  function toonGeluidKnop() {
    el.geluid.classList.toggle("uit", instelling.stil);
    el.geluid.setAttribute("aria-pressed", String(!instelling.stil));
    var t = instelling.stil ? T.geluidUit : T.geluidAan;
    el.geluid.setAttribute("aria-label", t); el.geluid.title = t;
  }
  toonGeluidKnop();
  el.geluid.addEventListener("click", function () { instelling.stil = !instelling.stil; Geluid.zetStil(instelling.stil); bewaar(); toonGeluidKnop(); if (!instelling.stil) Geluid.zeg(["zacht"]); });
  el.test.addEventListener("click", function () { Geluid.ontgrendel(); Geluid.zeg(["gong", "proef"], true, true); });
  el.scherm.addEventListener("click", function () {
    var d = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    var f = d.requestFullscreen || d.webkitRequestFullscreen; if (f) { var p = f.call(d); if (p && p.catch) p.catch(function () {}); }
  });

  // ---------- Positie ----------
  // De tijd van een positie komt van de klok van de rit, niet uit pos.timestamp (zie Geo.maakKlok).
  // In de proefrit loopt de tijd bewust anders (sneller, of op een gekozen uur): daar telt de positie.
  var ritKlok = G.maakKlok(function () { return window.performance && performance.now ? performance.now() : Date.now(); }, function () { return Date.now(); });
  var vorigePos = null;
  function opPositie(pos) {
    var c = pos.coords;
    // Twee keer dezelfde positie (een tweede luisteraar, of de browser herhaalt hem): een keer.
    var sleutel = pos.timestamp + "|" + c.latitude + "|" + c.longitude + "|" + c.speed;
    if (sleutel === vorigePos) return;
    vorigePos = sleutel;
    var t = q.has("sim") ? Math.max(pos.timestamp || 0, staat.laatsteT || 0) : ritKlok();
    staat.laatsteT = t;
    if (pos.timestamp) staat.klokAf = Math.round((pos.timestamp - Date.now()) / 1000);
    staat.laatsteFix = Date.now(); staat.stilTikken = 0;
    if (staat.gpsKwijt) { staat.gpsKwijt = false; Geluid.zeg(["zacht", "gps_terug"]); }
    if (c.accuracy > 100) { zetTekst(el.gps, T.gpsZoekt); el.gps.className = "chip zoekt"; return; }
    // Snelheid: coords.speed is in de Tesla altijd gevuld. Anders zelf uitrekenen over minstens 1 s.
    var kmh = c.speed != null && !isNaN(c.speed) ? c.speed * 3.6 : null;
    var v = staat.vorigeVoorSnelheid;
    if (kmh == null && v && t - v.t >= 1000) kmh = (G.afstand(v.lat, v.lon, c.latitude, c.longitude) / ((t - v.t) / 1000)) * 3.6;
    if (!v || t - v.t >= 1000) staat.vorigeVoorSnelheid = { lat: c.latitude, lon: c.longitude, t: t };
    if (kmh == null) kmh = staat.kmh || 0;
    // Richting: coords.heading, of uit de beweging over minstens 15 m.
    var koers = c.heading != null && !isNaN(c.heading) && kmh > 4 ? c.heading : null;
    var vk = staat.vorigeVoorKoers;
    if (vk && G.afstand(vk.lat, vk.lon, c.latitude, c.longitude) >= 15) {
      if (koers == null) koers = G.peiling(vk.lat, vk.lon, c.latitude, c.longitude);
      staat.vorigeVoorKoers = { lat: c.latitude, lon: c.longitude };
    } else if (!vk) staat.vorigeVoorKoers = { lat: c.latitude, lon: c.longitude };
    if (koers == null && kmh > 4) koers = staat.koers;
    staat.kmh = kmh; staat.koers = koers;
    staat.pos = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, t: t };
    zetTekst(el.v, String(Math.round(kmh)));
    zetTekst(el.gps, T.gps + " " + Math.round(c.accuracy) + " m"); el.gps.className = c.accuracy <= 25 ? "chip goed" : "chip zoekt";

    // Het zware werk vijf keer per seconde, in de tijd van de posities.
    if (t - staat.laatsteStap < 200 && t >= staat.laatsteStap) return;
    staat.laatsteStap = t;
    var d = datumVan(t);
    staat.tegelKlaar = Kaart.vraagRond(c.latitude, c.longitude, koers, kmh);
    // Even geen weg (kruispunt, GPS-sprong): de vorige 3 s laten staan in plaats van te knipperen.
    var nieuw = Kaart.weg(c.latitude, c.longitude, kmh > 4 ? koers : null, d, kmh);
    if (nieuw) { staat.weg = nieuw; staat.wegT = t; }
    else if (!staat.wegT || t - staat.wegT > 3000) staat.weg = null;
    var land = landVan(c.latitude, c.longitude);
    if (land !== undefined && land !== staat.land) {
      var was = staat.flitsersAan, eerder = staat.land !== undefined;
      staat.land = land;
      // Tijdvoorwaarden (zoals 130 van 19:00 tot 6:00) in de tijd van het land, niet van het toestel.
      Kaart.zetZone(ZONE_PER_LAND[land] || "Europe/Amsterdam");
      staat.flitsersAan = !!(land && FLITSERS_PER_LAND[land] === true);
      if (eerder && was !== staat.flitsersAan) Geluid.zeg(["zacht", staat.flitsersAan ? "land_aan" : "land_uit"]);
      if (!eerder && !staat.flitsersAan) Geluid.zeg(["zacht", "land_uit"]);
      log("land " + (land || "ander land") + ", flitsers " + (staat.flitsersAan ? "aan" : "uit"));
    }
    var f = Flitsers.stap({ lat: c.latitude, lon: c.longitude, kmh: kmh, koers: koers, t: t, datum: d }, staat.flitsersAan);
    var g = Gemeld.stap({ lat: c.latitude, lon: c.longitude, kmh: kmh, koers: koers, t: t }, staat.flitsersAan);
    f.gemeld = g.gemeld;
    // Matrixborden (alleen in NL): de limiet van het portaal gaat voor de vaste limiet van de kaart.
    var vast = limietNu(f);
    f.matrix = Matrix.stap({ lat: c.latitude, lon: c.longitude, kmh: kmh, koers: koers, t: t, limiet: vast && !vast.impliciet ? vast.v : null }, staat.land === "NL");
    teHard(kmh, t, f);
    teken(f);
  }

  // Tijd van de dag voor tijdvoorwaarden ("130 @ (19:00-06:00)"). pos.timestamp hoort de tijd van de
  // meting te zijn, maar niet elke browser vult hem uit dezelfde klok. Wijkt hij meer dan 2 minuten af
  // van de klok van het toestel, dan telt die klok (in ?debug=1: klokAf in seconden). In de proefrit
  // lopen de tijden bewust anders (sneller, of op een gekozen uur): daar telt de positie.
  function datumVan(t) {
    var af = t - Date.now();
    if (q.has("sim") || Math.abs(af) <= 120000) return new Date(t);
    if (!staat.klokGemeld) { staat.klokGemeld = true; log("klok: positie wijkt " + staat.klokAf + " s af, de klok van het toestel telt"); }
    return new Date();
  }
  function limietNu(f) {
    var w = staat.weg && staat.weg.limiet;
    if (f && f.matrix && f.matrix.limiet) return f.matrix.limiet;
    // Trajectcontrole en weg: bij twijfel de laagste (27 okt 2026: het traject toonde 130 waar 100 gold).
    if (f && f.traject && !f.traject.komt && f.traject.limiet) {
      if (w && w.v && !w.impliciet && w.v < f.traject.limiet) return w;
      return { v: f.traject.limiet, traject: true };
    }
    return w && w.v ? w : null;
  }
  function teHard(kmh, t, f) {
    var L = limietNu(f);
    var echt = L && !L.impliciet;
    var over = echt && kmh > L.v + 3;
    document.body.classList.toggle("te-hard", !!over);
    if (!echt || !instelling.teHard) { staat.teHardSinds = 0; return; }
    if (kmh <= L.v) { staat.teHardGewapend = true; staat.teHardSinds = 0; return; }
    if (kmh > L.v + 5) {
      if (!staat.teHardSinds) staat.teHardSinds = t;
      if (staat.teHardGewapend && t - staat.teHardSinds > 3000 && t - staat.teHardGemeld > 60000) {
        staat.teHardGemeld = t; staat.teHardGewapend = false;
        Geluid.zeg(["let", "te_hard"], false);
      }
    } else staat.teHardSinds = 0;
  }

  // ---------- Waar wacht de app op ----------
  // Zonder limiet zegt de tekst onder het bord waarom: nog geen locatie, de kaart wordt
  // opgehaald, of de kaart is er niet (dan blijft de snelheid werken en probeert de app het
  // op de achtergrond opnieuw).
  function meldKaart(L) {
    var t = "";
    if (!staat.pos || Date.now() - staat.laatsteFix > 15000) t = staat.startT && Date.now() - staat.startT > 20000 && !staat.pos ? T.nogGeenLocatie : T.wachtLocatie;
    else if (!L) {
      var st = Kaart.status(staat.pos.lat, staat.pos.lon);
      staat.kaartStatus = st;
      if (st.klaar) t = T.geenLimiet;
      else if (st.mislukt >= 2 || st.wacht > (st.bron === "vooraf" ? 12000 : 40000)) t = T.kaartWeg;
      else t = T.laden;
    }
    zetTekst(el.limTekst, t);
  }

  // ---------- Tekenen ----------
  function zetTekst(e, t) { if (e.textContent !== t) e.textContent = t; }
  function teken(f) {
    var L = limietNu(f);
    zetTekst(el.lim, L ? String(L.v) : "");
    el.bord.className = "bord" + (L ? (L.impliciet ? " impliciet" : "") + (L.matrix ? " matrix" : "") : " leeg");
    var stand = Kaart.stand();
    meldKaart(L);
    var mx = f.matrix || {};
    if (L && L.matrix) zetTekst(el.limTekst, T.matrixbord);
    else if (mx.advies) zetTekst(el.limTekst, T.advies.replace("{n}", mx.advies));
    el.limTekst.classList.toggle("matrix", !!((L && L.matrix) || mx.advies));
    tekenStroken(mx.portaal);
    if (staat.land !== undefined) {
      zetTekst(el.land, (staat.land || T.buiten) + " · " + (staat.flitsersAan ? T.aan : T.uit));
      el.land.className = "chip " + (staat.flitsersAan ? "goed" : "uit");
    }
    // Eén melding tegelijk: actief traject, dan de dichtste camera, dan een traject dat komt.
    var m = null;
    if (f.traject && !f.traject.komt) {
      var tr = f.traject, gemOk = tr.gem != null;
      var over = tr.limiet && gemOk && tr.gem > tr.limiet;
      var nog = T.nog + " " + String(tr.rest).replace(".", taal === "nl" ? "," : ".") + " " + T.km;
      // Het gemiddelde is waar het om gaat: dat groot, de rest klein. Halverwege aangesloten en nog
      // te weinig gemeten: geen getal, dan staat de resterende afstand groot.
      m = { soort: "traject", wat: T.traject, detail: (tr.limiet ? T.max + " " + tr.limiet + " \u00b7 " : "") + (gemOk ? nog : T.gemVolgt), afstand: gemOk ? T.gem + " " + tr.gem : nog, fout: over, d: 0 };
    } else if (f.camera && (!f.gemeld || f.camera.d <= f.gemeld.d)) {
      m = { soort: "camera", wat: f.camera.soort === 1 ? T.rood : f.camera.soort === 2 ? T.flitserRood : T.flitser, detail: f.camera.max ? T.max + " " + f.camera.max : "", afstand: f.camera.d + " m", d: f.camera.d };
    } else if (f.gemeld) {
      var gm = f.gemeld;
      var wanneer = gm.bevestigd != null && gm.bevestigd < gm.min ? (gm.bevestigd < 1 ? T.bevestigdNet : T.bevestigd.replace("{n}", gm.bevestigd)) : (gm.min < 1 ? T.gemeldNet : T.gemeldGeleden.replace("{n}", gm.min));
      m = { soort: "gemeld", wat: T.gemeldFlitser, detail: wanneer, afstand: gm.d + " m", d: gm.d };
    } else if (f.traject && f.traject.komt) {
      m = { soort: "traject", wat: T.traject, detail: f.traject.limiet ? T.max + " " + f.traject.limiet : "", afstand: f.traject.d + " m", d: f.traject.d };
    }
    // Een melding die er echt aankomt (dichter dan 500 m, of een traject) gaat voor de vraag
    // "Staat hij er nog?"; een flitspaal die nog ver weg op het scherm staat niet.
    if (m && vraagNu && (m.soort === "traject" || m.d <= 500)) verbergVraag();
    el.meldKnop.classList.toggle("uit", !staat.flitsersAan);
    if (!m || vraagNu) { el.melding.hidden = true; }
    else {
      el.melding.hidden = false;
      el.melding.className = "melding " + m.soort + (m.fout ? " fout" : "");
      zetTekst(el.mWat, m.wat); zetTekst(el.mDetail, m.detail); zetTekst(el.mAfstand, m.afstand);
    }
    if (el.debug) {
      el.debug.textContent = JSON.stringify({ matrix: Matrix.staat(), portaal: mx.portaal || null, kmh: Math.round(staat.kmh), koers: staat.koers == null ? null : Math.round(staat.koers), weg: staat.weg, land: staat.land, flitsers: staat.flitsersAan, kaart: stand, kaartStatus: staat.kaartStatus, geluid: Geluid.staat() + (Geluid.klaar() ? ", geladen" : ""), rij: Geluid.rij(), traject: f.traject && !f.traject.komt ? f.traject : !!Flitsers.actiefTraject(), klokAf: staat.klokAf, gemeld: Object.keys(Gemeld.lijst()).length, motor: Motor.staat() }) + "\n" + logRegels.slice(-14).join("\n");
    }
  }

  // De stroken van het portaal boven de weg: per rijstrook wat erop staat (getal, kruis, pijl).
  var STROOK_SVG = {
    x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M19 5L5 19" stroke="#e3261d"/></svg>',
    o: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v15M6 13l6 6 6-6" stroke="#3ecf8e"/></svg>',
    "<": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5L7 16M7 8v8h8" stroke="#f5f5f5"/></svg>',
    ">": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5l11 11M17 8v8H9" stroke="#f5f5f5"/></svg>',
    e: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="#f5f5f5" stroke-width="2"/><path d="M6.5 17.5l11-11" stroke="#f5f5f5" stroke-width="2"/></svg>',
    "!": '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v9M12 18.5v.5" stroke="#f5b83d"/></svg>'
  };
  var strokenNu = "";
  function tekenStroken(p) {
    var sleutel = p ? p.stroken.join(" ") : "";
    if (sleutel === strokenNu) return;
    strokenNu = sleutel;
    if (!p) { el.stroken.hidden = true; el.stroken.textContent = ""; return; }
    var namen = [];
    el.stroken.innerHTML = p.stroken.map(function (c) {
      var m = /^(a?)(\d+)(f?)$/.exec(c);
      if (m && !m[1]) { namen.push(m[2]); return '<span class="strook"><span class="ring">' + m[2] + "</span></span>"; }
      if (m) { namen.push(T.advies.replace("{n}", m[2])); return '<span class="strook advies' + (m[3] ? " knippert" : "") + '">' + m[2] + "</span>"; }
      namen.push(c === "x" ? T.strookDicht : c === "o" ? T.strookOpen : c === "<" ? T.strookLinks : c === ">" ? T.strookRechts : c === "e" ? T.strookEinde : T.strookLeeg);
      return '<span class="strook">' + (STROOK_SVG[c] || "") + "</span>";
    }).join("");
    el.stroken.setAttribute("role", "img");
    el.stroken.setAttribute("aria-label", T.stroken + ": " + namen.join(", "));
    el.stroken.hidden = false;
  }

  // ---------- Flitser hier ----------
  // Eén tik: positie en rijrichting van nu. Geen typen, geen bevestiging.
  var meldBezig = false, meldKlok = null;
  function meldFeedback(t, soort) {
    zetTekst(el.meldTekst, t);
    el.meldKnop.classList.remove("ok", "nee"); if (soort) el.meldKnop.classList.add(soort);
    clearTimeout(meldKlok);
    meldKlok = setTimeout(function () { zetTekst(el.meldTekst, T.flitserHier); el.meldKnop.classList.remove("ok", "nee"); }, 3500);
  }
  el.meldKnop.addEventListener("click", function () {
    Geluid.ontgrendel();
    if (meldBezig) return;
    if (!staat.pos || Date.now() - staat.laatsteFix > 15000) { meldFeedback(T.gemeldGeenPos, "nee"); return; }
    if (staat.land !== undefined && !staat.flitsersAan) { meldFeedback(T.gemeldBuiten, "nee"); return; }
    meldBezig = true; zetTekst(el.meldTekst, T.gemeldBezig);
    var p = { lat: staat.pos.lat, lon: staat.pos.lon, koers: staat.koers, acc: staat.pos.acc };
    Gemeld.meld(p).then(function (u) {
      meldBezig = false;
      log("gemeld: " + (u.ok ? (u.samengevoegd ? "samengevoegd " : "nieuw ") + u.id : u.code));
      if (u.ok) { meldFeedback(u.samengevoegd ? T.gemeldSamen : T.gemeldOk, "ok"); Geluid.zeg(["zacht", "dank_gemeld"]); return; }
      meldFeedback(u.code === "te_snel" ? T.gemeldTeSnel : u.code === "dag_vol" ? T.gemeldVol : u.code === "buiten" ? T.gemeldBuiten : u.code === "proefrit" ? T.gemeldProef : u.code === "netwerk" ? T.gemeldNetwerk : T.gemeldNetwerk, "nee");
    });
  });

  // ---------- Staat hij er nog? ----------
  // Na het langsrijden: twee grote knoppen, en na 15 s vanzelf weg (geen antwoord is ook goed).
  var vraagNu = null, vraagKlok = null;
  function toonVraag(m) {
    vraagNu = m;
    el.vraag.hidden = false; el.melding.hidden = true;
    el.vraag.classList.remove("bedankt");
    el.vraag.querySelector(".vtekst").textContent = T.nogDaar;
    // De balk die afloopt opnieuw starten.
    var balk = el.vraag.querySelector(".vtijd"); balk.style.animation = "none"; void balk.offsetWidth; balk.style.animation = "";
    Geluid.zeg(["zacht"]);
    clearTimeout(vraagKlok); vraagKlok = setTimeout(verbergVraag, 15000);
    log("vraag: staat " + m.id + " er nog?");
  }
  function verbergVraag() { vraagNu = null; el.vraag.hidden = true; clearTimeout(vraagKlok); }
  function antwoord(ja) {
    if (!vraagNu) return;
    var m = vraagNu;
    Gemeld.stem(m.id, ja).then(function (x) { log("stem " + m.id + " " + (ja ? "ja" : "nee") + ": " + x.status); });
    el.vraag.classList.add("bedankt"); el.vraag.querySelector(".vtekst").textContent = T.dank;
    clearTimeout(vraagKlok); vraagKlok = setTimeout(verbergVraag, 1200);
    vraagNu = null;
  }
  el.vraagJa.addEventListener("click", function () { antwoord(true); });
  el.vraagNee.addEventListener("click", function () { antwoord(false); });

  // ---------- Motorgeluid (verborgen) ----------
  // Vijf keer op de snelheid tikken opent de keuze. Standaard uit.
  var tikken = [];
  el.snelheid.addEventListener("click", function () {
    var nu = Date.now();
    tikken = tikken.filter(function (t) { return nu - t < 3000; }); tikken.push(nu);
    if (tikken.length >= 5) { tikken = []; toonMotorKeuze(el.motorKeuze.hidden); }
  });
  var motorKlok = null;
  function toonMotorKeuze(aan) {
    el.motorKeuze.hidden = !aan;
    if (!aan) return;
    el.motorKeuze.querySelectorAll("[data-motor]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-motor") === instelling.motor)); });
    el.turboKnop.setAttribute("aria-pressed", String(instelling.turbo));
    clearTimeout(motorKlok); motorKlok = setTimeout(function () { el.motorKeuze.hidden = true; }, 20000);
  }
  el.motorKeuze.addEventListener("click", function (e) {
    var b = e.target.closest("[data-motor]"); if (!b) return;
    Geluid.ontgrendel(); Motor.verbind(Geluid.context());
    instelling.motor = b.getAttribute("data-motor"); bewaar();
    Motor.zet(instelling.motor);
    el.motorKeuze.hidden = true;
    log("motorgeluid: " + (instelling.motor || "uit"));
  });
  // De turbo-schakelaar (voor V8 en Sportauto) laat de keuze open staan.
  el.turboKnop.addEventListener("click", function () {
    Geluid.ontgrendel(); Motor.verbind(Geluid.context());
    instelling.turbo = !instelling.turbo; bewaar();
    Motor.zetTurbo(instelling.turbo);
    el.turboKnop.setAttribute("aria-pressed", String(instelling.turbo));
    clearTimeout(motorKlok); motorKlok = setTimeout(function () { el.motorKeuze.hidden = true; }, 20000);
    log("turbo op V8 en Sportauto: " + (instelling.turbo ? "aan" : "uit"));
  });

  // ---------- GPS kwijt ----------
  // Alleen als de klok zelf gewoon doorliep: de Tesla bevriest de pagina soms tot 32 s
  // (gemeten), en daarna is er niets kwijt.
  var vorigeTik = Date.now();
  setInterval(function () {
    var nu = Date.now(), regelmatig = nu - vorigeTik < 2500;
    vorigeTik = nu;
    if (!staat.gestart) return;
    if (!el.rit.hidden && (!staat.pos || nu - staat.laatsteFix > 15000)) meldKaart(null);
    if (!staat.laatsteFix) return;
    if (nu - staat.laatsteFix > 4000) { zetTekst(el.gps, T.gpsZoekt); el.gps.className = "chip zoekt"; }
    staat.stilTikken = regelmatig && nu - staat.laatsteFix > 1500 ? staat.stilTikken + 1 : 0;
    if (staat.stilTikken >= 15 && !staat.gpsKwijt && (staat.kmh || 0) > 10) { staat.gpsKwijt = true; Geluid.zeg(["zacht", "gps_kwijt"]); }
  }, 1000);

  if (q.get("debug") === "1" && el.debug) el.debug.hidden = false;
  window.__rijhulp = { staat: staat, log: logRegels, gesproken: Geluid.gesproken, Kaart: Kaart, Flitsers: Flitsers, Geluid: Geluid, Gemeld: Gemeld, Motor: Motor, Matrix: Matrix, taal: taal, instelling: instelling, zetTeHard: function (b) { instelling.teHard = !!b; bewaar(); } };

  // Offline: de site zelf, de data en het geluid uit de cache.
  // Een nieuwe versie van de site: de nieuwe service worker neemt het over (skipWaiting en
  // claim). Is de rit nog niet gestart, dan meteen herladen, zodat je niet met de oude app rijdt.
  if ("serviceWorker" in navigator && !q.has("sim")) {
    var hadBaas = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", function () {
      if (hadBaas && !staat.gestart && !window.__herladen) { window.__herladen = true; location.reload(); }
    });
    navigator.serviceWorker.register("sw.js").then(function (r) { if (r.update) r.update().catch(function () {}); }).catch(function () {});
  }
})();
