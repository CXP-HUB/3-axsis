import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 8000);
const deviceUrl = process.env.DEVICE_URL || 'http://192.168.4.1';
const deviceTimeoutMs = Number(process.env.DEVICE_TIMEOUT_MS || 120000);
const maxJobSize = 8 * 1024 * 1024;
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const proxyRoutes = new Map([
  ['GET /api/device/status', '/api/status'],
  ['PUT /api/device/job', '/api/job'],
  ['POST /api/device/start', '/api/start'],
  ['POST /api/device/pause', '/api/pause'],
  ['POST /api/device/resume', '/api/resume'],
  ['POST /api/device/stop', '/api/stop']
]);

function sendJson(response, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': body.length
  });
  response.end(body);
}

function getDeviceTarget(devicePath) {
  const target = new URL(deviceUrl);
  target.pathname = devicePath;
  target.search = '';
  return target;
}

function proxyToDevice(request, response, devicePath) {
  const contentLength = Number(request.headers['content-length'] || 0);
  if (request.method === 'PUT' && (!Number.isSafeInteger(contentLength) || contentLength < 1 || contentLength > maxJobSize)) {
    sendJson(response, 411, { error: 'content_length_required', max: maxJobSize });
    request.resume();
    return;
  }

  const target = getDeviceTarget(devicePath);
  const headers = {};
  for (const name of ['content-length', 'content-type', 'x-file-name', 'x-job-sha256']) {
    if (request.headers[name]) headers[name] = request.headers[name];
  }
  headers.connection = 'close';

  const upstream = http.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || 80,
    path: `${target.pathname}${target.search}`,
    method: request.method,
    headers,
    timeout: deviceTimeoutMs
  }, upstreamResponse => {
    const responseHeaders = {
      'Content-Type': upstreamResponse.headers['content-type'] || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    };
    if (upstreamResponse.headers['content-length']) {
      responseHeaders['Content-Length'] = upstreamResponse.headers['content-length'];
    }
    response.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
    upstreamResponse.pipe(response);
  });

  upstream.on('timeout', () => upstream.destroy(new Error('device_request_timeout')));
  upstream.on('error', error => {
    if (!response.headersSent) sendJson(response, 502, { error: error.message });
    else response.destroy(error);
  });
  request.on('aborted', () => upstream.destroy(new Error('browser_request_aborted')));
  request.pipe(upstream);
}

const server = http.createServer(async (request, response) => {
  const requestPath = decodeURIComponent((request.url || '/').split('?')[0]);
  const route = proxyRoutes.get(`${request.method} ${requestPath}`);

  if (request.method === 'GET' && requestPath === '/api/device/config') {
    sendJson(response, 200, { device_url: deviceUrl, max_job_size: maxJobSize });
    return;
  }

  if (route) {
    proxyToDevice(request, response, route);
    return;
  }

  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'method_not_allowed' });
    request.resume();
    return;
  }

  try {
    const relativePath = requestPath === '/' ? '/index.html' : requestPath;
    const filePath = normalize(join(root, relativePath));
    if (!filePath.startsWith(root)) {
      response.writeHead(403);
      response.end('Forbidden');
      return;
    }
    const content = await readFile(filePath);
    response.writeHead(200, { 'Content-Type': contentTypes[extname(filePath)] || 'application/octet-stream' });
    response.end(content);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Vector G-code Web Component: http://localhost:${port}/`);
  console.log(`ESP32 device proxy: ${deviceUrl}`);
  console.log('按 Ctrl+C 停止服务器。');
});
