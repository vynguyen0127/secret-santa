// Tiny web server: phone-number login, see your recipient's wishlist, manage your own.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, init, one, getSetting, normalizePhone } = require('./db');

const PORT = process.env.PORT || 3000;
const SESSION_DAYS = 60;

// --- helpers --------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string';
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json' : 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 20_000) reject(new Error('Too large'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Bad JSON')); }
    });
  });
}

function getCookie(req, name) {
  const match = (req.headers.cookie || '').match(new RegExp(`(?:^|; )${name}=([^;]+)`));
  return match ? match[1] : null;
}

async function currentUser(req) {
  const token = getCookie(req, 'session');
  if (!token) return null;
  const minCreated = Date.now() - SESSION_DAYS * 864e5;
  return one(`
    SELECT p.id, p.name, p.recipient_id
    FROM sessions s JOIN participants p ON p.id = s.participant_id
    WHERE s.token = ? AND s.created_at > ?
  `, [token, minCreated]);
}

async function itemsFor(participantId) {
  const { rows } = await db.execute({
    sql: 'SELECT id, name, urls, notes FROM wishlist_items WHERE participant_id = ? ORDER BY created_at, id',
    args: [participantId],
  });
  return rows.map((r) => ({ id: Number(r.id), name: r.name, urls: JSON.parse(r.urls), notes: r.notes }));
}

// Validate a wishlist item from the form: a name, up to 5 web links, and optional notes.
const MAX_URLS = 5;
function cleanItem(body) {
  const name = String(body.name ?? '').trim().slice(0, 200);
  if (!name) throw new Error('Give the item a name.');

  const raw = Array.isArray(body.urls) ? body.urls : [];
  const urls = [];
  for (let u of raw) {
    u = String(u ?? '').trim();
    if (!u) continue;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u; // allow "amazon.com/..." without https://
    let parsed;
    try { parsed = new URL(u); } catch { throw new Error(`"${u}" doesn't look like a link.`); }
    // Only allow normal web links, so nobody can sneak in a javascript: link.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`"${u}" isn't a web link.`);
    urls.push(parsed.href.slice(0, 2000));
  }
  if (urls.length > MAX_URLS) throw new Error(`Up to ${MAX_URLS} links per item.`);
  const notes = String(body.notes ?? '').trim().slice(0, 2000);
  return { name, urls, notes };
}

// Slow down anyone trying to guess phone numbers: 10 failed tries per IP per 15 min.
const failures = new Map();
function tooManyFailures(ip) {
  const now = Date.now();
  const recent = (failures.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  failures.set(ip, recent);
  return recent.length >= 10;
}

// --- routes ---------------------------------------------------------------

const indexHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && url.pathname === '/') return send(res, 200, indexHtml);

    if (req.method === 'POST' && url.pathname === '/api/login') {
      const ip = req.socket.remoteAddress;
      if (tooManyFailures(ip)) return send(res, 429, { error: 'Too many tries. Wait a few minutes.' });

      const { phone } = await readJson(req);
      const user = await one('SELECT id FROM participants WHERE phone = ?', [normalizePhone(phone)]);
      if (!user) {
        failures.get(ip).push(Date.now());
        return send(res, 401, { error: "That number isn't on the list." });
      }
      const token = crypto.randomBytes(32).toString('hex');
      await db.execute({ sql: 'INSERT INTO sessions (token, participant_id, created_at) VALUES (?, ?, ?)', args: [token, user.id, Date.now()] });
      return send(res, 200, { ok: true }, {
        'Set-Cookie': `session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`,
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const token = getCookie(req, 'session');
      if (token) await db.execute({ sql: 'DELETE FROM sessions WHERE token = ?', args: [token] });
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'session=; Path=/; Max-Age=0' });
    }

    // Everything below needs a logged-in user.
    const me = await currentUser(req);
    if (url.pathname.startsWith('/api/') && !me) return send(res, 401, { error: 'Not logged in.' });

    if (req.method === 'GET' && url.pathname === '/api/me') {
      // Only ever returns who *you* give to — never who gives to you — and only
      // once the admin has run "npm run reveal". Until then nothing is sent.
      const revealed = (await getSetting('revealed')) === '1';
      const recipient = revealed && me.recipient_id
        ? await one('SELECT name FROM participants WHERE id = ?', [me.recipient_id])
        : null;
      return send(res, 200, {
        name: me.name,
        items: await itemsFor(me.id),
        revealed,
        recipient: recipient && { name: recipient.name, items: await itemsFor(me.recipient_id) },
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/items') {
      const { name, urls, notes } = cleanItem(await readJson(req));
      const { lastInsertRowid } = await db.execute({
        sql: 'INSERT INTO wishlist_items (participant_id, name, urls, notes, created_at) VALUES (?, ?, ?, ?, ?)',
        args: [me.id, name, JSON.stringify(urls), notes, Date.now()],
      });
      return send(res, 201, { id: Number(lastInsertRowid), name, urls, notes });
    }

    // /api/items/123 — edit or delete one of *your own* items.
    const itemMatch = url.pathname.match(/^\/api\/items\/(\d+)$/);
    if (itemMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const id = Number(itemMatch[1]);
      let result;
      if (req.method === 'PUT') {
        const { name, urls, notes } = cleanItem(await readJson(req));
        result = await db.execute({
          sql: 'UPDATE wishlist_items SET name = ?, urls = ?, notes = ? WHERE id = ? AND participant_id = ?',
          args: [name, JSON.stringify(urls), notes, id, me.id],
        });
      } else {
        result = await db.execute({
          sql: 'DELETE FROM wishlist_items WHERE id = ? AND participant_id = ?',
          args: [id, me.id],
        });
      }
      if (!result.rowsAffected) return send(res, 404, { error: 'Item not found.' });
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

init().then(() => {
  server.listen(PORT, () => console.log(`Secret Santa running at http://localhost:${PORT}`));
});
