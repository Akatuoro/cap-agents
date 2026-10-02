/**
 * create-destination-mtls.mjs
 *
 * Creates (or updates) the JOULE_APP_2_APP_MTLS subaccount destination using mTLS:
 *   - URL targets the bookshop-agent-srv .cert. route
 *   - clientCertificate + clientKey (PEM) from the X509_GENERATED proxy IAS binding
 *     authenticate the token exchange with IAS — no clientSecret needed
 *   - VCAP_SERVICES.identity    → bookshop-agent-proxy-ias (X509_GENERATED, default MTA key)
 *   - VCAP_SERVICES.destination → bookshop-agent-dest
 *
 * After deploy, bind the services:
 *   cds bind bookshop-agent-proxy-ias -2 bookshop-agent-proxy-ias
 *   cds bind bookshop-agent-dest      -2 bookshop-agent-dest
 *
 * Usage:
 *   npm run create-destination:mtls
 *
 * Dry-run (prints payload, skips API call):
 *   DRY_RUN=true npm run create-destination:mtls
 *
 * IAS dependencies that must be set manually in the IAS admin UI
 * (consumed-apis in mta.yaml does NOT wire them automatically):
 *
 *   App: das-ias
 *     → Dependencies → Add:
 *       Name: joule-to-proxy,  Target: bookshop-agent-proxy,  API group: bookshop-agent-proxy
 *
 *   App: bookshop-agent-proxy
 *     → Dependencies → Add:
 *       Name: proxy-to-bookshop-agent,  Target: bookshop-agent
 */

import https from 'https';
import http from 'http';
import { URL } from 'url';

// ---------------------------------------------------------------------------
// VCAP_SERVICES
// ---------------------------------------------------------------------------

function vcap() {
  return JSON.parse(process.env.VCAP_SERVICES ?? '{}');
}

function requireIas(v, nameHint) {
  const bindings = v.identity ?? [];
  const hit = bindings.find((b) => b.name.toLowerCase().includes(nameHint)) ?? bindings[0];
  if (!hit) throw new Error(
    `No identity binding matching "${nameHint}" found in VCAP_SERVICES.\n` +
    `Run: cds bind bookshop-agent-proxy-ias-x509 -2 bookshop-agent-proxy-ias --key bookshop-agent-proxy-ias-x509-key`
  );
  const creds = hit.credentials;
  if (!creds.certificate || !creds.key) throw new Error(
    `Identity binding "${hit.name}" has no certificate/key.\n` +
    `Ensure the binding uses the X509 key (bookshop-agent-proxy-ias-x509-key), not the SECRET key.`
  );
  return creds;
}

function requireDest(v) {
  const bindings = v.destination ?? [];
  if (!bindings[0]) throw new Error(
    `No destination binding found in VCAP_SERVICES.\n` +
    `Run: cds bind bookshop-agent-dest -2 bookshop-agent-dest`
  );
  return bindings[0].credentials;
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
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function clientCredentialsToken(tokenUrl, clientId, clientSecret) {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }).toString();
  const res = await request({
    method: 'POST', url: tokenUrl,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  if (res.status >= 400) throw new Error(`Token request failed [${res.status}]: ${res.body}`);
  return JSON.parse(res.body).access_token;
}

// ---------------------------------------------------------------------------
// Destination Service management API
// ---------------------------------------------------------------------------

async function upsertSubaccountDestination(destServiceUri, accessToken, destination) {
  const url = `${destServiceUri.replace(/\/$/, '')}/destination-configuration/v1/subaccountDestinations`;
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  const body = JSON.stringify(destination);

  const putRes = await request({ method: 'PUT', url, headers, body });
  if (putRes.status === 404 || putRes.status === 405) {
    const postRes = await request({ method: 'POST', url, headers, body });
    if (postRes.status >= 400) throw new Error(`POST destination failed [${postRes.status}]: ${postRes.body}`);
    console.log(`Created destination (POST ${postRes.status})`);
    return;
  }
  if (putRes.status >= 400) throw new Error(`PUT destination failed [${putRes.status}]: ${putRes.body}`);
  console.log(`Updated destination (PUT ${putRes.status})`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const dryRun = process.env.DRY_RUN === 'true';
const targetApiUrl = process.env.TARGET_API_URL;

if (!targetApiUrl) {
  console.error(
    'TARGET_API_URL is required — must be the .cert. route of bookshop-agent-srv.\n' +
    'Get it with: cf app bookshop-agent-srv  (use the *.cert.* route)\n' +
    'Or just run: npm run create-destination:mtls  (auto-resolves the cert URL)'
  );
  process.exit(1);
}

const v = vcap();
const proxy = requireIas(v, 'proxy-ias-x509');
const dest  = requireDest(v);

const iasTenantUrl = proxy.url.replace(/\/$/, '');

const destination = {
  Name:           'JOULE_APP_2_APP_MTLS',
  Type:           'HTTP',
  // .cert. route — the Destination Service connects over mTLS
  URL:            targetApiUrl,
  ProxyType:      'Internet',
  Authentication: 'OAuth2JWTBearer',
  // IAS token endpoint for the jwt-bearer exchange (proxy → bookshop-agent)
  tokenServiceURL: `${iasTenantUrl}/oauth2/token`,
  // mTLS client identity — PEM cert+key from the X509_GENERATED proxy IAS binding
  clientId:          proxy.clientid,
  clientCertificate: proxy.certificate,
  clientKey:         proxy.key,
  'tokenService.addClientCredentialsInBody': 'false',
  'tokenService.body.client_id': proxy.clientid,
  // Dependency name on bookshop-agent-proxy pointing to bookshop-agent (set manually in IAS admin)
  'tokenService.body.resource':    'urn:sap:identity:application:provider:name:proxy-to-bookshop-agent',
  'tokenService.body.token_format': 'jwt',
  'x_user_token.jwks_uri': `${iasTenantUrl}/oauth2/certs`,
  // Tells Joule's BusinessConnector to do step 1 (joule-to-proxy) before invoking this destination
  'apptoapp': 'true',
};

console.log('Destination payload:');
console.log(JSON.stringify({
  ...destination,
  clientCertificate: '<redacted>',
  clientKey: '<redacted>',
}, null, 2));
console.log();

if (dryRun) {
  console.log('[DRY RUN] Skipping API call.');
  process.exit(0);
}

console.log('Fetching destination service management token...');
const accessToken = await clientCredentialsToken(`${dest.url}/oauth/token`, dest.clientid, dest.clientsecret);

console.log(`Upserting destination to ${dest.uri} ...`);
await upsertSubaccountDestination(dest.uri, accessToken, destination);
console.log('Done. Verify at: BTP cockpit → Connectivity → Destinations → JOULE_APP_2_APP_MTLS');
