const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const rootDir = __dirname;
const sessionsFile = path.join(__dirname, 'sessions.json');
let sessions = {};

function loadSessions() {
  try {
    if (fs.existsSync(sessionsFile)) {
      const raw = fs.readFileSync(sessionsFile, 'utf8');
      sessions = JSON.parse(raw || '{}');
    }
  } catch (e) {
    sessions = {};
  }
}

function saveSessions() {
  try {
    fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2), 'utf8');
  } catch (e) {
    console.error('Could not save sessions:', e);
  }
}

function sendJSON(res, data, status = 200) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload, 'utf8'),
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
  });
  res.end(payload);
}

function sendText(res, text, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text, 'utf8'),
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
  });
  res.end(text);
}

function sendFile(res, filePath, status = 200) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendText(res, 'Not found', 404);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
      '.woff2': 'font/woff2',
    };
    res.writeHead(status, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve(null);
      try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function randomSessionId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 8; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

function normalizeSession(session) {
  return {
    hostName: session.hostName || 'Host',
    sessionId: session.sessionId || randomSessionId(),
    people: Array.isArray(session.people) ? session.people : [],
    locked: Boolean(session.locked),
    started: Boolean(session.started),
    requests: Array.isArray(session.requests) ? session.requests : [],
    likes: session.likes || {},
    spin: session.spin || null,
    createdAt: session.createdAt || new Date().toISOString(),
  };
}

async function handleApi(req, res) {
  const parsedUrl = url.parse(req.url, true);
  const parts = parsedUrl.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }
  if (parts.length === 1 && parts[0] === 'health' && req.method === 'GET') {
    sendJSON(res, { ok: true });
    return;
  }
  if (parts.length === 1 && parts[0] === 'session' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      if (!body) return sendText(res, 'Missing session body', 400);
      const session = normalizeSession(body);
      if (!session.sessionId || sessions[session.sessionId]) {
        session.sessionId = randomSessionId();
      }
      session.requests = [];
      sessions[session.sessionId] = session;
      saveSessions();
      sendJSON(res, session);
    } catch (e) {
      sendText(res, 'Invalid JSON', 400);
    }
    return;
  }
  if (parts.length === 2 && parts[0] === 'session' && req.method === 'GET') {
    const sessionId = parts[1];
    const session = sessions[sessionId];
    if (!session) return sendText(res, 'Session not found', 404);
    sendJSON(res, session);
    return;
  }
  if (parts.length === 3 && parts[0] === 'session' && parts[2] === 'requests' && req.method === 'GET') {
    const sessionId = parts[1];
    const session = sessions[sessionId];
    if (!session) return sendText(res, 'Session not found', 404);
    sendJSON(res, session.requests || []);
    return;
  }
  if (parts.length === 3 && parts[0] === 'session' && parts[2] === 'request' && req.method === 'POST') {
    const sessionId = parts[1];
    const session = sessions[sessionId];
    if (!session) return sendText(res, 'Session not found', 404);
    try {
      const body = await parseBody(req);
      if (!body || !body.id) return sendText(res, 'Invalid request object', 400);
      session.requests = session.requests || [];
      const existing = session.requests.find(r => !r.accepted && !r.rejected && r.name === body.name && r.pincode === body.pincode);
      if (!existing) {
        session.requests.push(Object.assign({ accepted: false, rejected: false }, body));
      }
      sessions[sessionId] = session;
      saveSessions();
      sendJSON(res, session);
    } catch (e) {
      sendText(res, 'Invalid JSON', 400);
    }
    return;
  }
  if (parts.length === 5 && parts[0] === 'session' && parts[2] === 'request' && parts[4] === 'approve' && req.method === 'POST') {
    const sessionId = parts[1];
    const requestId = parts[3];
    const session = sessions[sessionId];
    if (!session) return sendText(res, 'Session not found', 404);
    const request = (session.requests || []).find(r => r && r.id === requestId);
    if (!request) return sendText(res, 'Join request not found', 404);
    if (request.accepted) return sendJSON(res, session);
    if (session.people.length >= 4) return sendText(res, 'Session is full', 400);
    request.accepted = true;
    request.rejected = false;
    if (!session.people.some(p => p && p.name === request.name && p.pincode === request.pincode)) {
      session.people.push({ name: request.name, pincode: request.pincode, lat: request.lat, lng: request.lng });
    }
    session.locked = session.people.length >= 4;
    sessions[sessionId] = session;
    saveSessions();
    sendJSON(res, session);
    return;
  }
  if (parts.length === 3 && parts[0] === 'session' && parts[2] === 'like' && req.method === 'POST') {
    const sessionId = parts[1];
    const session = sessions[sessionId];
    if (!session) return sendText(res, 'Session not found', 404);
    try {
      const body = await parseBody(req);
      if (!body || !body.venueKey || typeof body.personName !== 'string') return sendText(res, 'Invalid request', 400);
      session.likes = session.likes || {};
      const venueKey = body.venueKey;
      let voters = new Set(session.likes[venueKey] || []);
      if (body.like) voters.add(body.personName);
      else voters.delete(body.personName);
      session.likes[venueKey] = Array.from(voters);
      sessions[sessionId] = session;
      saveSessions();
      sendJSON(res, session.likes);
    } catch (e) {
      sendText(res, 'Invalid JSON', 400);
    }
    return;
  }
  if (parts.length === 3 && parts[0] === 'session' && parts[2] === 'spin' && req.method === 'POST') {
    const sessionId = parts[1];
    const session = sessions[sessionId];
    if (!session) return sendText(res, 'Session not found', 404);
    if (!session.people || !session.people.length) return sendText(res, 'No people', 400);
    const winnerIndex = Math.floor(Math.random() * session.people.length);
    session.spin = { winnerIndex, ts: Date.now() };
    saveSessions();
    sendJSON(res, session.spin);
    return;
  }
  if (parts.length === 3 && parts[0] === 'session' && parts[2] === 'clearspin' && req.method === 'POST') {
    const sessionId = parts[1];
    const session = sessions[sessionId];
    if (session) {
      session.spin = null;
      saveSessions();
    }
    sendJSON(res, { ok: true });
    return;
  }
  sendText(res, 'API endpoint not found', 404);
}

function serveStatic(req, res) {
  let parsedUrl = url.parse(req.url);
  let pathname = parsedUrl.pathname;
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(rootDir, pathname);
  if (!filePath.startsWith(rootDir)) {
    sendText(res, 'Forbidden', 403);
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendText(res, 'Not found', 404);
    return;
  }
  sendFile(res, filePath);
}

loadSessions();

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url);
  if (parsedUrl.pathname && parsedUrl.pathname.startsWith('/api/')) {
    handleApi(req, res).catch(err => {
      console.error(err);
      sendText(res, 'Internal server error', 500);
    });
  } else {
    serveStatic(req, res);
  }
});

const port = process.env.PORT || 8000;
server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});