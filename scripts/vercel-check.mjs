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

/*
 * Top-level keys, guarded for the same reason as the rewrite keys below: Vercel rejects a
 * key it does not know, and it does so after the deploy has replaced the live site.
 */
const ALLOWED_TOP = new Set(['$schema', 'regions', 'functionFailoverRegions', 'rewrites', 'redirects', 'headers', 'crons', 'functions', 'cleanUrls', 'trailingSlash']);
const strayTop = Object.keys(config).filter((k) => !ALLOWED_TOP.has(k));
if (strayTop.length) bad(`vercel.json has keys Vercel will reject: ${strayTop.join(', ')}`);
else ok('vercel.json carries only keys Vercel accepts');

/*
 * Where the functions RUN, which is a privacy question rather than a performance one.
 *
 * Every endpoint in api/ holds the service role key and reads customers' trade data. The
 * database is in London; without this key the functions default to Vercel's US region, so
 * the storage would be in the UK while the processing happened in Virginia. That is the
 * difference between "your data stays in the UK" being true and being nearly true, and it
 * is the question a desk's compliance team actually asks.
 *
 * Kept in the same file that silently 404'd /admin once, so it is checked here before a
 * deploy rather than discovered afterwards.
 */
const UK_AND_EU = new Set(['lhr1', 'dub1', 'cdg1', 'fra1', 'arn1', 'zrh1']);
const regions = config.regions ?? [];
if (!regions.length) bad('no regions set: functions would run in Vercel\'s default US region while the database is in London');
else if (regions.some((r) => !UK_AND_EU.has(r))) bad(`functions would run outside the UK/EU: ${regions.join(', ')}`);
else ok(`functions run in ${regions.join(', ')}, beside the database`);

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
