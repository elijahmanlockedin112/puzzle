/* Zero-dependency static server. Only here so the camera gets a secure
   context — the app itself never talks to it. */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json'
};

function start(port, onReady) {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0]);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(ROOT, path.normalize(rel).replace(/^([\\/])+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      res.end(data);
    });
  });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      console.error('Port ' + port + ' is already in use. Pass another: node serve.js 8758');
      process.exit(1);
    }
    throw err;
  });
  server.listen(port, () => {
    console.log('Puzzle Solver+ → http://localhost:' + port);
    if (onReady) onReady(server);
  });
  return server;
}

module.exports = { start };

if (require.main === module) start(Number(process.argv[2]) || 8123);
