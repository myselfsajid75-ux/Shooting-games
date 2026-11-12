const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const E = process.env, PORT = E.PORT || 3000, DB = path.join(__dirname, 'users.json');
let users = {}; try { users = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch (e) {}
const sessions = new Map();
const pub = { ws: true, googleClientId: E.GOOGLE_CLIENT_ID || '', facebookAppId: E.FB_APP_ID || '' };

async function verify(provider, token) {
  if (provider === 'google' && E.GOOGLE_CLIENT_ID) {
    const r = await (await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token))).json();
    if (r.aud !== E.GOOGLE_CLIENT_ID || !r.sub) throw new Error('bad google token');
    return { sub: r.sub, name: r.name || r.given_name || 'Player' };
  }
  if (provider === 'facebook' && E.FB_APP_ID && E.FB_APP_SECRET) {
    const url = 'https://graph.facebook.com/debug_token?input_token=' + encodeURIComponent(token) + '&access_token=' + E.FB_APP_ID + '|' + E.FB_APP_SECRET;
    const d = (await (await fetch(url)).json()).data;
    if (!d || !d.is_valid || d.app_id !== E.FB_APP_ID) throw new Error('bad facebook token');
    const me = await (await fetch('https://graph.facebook.com/me?fields=name&access_token=' + encodeURIComponent(token))).json();
    return { sub: d.user_id, name: me.name || 'Player' };
  }
  throw new Error('provider not configured');
}

function account(provider, v) {
  const key = provider + ':' + v.sub;
  const u = users[key] || (users[key] = { playerId: 'ZR-' + crypto.randomBytes(3).toString('hex').toUpperCase(), created: Date.now() });
  u.name = String(v.name).slice(0, 20);
  fs.writeFile(DB, JSON.stringify(users), () => {});
  return u;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/api/login' && req.method === 'POST') {
    let b = ''; for await (const c of req) { b += c; if (b.length > 8192) return json(413, {}); }
    try {
      const { provider, token } = JSON.parse(b), u = account(provider, await verify(provider, token));
      const session = crypto.randomBytes(24).toString('hex'); sessions.set(session, u);
      return json(200, { session, name: u.name, playerId: u.playerId });
    } catch (e) { return json(401, { error: 'login failed' }); }
  }
  if (url.pathname === '/api/me') {
    const u = sessions.get(url.searchParams.get('s'));
    return u ? json(200, { name: u.name, playerId: u.playerId }) : json(401, {});
  }
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace('/*ZR_CONFIG*/{}', JSON.stringify(pub));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html);
});

const rooms = new Map(), KEYS = ['st', 'x', 'y', 'a', 'hp', 'd', 'k', 'n', 'sa', 'kb'];
new WebSocketServer({ server }).on('connection', ws => {
  let room = null, id = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (m.t === 'join' && !room) {
      const u = sessions.get(m.session);
      let r = rooms.get(m.room);
      if (!u || !/^zr-[a-z0-9]{3,8}$/.test(m.room) || (r && r.size >= 25)) { ws.send('{"t":"err"}'); return ws.close(); }
      if (!r) rooms.set(m.room, r = new Map());
      id = crypto.randomBytes(4).toString('hex'); room = m.room;
      r.set(id, { ws, p: { nm: u.name } });
      ws.send(JSON.stringify({ t: 'hi', id }));
    } else if (m.t === 'p' && room && m.p && typeof m.p === 'object') {
      const e = rooms.get(room).get(id);
      for (const k of KEYS) if (k in m.p && (m.p[k] === null || ['number', 'string'].includes(typeof m.p[k]))) e.p[k] = m.p[k];
    }
  });
  ws.on('close', () => { if (!room) return; const r = rooms.get(room); r.delete(id); if (!r.size) rooms.delete(room); });
});
setInterval(() => rooms.forEach(r => {
  const msg = JSON.stringify({ t: 'peers', peers: [...r].map(([id, e]) => ({ id, p: e.p })) });
  r.forEach(e => e.ws.readyState === 1 && e.ws.send(msg));
}), 50);
server.listen(PORT, () => console.log('Zone Rush Online on http://localhost:' + PORT));
