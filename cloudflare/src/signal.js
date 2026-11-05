// PeerJS-compatible signaling server as one Durable Object (SQLite-backed class, WebSocket Hibernation API).
//
// Wire protocol (same as peerjs-server, so the stock PeerJS 1.5 client works unchanged):
//   client -> server: HEARTBEAT, OFFER, ANSWER, CANDIDATE, LEAVE, EXPIRE   ({type, dst, payload})
//   server -> client: OPEN, ID-TAKEN, ERROR, EXPIRE, and relayed OFFER/ANSWER/CANDIDATE/LEAVE ({type, src, dst, payload})
//
// Every peer of the game connects to the same instance ("global"), so relaying is a lookup by WebSocket tag (the peer
// id). Room codes are peer ids ('stormfall-abcde'): a second socket asking for a taken id gets ID-TAKEN, which keeps
// room codes unique. Heartbeats are answered by the runtime's auto-response without waking the object, so an idle
// room costs no Durable Object duration and no requests; the object only wakes for real signaling messages.
//
// The same object also serves friends presence and invites (/api/social/ws, see presence.js) and the ranked matchmaking
// queue (/api/ranked/ws, see queue.js): sockets tagged 'S' are social, 'Q' ranked queue, everything else is PeerJS. Keeping both in one global instance bounds the total Durable Object duration to
// one object's day (~11,000 GB-s at 128 MB), inside the free allowance, and lets both share the heartbeat auto-response.

import { DurableObject } from 'cloudflare:workers';
import { validPeerId } from './lib.js';
import { Presence, S_TAG } from './presence.js';
import { Queue, Q_TAG } from './queue.js';

const HB = '{"type":"HEARTBEAT"}';
const MAX_PEERS = 3000;         // sockets per instance (guards memory and the free daily budget)
const MAX_MSG = 16384;          // bytes per signaling message (SDP offers are ~2-6 KB)
const MSG_WINDOW = 10000, MSG_LIMIT = 300; // messages per socket per 10 s (ICE trickle bursts are ~20-60)
const RELAY = new Set(['OFFER', 'ANSWER', 'CANDIDATE', 'LEAVE', 'EXPIRE']);

export class Signal extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.rate = new WeakMap(); // ws -> {t, n}; in memory only (resets on hibernation, which is fine)
    // answered by the runtime itself: does not wake the object, is not billed as duration
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HB, HB));
    this.social = new Presence(ctx, env);
    this.queue = new Queue(ctx, env);
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    if (new URL(request.url).pathname === '/api/social/ws') return this.social.accept(request);
    if (new URL(request.url).pathname === '/api/ranked/ws') return this.queue.accept(request);
    const u = new URL(request.url), key = u.searchParams.get('key'), id = u.searchParams.get('id'), token = u.searchParams.get('token');
    const [client, server] = Object.values(new WebSocketPair());
    const refuse = (type, msg) => {
      server.accept(); // a plain (non-hibernating) accept: we send one message and close
      server.send(JSON.stringify(msg ? { type, payload: { msg } } : { type }));
      server.close(1000, type);
      return new Response(null, { status: 101, webSocket: client });
    };
    if (!id || !token || !key) return refuse('ERROR', 'No id, token, or key supplied to websocket server');
    if (key !== (this.env.PEER_KEY || 'peerjs')) return refuse('INVALID-KEY', 'Invalid key provided');
    if (!validPeerId(id) || token.length > 64) return refuse('ERROR', 'Invalid id or token');

    const same = this.open(id);
    if (same.length) {
      const att = same[0].deserializeAttachment() || {};
      if (att.token !== token) return refuse('ID-TAKEN', 'ID is taken');
      for (const ws of same) { try { ws.close(1000, 'Replaced'); } catch (_) {} } // the same peer reconnecting
    } else if (this.ctx.getWebSockets().length - this.ctx.getWebSockets(S_TAG).length - this.ctx.getWebSockets(Q_TAG).length >= MAX_PEERS) {
      return refuse('ERROR', 'Server is busy. Try again in a minute.');
    }

    this.ctx.acceptWebSocket(server, [id]);
    server.serializeAttachment({ id, token });
    server.send('{"type":"OPEN"}');
    return new Response(null, { status: 101, webSocket: client });
  }

  open(id) {
    return this.ctx.getWebSockets(id).filter(ws => ws.readyState === 1);
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return;
    const sa = ws.deserializeAttachment();
    if (sa && sa.k === 's') return this.social.message(ws, raw, sa);
    if (sa && sa.k === 'q') return this.queue.message(ws, raw, sa);
    const now = Date.now();
    let r = this.rate.get(ws);
    if (!r || now - r.t > MSG_WINDOW) { r = { t: now, n: 0 }; this.rate.set(ws, r); }
    if (++r.n > MSG_LIMIT) { try { ws.close(4008, 'Too many messages'); } catch (_) {} return; }

    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }
    if (!m || typeof m !== 'object' || !RELAY.has(m.type)) return; // HEARTBEAT (if it ever reaches us) and junk: ignore
    const att = ws.deserializeAttachment();
    if (!att) return;
    const dst = typeof m.dst === 'string' ? m.dst : '';
    if (!validPeerId(dst)) return;
    const to = this.open(dst)[0];
    if (to) {
      try { to.send(JSON.stringify({ type: m.type, src: att.id, dst, payload: m.payload })); } catch (_) {}
    } else if (m.type !== 'LEAVE' && m.type !== 'EXPIRE') {
      // like peerjs-server when a queued message times out: tell the sender the peer is not there
      // (the client turns this into a 'peer-unavailable' error, which the game shows as "No room called ...")
      try { ws.send(JSON.stringify({ type: 'EXPIRE', src: dst, dst: att.id })); } catch (_) {}
    }
  }

  async webSocketClose(ws) {
    const a = ws.deserializeAttachment();
    if (a && a.k === 's') return this.social.closed(ws);
    if (a && a.k === 'q') return this.queue.closed(ws);
    try { ws.close(1000, 'Bye'); } catch (_) {}
  }

  async webSocketError(ws) {
    const a = ws.deserializeAttachment();
    if (a && a.k === 's') { this.social.drop(ws, a, 4011, 'Error'); return; }
    if (a && a.k === 'q') return this.queue.closed(ws);
    try { ws.close(4011, 'Error'); } catch (_) {}
  }

  // one alarm for both: the ranked queue tick (every 3 s while anyone waits) and the social sweep (stale presence sockets)
  async alarm() { await this.queue.tick(); await this.social.sweep(); }

  // RPC from the Worker after a friends change (see presence.js link())
  async link(a, b, kind) { return this.social.link(a, b, kind); }

  // RPC from the Worker after a battalion change: c's battalion is now `bat` ('' = none); mates/target get {t:'bx'}
  async batSet(c, bat, notify) { return this.social.batSet(c, bat, notify); }
  // RPC from the Worker after a battalion chat line: pushed to the battalion's connected members
  async batMsg(bat, msg) { return this.social.batMsg(bat, msg); }
}
