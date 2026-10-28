// De wachtrij van het geluid (site/js/geluid.js) tegen een nep-AudioContext met een eigen klok.
// Speelt na wat de Tesla-browser kan doen: een geluidsklok die stilstaat (hapering), een
// AudioContext die niet loopt, een clip die ontbreekt of niet start. Eis: de wachtrij raakt
// nooit vast, niets van een afgebroken zin klinkt later alsnog, en meldingen praten nooit
// door elkaar heen.
// node test/geluid.mjs
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert/strict";

const bron = fs.readFileSync(new URL("../site/js/geluid.js", import.meta.url), "utf8");
const CLIPS = { traject_start: [18.49, 1.586], limiet: [24.224, 0.988], n100: [119.342, 0.616], traject_1000: [13.988, 1.936], gemiddeld: [21.88, 0.718], n98: [117.0, 0.7], te_hoog: [22.718, 1.386], proef: [1, 1] };

function omgeving({ voorloop = 0, startGooit = null } = {}) {
  let wand = 0; // ms
  let timers = [], volg = 0;
  const bronnen = [];
  const ctx = {
    state: "running", currentTime: 0, vast: false, weigerResume: false, destination: {},
    resume() { if (!this.weigerResume) this.state = "running"; return Promise.resolve(); },
    createBuffer() { return {}; },
    createGain() { return { gain: { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; },
    createOscillator() { return maakBron("toon"); },
    createBufferSource() { return maakBron("clip"); },
    decodeAudioData(ab, ok) { ok({ duration: 200 }); },
  };
  function maakBron(soort) {
    const b = { soort, frequency: { value: 0 }, connect() {}, disconnect() {}, start(t, o, d) {
      if (soort === "clip" && startGooit && startGooit(o)) throw new Error("nep: start faalt");
      b.t = t; b.o = o; b.d = soort === "clip" ? d : null; b.gestart = true; bronnen.push(b);
    }, stop(t) { if (soort === "toon" && b.stopT == null && t > 0) { b.eindT = t; return; } b.gestoptOp = ctx.currentTime; } };
    return b;
  }
  const window = {
    AudioContext: function () { return ctx; },
    performance: { now: () => wand },
    setTimeout: (f, ms) => { const id = ++volg; timers.push({ id, t: wand + Math.max(0, ms || 0), f }); return id; },
    clearTimeout: (id) => { timers = timers.filter((x) => x.id !== id); },
    setInterval: (f, ms) => { const id = ++volg; const x = { id, t: wand + ms, f, elk: ms }; timers.push(x); return id; },
    clearInterval: (id) => { timers = timers.filter((x) => x.id !== id); },
    fetch: async () => ({ ok: true, json: async () => ({ clips: CLIPS, ogg: "" }) }),
    atob: (s) => Buffer.from(s, "base64").toString("binary"),
    Date, Math, JSON, Promise, Uint8Array, Object, Array,
  };
  window.window = window;
  window.performance = window.performance;
  const c = vm.createContext(window);
  vm.runInContext(bron, c);
  const G = window.Geluid;
  const log = [];
  G.opLog((t) => log.push(t));
  G.opSpreek(() => {}, () => voorloop);
  // De tijd laten lopen in stappen van 10 ms; de geluidsklok loopt mee zolang hij niet stilstaat.
  async function loop(ms) {
    for (let i = 0; i < ms / 10; i++) {
      wand += 10;
      if (ctx.state === "running" && !ctx.vast) ctx.currentTime += 0.01;
      for (;;) {
        timers.sort((a, b) => a.t - b.t || a.id - b.id);
        const x = timers[0];
        if (!x || x.t > wand) break;
        if (x.elk) x.t += x.elk; else timers.shift();
        x.f();
      }
      await Promise.resolve();
    }
  }
  /** Wat er echt klinkt: per clip het stuk [begin, eind) op de geluidsklok. */
  function hoorbaar() {
    return bronnen.filter((b) => b.soort === "clip").map((b) => {
      const eind = b.gestoptOp != null ? Math.min(b.t + b.d, b.gestoptOp) : b.t + b.d;
      return { naam: Object.keys(CLIPS).find((k) => CLIPS[k][0] === b.o), begin: b.t, eind };
    }).filter((x) => x.eind > x.begin);
  }
  return { G, ctx, log, loop, hoorbaar, bronnen };
}
async function klaar() {
  const o = omgeving(...arguments);
  o.G.ontgrendel();
  await o.G.laad("nl");
  return o;
}
function geenOverlap(lijst) {
  const s = [...lijst].sort((a, b) => a.begin - b.begin);
  for (let i = 1; i < s.length; i++) assert.ok(s[i].begin >= s[i - 1].eind - 1e-9, `overlap: ${s[i - 1].naam} en ${s[i].naam}`);
}
let n = 0;
async function proef(naam, f) { await f(); n++; console.log("ok", naam); }

for (const voorloop of [0, 0.18]) {
  const m = voorloop ? "met motor" : "zonder motor";

  await proef(`gewone zin, in volgorde en zonder gaten ${m}`, async () => {
    const { G, loop, hoorbaar } = await klaar({ voorloop });
    G.zeg(["gong", "traject_start", "limiet", "n100"], true);
    await loop(5000);
    const h = hoorbaar();
    assert.deepEqual(h.map((x) => x.naam), ["traject_start", "limiet", "n100"]);
    geenOverlap(h);
    assert.equal(G.rij().speelt, false);
    assert.equal(G.rij().teller.gespeeld, 1);
  });

  await proef(`klok staat stil midden in de zin: rest vervalt, rij weer vrij ${m}`, async () => {
    const { G, ctx, loop, hoorbaar, log } = await klaar({ voorloop });
    G.zeg(["gong", "traject_start", "limiet", "n100"], true);
    await loop(900); // midden in "traject_start"
    ctx.vast = true; // de hapering
    G.zeg(["zacht", "gemiddeld", "n98"], false);
    await loop(3000);
    assert.ok(log.some((t) => t.includes("vastgelopen")), log.join("\n"));
    ctx.vast = false; // de klok loopt weer
    await loop(6000);
    const h = hoorbaar();
    // Van de eerste zin hooguit het begin; "limiet" en "n100" klinken nooit meer laat.
    assert.ok(!h.some((x) => x.naam === "limiet" || x.naam === "n100"), JSON.stringify(h));
    geenOverlap(h);
    assert.equal(G.rij().speelt, false);
  });

  await proef(`AudioContext loopt niet: eerst hervatten, dan pas spelen ${m}`, async () => {
    const { G, ctx, loop, hoorbaar } = await klaar({ voorloop });
    ctx.state = "suspended"; ctx.weigerResume = true;
    G.zeg(["gong", "traject_1000"], true);
    await loop(1500);
    assert.deepEqual(hoorbaar(), []); // niets op een stilstaande klok gezet
    ctx.weigerResume = false;
    await loop(3000);
    assert.deepEqual(hoorbaar().map((x) => x.naam), ["traject_1000"]);
  });

  await proef(`AudioContext blijft stilstaan: melding vervalt na 6 s, rij niet vast ${m}`, async () => {
    const { G, ctx, loop, hoorbaar } = await klaar({ voorloop });
    ctx.state = "suspended"; ctx.weigerResume = true;
    G.zeg(["gong", "traject_1000"], true);
    await loop(7000);
    assert.equal(G.rij().wacht, 0);
    assert.equal(G.rij().teller.teOud, 1);
    ctx.weigerResume = false; ctx.state = "running";
    G.zeg(["zacht", "gemiddeld", "n98"], false);
    await loop(3000);
    assert.deepEqual(hoorbaar().map((x) => x.naam), ["gemiddeld", "n98"]);
  });

  await proef(`ontbrekende clip wordt overgeslagen, de rest klinkt ${m}`, async () => {
    const { G, loop, hoorbaar } = await klaar({ voorloop });
    G.zeg(["gong", "traject_start", "limiet", "n139"], true); // n139 zit niet in deze nep-set
    G.zeg(["zacht", "gemiddeld", "n98"], false);
    await loop(6000);
    assert.deepEqual(hoorbaar().map((x) => x.naam), ["traject_start", "limiet", "gemiddeld", "n98"]);
    geenOverlap(hoorbaar());
  });

  await proef(`clip die niet start wordt overgeslagen, rij loopt door ${m}`, async () => {
    const { G, loop, hoorbaar } = await klaar({ voorloop, startGooit: (o) => o === CLIPS.limiet[0] });
    G.zeg(["gong", "traject_start", "limiet", "n100"], true);
    G.zeg(["let", "te_hoog"], false);
    await loop(7000);
    assert.deepEqual(hoorbaar().map((x) => x.naam), ["traject_start", "n100", "te_hoog"]);
    geenOverlap(hoorbaar());
    assert.equal(G.rij().speelt, false);
  });

  await proef(`dezelfde zin twee keer achter elkaar klinkt één keer ${m}`, async () => {
    const { G, loop, hoorbaar } = await klaar({ voorloop });
    G.zeg(["gong", "traject_1000"], true);
    G.zeg(["gong", "traject_1000"], true);
    await loop(100);
    G.zeg(["gong", "traject_1000"], true);
    await loop(5000);
    assert.deepEqual(hoorbaar().map((x) => x.naam), ["traject_1000"]);
  });

  await proef(`klok blijft voorgoed stil: elke melding vervalt, nooit vast ${m}`, async () => {
    const { G, ctx, loop } = await klaar({ voorloop });
    ctx.vast = true;
    for (let i = 0; i < 5; i++) { G.zeg(["gong", "traject_start", "limiet", "n100"].slice(0, 2 + (i % 3)), false); await loop(2000); }
    await loop(10000);
    assert.equal(G.rij().speelt, false);
    assert.equal(G.rij().wacht, 0);
  });
}

await proef("geluid uit stopt wat klinkt", async () => {
  const { G, loop, hoorbaar } = await klaar();
  G.zeg(["gong", "traject_start", "limiet", "n100"], true);
  await loop(600);
  G.zetStil(true);
  await loop(4000);
  assert.ok(!hoorbaar().some((x) => x.naam === "n100"));
  assert.equal(G.rij().speelt, false);
});
console.log(n, "proeven geslaagd");
