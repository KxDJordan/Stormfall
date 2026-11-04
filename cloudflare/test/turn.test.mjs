// /api/turn with TURN secrets configured, against a local mock of the Cloudflare Realtime TURN API.
//   node --test test/turn.test.mjs
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..');
let API, proc, state, mock, calls = [];

before(async () => {
  mock = createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => {
      calls.push({ url: req.url, auth: req.headers.authorization, body: b });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ iceServers: [
        { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
        { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'user1', credential: 'cred1' },
      ] }));
    });
  });
  await new Promise(r => mock.listen(0, '127.0.0.1', r));
  const mp = mock.address().port, port = 20000 + Math.floor(Math.random() * 2000);
  state = mkdtempSync(join(tmpdir(), 'sf-wr-'));
  execFileSync('node', ['scripts/build-public.mjs'], { cwd: dir, stdio: 'ignore' });
  proc = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', state,
    '--var', 'TURN_KEY_ID:key123', '--var', 'TURN_KEY_API_TOKEN:tok456', '--var', 'TURN_API_BASE:http://127.0.0.1:' + mp], { cwd: dir, stdio: 'ignore', detached: true });
  API = 'http://127.0.0.1:' + port;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(API + '/api/health')).ok) return; } catch (_) {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('wrangler dev did not start');
});
after(() => {
  try { process.kill(-proc.pid, 'SIGTERM'); } catch (_) {}
  mock.close();
  setTimeout(() => rmSync(state, { recursive: true, force: true }), 1500);
});

test('turn: credentials minted once, shared, :53 dropped', async () => {
  const h = await (await fetch(API + '/api/health')).json();
  assert.equal(h.turn, true);
  const a = await (await fetch(API + '/api/turn')).json();
  assert.equal(a.turn, true);
  assert.ok(a.ttl > 80000 && a.ttl <= 86400);
  assert.deepEqual(a.iceServers[1], { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'user1', credential: 'cred1' });
  assert.ok(!JSON.stringify(a).includes(':53'));
  const b = await (await fetch(API + '/api/turn')).json();
  assert.deepEqual(b.iceServers, a.iceServers);
  assert.equal(calls.length, 1, 'the second request is served from the isolate cache');
  assert.equal(calls[0].url, '/turn/keys/key123/credentials/generate-ice-servers');
  assert.equal(calls[0].auth, 'Bearer tok456');
  assert.equal(JSON.parse(calls[0].body).ttl, 86400);
});
