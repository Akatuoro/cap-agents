/**
 * test-auth-mtls.mjs
 *
 * Verifies IAS App2App principal propagation for bookshop-agent using mTLS.
 *
 * Step 0: password grant on bookshop-agent-sender-ias -> sender JWT  (cached to .sender-jwt-mtls)
 * Step 1: sender JWT -> proxy JWT  (joule-to-proxy dependency, sender IAS credentials)
 * Step 2: proxy JWT -> target JWT  (proxy-to-bookshop-agent dependency, proxy X.509 cert — mTLS)
 * Step 3: GET bookshop-agent-srv .cert. route with target JWT (mTLS)
 *
 * Token URL for Steps 1+2 is derived from ias_iss/iss inside the JWT itself,
 * mirroring IasRestTemplateDelegate.retrieveIasAclTokenFromIasToken().
 *
 * Bindings required in .cdsrc-private.json:
 *   cds bind bookshop-agent-sender-ias -2 bookshop-agent-sender-ias
 *   cds bind bookshop-agent-proxy-ias  -2 bookshop-agent-proxy-ias
 *   (proxy key must be X509_GENERATED — the MTA deploy default)
 *
 * First run (or after token expiry):
 *   IAS_USER=you@example.com IAS_PASSWORD=secret npm run test:auth:mtls
 *
 * Subsequent runs (token still valid):
 *   npm run test:auth:mtls
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { URL, fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SENDER_JWT_CACHE = path.join(__dirname, '..', '.sender-jwt-mtls');

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
// HTTP helpers — plain and mTLS
// ---------------------------------------------------------------------------

function request({ method, url, headers, body, cert, key }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
      ...(cert && key ? { cert, key } : {}),
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

// Plain POST — used for Step 0 password grant (proxy IAS may require SECRET for password grant)
async function post(url, params, headers) {
  return request({ method: 'POST', url, headers, body: new URLSearchParams(params).toString() });
}

// mTLS POST — used for Step 1 jwt-bearer exchange (client cert authenticates, no client_secret)
async function postMtls(url, params, headers, cert, key) {
  return request({ method: 'POST', url, headers, body: new URLSearchParams(params).toString(), cert, key });
}

// mTLS GET — used for Step 2 call to the .cert. route
async function getMtls(url, headers, cert, key) {
  return request({ method: 'GET', url, headers, cert, key });
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
  console.error('TARGET_APP_URL is required — must be the .cert. route of bookshop-agent-srv\n' +
    '(set automatically by npm run test:auth:mtls)');
  process.exit(1);
}

const v = vcap();
const sender = findIas(v, /sender/i,                    'bookshop-agent-sender-ias');
const proxy  = findIas(v, /proxy-ias-x509/,             'bookshop-agent-proxy-ias-x509');

if (!proxy.certificate || !proxy.key) {
  console.error(
    'bookshop-agent-proxy-ias binding has no certificate/key.\n' +
    'Ensure the service key uses credential-type X509_GENERATED (the MTA deploy default).'
  );
  process.exit(1);
}

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
      '  IAS_USER=you@example.com IAS_PASSWORD=secret npm run test:auth:mtls\n'
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
  console.log('  Fresh sender JWT obtained and cached to .sender-jwt-mtls.');
}

summarise('sender JWT', senderJwt);
console.log();

// -- Step 1: sender JWT -> proxy JWT (joule-to-proxy) -----------------------
// Same as non-mTLS: sender IAS credentials, token URL from ias_iss/iss in the sender JWT.
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

// -- Step 2: proxy JWT -> target JWT (proxy-to-bookshop-agent, mTLS) --------
// client_secret omitted — proxy X.509 cert authenticates on the TLS handshake.
// Token URL from ias_iss/iss inside the proxy JWT (mirrors IasRestTemplateDelegate).
console.log('=== Step 2: proxy JWT -> target JWT (proxy-to-bookshop-agent, mTLS) ===');

const targetJwt = accessToken(await postMtls(issuerTokenUrl(proxyJwt), {
  grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
  client_id:  proxy.clientid,
  assertion:  proxyJwt,
  resource:   'urn:sap:identity:application:provider:name:proxy-to-bookshop-agent',
  app_tid:    appTid,
}, { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
  proxy.certificate, proxy.key));

summarise('target JWT', targetJwt);
console.log();

// -- Step 3: call bookshop-agent-srv .cert. route (mTLS) --------------------
console.log('=== Step 3: call bookshop-agent-srv (mTLS) ===');
console.log(`  GET ${targetAppUrl}`);
const response = await getMtls(targetAppUrl, { Authorization: `Bearer ${targetJwt}` }, proxy.certificate, proxy.key);
try {
  console.log('  Response:', JSON.stringify(JSON.parse(response), null, 2));
} catch {
  console.log('  Response:', response);
}
