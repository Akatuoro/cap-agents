# bookshop-agent

A CAP application with Joule App2App principal propagation via IAS.

## Deploy

### 1. Build and deploy

```sh
cds up
```

### 2. Create service keys

The MTA deploy creates a default X509 key for `bookshop-agent-proxy-ias`. You need two keys:
- A **SECRET** key for `create-destination` (client_secret flow)
- The default **X509** key is used as-is for `create-destination:mtls`

```sh
# Rename the default X509 key (already exists after deploy — skip if already named correctly)
# Then create the SECRET key for the plain flow:
cf create-service-key bookshop-agent-proxy-ias bookshop-agent-proxy-ias-key -c '{"credential-type":"SECRET"}'
cf create-service-key bookshop-agent-proxy-ias bookshop-agent-proxy-ias-x509-key -c '{"credential-type":"X509_GENERATED"}'

# Sender IAS app needs a SECRET key for the password grant:
cf create-service-key bookshop-agent-sender-ias bookshop-agent-sender-ias-key -c '{"credential-type":"SECRET"}'
```

### 3. Wire IAS dependencies manually

The `consumed-apis` entries in `mta.yaml` are stored as CF service instance metadata but
**do not automatically create the dependency in the IAS admin UI**. You must add them manually.

Open the IAS admin console for your tenant and make the following changes:

**App: `das-ias-mock`** (`bookshop-agent-sender-ias`) → Dependencies tab → Add:
| Field | Value |
|-------|-------|
| Name | `joule-to-proxy` |
| Target app | `bookshop-agent-proxy` |
| API permission group | `bookshop-agent-proxy` |

**App: `bookshop-agent-proxy`** → Dependencies tab → Add:
| Field | Value |
|-------|-------|
| Name | `proxy-to-bookshop-agent` |
| Target app | `bookshop-agent` |

> `bookshop-agent` appears in the target app picker because it has `allow-principal-propagation: true`
> and a `provided-apis` entry (`bookshop-agent-ias-api`) set in `mta.yaml`.

### 4. Bind services

```sh
cds bind bookshop-agent-sender-ias    -2 bookshop-agent-sender-ias
cds bind bookshop-agent-proxy-ias     -2 bookshop-agent-proxy-ias
cds bind bookshop-agent-proxy-ias-x509 --key bookshop-agent-proxy-ias-x509-key -2 bookshop-agent-proxy-ias
cds bind bookshop-agent-dest          -2 bookshop-agent-dest
```

### 5. Create destinations

**Plain (client_secret):**
```sh
npm run create-destination
```
Creates `JOULE_APP_2_APP`. Verify: BTP cockpit → Connectivity → Destinations → `JOULE_APP_2_APP`.

**mTLS (X509 cert):**
```sh
npm run create-destination:mtls
```
Creates `JOULE_APP_2_APP_MTLS`. Verify: BTP cockpit → Connectivity → Destinations → `JOULE_APP_2_APP_MTLS`.

## Local development

```sh
cds watch
```

## Test: principal propagation


| Step | What happens |
|------|-------------|
| 0 | Password grant on `bookshop-agent-sender-ias` (mocks `das-ias`) → sender JWT (cached) |
| 1 | JWT-bearer: sender JWT → proxy JWT via `joule-to-proxy` dependency |
| 2 | JWT-bearer: proxy JWT → target JWT via `proxy-to-bookshop-agent` dependency |
| 3 | GET `bookshop-agent-srv` with target JWT |

Step 2 in the mTLS variant authenticates with the proxy X.509 cert instead of a client secret.
Step 3 in the mTLS variant uses the `.cert.` route.

**First run** (writes JWT cache):

```sh
IAS_USER=you@example.com IAS_PASSWORD=secret npm run test:auth
IAS_USER=you@example.com IAS_PASSWORD=secret npm run test:auth:mtls
```

**Subsequent runs** (token reused until expiry):

```sh
npm run test:auth
npm run test:auth:mtls
```
