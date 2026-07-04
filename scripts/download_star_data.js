import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const baseDir = path.resolve(__dirname, '../public/gaia_sky_map');
if (!fs.existsSync(baseDir)) {
  fs.mkdirSync(baseDir, { recursive: true });
}

const base = 'https://ebruneton.github.io/gaia_sky_map';
const prefixes = ['pos-x', 'neg-x', 'pos-y', 'neg-y', 'pos-z', 'neg-z'];

const tasks = [];
for (let l = 0; l <= 4; ++l) {
  const size = 2048 / (1 << l);
  const tileSize = Math.min(256, size);
  const numTiles = size / tileSize;
  for (let i = 0; i < 6; ++i) {
    for (let tj = 0; tj < numTiles; ++tj) {
      for (let ti = 0; ti < numTiles; ++ti) {
        const filename = `${prefixes[i]}-${l}-${ti}-${tj}.dat`;
        const url = `${base}/${filename}`;
        const dest = path.join(baseDir, filename);
        tasks.push({ url, dest, filename });
      }
    }
  }
}

console.log(`Starting download of ${tasks.length} star map tiles...`);

const CONCURRENCY = 15;
let active = 0;
let completed = 0;

function runNext() {
  if (tasks.length === 0) {
    if (active === 0) {
      console.log('All downloads completed successfully!');
    }
    return;
  }

  const { url, dest, filename } = tasks.shift();
  active++;

  // Skip downloading if the file already exists and is not empty
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    completed++;
    active--;
    runNext();
    return;
  }

  fetch(url)
    .then(async (res) => {
      if (!res.ok) {
        throw new Error(`Failed with status: ${res.status}`);
      }
      const buffer = await res.arrayBuffer();
      fs.writeFileSync(dest, Buffer.from(buffer));
      completed++;
      active--;
      const percent = ((completed / 516) * 100).toFixed(1);
      console.log(`[${percent}%] Downloaded ${filename}`);
      runNext();
    })
    .catch((err) => {
      console.error(`Error downloading ${filename}:`, err.message);
      // Retry by pushing back to the queue
      tasks.push({ url, dest, filename });
      active--;
      setTimeout(runNext, 1000);
    });
}

for (let i = 0; i < CONCURRENCY; ++i) {
  runNext();
}
