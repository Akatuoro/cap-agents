/**
 * test-auth.mjs
 *
 * Verifies IAS App2App principal propagation for bookshop-agent.
 *
 * Step 0: password grant on bookshop-agent-sender-ias -> sender JWT  (cached to .sender-jwt)
 * Step 1: sender JWT -> proxy JWT  (joule-to-proxy dependency, sender IAS credentials)
 * Step 2: proxy JWT -> target JWT  (proxy-to-bookshop-agent dependency, proxy IAS credentials)
 * Step 3: GET bookshop-agent-srv/a2a/catalog with target JWT
 *
 * Token URL for Steps 1+2 is derived from ias_iss/iss inside the JWT itself,
 * mirroring IasRestTemplateDelegate.retrieveIasAclTokenFromIasToken().
 *
 * Bindings required in .cdsrc-private.json:
 *   cds bind bookshop-agent-sender-ias -2 bookshop-agent-sender-ias
 *   cds bind bookshop-agent-proxy-ias  -2 bookshop-agent-proxy-ias
 *
 * First run (or after token expiry):
 *   IAS_USER=you@example.com IAS_PASSWORD=secret npm run test:auth
 *
 * Subsequent runs (token still valid):
 *   npm run test:auth
 *
 * References:
 *   - IAS App2App flow: descr.md (joule-to-proxy/tmp/descr.md)
 *   - joule-to-proxy/src/test.ts  (this file mirrors that flow exactly)
 *   - DestinationLookupService.ts TOKEN_EXCHANGE_PROXY_APP_NAME = 'joule-to-proxy'
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL, fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SENDER_JWT_CACHE = path.join(__dirname, '..', '.sender-jwt');

// ---------------------------------------------------------------------------
// JWT helpers
// ---------------------------------------------------------------------------

function decodeJwtClaims(jwt) {
  const parts = jwt.split('.');
  if (parts.length < 2) throw new Error('Not a valid JWT');
  const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString('utf-8'));
}

function isExpired(jwt) {
  try {
    const exp = decodeJwtClaims(jwt)['exp'];
    if (typeof exp !== 'number') return true;
    return Date.now() / 1000 > exp - 60;
  } catch { return true; }
}

function summarise(label, jwt) {
  try {
    const c = decodeJwtClaims(jwt);
    const aud = c['aud'];
    console.log(`  ${label}:`);
    console.log(`    sub     = ${c['sub'] ?? '-'}`);
    console.log(`    aud     = ${Array.isArray(aud) ? aud.join(', ') : (aud ?? '-')}`);
    console.log(`    app_tid = ${c['app_tid'] ?? '-'}`);
    console.log(`    exp     = ${c['exp'] ? new Date(c['exp'] * 1000).toISOString() : '-'}`);
  } catch {
    console.log(`  ${label}: (could not decode)`);
  }
}

// Derive the IAS token endpoint from inside the JWT itself.
// Mirrors IasRestTemplateDelegate: `${ias_iss || iss}/oauth2/token`
function issuerTokenUrl(jwt) {
  const c = decodeJwtClaims(jwt);
  const issuer = (c['ias_iss'] ?? c['iss'] ?? '').replace(/\/$/, '');
  if (!issuer) throw new Error('JWT has no ias_iss or iss claim');
  return `${issuer}/oauth2/token`;
}

// ---------------------------------------------------------------------------
// Token cache
// ---------------------------------------------------------------------------

function loadCachedSenderJwt() {
  try {
    const jwt = fs.readFileSync(SENDER_JWT_CACHE, 'utf-8').trim();
    if (!isExpired(jwt)) return jwt;
    console.log('  Cached sender JWT has expired, need fresh password grant.');
    return null;
  } catch { return null; }
}

function cacheSenderJwt(jwt) {
  fs.writeFileSync(SENDER_JWT_CACHE, jwt, { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function request({ method, url, headers, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
    };
    if (body) opts.headers['Content-Length'] = String(Buffer.byteLength(body));
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode >= 400) reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
        else resolve(raw);
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function accessToken(raw) {
  const parsed = JSON.parse(raw);
  if (!parsed.access_token) throw new Error(`No access_token in response: ${raw}`);
  return parsed.access_token;
}

async function post(url, params, headers) {
  return request({ method: 'POST', url, headers, body: new URLSearchParams(params).toString() });
}

async function get(url, headers) {
  return request({ method: 'GET', url, headers });
}

// ---------------------------------------------------------------------------
// VCAP_SERVICES
// ---------------------------------------------------------------------------

function vcap() {
  return JSON.parse(process.env.VCAP_SERVICES ?? '{}');
}

function findIas(v, pattern, label) {
  const hit = (v.identity ?? []).find((b) => pattern.test(b.name));
  if (!hit) throw new Error(
    `No identity binding matching ${pattern} in VCAP_SERVICES -- run: cds bind ${label} -2 ${label}`
  );
  return hit.credentials;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const targetAppUrl = process.env.TARGET_APP_URL;
if (!targetAppUrl) {
  console.error('TARGET_APP_URL is required (set automatically by npm run test:auth)');
  process.exit(1);
}

const v = vcap();
const sender = findIas(v, /sender/i,                 'bookshop-agent-sender-ias');
const proxy  = findIas(v, /^bookshop-agent-proxy-ias$/, 'bookshop-agent-proxy-ias');

const senderTokenUrl = `${sender.url.replace(/\/$/, '')}/oauth2/token`;

// -- Step 0: sender JWT (password grant on sender IAS app, cached) ----------
console.log('=== Step 0: sender JWT (password grant) ===');
let senderJwt = loadCachedSenderJwt();

if (senderJwt) {
  console.log('  Using cached sender JWT.');
} else {
  const iasUser     = process.env.IAS_USER;
  const iasPassword = process.env.IAS_PASSWORD;

  if (!iasUser || !iasPassword) {
    console.error(
      '\nNo valid cached sender JWT found.\n' +
      'Provide credentials to fetch a fresh one:\n\n' +
      '  IAS_USER=you@example.com IAS_PASSWORD=secret npm run test:auth\n'
    );
    process.exit(1);
  }

  senderJwt = accessToken(await post(senderTokenUrl, {
    grant_type:    'password',
    client_id:     sender.clientid,
    client_secret: sender.clientsecret,
    username:      iasUser,
    password:      iasPassword,
    token_format:  'jwt',
    // IAS jwt-bearer requires aud = token endpoint URL, not the client's own clientid.
    // Setting audience here makes IAS issue the JWT with aud = senderTokenUrl.
    audience:      senderTokenUrl,
  }, { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }));

  cacheSenderJwt(senderJwt);
  console.log('  Fresh sender JWT obtained and cached to .sender-jwt.');
}

summarise('sender JWT', senderJwt);
console.log();

// -- Step 1: sender JWT -> proxy JWT (joule-to-proxy) -----------------------
// Token URL from ias_iss/iss inside the sender JWT (mirrors IasRestTemplateDelegate).
console.log('=== Step 1: sender JWT -> proxy JWT (joule-to-proxy) ===');
const senderClaims = decodeJwtClaims(senderJwt);
const appTid = senderClaims['app_tid'] ?? '';

const proxyJwt = accessToken(await post(issuerTokenUrl(senderJwt), {
  grant_type:    'urn:ietf:params:oauth:grant-type:jwt-bearer',
  client_id:     sender.clientid,
  client_secret: sender.clientsecret,
  assertion:     senderJwt,
  resource:      'urn:sap:identity:application:provider:name:joule-to-proxy',
  app_tid:       appTid,
}, { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }));

summarise('proxy JWT', proxyJwt);
console.log();

// -- Step 2: proxy JWT -> target JWT (proxy-to-bookshop-agent) --------------
// Token URL from ias_iss/iss inside the proxy JWT, proxy IAS credentials.
console.log('=== Step 2: proxy JWT -> target JWT (proxy-to-bookshop-agent) ===');

const targetJwt = accessToken(await post(issuerTokenUrl(proxyJwt), {
  grant_type:    'urn:ietf:params:oauth:grant-type:jwt-bearer',
  client_id:     proxy.clientid,
  client_secret: proxy.clientsecret,
  assertion:     proxyJwt,
  resource:      'urn:sap:identity:application:provider:name:proxy-to-bookshop-agent',
  app_tid:       appTid,
}, { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }));

summarise('target JWT', targetJwt);
console.log();

// -- Step 3: call bookshop-agent-srv ----------------------------------------
console.log('=== Step 3: call bookshop-agent-srv ===');
console.log(`  GET ${targetAppUrl}`);
const response = await get(targetAppUrl, { Authorization: `Bearer ${targetJwt}` });
try {
  console.log('  Response:', JSON.stringify(JSON.parse(response), null, 2));
} catch {
  console.log('  Response:', response);
}
