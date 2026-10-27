// De feed volgens PROTOCOL.md: vorm, afronding, geen melder-hash, en de handtekening.
// node test/feed.mjs
import fs from "node:fs";
import assert from "node:assert/strict";
import { maakServer, vakVan } from "../server/server.mjs";
import { klopt, keur, naarB64url } from "../../protocol/feed.mjs";
import { sqliteDb, migreer } from "../server/adapters/sqlite.mjs";

const DB = sqliteDb(":memory:");
migreer(DB);
const grenzen = JSON.parse(fs.readFileSync(new URL("./grenzen-proef.json", import.meta.url))).landen;
let klok = Date.parse("2026-10-27T09:00:00Z");
const server = maakServer({ grenzen, nu: () => klok, zonderCache: true });

// Een sleutelpaar alleen voor deze test, in het geheugen.
const paar = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const geheim = naarB64url(await crypto.subtle.exportKey("pkcs8", paar.privateKey));
const publiek = naarB64url(await crypto.subtle.exportKey("raw", paar.publicKey));
const env = { DB, APP_ID: "proef-app", FEED_SLEUTEL: geheim };

const plek = { lat: 52.026234, lon: 4.534911, koers: 10 };
// Het toestel-id geeft de server uit (POST /api/toestel); schrijven alleen als JSON.
const json = { "x-real-ip": "1.2.3.4", "user-agent": "proef", "content-type": "application/json" };
const toestel = (await (await server.fetch(new Request("https://rijhulp.example/api/toestel", { method: "POST", body: "{}", headers: json }), env, null)).json()).toestel;
let r = await server.fetch(new Request("https://rijhulp.example/api/meldingen", { method: "POST", body: JSON.stringify({ toestel, ...plek }), headers: json }), env, null);
assert.equal(r.status, 201);

const vak = vakVan(plek.lat, plek.lon);
r = await server.fetch(new Request("https://rijhulp.example/feed?vak=" + vak), env, null);
assert.equal(r.status, 200);
const bytes = new Uint8Array(await r.arrayBuffer());
const kop = r.headers.get("Rijhulp-Handtekening");
assert.ok(await klopt(bytes, kop, publiek), "handtekening klopt");
const kapot = bytes.slice(); kapot[10] ^= 1;
assert.ok(!(await klopt(kapot, kop, publiek)), "gewijzigde feed wordt geweigerd");
console.log("ok  handtekening klopt, een gewijzigde feed niet");

const j = JSON.parse(new TextDecoder().decode(bytes));
assert.equal(j.protocol, "0.1"); assert.equal(j.app, "proef-app"); assert.equal(j.vak, vak);
assert.equal(j.meldingen.length, 1);
const m = j.meldingen[0];
assert.equal(m.lat, 52.0262); assert.equal(m.lon, 4.5349); assert.equal(m.soort, "mobiele_flitser");
assert.ok(!("melder" in m), "geen melder-hash in de feed");
assert.ok(!new TextDecoder().decode(bytes).includes("1.2.3.4"), "geen IP in de feed");
console.log("ok  vorm, afronding op 4 decimalen, geen melder of IP");

const k = keur(j, { app: "proef-app", vak, nu: klok, landAan: () => true });
assert.ok(k.ok); assert.equal(k.meldingen.length, 1); assert.equal(k.meldingen[0].sleutel, "proef-app:" + m.id);
assert.equal(keur(j, { app: "proef-app", vak, nu: klok, landAan: () => false }).meldingen.length, 0);
assert.equal(keur(j, { app: "andere-app", vak, nu: klok }).ok, false);
assert.equal(keur(j, { app: "proef-app", vak, nu: klok + 10 * 60e3 }).ok, false);
console.log("ok  keuren: landregels, verkeerde app en een oude feed");
console.log("alles goed");
