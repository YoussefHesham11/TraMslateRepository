// Serves the repository over HTTP on a throwaway port, for checks that need
// the editor's media: fetch() cannot read it over file://, so over file:// the
// waveform and shot-change analysis never run.
//
// Byte ranges are honoured because <video> asks for them, and a server that
// ignores them makes the element misbehave for reasons that have nothing to
// do with the code under test.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const TYPES = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.m4v': 'video/mp4',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serve() {
    const server = http.createServer((req, res) => {
        const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
        const file = path.join(ROOT, rel);
        if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            res.writeHead(404).end('not found');
            return;
        }
        const size = fs.statSync(file).size;
        const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
        const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
        if (range) {
            const start = range[1] ? Number(range[1]) : 0;
            const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
            res.writeHead(206, {
                'Content-Type': type,
                'Content-Length': end - start + 1,
                'Content-Range': `bytes ${start}-${end}/${size}`,
                'Accept-Ranges': 'bytes',
            });
            fs.createReadStream(file, { start, end }).pipe(res);
        } else {
            res.writeHead(200, { 'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes' });
            fs.createReadStream(file).pipe(res);
        }
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
        server.base = `http://127.0.0.1:${server.address().port}`;
        resolve(server);
    }));
}

module.exports = { serve, ROOT };
