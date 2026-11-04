// Shared helpers for the browser tests: the game page from the local Worker (wrangler dev), with a test hook
// (window.__ev) inserted before the final `})();` of the game script, and optionally a different API meta.
const fs = require('fs'), path = require('path');
const API = process.env.SF_API || 'http://127.0.0.1:8787';
const SRC = path.join(__dirname, '..', '..', '..', 'index.html');
function hooked(apiMeta) {
  let s = fs.readFileSync(SRC, 'utf8');
  const i = s.lastIndexOf('})();');
  s = s.slice(0, i) + 'window.__ev=s=>eval(s);\n' + s.slice(i);
  if (apiMeta != null) s = s.replace(/<meta name="sf-api" content="[^"]*">/, `<meta name="sf-api" content="${apiMeta}">`);
  return s;
}
// serve the hooked page for "/" and "/index.html"; everything else (vendor/, assets/, /api) goes to the Worker
async function routeGame(target, apiMeta) {
  const html = hooked(apiMeta);
  await target.route(u => { const x = new URL(u); return x.origin === API && (x.pathname === '/' || x.pathname === '/index.html'); },
    r => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
}
async function openGame(ctx, opts = {}) {
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|ERR_CONNECTION_REFUSED|net::/.test(m.text())) errs.push('console ' + m.text()); });
  p.errs = errs;
  if (opts.init) await p.addInitScript(opts.init);
  await routeGame(p, opts.api);
  await p.goto(API + '/');
  await p.waitForFunction(() => window.__ev && document.querySelector('#menu'));
  await p.waitForTimeout(300);
  if (await p.isVisible('#howClose')) await p.click('#howClose');
  return p;
}
const ev = (p, s) => p.evaluate(x => window.__ev(x), s);
module.exports = { API, hooked, routeGame, openGame, ev };
