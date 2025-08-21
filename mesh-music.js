/**
 * Multi-Pi Music Mesh – Single Script with Categories
 */

const express = require("express");
const fetch = require("node-fetch");
const bonjour = require("bonjour")();
const { exec, spawn, execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const multer = require("multer");
const FormData = require("form-data");
const cors = require("cors");

const app = express();
app.use(express.json());
app.use(cors());

const HOSTNAME = os.hostname();
const PORT = 3000;
const MUSIC_DIR = "/home/skroman/music/";
if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });

// ---- Categories ----
const CATEGORIES = ["lullabies", "white-noise", "mantras", "sleeping-songs", "favorites"];
for (const cat of CATEGORIES) {
  const dir = path.join(MUSIC_DIR, cat);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/* ---------- Helpers ---------- */
const listAllSongs = () =>
  CATEGORIES.map(cat => {
    const dir = path.join(MUSIC_DIR, cat);
    const songs = fs.readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith(".mp3"))
      .sort((a, b) => a.localeCompare(b));
    return { category: cat, songs };
  });

// Flatten all songs
const listMp3 = () => {
  return CATEGORIES.flatMap(cat => {
    const dir = path.join(MUSIC_DIR, cat);
    return fs.readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith(".mp3"))
      .map(f => path.join(cat, f)); // include category
  });
};

function sanitizeFilename(name) {
  return path.basename(name).replace(/[^\w\s.\-()[\]]/g, "_");
}

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stdout?.trim() ?? "");
    });
  });
}

/* ---------- Advertise self via mDNS ---------- */
const ad = bonjour.publish({ name: HOSTNAME + '-' + Date.now(), type: "http", port: PORT, txt: { mesh: "music" } });

/* ---------- Discover peers ---------- */
const peers = new Map();

const browser = bonjour.find({ type: "http" });
browser.on("up", (service) => {
  try {
    const isMesh = (service.txt && service.txt.mesh === "music");
    if (service.port === PORT && isMesh) {
      const name = service.name || service.host || `peer-${Date.now()}`;
      if (name !== HOSTNAME) {
        const host = (service.referer && service.referer.address) ? service.referer.address : (service.host || service.name);
        const addr = `${host}:${service.port}`;
        peers.set(name, addr);
        console.log("⬆️ Discovered peer:", name, addr);
      }
    }
  } catch { }
});
browser.on("down", (service) => {
  const name = service.name || service.host;
  if (peers.has(name)) {
    peers.delete(name);
    console.log("⬇️ Peer left:", name);
  }
});

/* ---------- Multer for uploads ---------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    let category = String(req.query.category || "favorites");
    if (!CATEGORIES.includes(category)) category = "favorites";
    cb(null, path.join(MUSIC_DIR, category));
  },
  filename: (req, file, cb) => {
    let category = String(req.query.category || "favorites");
    if (!CATEGORIES.includes(category)) category = "favorites";
    const dir = path.join(MUSIC_DIR, category);

    const baseName = sanitizeFilename(file.originalname);
    let name = baseName;
    let ext = path.extname(baseName);
    let base = path.basename(baseName, ext);

    let counter = 1;
    while (fs.existsSync(path.join(dir, name))) {
      name = `${base} (${counter})${ext}`;
      counter++;
    }
    cb(null, name);
  }
});
const upload = multer({ storage });

/* ---------- Routes ---------- */

// Health
app.get("/health", (_req, res) => res.json({ ok: true, host: HOSTNAME, port: PORT, peers: [...peers.keys()].sort() }));

// List all songs category-wise
app.get("/songs", (_req, res) => res.json(listAllSongs()));

// Play local song
let currentProcess = null;
let currentSong = null;

app.post("/play", async (req, res) => {
  const file = sanitizeFilename(req.body.song);
  let foundPath = null;

  for (const cat of CATEGORIES) {
    const p = path.join(MUSIC_DIR, cat, file);
    if (fs.existsSync(p)) {
      foundPath = p;
      break;
    }
  }

  if (!foundPath) return res.status(404).send("Not found");

  try { execSync("pkill -9 mpg123"); } catch { }
  currentSong = file;
  currentProcess = spawn("mpg123", [foundPath]);

  currentProcess.on("exit", () => { currentProcess = null; currentSong = null; });
  res.json({ message: ` Playing "${file}"`, ok: true });
});

app.get("/status", async (_req, res) => {
  res.json({ playing: currentProcess != null, currentSong });
});

// Stop playback
app.get("/stop", async (_req, res) => {
  try {
    await run("killall -q mpg123 || true");
    res.json({ message: ` Stopped`, ok: true });
  } catch (e) {
    res.status(500).send("Stop error: " + e);
  }
});

// Volume (0-100)
app.post("/volume", async (req, res) => {
  try {
    const level = Math.max(0, Math.min(100, parseInt(req.body?.level ?? "70", 10)));

    const controlsOutput = await run("amixer scontrols");
    const controls = [];
    controlsOutput.split("\n").forEach(line => {
      const match = line.match(/Simple mixer control '([^']+)'/);
      if (match) controls.push(match[1]);
    });

    const control = controls.includes("PCM") ? "PCM"
      : controls.includes("Master") ? "Master"
        : controls[0];

    if (!control) return res.status(500).send("No audio control found");

    await run(`amixer sset '${control}' ${level}%`);
    res.json({ message: ` Changed volume `, ok: true, level, control });
  } catch (e) {
    res.status(500).send("Volume error: " + e);
  }
});

// List peers
app.get("/peers", (_req, res) => res.json([...peers.keys()].sort()));

// Get songs from a peer
app.get("/songs-on-peer", async (req, res) => {
  const peer = String(req.query.peer || "");
  const addr = peers.get(peer);
  if (!addr) return res.status(404).send("Peer not found");
  try {
    const songs = await fetch(`http://${addr}/songs`).then(r => r.json());
    res.json(songs);
  } catch (e) {
    res.status(500).send("Peer fetch error: " + e);
  }
});

// Play on peer
app.post("/play-on-peer", async (req, res) => {
  const peer = String(req.body?.peer || "");
  const song = String(req.body?.song || "");
  const addr = peers.get(peer);
  if (!addr) return res.status(404).send("Peer not found");
  try {
    const r = await fetch(`http://${addr}/play`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ song })
    });
    res.status(r.status).send(await r.text());
  } catch (e) {
    res.status(500).send("Peer play error: " + e);
  }
});

// Upload to THIS Pi
app.post("/upload", upload.single("song"), async (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");
  const filename = req.file.filename;
  const category = String(req.query.category || "favorites");
  const full = path.join(MUSIC_DIR, category, filename);

  const doSync = (String(req.query.sync || "").toLowerCase() === "all");
  if (!doSync) return res.json({ message: "Uploaded", ok: true });

  const peerList = [...peers.entries()];
  let ok = 0, fail = 0;

  await Promise.all(peerList.map(async ([name, addr]) => {
    try {
      const peerSongs = await fetch(`http://${addr}/songs`).then(r => r.json());
      const allNames = peerSongs.flatMap(p => p.songs);
      if (allNames.includes(filename)) return;

      const form = new FormData();
      form.append("song", fs.createReadStream(full), filename);
      const r = await fetch(`http://${addr}/upload?category=${category}`, { method: "POST", body: form, headers: form.getHeaders() });
      if (r.ok) ok++; else fail++;
    } catch { fail++; }
  }));
  res.json({ status: "uploaded", filename, host: HOSTNAME, ok: true, fail, message: "Uploaded" });
});

// Manual full-library sync
app.post("/sync-library", async (_req, res) => {
  const files = listMp3();
  const peerList = [...peers.entries()];
  let sent = 0, failed = 0;
  for (const file of files) {
    const full = path.join(MUSIC_DIR, file);
    await Promise.all(peerList.map(async ([, addr]) => {
      try {
        const form = new FormData();
        form.append("song", fs.createReadStream(full), path.basename(file));
        const r = await fetch(`http://${addr}/upload?category=${path.dirname(file)}`, { method: "POST", body: form, headers: form.getHeaders() });
        if (r.ok) sent++; else failed++;
      } catch { failed++; }
    }));
  }
  res.send(`🔁 Library sync finished — sent=${sent}, failed=${failed}, peers=${peerList.length}, files=${files.length}`);
});

/* ---------- DELETE ROUTES ---------- */
app.delete("/delete", async (req, res) => {
  const file = sanitizeFilename(req.body.song || "");
  let deleted = false;

  for (const cat of CATEGORIES) {
    const fullPath = path.join(MUSIC_DIR, cat, file);
    if (fs.existsSync(fullPath)) {
      try {
        fs.unlinkSync(fullPath);
        deleted = true;
        return res.json({ ok: true, message: "deleted", hostname: HOSTNAME, file });
      } catch (err) {
        return res.status(500).send("Delete error: " + err.message);
      }
    }
  }
  if (!deleted) return res.status(404).send("File not found");
});

// Delete on peer
app.post("/delete-on-peer", async (req, res) => {
  const peer = String(req.body?.peer || "");
  const song = String(req.body?.song || "");
  const addr = peers.get(peer);
  if (!addr) return res.status(404).send("Peer not found");

  try {
    const r = await fetch(`http://${addr}/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ song })
    });
    res.status(r.status).send(await r.text());
  } catch (e) {
    res.status(500).send("Peer delete error: " + e);
  }
});

/* ---------- UI ---------- */
app.get("/ui", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.end(`<!doctype html><meta charset="utf-8">
  <title>Music Mesh (${HOSTNAME})</title>
  <style>
    body{font-family:system-ui,Segoe UI,Arial;margin:2rem;max-width:820px}
    code{background:#f2f2f2;padding:2px 6px;border-radius:6px}
    button{margin-left:0.5rem}
  </style>
  <h2>🎵 Music Mesh — ${HOSTNAME}</h2>
  <p>Peers: <span id="peers">loading…</span></p>

  <h3>Upload to this Pi (choose category)</h3>
  <form id="up" enctype="multipart/form-data" method="post">
    <input type="file" name="song" accept=".mp3" required>
    <select name="category">
      ${CATEGORIES.map(c=>`<option value="${c}">${c}</option>`).join('')}
    </select>
    <button>Upload (+ sync to peers)</button>
  </form>

  <h3>All Songs (Category-wise)</h3>
  <div id="allSongs"></div>

  <script>
    async function json(u, opts){const r=await fetch(u,opts);try{return await r.json()}catch{return await r.text()}}
    async function init(){
      const peers=await json('/peers'); 
      document.getElementById('peers').textContent = peers.join(', ') || '(none)';

      const all=await json('/songs');
      const div=document.getElementById('allSongs'); div.innerHTML='';
      all.forEach(catObj=>{
        const h=document.createElement('h4');h.textContent=catObj.category;div.appendChild(h);
        const ul=document.createElement('ul');
        catObj.songs.forEach(s=>{
          const li=document.createElement('li');
          const playBtn=document.createElement('button'); playBtn.textContent='▶️ Play';
          playBtn.onclick=()=>fetch('/play',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({song:s})});
          const delBtn=document.createElement('button'); delBtn.textContent='🗑 Delete';
          delBtn.onclick=()=>fetch('/delete',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({song:s})}).then(()=>init());
          li.textContent=s+' '; li.appendChild(playBtn); li.appendChild(delBtn); ul.appendChild(li);
        });
        div.appendChild(ul);
      });
    }
    init();
  </script>`);
});

/* ---------- Start ---------- */
app.listen(PORT, () => {
  console.log(`🎧 Music Mesh API on http://${HOSTNAME}.local:${PORT}`);
  console.log(`Music dir: ${MUSIC_DIR}`);
  console.log(`Try UI:    http://${HOSTNAME}.local:${PORT}/ui`);
});
