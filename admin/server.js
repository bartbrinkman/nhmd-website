import express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLIC_IMAGES = path.join(REPO_ROOT, 'public', 'images');
const CONTENT_DIR = path.join(REPO_ROOT, 'src', 'content');
const CAROUSELS_JSON = path.join(CONTENT_DIR, 'carousels.json');
const PORT = Number(process.env.PORT) || 5179;
const PENDING = 'pending';

// Array-shaped data files the admin can edit. Each has a validator that
// coerces/cleans incoming rows before writing.
const DATA_FILES = {
  exposanten: {
    file: path.join(CONTENT_DIR, 'exposanten.json'),
    clean(row) {
      const out = {};
      for (const k of ['title', 'href', 'scale', 'description', 'category', 'status', 'image']) {
        const v = row[k];
        if (typeof v === 'string' && v.trim()) out[k] = v.trim();
      }
      return out;
    },
  },
  events: {
    file: path.join(CONTENT_DIR, 'events.json'),
    clean(row) {
      const out = {};
      for (const k of ['date', 'endDate', 'startTime', 'endTime', 'title', 'description', 'location', 'type', 'link']) {
        const v = row[k];
        if (typeof v === 'string' && v.trim()) out[k] = v.trim();
      }
      return out;
    },
  },
};

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/images', express.static(PUBLIC_IMAGES));

function safeJoin(base, rel) {
  const resolved = path.resolve(base, rel);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) {
    throw new Error('Path escapes base directory');
  }
  return resolved;
}

function validId(id) {
  return typeof id === 'string' && /^[a-z0-9_-]+$/i.test(id);
}

function validFilename(name) {
  return typeof name === 'string' && name.length > 0 && !name.includes('/') && !name.includes('..');
}

async function listCarousels() {
  const entries = await fs.readdir(PUBLIC_IMAGES, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && e.name !== PENDING)
    .map((e) => e.name)
    .sort();
}

async function listImagesIn(folder) {
  const dir = safeJoin(PUBLIC_IMAGES, folder);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && /\.(jpe?g|png|gif|webp|avif)$/i.test(e.name))
    .map((e) => e.name)
    .sort();
}

async function readCarousels() {
  try {
    return JSON.parse(await fs.readFile(CAROUSELS_JSON, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

async function writeCarousels(data) {
  await fs.writeFile(CAROUSELS_JSON, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

// --- API -----------------------------------------------------------------

app.get('/api/state', async (_req, res) => {
  try {
    const carousels = await readCarousels();
    const ids = await listCarousels();
    const images = {};
    images[PENDING] = await listImagesIn(PENDING).catch(() => []);
    for (const id of ids) images[id] = await listImagesIn(id);
    res.json({ carousels, ids, images });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/carousels/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!validId(id) || id === PENDING) return res.status(400).json({ error: 'invalid id' });
    const body = req.body;
    if (!Array.isArray(body)) return res.status(400).json({ error: 'body must be array' });
    for (const item of body) {
      if (!item || typeof item.src !== 'string' || typeof item.title !== 'string') {
        return res.status(400).json({ error: 'item missing src/title' });
      }
      if (item.description !== undefined && typeof item.description !== 'string') {
        return res.status(400).json({ error: 'bad description' });
      }
    }
    const data = await readCarousels();
    data[id] = body.map((i) => {
      const out = { src: i.src, title: i.title };
      if (i.description && i.description.trim()) out.description = i.description;
      return out;
    });
    await writeCarousels(data);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new carousel = create its image folder + add empty metadata entry.
app.post('/api/carousels', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!validId(id) || id === PENDING) return res.status(400).json({ error: 'invalid id' });
    await fs.mkdir(safeJoin(PUBLIC_IMAGES, id), { recursive: true });
    const data = await readCarousels();
    if (!(id in data)) { data[id] = []; await writeCarousels(data); }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Move an image between folders (pending ↔ carousel, or carousel → carousel).
// If moving OUT of a carousel folder, also remove it from that carousel's JSON.
app.post('/api/move', async (req, res) => {
  try {
    const { from, to, name, rename } = req.body || {};
    if (!validId(from) || !validId(to)) return res.status(400).json({ error: 'invalid folder' });
    if (!validFilename(name)) return res.status(400).json({ error: 'bad name' });
    if (rename !== undefined && !validFilename(rename)) return res.status(400).json({ error: 'bad rename' });
    if (from === to) return res.status(400).json({ error: 'same folder' });

    const srcPath = safeJoin(safeJoin(PUBLIC_IMAGES, from), name);
    const finalName = rename || name;
    const destDir = safeJoin(PUBLIC_IMAGES, to);
    await fs.mkdir(destDir, { recursive: true });
    const destPath = safeJoin(destDir, finalName);
    await fs.rename(srcPath, destPath);

    // Keep carousels.json in sync: drop references to the old path,
    // rewrite if moving between two carousels.
    if (from !== PENDING || to !== PENDING) {
      const data = await readCarousels();
      let changed = false;
      const oldSrc = `/images/${from}/${name}`;
      const newSrc = `/images/${to}/${finalName}`;
      for (const id of Object.keys(data)) {
        for (let i = 0; i < data[id].length; i++) {
          if (data[id][i].src === oldSrc) {
            if (id === to) {
              data[id][i] = { ...data[id][i], src: newSrc };
            } else {
              data[id].splice(i, 1); i--;
            }
            changed = true;
          }
        }
      }
      if (changed) await writeCarousels(data);
    }

    res.json({ ok: true, src: `/images/${to}/${finalName}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/delete-image', async (req, res) => {
  try {
    const { folder, name } = req.body || {};
    if (!validId(folder) || !validFilename(name)) return res.status(400).json({ error: 'bad input' });
    await fs.unlink(safeJoin(safeJoin(PUBLIC_IMAGES, folder), name));
    const data = await readCarousels();
    const src = `/images/${folder}/${name}`;
    let changed = false;
    for (const id of Object.keys(data)) {
      const before = data[id].length;
      data[id] = data[id].filter((s) => s.src !== src);
      if (data[id].length !== before) changed = true;
    }
    if (changed) await writeCarousels(data);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- generic JSON array data (exposanten, events) ----------------------------

app.get('/api/data/:name', async (req, res) => {
  const entry = DATA_FILES[req.params.name];
  if (!entry) return res.status(404).json({ error: 'unknown dataset' });
  try {
    const raw = await fs.readFile(entry.file, 'utf8').catch((err) => {
      if (err.code === 'ENOENT') return '[]';
      throw err;
    });
    res.json(JSON.parse(raw));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/data/:name', async (req, res) => {
  const entry = DATA_FILES[req.params.name];
  if (!entry) return res.status(404).json({ error: 'unknown dataset' });
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'body must be array' });
  try {
    const cleaned = req.body.map(entry.clean);
    await fs.writeFile(entry.file, JSON.stringify(cleaned, null, 2) + '\n', 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`\n  NHMD admin → http://localhost:${PORT}\n`);
  console.log(`  Content: ${CONTENT_DIR}`);
  console.log(`  Images:  ${PUBLIC_IMAGES}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✗ Port ${PORT} is already in use. Set a different port: PORT=5180 npm start\n`);
    process.exit(1);
  }
  throw err;
});
