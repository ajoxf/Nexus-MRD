import { readFileSync } from 'node:fs';

/*
 * vercel.json is only validated when Vercel reads it, which is after a deploy has already
 * replaced the live site. A rewrite object with an unknown key is silently rejected, and the
 * first anybody knows is a 404 on a page that worked locally — which is how /admin shipped
 * broken. This runs in a second and says so before the push.
 */
let fail = 0;
const bad = (msg) => { fail++; console.log('FAIL', msg); };
const ok = (msg) => console.log('ok  ', msg);

const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
const rewrites = config.rewrites ?? [];

if (!rewrites.length) bad('no rewrites: every path but / would 404');
else ok('a rewrite is configured');

const ALLOWED = new Set(['source', 'destination', 'has', 'missing', 'statusCode']);
for (const rule of rewrites) {
  const strays = Object.keys(rule).filter((k) => !ALLOWED.has(k));
  if (strays.length) bad(`rewrite has keys Vercel will reject: ${strays.join(', ')} — JSON takes no comments`);
  else ok('rewrite carries only keys Vercel accepts');
}

// And that it actually routes what it is there to route.
const rule = rewrites[0];
if (rule) {
  const re = new RegExp('^' + rule.source.replace(/^\//, '\\/') + '$');
  for (const path of ['/admin', '/subscribe', '/']) {
    if (re.test(path)) ok(`${path} serves the app`);
    else bad(`${path} would 404`);
  }
  for (const path of ['/api/trial', '/api/admin/customers', '/api/admin/subscription']) {
    if (!re.test(path)) ok(`${path} stays an endpoint`);
    else bad(`${path} would be swallowed and return HTML instead of JSON`);
  }
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
