// Zet de Opus-pakketten uit een CAF-bestand van afconvert om naar een Ogg Opus-bestand
// (RFC 7845). afconvert kan zelf geen Ogg Opus schrijven op deze Mac ('pck?'), wel CAF.
import fs from "node:fs";

const CRC = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; CRC[i] = r >>> 0; }
const crc32 = (b) => { let c = 0; for (const x of b) c = ((c << 8) ^ CRC[((c >>> 24) ^ x) & 0xff]) >>> 0; return c; };

export function leesCaf(buf) {
  if (buf.toString("ascii", 0, 4) !== "caff") throw new Error("geen CAF");
  let i = 8, desc, pakt, data;
  while (i < buf.length) {
    const type = buf.toString("ascii", i, i + 4);
    const size = Number(buf.readBigInt64BE(i + 4));
    const body = buf.subarray(i + 12, size < 0 ? buf.length : i + 12 + size);
    if (type === "desc") desc = { sampleRate: body.readDoubleBE(0), formatId: body.toString("ascii", 8, 12), framesPerPacket: body.readUInt32BE(20), channels: body.readUInt32BE(24) };
    if (type === "pakt") {
      const n = Number(body.readBigInt64BE(0)), valid = Number(body.readBigInt64BE(8)), priming = body.readInt32BE(16), remainder = body.readInt32BE(20);
      const maten = []; let p = 24;
      for (let k = 0; k < n; k++) { let v = 0, b; do { b = body[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); maten.push(v); }
      pakt = { n, valid, priming, remainder, maten };
    }
    if (type === "data") data = body.subarray(4);
    if (size < 0) break;
    i += 12 + size;
  }
  if (!desc || desc.formatId !== "opus" || !pakt || !data) throw new Error("CAF zonder opus/pakt/data");
  const pakketten = []; let o = 0;
  for (const m of pakt.maten) { pakketten.push(data.subarray(o, o + m)); o += m; }
  return { desc, pakt, pakketten };
}

function pagina(serial, seq, granule, vlag, pakketten) {
  const seg = [];
  for (const p of pakketten) { let n = p.length; while (n >= 255) { seg.push(255); n -= 255; } seg.push(n); }
  const kop = Buffer.alloc(27 + seg.length);
  kop.write("OggS", 0); kop[4] = 0; kop[5] = vlag;
  kop.writeBigInt64LE(BigInt(granule), 6); kop.writeUInt32LE(serial, 14); kop.writeUInt32LE(seq, 18); kop.writeUInt32LE(0, 22);
  kop[26] = seg.length; Buffer.from(seg).copy(kop, 27);
  const pg = Buffer.concat([kop, ...pakketten]);
  pg.writeUInt32LE(crc32(pg), 22);
  return pg;
}

export function cafNaarOgg(buf, invoerRate = 24000) {
  const { desc, pakt, pakketten } = leesCaf(buf);
  const serial = 0x48594d4f; // "HYMO"
  // Ogg Opus telt altijd in 48 kHz; CAF telt in de eigen samplerate.
  const schaal = 48000 / desc.sampleRate;
  const priming = Math.round(pakt.priming * schaal);
  const head = Buffer.alloc(19);
  head.write("OpusHead", 0); head[8] = 1; head[9] = desc.channels; head.writeUInt16LE(priming, 10);
  head.writeUInt32LE(invoerRate, 12); head.writeInt16LE(0, 16); head[18] = 0;
  const vendor = Buffer.from("rijhulp-open");
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write("OpusTags", 0); tags.writeUInt32LE(vendor.length, 8); vendor.copy(tags, 12); tags.writeUInt32LE(0, 12 + vendor.length);
  const uit = [pagina(serial, 0, 0, 0x02, [head]), pagina(serial, 1, 0, 0, [tags])];
  const fpp = desc.framesPerPacket * schaal;
  const einde = priming + Math.round(pakt.valid * schaal);
  let seq = 2, granule = 0, bundel = [], segs = 0;
  for (let k = 0; k < pakketten.length; k++) {
    const p = pakketten[k];
    const nodig = Math.floor(p.length / 255) + 1;
    if (segs + nodig > 255 || bundel.length >= 50) { uit.push(pagina(serial, seq++, granule, 0, bundel)); bundel = []; segs = 0; }
    bundel.push(p); segs += nodig; granule += fpp;
  }
  uit.push(pagina(serial, seq++, Math.min(granule, einde), 0x04, bundel));
  return Buffer.concat(uit);
}
