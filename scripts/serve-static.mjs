// Servidor estático mínimo para probar el sitio generado en local, como lo serviría GitHub Pages:
// decodifica la ruta (%20, %C3%B3…), sirve index.html en carpetas y añade CORS.
//   node scripts/serve-static.mjs [carpeta] [puerto]
import { createReadStream, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'site');
const port = Number(process.argv[3] ?? 7100);
const types = { '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };

http.createServer((req, res) => {
  let rel;
  try {
    rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  let file = path.join(root, rel);
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    if (statSync(file).isDirectory()) file = path.join(file, 'index.html');
    statSync(file);
  } catch {
    return res.writeHead(404, { 'access-control-allow-origin': '*' }).end('not found');
  }
  res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream', 'access-control-allow-origin': '*' });
  createReadStream(file).pipe(res);
}).listen(port, () => console.log(`Sitio estático ${root} en http://127.0.0.1:${port}/`));
