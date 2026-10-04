#!/usr/bin/env node
// Resize every image in public/images/pending/ so its long edge <= MAX.
// Keeps aspect ratio, applies EXIF orientation, overwrites in place via
// tmp-file rename. Skips files already within bounds.

import sharp from 'sharp';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PENDING_DIR = path.resolve(__dirname, '..', 'public', 'images', 'pending');
const MAX = Number(process.env.MAX_DIMENSION) || 2000;

const entries = await fs.readdir(PENDING_DIR, { withFileTypes: true }).catch((err) => {
  if (err.code === 'ENOENT') {
    console.error(`No pending/ directory at ${PENDING_DIR}`);
    process.exit(1);
  }
  throw err;
});

const files = entries
  .filter((e) => e.isFile() && /\.(jpe?g|png|gif|webp|avif)$/i.test(e.name))
  .map((e) => e.name)
  .sort();

if (files.length === 0) {
  console.log('No images in pending/.');
  process.exit(0);
}

console.log(`Scanning ${files.length} image(s) in ${PENDING_DIR} (max ${MAX}px)…\n`);

let resized = 0, skipped = 0, errors = 0;

for (const name of files) {
  const file = path.join(PENDING_DIR, name);
  try {
    const meta = await sharp(file).metadata();
    const w = meta.width || 0;
    const h = meta.height || 0;
    if (w <= MAX && h <= MAX) {
      console.log(`  skip  ${name}  (${w}×${h})`);
      skipped++;
      continue;
    }
    const tmp = file + '.tmp';
    await sharp(file)
      .rotate()
      .resize({ width: MAX, height: MAX, fit: 'inside', withoutEnlargement: true })
      .toFile(tmp);
    await fs.rename(tmp, file);
    const after = await sharp(file).metadata();
    console.log(`  done  ${name}  ${w}×${h} → ${after.width}×${after.height}`);
    resized++;
  } catch (err) {
    console.error(`  err   ${name}  ${err.message}`);
    errors++;
  }
}

console.log(`\nResized ${resized}, skipped ${skipped}${errors ? ', ' + errors + ' error(s)' : ''}.`);
process.exit(errors ? 1 : 0);
