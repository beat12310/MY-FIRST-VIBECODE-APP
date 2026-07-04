#!/usr/bin/env node
/**
 * DWOMOH Build-Worker Edge Proxy
 * ───────────────────────────────
 * One public port (8080, the ALB target) fronts two things inside the container:
 *
 *   Host = worker.<domain>     → the DWOMOH Next.js app on :3000  (handles /api/chat)
 *   Host = preview.<domain>    → the currently-running generated project's dev server
 *                                (port read from <WORKSPACE_DIR>/.server-state.json)
 *
 * It also forwards WebSocket upgrades so Next.js HMR works through the preview host.
 *
 * v1 routes the single active preview (project-runner tracks one server at a time).
 * Concurrent per-user previews are Phase 3 (one Fargate task per session) — see
 * PRODUCTION_BUILD_WORKER_DESIGN.md.
 */
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const EDGE_PORT = Number(process.env.EDGE_PORT || 8080);
const NEXT_PORT = Number(process.env.NEXT_PORT || 3000);
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/workspace';
const STATE_FILE = join(WORKSPACE_DIR, '.server-state.json');

// ── Start the DWOMOH Next.js app (the worker brain) as a child ───────────────
const next = spawn('node_modules/.bin/next', ['start', '-p', String(NEXT_PORT)], {
  stdio: 'inherit',
  env: process.env,
});
next.on('exit', (code) => {
  console.error(`[edge] Next.js exited with code ${code} — shutting down`);
  process.exit(code ?? 1);
});

/** Resolve the port of the current generated-project dev server, or null. */
function currentPreviewPort() {
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    return typeof state.port === 'number' ? state.port : null;
  } catch {
    return null;
  }
}

/** Decide upstream port from the Host header. */
function upstreamPortFor(hostHeader) {
  const host = (hostHeader || '').split(':')[0].toLowerCase();
  if (host.startsWith('preview.') || host.startsWith('preview-')) {
    return currentPreviewPort();
  }
  return NEXT_PORT; // worker.<domain>, health checks, everything else
}

// ── HTTP proxy ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  // ALB health check fast-path
  if (req.url === '/__health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  const port = upstreamPortFor(req.headers.host);
  if (!port) {
    res.writeHead(503, { 'Content-Type': 'text/html' });
    res.end('<h1>No preview running yet</h1><p>Generate an app first, then the preview appears here.</p>');
    return;
  }

  const proxyReq = http.request(
    { host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end(`Upstream error: ${err.message}`);
  });
  req.pipe(proxyReq);
});

// ── WebSocket / HMR upgrade proxy ────────────────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  const port = upstreamPortFor(req.headers.host);
  if (!port) { socket.destroy(); return; }

  const upstream = net.connect(port, '127.0.0.1', () => {
    upstream.write(
      `${req.method} ${req.url} HTTP/1.1\r\n` +
      Object.entries(req.headers).map(([k, v]) => `${k}: ${v}\r\n`).join('') +
      '\r\n',
    );
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(EDGE_PORT, () => {
  console.log(`[edge] listening on :${EDGE_PORT} → Next :${NEXT_PORT}, previews via ${STATE_FILE}`);
});
