// Bundelt de clips per taal tot één Ogg Opus-bestand (afconvert van macOS) met een
// tabel van begin en duur per clip, en zet dat als base64 in site/geluid/<taal>.json.
// Waarom zo: de site neemt geen .ogg aan, mp3 is vijf keer groter, en één bestand
// laadt in de auto in één keer en blijft offline in de cache.
// Stilte voor en na elke clip wordt weggeknipt, zodat clips direct achter elkaar kunnen.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ZINNEN, GETALLEN } from "./zinnen.mjs";
import { cafNaarOgg } from "./caf-naar-ogg.mjs";

const SR = 24000;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hm-geluid-"));
const leesWav = (pad) => {
  const b = fs.readFileSync(pad);
  let i = 12;
  while (i < b.length) {
    const id = b.toString("ascii", i, i + 4), n = b.readUInt32LE(i + 4);
    if (id === "data") return new Int16Array(b.buffer.slice(b.byteOffset + i + 8, b.byteOffset + i + 8 + n));
    i += 8 + n + (n % 2);
  }
  throw new Error("geen data in " + pad);
};
const schrijfWav = (pad, pcm) => {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length * 2, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24); h.writeUInt32LE(SR * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length * 2, 40);
  fs.writeFileSync(pad, Buffer.concat([h, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2)]));
};
function knip(pcm) {
  const venster = SR / 100; // 10 ms
  const luid = (s) => { let t = 0; for (let j = s; j < Math.min(pcm.length, s + venster); j++) t += pcm[j] * pcm[j]; return Math.sqrt(t / venster) > 330; }; // ca. -40 dBFS
  let a = 0, b = pcm.length - venster;
  while (a < pcm.length && !luid(a)) a += venster;
  while (b > a && !luid(b)) b -= venster;
  a = Math.max(0, a - 0.04 * SR); b = Math.min(pcm.length, b + venster + 0.08 * SR);
  return pcm.subarray(a, b);
}

fs.mkdirSync(new URL("../site/geluid/", import.meta.url), { recursive: true });
for (const taal of Object.keys(ZINNEN)) {
  const namen = [...Object.keys(ZINNEN[taal]), ...GETALLEN.map((n) => "n" + n)];
  const stukken = [], clips = {};
  const stil = new Int16Array(Math.round(0.12 * SR));
  let pos = 0;
  for (const naam of namen) {
    const wav = path.join(tmp, `${taal}-${naam}.wav`);
    execFileSync("afconvert", ["-f", "WAVE", "-d", `LEI16@${SR}`, "-c", "1", fileURLToPath(new URL(`../data-bron/stem/${taal}/${naam}.mp3`, import.meta.url)), wav]);
    const pcm = knip(leesWav(wav));
    if (pcm.length < 0.2 * SR) console.warn(`LET OP: ${taal} ${naam} is na het knippen maar ${(pcm.length / SR).toFixed(2)} s`);
    clips[naam] = [Math.round((pos / SR) * 1000) / 1000, Math.round((pcm.length / SR) * 1000) / 1000];
    stukken.push(pcm, stil);
    pos += pcm.length + stil.length;
  }
  const alles = new Int16Array(pos);
  let o = 0; for (const s of stukken) { alles.set(s, o); o += s.length; }
  const wavAlles = path.join(tmp, `${taal}.wav`), caf = path.join(tmp, `${taal}.caf`);
  schrijfWav(wavAlles, alles);
  execFileSync("afconvert", ["-f", "caff", "-d", "opus", "-b", "24000", wavAlles, caf]);
  const bytes = cafNaarOgg(fs.readFileSync(caf), SR);
  const uit = { v: 1, taal, duur: Math.round((pos / SR) * 10) / 10, clips, ogg: bytes.toString("base64") };
  const doel = new URL(`../site/geluid/${taal}.json`, import.meta.url);
  fs.writeFileSync(doel, JSON.stringify(uit));
  // Ook als opus en wav naar data-bron, om lokaal na te luisteren.
  fs.writeFileSync(fileURLToPath(new URL(`../data-bron/${taal}.opus`, import.meta.url)), bytes);
  fs.writeFileSync(fileURLToPath(new URL(`../data-bron/${taal}.wav`, import.meta.url)), fs.readFileSync(wavAlles));
  console.log(taal, `${namen.length} clips, ${uit.duur} s, opus ${bytes.length} bytes, json ${fs.statSync(doel).size} bytes`);
}
function fileURLToPath(u) { return decodeURIComponent(u.pathname); }
