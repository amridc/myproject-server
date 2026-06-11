const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Speicherorte
const DATEN_ORDNER = process.env.DATEN_ORDNER || path.join(__dirname, 'daten');
const FIRMEN_ROOT = path.join(DATEN_ORDNER, 'Firmen');     // daten/Firmen/<id>/Projekte/...
const USERS = path.join(DATEN_ORDNER, 'benutzer.json');
const FIRMEN = path.join(DATEN_ORDNER, 'firmen.json');

fs.ensureDirSync(FIRMEN_ROOT);

app.use(cors());
app.use(express.json());

// ── Hilfsfunktionen ──────────────────────────────────────────
function ladeBenutzer() { try { return fs.readJsonSync(USERS); } catch { return { benutzer: [] }; } }
function speichereBenutzer(b) { fs.writeJsonSync(USERS, b, { spaces: 2 }); }
function ladeFirmen() { try { return fs.readJsonSync(FIRMEN); } catch { return { firmen: [] }; } }
function speichereFirmen(f) { fs.writeJsonSync(FIRMEN, f, { spaces: 2 }); }
function hashPasswort(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function sicherName(n) { return path.basename((n || '').trim()); }
function heuteDatum() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function neueId() { return crypto.randomBytes(6).toString('hex'); }
function neuerCode() {
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne verwechselbare 0/O/1/I
  let c = '';
  for (let i = 0; i < 6; i++) c += alpha[crypto.randomInt(alpha.length)];
  return c;
}
function projekteRoot(firmaId) { return path.join(FIRMEN_ROOT, firmaId, 'Projekte'); }

async function alleFotos(fotosPfad) {
  const ergebnis = [];
  if (!await fs.pathExists(fotosPfad)) return ergebnis;
  async function gehe(dir, rel) {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const voll = path.join(dir, e.name);
      const rp = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await gehe(voll, rp);
      else if (/\.(jpe?g|png|heic|heif)$/i.test(e.name)) {
        const st = await fs.stat(voll);
        ergebnis.push({ pfad: rp, zeit: st.mtimeMs });
      }
    }
  }
  await gehe(fotosPfad, '');
  ergebnis.sort((a, b) => b.zeit - a.zeit);
  return ergebnis;
}

function benutzerFinden(name) {
  return ladeBenutzer().benutzer.find(x => x.name.toLowerCase() === (name || '').toLowerCase());
}
function firmaFinden(id) {
  return ladeFirmen().firmen.find(f => f.id === id);
}
function firmaPerCode(code) {
  return ladeFirmen().firmen.find(f => f.code.toLowerCase() === (code || '').trim().toLowerCase());
}

function benutzerAnlegen(name, passwort, firmaId) {
  const db = ladeBenutzer();
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPasswort(passwort, salt);
  db.benutzer.push({ name, salt, hash, firmaId });
  speichereBenutzer(db);
}

// ── Anmeldung / Sitzungen ────────────────────────────────────
const tokens = new Map(); // token -> { name, firmaId }
function neuerToken(name, firmaId) {
  const t = crypto.randomBytes(24).toString('hex');
  tokens.set(t, { name, firmaId });
  return t;
}
function auth(req, res, next) {
  const ausHeader = (req.headers.authorization || '').replace('Bearer ', '');
  const ausUrl = req.query.token || '';
  const t = ausHeader || ausUrl;
  const sitzung = t && tokens.get(t);
  if (!sitzung) return res.status(401).json({ fehler: 'Nicht angemeldet' });
  req.benutzer = sitzung.name;
  req.firmaId = sitzung.firmaId;
  next();
}

// ── Status ───────────────────────────────────────────────────
app.get('/', (req, res) => res.send('MyProject Server läuft ✓'));
app.get('/status', (req, res) => res.json({ ok: true, version: 'cloud-2.0-firmen' }));

// ── Registrierung: neue Firma anlegen ────────────────────────
app.post('/registrieren/firma', async (req, res) => {
  const firmaName = (req.body && req.body.firmaName || '').trim();
  const benutzer = (req.body && req.body.benutzer || '').trim();
  const passwort = (req.body && req.body.passwort || '');
  if (!firmaName || !benutzer || !passwort)
    return res.status(400).json({ fehler: 'Firma, Benutzername und Passwort sind nötig' });
  if (benutzerFinden(benutzer))
    return res.status(409).json({ fehler: 'Benutzername ist schon vergeben' });

  // Firma anlegen (mit eindeutigem Code zum Beitreten)
  const db = ladeFirmen();
  let code; do { code = neuerCode(); } while (db.firmen.some(f => f.code === code));
  const firma = { id: neueId(), name: firmaName, code };
  db.firmen.push(firma);
  speichereFirmen(db);
  await fs.ensureDir(projekteRoot(firma.id));

  benutzerAnlegen(benutzer, passwort, firma.id);
  const token = neuerToken(benutzer, firma.id);
  console.log(`Neue Firma "${firmaName}" (Code ${code}) von ${benutzer}`);
  res.json({ erfolg: true, token, name: benutzer, firmaName, code });
});

// ── Registrierung: einer Firma beitreten ─────────────────────
app.post('/registrieren/beitreten', async (req, res) => {
  const code = (req.body && req.body.code || '').trim();
  const benutzer = (req.body && req.body.benutzer || '').trim();
  const passwort = (req.body && req.body.passwort || '');
  if (!code || !benutzer || !passwort)
    return res.status(400).json({ fehler: 'Code, Benutzername und Passwort sind nötig' });
  const firma = firmaPerCode(code);
  if (!firma) return res.status(404).json({ fehler: 'Firmen-Code nicht gefunden' });
  if (benutzerFinden(benutzer))
    return res.status(409).json({ fehler: 'Benutzername ist schon vergeben' });

  benutzerAnlegen(benutzer, passwort, firma.id);
  const token = neuerToken(benutzer, firma.id);
  console.log(`${benutzer} ist Firma "${firma.name}" beigetreten`);
  res.json({ erfolg: true, token, name: benutzer, firmaName: firma.name });
});

// ── Login ────────────────────────────────────────────────────
app.post('/login', (req, res) => {
  const { benutzer, passwort } = req.body || {};
  const u = benutzerFinden(benutzer);
  if (!u || hashPasswort(passwort || '', u.salt) !== u.hash)
    return res.status(401).json({ fehler: 'Benutzername oder Passwort falsch' });
  const firma = firmaFinden(u.firmaId);
  const token = neuerToken(u.name, u.firmaId);
  res.json({ erfolg: true, token, name: u.name, firmaName: firma ? firma.name : '' });
});

// ── Eigene Firma (Name + Code zum Teilen) ────────────────────
app.get('/meinefirma', auth, (req, res) => {
  const firma = firmaFinden(req.firmaId);
  if (!firma) return res.status(404).json({ fehler: 'Firma nicht gefunden' });
  res.json({ name: firma.name, code: firma.code });
});

// ── Projekte (immer auf die eigene Firma begrenzt) ───────────
app.get('/projekte', auth, async (req, res) => {
  const root = projekteRoot(req.firmaId);
  await fs.ensureDir(root);
  const liste = await fs.readdir(root, { withFileTypes: true });
  const projekte = [];
  for (const e of liste) {
    if (!e.isDirectory()) continue;
    const f = await alleFotos(path.join(root, e.name, 'Fotos'));
    projekte.push({ name: e.name, anzahlFotos: f.length });
  }
  projekte.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ projekte });
});

app.post('/projekte', auth, async (req, res) => {
  const n = sicherName(req.body && req.body.name);
  if (!n) return res.status(400).json({ fehler: 'Name fehlt' });
  for (const s of ['Auftrag', 'Rechnungen', 'Fotos']) await fs.ensureDir(path.join(projekteRoot(req.firmaId), n, s));
  res.json({ erfolg: true, name: n });
});

app.get('/projekte/:p/fotos', auth, async (req, res) => {
  res.json({ fotos: await alleFotos(path.join(projekteRoot(req.firmaId), sicherName(req.params.p), 'Fotos')) });
});

app.get('/alles', auth, async (req, res) => {
  const root = projekteRoot(req.firmaId);
  await fs.ensureDir(root);
  const liste = await fs.readdir(root, { withFileTypes: true });
  const projekte = [];
  for (const e of liste) {
    if (!e.isDirectory()) continue;
    const fotos = await alleFotos(path.join(root, e.name, 'Fotos'));
    projekte.push({ name: e.name, fotos: fotos.map(f => f.pfad) });
  }
  res.json({ projekte });
});

app.get('/projekte/:p/foto', auth, async (req, res) => {
  const basis = path.resolve(path.join(projekteRoot(req.firmaId), sicherName(req.params.p), 'Fotos'));
  const ziel = path.resolve(basis, req.query.datei || '');
  if (ziel !== basis && !ziel.startsWith(basis + path.sep)) return res.status(400).end();
  if (!await fs.pathExists(ziel)) return res.status(404).end();
  res.sendFile(ziel);
});

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const z = path.join(projekteRoot(req.firmaId), sicherName(req.params.p), 'Fotos', heuteDatum());
    await fs.ensureDir(z); cb(null, z);
  },
  filename: (req, file, cb) =>
    cb(null, `foto_${Date.now()}_${Math.floor(Math.random()*1000)}${path.extname(file.originalname) || '.jpg'}`)
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

app.post('/upload/:p', auth, upload.array('fotos', 20), (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ fehler: 'Keine Fotos' });
  console.log(`[${heuteDatum()}] ${req.files.length} Foto(s) -> ${req.firmaId}/${sicherName(req.params.p)}`);
  res.json({ erfolg: true, anzahl: req.files.length });
});

// ── Migration + Standard-Firma fuer bestehende Daten ─────────
// Sorgt dafuer, dass alte Daten (vor den Firmen) erhalten bleiben.
function standardFirmaSichern() {
  const db = ladeFirmen();
  let standard = db.firmen.find(f => f.id === 'standard');
  if (!standard) {
    standard = { id: 'standard', name: 'Standard', code: 'STDFRM' };
    db.firmen.push(standard);
    speichereFirmen(db);
  }
  // Benutzer ohne Firma der Standard-Firma zuordnen
  const ub = ladeBenutzer();
  let geaendert = false;
  for (const u of ub.benutzer) { if (!u.firmaId) { u.firmaId = 'standard'; geaendert = true; } }
  if (geaendert) speichereBenutzer(ub);
  // Alte Projekte (daten/Projekte) in die Standard-Firma verschieben
  const alteProjekte = path.join(DATEN_ORDNER, 'Projekte');
  const zielProjekte = projekteRoot('standard');
  try {
    if (fs.pathExistsSync(alteProjekte) && !fs.pathExistsSync(zielProjekte)) {
      fs.moveSync(alteProjekte, zielProjekte);
      console.log('Alte Projekte in die Standard-Firma uebernommen.');
    }
  } catch (e) { console.log('Hinweis Migration:', e.message); }
  fs.ensureDirSync(zielProjekte);
}

// adduser-Befehl (legt in der Standard-Firma an)
if (process.argv[2] === 'adduser') {
  const name = process.argv[3], pass = process.argv[4];
  if (!name || !pass) { console.log('Aufruf: node server.js adduser NAME PASSWORT'); process.exit(1); }
  standardFirmaSichern();
  if (benutzerFinden(name)) {
    const db = ladeBenutzer();
    const u = db.benutzer.find(x => x.name.toLowerCase() === name.toLowerCase());
    const salt = crypto.randomBytes(16).toString('hex');
    u.salt = salt; u.hash = hashPasswort(pass, salt);
    speichereBenutzer(db);
  } else benutzerAnlegen(name, pass, 'standard');
  console.log(`Benutzer "${name}" in Standard-Firma gespeichert.`);
  process.exit(0);
}

// Admin aus Umgebungsvariablen (bestehendes Verhalten, in Standard-Firma)
function adminAusUmgebung() {
  const name = process.env.ADMIN_USER, pass = process.env.ADMIN_PASS;
  if (!name || !pass) return;
  const db = ladeBenutzer();
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPasswort(pass, salt);
  const vorhanden = db.benutzer.find(u => u.name.toLowerCase() === name.toLowerCase());
  if (vorhanden) { vorhanden.salt = salt; vorhanden.hash = hash; if (!vorhanden.firmaId) vorhanden.firmaId = 'standard'; }
  else db.benutzer.push({ name, salt, hash, firmaId: 'standard' });
  speichereBenutzer(db);
  console.log(`Benutzer "${name}" aus Umgebungsvariablen bereit (Standard-Firma).`);
}

standardFirmaSichern();
adminAusUmgebung();

app.listen(PORT, () => {
  console.log(`MyProject Server laeuft auf Port ${PORT}`);
  console.log(`Datenordner: ${DATEN_ORDNER}`);
});
