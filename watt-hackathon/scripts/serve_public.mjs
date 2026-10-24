import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const port = Number(process.argv[2] || 8511);
const index = resolve('dist/index.html');
createServer((request, response) => {
  if (!['/', '/index.html'].includes(request.url?.split('?')[0])) {
    response.writeHead(404); response.end('Not found'); return;
  }
  try {
    response.writeHead(200, {'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store'});
    response.end(readFileSync(index));
  } catch {
    response.writeHead(503); response.end('Run python web/build.py first.');
  }
}).listen(port, '127.0.0.1', () => console.log(`GridScout preview: http://127.0.0.1:${port}/`));
