// De gesproken zinnen van de rijhulp. Kort en rustig: eerst wat, dan hoe ver.
// De stem kies je zelf: elke TTS die mp3 per zin kan maken werkt (zie RECEPT.md, stap 5).
// Leg de mp3's in data-bron/stem/<taal>/<naam>.mp3 en draai daarna bouw-geluid.mjs.
export const GETALLEN = Array.from({ length: 111 }, (_, i) => 30 + i); // 30 t/m 140
export const ZINNEN = {
  nl: {
    start: "Rijhulp staat aan.",
    proef: "Dit is een proefmelding. Het geluid werkt.",
    flitser_500: "Flitser over vijfhonderd meter.",
    flitser_300: "Flitser over driehonderd meter.",
    flitser_150: "Flitser over 150 meter.",
    rood_300: "Roodlichtcamera over driehonderd meter.",
    rood_150: "Roodlichtcamera over 150 meter.",
    traject_1000: "Trajectcontrole over een kilometer.",
    traject_500: "Trajectcontrole over vijfhonderd meter.",
    traject_start: "Trajectcontrole begint.",
    traject_eind: "Einde van de trajectcontrole.",
    gemiddeld: "Gemiddeld",
    te_hoog: "Je gemiddelde is te hoog.",
    limiet: "De limiet is",
    te_hard: "Je rijdt te hard.",
    land_uit: "Flitsermeldingen staan uit in dit land.",
    land_aan: "Flitsermeldingen staan aan.",
    gps_kwijt: "Geen GPS-signaal.",
    gps_terug: "GPS-signaal is terug.",
    gemeld_500: "Gemelde flitser over vijfhonderd meter.",
    gemeld_300: "Gemelde flitser over driehonderd meter.",
    gemeld_150: "Gemelde flitser over 150 meter.",
    dank_gemeld: "Flitser gemeld. Dank je.",
    matrix_limiet: "Matrix-bord. De limiet is",
  },
  en: {
    start: "Driving assistant is on.",
    proef: "This is a test alert. Sound works.",
    flitser_500: "Speed camera in five hundred meters.",
    flitser_300: "Speed camera in three hundred meters.",
    flitser_150: "Speed camera in one hundred fifty meters.",
    rood_300: "Red light camera in three hundred meters.",
    rood_150: "Red light camera in one hundred fifty meters.",
    traject_1000: "Average speed check in one kilometer.",
    traject_500: "Average speed check in five hundred meters.",
    traject_start: "Average speed check starts.",
    traject_eind: "End of average speed check.",
    gemiddeld: "Average",
    te_hoog: "Your average is too high.",
    limiet: "The limit is",
    te_hard: "You are over the limit.",
    land_uit: "Speed camera alerts are off in this country.",
    land_aan: "Speed camera alerts are on.",
    gps_kwijt: "No GPS signal.",
    gps_terug: "GPS signal is back.",
    gemeld_500: "Reported speed camera in five hundred meters.",
    gemeld_300: "Reported speed camera in three hundred meters.",
    gemeld_150: "Reported speed camera in one hundred fifty meters.",
    dank_gemeld: "Speed camera reported. Thank you.",
    matrix_limiet: "Overhead sign. The limit is",
  },
};

// Getallen als woorden voor het Nederlands: als cijfers gaf een TTS soms een lege clip.
const EEN = ["", "een", "twee", "drie", "vier", "vijf", "zes", "zeven", "acht", "negen", "tien", "elf", "twaalf", "dertien", "veertien", "vijftien", "zestien", "zeventien", "achttien", "negentien"];
const TIEN = ["", "", "twintig", "dertig", "veertig", "vijftig", "zestig", "zeventig", "tachtig", "negentig"];
function onder100(n) {
  if (n < 20) return EEN[n];
  const t = Math.floor(n / 10), e = n % 10;
  if (!e) return TIEN[t];
  return EEN[e] + (/e$/.test(EEN[e]) ? "\u00ebn" : "en") + TIEN[t];
}
// Waar de TTS bij de gewone spelling een lege clip gaf, een spelling die wel werkt.
const UITZONDERING = { 36: "zes en dertig" };
export function getalTekst(n, taal) {
  if (taal !== "nl") return String(n);
  if (UITZONDERING[n]) return UITZONDERING[n];
  return n >= 100 ? "honderd" + onder100(n - 100) : onder100(n);
}
