// Ranked and battalions: pure helpers shared by the Worker, the matchmaking Durable Object and the unit tests
// (rating math, tiers, seasons, result consensus, validation, moderation). No Cloudflare globals here.
import { B32, dayKey } from './lib.js';

/* ---------------- ranked ---------------- */

export const RANK_MODES = ['solo', 'duos'];
export const HUMANS = { solo: 8, duos: 4 };      // humans per ranked lobby (Duos: one per team, each with an AI partner)
export const R0 = 1000, RD0 = 300, RD_MIN = 60, RD_MAX = 350, RD_DAY = 15; // Glicko-lite: start, deviation bounds, growth/day idle
export const PLACEMENTS = 5;                     // matches before a tier shows (and peak counts)
export const SEASON_EPOCH = Date.UTC(2026, 0, 5); // a Monday
export const SEASON_DAYS = 56;                   // 8-week seasons
export const RANK_TURN = 30;                     // the fixed ranked turn timer (seconds)
export const GRACE = 60000;                      // after the first report, how long the others have to report
export const TOP_RANKED = 100;
export const TIERS = [
  { k: 'bronze', n: 'Bronze', lo: -1e9 }, { k: 'silver', n: 'Silver', lo: 1100 }, { k: 'gold', n: 'Gold', lo: 1300 },
  { k: 'plat', n: 'Platinum', lo: 1500 }, { k: 'diamond', n: 'Diamond', lo: 1700 }, { k: 'storm', n: 'Stormlord', lo: 1900 },
];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function seasonOf(t) { return Math.max(1, Math.floor((t - SEASON_EPOCH) / (SEASON_DAYS * 86400000)) + 1); }
export function seasonStart(s) { return SEASON_EPOCH + (s - 1) * SEASON_DAYS * 86400000; }
export function seasonEnd(s) { return seasonStart(s + 1); }

/** rating -> {i, k, n, div}: tier index/key/name and division 3 (III, lowest) .. 1 (I); Stormlord has none (div 0) */
export function tierOf(r) {
  let i = 0;
  for (let k = 0; k < TIERS.length; k++) if (r >= TIERS[k].lo) i = k;
  const T = TIERS[i];
  if (i === TIERS.length - 1) return { i, k: T.k, n: T.n, div: 0 };
  const lo = i === 0 ? 900 : T.lo, hi = TIERS[i + 1].lo, f = clamp((r - lo) / (hi - lo), 0, 0.9999);
  return { i, k: T.k, n: T.n, div: 3 - Math.floor(f * 3) };
}

/** deviation grows while a player is idle (Glicko step 1), capped at RD_MAX */
export function rdNow(rd, lastAt, now) {
  const days = Math.max(0, (now - (lastAt || now)) / 86400000);
  return clamp(Math.sqrt(rd * rd + RD_DAY * RD_DAY * days), RD_MIN, RD_MAX);
}

/** start of a new season from last season's row (soft reset: halfway back to R0, more uncertainty) */
export function softReset(prev) {
  if (!prev) return { r: R0, rd: RD0 };
  return { r: Math.round((R0 + (prev.r - R0) * 0.5) * 10) / 10, rd: clamp(Math.max(prev.rd, 200), RD_MIN, RD_MAX) };
}

/** AI difficulty for a lobby's average rating */
export function diffFor(avg) { return avg < 1100 ? 'recruit' : avg < 1500 ? 'veteran' : 'elite'; }

const Q = Math.LN10 / 400;
const g = rd => 1 / Math.sqrt(1 + 3 * Q * Q * rd * rd / (Math.PI * Math.PI));

/**
 * Glicko-lite for a free-for-all: every pair of humans is one game (better placement wins, equal = draw), each
 * weighted 1/sqrt(N-1) so an 8-human lobby moves ratings more than a duel but far less than 7 separate games.
 * players: [{id, r, rd, place}] (lower place = better). Returns [{id, r, rd, d}] (new rating/deviation, delta).
 */
export function rateMatch(players) {
  const N = players.length;
  if (N < 2) return players.map(p => ({ id: p.id, r: p.r, rd: p.rd, d: 0 }));
  const w = 1 / Math.sqrt(N - 1);
  return players.map(p => {
    let v = 0, s = 0;
    for (const o of players) {
      if (o === p) continue;
      const go = g(o.rd), E = 1 / (1 + Math.pow(10, -go * (p.r - o.r) / 400));
      const S = p.place < o.place ? 1 : p.place === o.place ? 0.5 : 0;
      v += w * Q * Q * go * go * E * (1 - E);
      s += w * go * (S - E);
    }
    const den = 1 / (p.rd * p.rd) + v;
    const d = clamp(Q / den * s, -200, 200);
    return { id: p.id, r: Math.round((p.r + d) * 10) / 10, rd: Math.round(clamp(Math.sqrt(1 / den), RD_MIN, RD_MAX) * 10) / 10, d: Math.round(d * 10) / 10 };
  });
}

const RE_SID = new RegExp('^[' + B32 + ']{6}$');
export const validSid = s => typeof s === 'string' && RE_SID.test(s);
export const validMid = s => typeof s === 'string' && new RegExp('^[' + B32 + ']{10}$').test(s);

/** A client's match report -> {h, pl, left, bad} (canonical) or null. parts: the registered seat ids. */
export function cleanReport(b, parts) {
  if (!b || typeof b !== 'object' || !Array.isArray(parts)) return null;
  const bad = b.bad ? 1 : 0;
  if (bad) return { h: 0, pl: {}, left: [], bad: 1 };
  if (!Number.isInteger(b.h) || b.h < 0 || b.h > 0xffffffff) return null;
  if (!b.pl || typeof b.pl !== 'object') return null;
  const pl = {};
  for (const s of parts) { const v = b.pl[s]; if (!Number.isInteger(v) || v < 1 || v > 16) return null; pl[s] = v; }
  if (Object.keys(b.pl).length !== parts.length) return null;
  const left = Array.isArray(b.left) ? [...new Set(b.left)].filter(s => parts.includes(s)).sort() : [];
  if (Array.isArray(b.left) && left.length !== new Set(b.left).size) return null;
  return { h: b.h, pl, left, bad: 0 };
}
const repKey = (r, parts) => r.bad ? 'bad' : JSON.stringify([r.h, parts.map(s => r.pl[s]), r.left]);

/**
 * Do the reports agree? parts: registered seat ids; reps: {sid: report}; grace: the grace period is over.
 * - an agreeing group holding a strict majority of all registered humans decides at once;
 * - after the grace period, a strict majority of the humans who did report decides (the others left or went quiet);
 * - anything else waits (before the grace period) or voids the match.
 * Returns {st:'wait'} | {st:'void', why} | {st:'ok', pl:{sid:place}, left:[sid], n}
 */
export function consensus(parts, reps, grace) {
  const got = parts.filter(s => reps[s]);
  const groups = new Map();
  for (const s of got) { const k = repKey(reps[s], parts); groups.set(k, (groups.get(k) || []).concat(s)); }
  let best = null;
  for (const [k, L] of groups) if (k !== 'bad' && (!best || L.length > best.L.length)) best = { k, L };
  const ok = () => { const r = reps[best.L[0]]; return { st: 'ok', pl: r.pl, left: r.left, n: best.L.length }; };
  if (best && best.L.length * 2 > parts.length) return ok();
  if (got.length === parts.length || grace) {
    if (best && best.L.length * 2 > got.length) return ok();
    return { st: 'void', why: groups.has('bad') ? 'ruleset' : got.length ? 'disagree' : 'noreports' };
  }
  return { st: 'wait' };
}

/** placement among humans for the rating: leavers are last (tied), everyone else by their reported place */
export function humanPlaces(parts, res) {
  const out = {};
  for (const s of parts) out[s] = res.left.includes(s) ? 99 : res.pl[s];
  return out;
}

/** battalion points for one member's ranked result */
export function batPoints(place, teams, left) {
  if (left) return 0;
  return place === 1 ? 10 : place <= Math.ceil(teams / 2) ? 6 : 3;
}

/** week key: the Monday (UTC) that starts the week */
export function weekKey(t) {
  const d = new Date(t), back = (d.getUTCDay() + 6) % 7;
  return dayKey(t - back * 86400000);
}

/* ---------------- battalions ---------------- */

export const BAT_CAP = 30;
export const BAT_ID_LEN = 8;
export const EMBLEMS = ['bolt', 'crown', 'star', 'shield', 'skull', 'wolf', 'eye', 'flame', 'wing', 'cross', 'anchor', 'storm'];
export const CHAT_MAX = 160, CHAT_KEEP = 50, CHAT_DAYS = 7, DESC_MAX = 120;
export const INVITE_DAYS = 7;
export const ROLES = { l: 'leader', o: 'officer', m: 'member' };

// A small profanity list (substrings after leetspeak folding), checked word by word with a few known innocent words
// allowed (the Scunthorpe problem). Names and tags that contain one are refused; chat and descriptions mask them.
const BAD = ['fuck', 'fuk', 'fck', 'shit', 'cunt', 'nigg', 'faggot', 'fag', 'bitch', 'whore', 'slut', 'rape', 'nazi',
  'hitler', 'kike', 'spic', 'chink', 'retard', 'cock', 'dick', 'pussy', 'porn', 'twat', 'wank', 'kkk', 'jizz', 'penis', 'vagina', 'asshole', 'tits'];
const ALLOW = new Set(['scunthorpe', 'grape', 'grapes', 'drape', 'drapes', 'scrape', 'scraper', 'therapist', 'cockpit', 'cocktail',
  'peacock', 'hancock', 'woodcock', 'dickens', 'spice', 'spicy', 'despicable', 'conspicuous', 'shitake', 'titsa', 'fagin']);
const fold = s => String(s).toLowerCase().replace(/[0@4]/g, m => (m === '0' ? 'o' : 'a')).replace(/[1!|]/g, 'i').replace(/3/g, 'e')
  .replace(/[5$]/g, 's').replace(/7/g, 't').replace(/[^a-z]/g, '');
const badWord = w => { const f = fold(w); return !!f && !ALLOW.has(f) && BAD.some(x => f.includes(x)); };
export function isProfane(s) {
  const words = String(s).split(/[^A-Za-z0-9@$!|]+/).filter(Boolean);
  if (words.some(badWord)) return true;
  return words.length > 2 && words.every(w => w.length === 1) && badWord(words.join('')); // "F U C K"
}
/** masks words that contain a bad substring (keeps the first letter and any punctuation) */
export function maskProfanity(s) {
  return String(s).replace(/[A-Za-z0-9@$!|]+/g, w => (badWord(w) ? w[0] + '*'.repeat(Math.max(2, w.length - 1)) : w));
}

const ctl = s => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, ' ');
/** battalion name: 3-20 chars of letters, digits, space ' - _ . ; null when invalid or profane */
export function cleanBatName(n) {
  const s = ctl(n).replace(/\s+/g, ' ').trim();
  if (s.length < 3 || s.length > 20 || !/^[A-Za-z0-9 '._-]+$/.test(s) || !/[A-Za-z0-9]/.test(s) || isProfane(s)) return null;
  return s;
}
/** tag: 3-4 letters/digits, upper case; null when invalid or profane */
export function cleanTag(t) {
  const s = String(t == null ? '' : t).toUpperCase().trim();
  if (!/^[A-Z0-9]{3,4}$/.test(s) || isProfane(s)) return null;
  return s;
}
export function cleanDesc(d) { return maskProfanity(ctl(d).replace(/\s+/g, ' ').trim().slice(0, DESC_MAX)); }
export function cleanEmblem(e) { return EMBLEMS.includes(e) ? e : null; }
export function cleanBanner(b) { return typeof b === 'string' && /^bn_[a-z0-9_]{1,21}$/.test(b) ? b : 'bn_std'; }
/** a chat line: one line, at most CHAT_MAX chars, profanity masked; '' = nothing to send */
export function cleanChat(m) { return maskProfanity(ctl(m).replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX)); }
export const REPORT_KINDS = ['player', 'bat', 'chat'];
export function cleanReportWhy(w) { return ctl(w).replace(/\s+/g, ' ').trim().slice(0, 200); }
