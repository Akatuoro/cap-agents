/**
 * get-srv-url.mjs
 *
 * Prints the bookshop-agent-srv URL with an optional path appended.
 * Used by npm scripts to resolve the CF app route without hardcoding it.
 *
 * Usage:
 *   node scripts/get-srv-url.mjs [path]          # plain route
 *   node scripts/get-srv-url.mjs --cert [path]   # .cert. (mTLS) route
 *
 * Examples:
 *   node scripts/get-srv-url.mjs                         # https://host
 *   node scripts/get-srv-url.mjs /odata/v4/catalog       # https://host/odata/v4/catalog
 *   node scripts/get-srv-url.mjs --cert /a2a/catalog     # https://host.cert.domain/a2a/catalog
 */

import { execFileSync } from 'child_process';

const args = process.argv.slice(2);
const certFlag = args[0] === '--cert';
const suffix = certFlag ? (args[1] ?? '') : (args[0] ?? '');

const output = execFileSync('cf', ['app', 'bookshop-agent-srv'], { encoding: 'utf-8' });

// Routes line looks like: "routes:   host.domain, host.cert.domain"
const routesMatch = output.match(/^routes:\s+(.+)$/m);
if (!routesMatch) {
  console.error('Could not parse routes from cf app bookshop-agent-srv output:\n' + output);
  process.exit(1);
}

const routes = routesMatch[1].split(/,\s*/);
let route;
if (certFlag) {
  route = routes.find((r) => r.includes('.cert.'));
  if (!route) {
    console.error('No .cert. route found. Ensure mta.yaml includes the cert route for bookshop-agent-srv.');
    process.exit(1);
  }
} else {
  route = routes.find((r) => !r.includes('.cert.')) ?? routes[0];
}

process.stdout.write(`https://${route.trim()}${suffix}`);

