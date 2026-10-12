// Tiny local web server for testing (no installs needed): `npm start`
// Open http://localhost:8080 on this PC, or http://<this PC's IP>:8080 on a
// phone on the same Wi-Fi (camera works; GPS needs the https GitHub Pages link).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT) || 8080;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

createServer(async (req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
  const file = join(root, path || 'index.html');
  if (!file.startsWith(root) || /(^|[/\\])\./.test(path)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file.endsWith('\\') || file.endsWith('/') ? join(file, 'index.html') : file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(port, '0.0.0.0', () => {
  console.log(`Rider Route running at http://localhost:${port}`);
  for (const nets of Object.values(networkInterfaces())) for (const n of nets) if (n.family === 'IPv4' && !n.internal) console.log(`  on your phone (same Wi-Fi): http://${n.address}:${port}`);
});
