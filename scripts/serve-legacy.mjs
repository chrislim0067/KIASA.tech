/**
 * Serves the crawled original at the same URLs the live site uses, so the
 * rebuild can be compared against it route-for-route.
 *
 *   npm run legacy      -> http://127.0.0.1:8137
 *
 * /service?s=wordpress maps to legacy/service__s=wordpress.html, mirroring how
 * the crawler flattened the query-string families.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', 'legacy');
const PORT = Number(process.argv[2] ?? 8137);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function resolveFile(urlPath, search) {
  const clean = decodeURIComponent(urlPath).replace(/^\/+|\/+$/g, '');
  if (!clean) return path.join(ROOT, 'index.html');

  const direct = path.join(ROOT, clean);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;

  // query-string families: /service?s=wordpress -> service__s=wordpress.html
  const params = new URLSearchParams(search);
  for (const key of ['s', 'slug']) {
    const v = params.get(key);
    if (v) {
      const withParam = path.join(ROOT, `${clean}__${key}=${v}.html`);
      if (fs.existsSync(withParam)) return withParam;
    }
  }
  const asHtml = path.join(ROOT, `${clean}.html`);
  if (fs.existsSync(asHtml)) return asHtml;
  return null;
}

http
  .createServer((req, res) => {
    const [urlPath, search = ''] = req.url.split('?');
    const file = resolveFile(urlPath, search);
    if (!file) {
      console.log(`404 ${req.url}`);
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404');
      return;
    }
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`legacy original -> http://127.0.0.1:${PORT}`));
