// De lezer van de feed met matrixborden (NDW): codes per beeld en alleen de niet-lege borden.
// node referentie/test/msi.mjs
import assert from "node:assert/strict";
import { leesMsi, beeldCode } from "../server/server.mjs";
const ev = (uuid, display) => `<event><ts_event>2026-10-25T12:00:00Z</ts_event><sign_id><uuid>${uuid}</uuid></sign_id>${display}</event>`;
const xml = "<x>" + [
  ev("20832498-0000-4000-8000-000000000001", '<display><speedlimit flashing="false" red_ring="true">80</speedlimit></display>'),
  ev("69111960-0000-4000-8000-000000000002", '<display><speedlimit flashing="true" red_ring="false">70</speedlimit></display>'),
  ev("0f5077cc-0000-4000-8000-000000000003", '<display><lane_closed flashing="false"/></display>'),
  ev("9770e37f-0000-4000-8000-000000000004", '<display><lane_closed_ahead flashing="true"><merge_right/></lane_closed_ahead></display>'),
  ev("aaaaaaaa-0000-4000-8000-000000000005", '<display><blank flashing="false"/></display>'),
  ev("bbbbbbbb-0000-4000-8000-000000000006", '<lanelocation><road>A12</road><carriageway>L</carriageway><lane>1</lane><km>3.4</km></lanelocation>'),
].join("") + "</x>";
const { borden, beelden } = leesMsi(xml);
assert.equal(beelden, 5);
assert.deepEqual(borden, { "20832498": "80", "69111960": "a70f", "0f5077cc": "x", "9770e37f": ">" });
assert.equal(beeldCode('<restriction_end flashing="false"/>'), "e");
assert.equal(beeldCode('<lane_open flashing="false"/>'), "o");
assert.equal(beeldCode('<blank flashing="false"/>'), null);
console.log("alles goed");
