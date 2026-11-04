// Pure helpers shared by the Worker and the unit tests (no Cloudflare globals here, only WebCrypto).

export const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U
export const ID_LEN = 10, SECRET_LEN = 20;             // 50-bit public id, 100-bit secret
export const MAX_SAVE = 65536;                         // bytes of save code accepted per push
export const MAX_BODY = 72000;                         // bytes of request body read at most
export const TOP_N = 50;

export function randB32(n) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (let i = 0; i < n; i++) s += B32[b[i] & 31]; // 256 is a multiple of 32: uniform
  return s;
}

export async function sha256hex(s) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  let h = '';
  for (const x of d) h += x.toString(16).padStart(2, '0');
  return h;
}

const RE_ID = new RegExp('^[' + B32 + ']{' + ID_LEN + '}$');
const RE_SECRET = new RegExp('^[' + B32 + ']{' + SECRET_LEN + '}$');

/** "ID.SECRET" (what the client sends) -> {id, secret} or null */
export function parseAuth(a) {
  if (typeof a !== 'string' || a.length !== ID_LEN + 1 + SECRET_LEN) return null;
  const id = a.slice(0, ID_LEN), secret = a.slice(ID_LEN + 1);
  if (a[ID_LEN] !== '.' || !RE_ID.test(id) || !RE_SECRET.test(secret)) return null;
  return { id, secret };
}

/** The human account code (30 chars, any grouping/case, O/I/L typos tolerated) -> "ID.SECRET" or null */
export function codeToAuth(code) {
  const s = String(code || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  if (s.length !== ID_LEN + SECRET_LEN) return null;
  const a = s.slice(0, ID_LEN) + '.' + s.slice(ID_LEN);
  return parseAuth(a) ? a : null;
}

export function authToCode(id, secret) {
  return (id + secret).match(/.{5}/g).join('-');
}

/** UTC day key 'YYYY-MM-DD' */
export function dayKey(t) {
  return new Date(t).toISOString().slice(0, 10);
}
export function validDayKey(k) {
  return typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k) && dayKey(Date.parse(k + 'T00:00:00Z')) === k;
}

/** A daily submission may be for today or yesterday (a match started before midnight UTC). */
export function dayAccepted(k, now) {
  return k === dayKey(now) || k === dayKey(now - 86400000);
}

const int = (v, lo, hi) => (Number.isInteger(v) && v >= lo && v <= hi ? v : null);

/** Daily caps: 8-operative Solo match, 7 bots. Damage/rounds caps are generous plausibility bounds. */
export const DAILY_CAPS = { of: 8, dmg: 2500, rounds: 99 };

/**
 * Validates a daily result and recomputes its score exactly like the game does (dailyScore in index.html):
 * placement (0..1000) + victory 500 + eliminations x200 + damage x10 + rounds survived x25.
 * Returns {row} or {error}.
 */
export function cleanDaily(b) {
  if (!b || typeof b !== 'object') return { error: 'bad body' };
  if (!validDayKey(b.day)) return { error: 'bad day' };
  const of = int(b.of, 2, DAILY_CAPS.of), place = of && int(b.place, 1, of);
  const kills = of && int(b.kills, 0, of - 1), dmg = int(b.dmg, 0, DAILY_CAPS.dmg), rounds = int(b.rounds, 0, DAILY_CAPS.rounds);
  if (!of || !place || kills == null || dmg == null || rounds == null) return { error: 'implausible result' };
  const win = place === 1;
  if (typeof b.win === 'boolean' && b.win !== win) return { error: 'implausible result' };
  const P = Math.round((of - place) / (of - 1) * 1000) + (win ? 500 : 0);
  const score = P + kills * 200 + dmg * 10 + rounds * 25;
  return { row: { day: b.day, place, of, win: win ? 1 : 0, kills, dmg, rounds, score, name: cleanName(b.name), cls: cleanCls(b.cls) } };
}

export function cleanName(n) {
  const s = String(n == null ? '' : n).toUpperCase().replace(/[^A-Z0-9 _-]/g, '').trim().slice(0, 12);
  return s || 'OPERATIVE';
}
export function cleanCls(c) {
  return typeof c === 'string' && /^[a-z]{1,16}$/.test(c) ? c : '';
}

/** Is this save code acceptable to store? (format check only; the client validates the content when it restores) */
export function validSave(s) {
  return typeof s === 'string' && s.length > 5 && s.length <= MAX_SAVE && /^SFS[01]\.[A-Za-z0-9+/=]+$/.test(s);
}

/** CORS: exact origins from the comma separated list, the Worker's own origin, and (dev only) localhost. */
export function originAllowed(origin, selfOrigin, list, allowLocal) {
  if (!origin) return false;
  if (origin === selfOrigin) return true;
  const L = String(list || '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean);
  if (L.includes(origin) || L.includes('*')) return true;
  if (allowLocal && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return true;
  return false;
}

/** PeerJS id rules (same as the client's validateId) plus a length bound */
export function validPeerId(id) {
  return typeof id === 'string' && id.length <= 64 && /^[A-Za-z0-9]+(?:[ _-][A-Za-z0-9]+)*$/.test(id);
}

/** Normalises Cloudflare TURN API responses (old: {iceServers:{...}}, new: {iceServers:[...]}) and drops :53 urls,
 *  which browsers block or time out on. */
export function normIce(j) {
  let L = j && j.iceServers;
  if (!L) return null;
  if (!Array.isArray(L)) L = [L];
  const out = [];
  for (const s of L) {
    if (!s || !s.urls) continue;
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => typeof u === 'string' && !/:53(\?|$)/.test(u));
    if (!urls.length) continue;
    const o = { urls };
    if (s.username) o.username = s.username;
    if (s.credential) o.credential = s.credential;
    out.push(o);
  }
  return out.length ? out : null;
}

/** Fixed-window counter in isolate memory: a best-effort fallback when no rate limiting binding is configured. */
export class MemLimiter {
  constructor(limit, windowMs) { this.limit = limit; this.win = windowMs; this.m = new Map(); }
  hit(key, now = Date.now()) {
    let e = this.m.get(key);
    if (!e || now - e.t >= this.win) {
      if (this.m.size > 5000) for (const [k, v] of this.m) if (now - v.t >= this.win) this.m.delete(k);
      e = { t: now, n: 0 };
      this.m.set(key, e);
    }
    e.n++;
    return e.n <= this.limit;
  }
}

/* ---------------- socials (friends, presence, invites) ---------------- */

export const FCODE_LEN = 8;          // 40-bit random friend code (Crockford base32), shown as XXXX-XXXX
export const MAX_LINKS = 100;        // friends + outgoing requests per account
export const MAX_OUT = 30;           // outgoing pending requests per account
export const MAX_IN = 50;            // incoming pending requests per account (more are refused)
export const MAX_BLOCKS = 100;
export const INVITE_TTL = 5 * 60000; // invites expire after 5 minutes
export const ROOM_ABC = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // the game's room code alphabet (CODE_ABC in index.html)
export const PRESENCE = ['menu', 'lobby', 'match'];

/** Friend code typed or pasted in any form (case, dashes, spaces, O/I/L typos) -> 8 canonical chars, or null */
export function normFriendCode(s) {
  const c = String(s == null ? '' : s).toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1').replace(/U/g, 'V');
  if (c.length !== FCODE_LEN) return null;
  for (const ch of c) if (!B32.includes(ch)) return null;
  return c;
}
export function fmtFriendCode(c) { return c ? c.slice(0, 4) + '-' + c.slice(4) : ''; }

const RE_ID24 = /^[a-z0-9_]{1,24}$/;
/** The small public profile a client publishes about itself (no PII: callsign, level, class, name plate ids). */
export function cleanProfile(b) {
  b = b && typeof b === 'object' ? b : {};
  const lv = Number.isInteger(b.lv) && b.lv >= 1 && b.lv <= 999 ? b.lv : 1;
  return {
    name: cleanName(b.name), lv, cls: cleanCls(b.cls),
    title: typeof b.title === 'string' && RE_ID24.test(b.title) ? b.title : '',
    banner: typeof b.banner === 'string' && RE_ID24.test(b.banner) ? b.banner : '',
  };
}

/** Room code of an online lobby: 5 chars of the game's alphabet, or '' */
export function cleanRoom(r) {
  if (typeof r !== 'string' || r.length !== 5) return '';
  for (const ch of r) if (!ROOM_ABC.includes(ch)) return '';
  return r;
}
export function cleanMode(m) { return typeof m === 'string' && /^[a-z]{1,12}$/.test(m) ? m : ''; }

/** A presence update from a client: {s, r, m, o} -> clean, or null. r is only kept in a lobby; o = friends may join. */
export function cleanPresence(p) {
  if (!p || typeof p !== 'object' || !PRESENCE.includes(p.s)) return null;
  const lobby = p.s === 'lobby', r = lobby ? cleanRoom(p.r) : '';
  return { s: p.s, r, m: lobby ? cleanMode(p.m) : '', o: lobby && r && p.o ? 1 : 0 };
}
/** What friends see of a presence state (the room code only when the player lets friends join) */
export function publicPresence(st) {
  if (!st) return { s: 'off' };
  const o = { s: st.s };
  if (st.s === 'lobby') { if (st.m) o.m = st.m; if (st.o && st.r) o.r = st.r; }
  return o;
}
export function samePresence(a, b) {
  return JSON.stringify(publicPresence(a)) === JSON.stringify(publicPresence(b));
}
