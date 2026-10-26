CREATE TABLE IF NOT EXISTS meldingen (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  koers INTEGER,
  gemaakt INTEGER NOT NULL,
  verloopt INTEGER NOT NULL,
  ja INTEGER NOT NULL DEFAULT 0,
  nee INTEGER NOT NULL DEFAULT 0,
  laatste_ja INTEGER,
  melder TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS meldingen_plek ON meldingen (lat, lon);
CREATE INDEX IF NOT EXISTS meldingen_verloopt ON meldingen (verloopt);
CREATE TABLE IF NOT EXISTS stemmen (
  melding INTEGER NOT NULL,
  toestel TEXT NOT NULL,
  ja INTEGER NOT NULL,
  t INTEGER NOT NULL,
  PRIMARY KEY (melding, toestel)
);
CREATE TABLE IF NOT EXISTS acties (
  soort TEXT NOT NULL,
  toestel TEXT NOT NULL,
  vinger TEXT NOT NULL,
  t INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS acties_toestel ON acties (soort, toestel, t);
CREATE INDEX IF NOT EXISTS acties_vinger ON acties (soort, vinger, t);
CREATE TABLE IF NOT EXISTS zout (
  dag TEXT PRIMARY KEY,
  waarde TEXT NOT NULL
);
