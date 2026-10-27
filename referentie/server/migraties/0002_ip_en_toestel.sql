-- Verharding 26 okt 2026: limieten op de IP-hash en het /24- of /48-net, los van
-- het toestel-id en de browser; stemmen onthouden van welke IP-hash ze kwamen, zodat alleen nee
-- van verschillende IP's een melding weghaalt; en de sleutel waarmee de server toestel-ids
-- ondertekent. Ook hier alleen hashes met het dagzout, geen IP-adres.
ALTER TABLE acties ADD COLUMN ip TEXT;
ALTER TABLE acties ADD COLUMN net TEXT;
CREATE INDEX IF NOT EXISTS acties_ip ON acties (soort, ip, t);
CREATE INDEX IF NOT EXISTS acties_net ON acties (soort, net, t);
ALTER TABLE stemmen ADD COLUMN ip TEXT;
ALTER TABLE stemmen ADD COLUMN vers INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS sleutel (
  naam TEXT PRIMARY KEY,
  waarde TEXT NOT NULL
);
