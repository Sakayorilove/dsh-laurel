import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PARCHMENT_PREVIEW_PORT || 4318);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png' };
export function startPreview(previewPort = port) {
  const server = createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const file = resolve(root, `.${path === '/' ? '/preview/index.html' : path}`);
      if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) { res.writeHead(403); res.end(); return; }
      res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(await readFile(file));
    } catch (cause) { res.writeHead(404); res.end('Not found'); }
  });
  return new Promise(resolve => server.listen(previewPort, '127.0.0.1', () => resolve(server)));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = await startPreview();
  console.log(`Parchment preview: http://localhost:${server.address().port}`);
}
