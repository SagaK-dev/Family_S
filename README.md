# Family S

Family S is a private, family-only web chat designed for a small trusted group. It is implemented independently, with no X/Twitter branding or copied source code.

The architecture takes inspiration from publicly documented ideas in X/Twitter's open-source recommendation/feed code: separate candidate retrieval from filtering/deduplication, keep timeline ordering explicit, preserve conversation context, and use cursor-based pagination. Those ideas are adapted here to a private chronological family chat rather than a public recommendation feed.

References:

- `twitter/the-algorithm` — Home Mixer / Product Mixer public architecture
- `xai-org/x-algorithm` — current public X feed/recommendation code

## Features

- Family-only authentication with username + password.
- First-user bootstrap protected by a server-side `FAMILY_SETUP_SECRET`.
- Exactly one owner enforced at the database level.
- Owner-generated, single-use invite codes that expire after 24 hours.
- PBKDF2-SHA256 password hashing with a random salt per user.
- 30-day HttpOnly + Secure + SameSite=Strict session cookies.
- Chronological family message timeline.
- Reply-to-message context.
- Emoji reactions with a server-side allowlist.
- Edit your own messages.
- Delete your own messages; the family owner may delete any message.
- Owner-only message pinning.
- Search across visible messages.
- Read markers / aggregate seen count with server/database clamping.
- Family member list.
- Message send throttling and login-attempt throttling.
- Explicit API route/method allowlisting and request validation.
- Responsive phone/desktop interface.
- Installable PWA shell.
- Service worker explicitly excludes `/api/` from caching and uses network-first static updates.
- No external analytics, ads, trackers, recommendation model, or public profile system.

## Architecture

The application is deliberately small and dependency-free at runtime:

```text
Browser
  ├─ index.html / styles.css / app.js
  ├─ polling timeline (2.5 s while visible)
  └─ service worker for static shell only
          │
          ▼
Cloudflare Pages Functions
  ├─ functions/api/_middleware.js
  └─ functions/api/[[path]].js
          │
          ▼
Cloudflare D1
  ├─ users
  ├─ sessions
  ├─ invites
  ├─ messages
  ├─ reactions
  ├─ reads
  └─ auth_limits
```

`shared/chat.js` contains validation, cursor handling, reaction aggregation, and the timeline pipeline shared by the server and tests.

The timeline path follows a simple pipeline:

1. fetch message candidates from D1;
2. apply deletion/search/pin/cursor visibility constraints;
3. normalize and deduplicate;
4. order chronologically;
5. attach reply/social context, reactions, and seen counts;
6. return a bounded page plus an opaque cursor.

This is conceptually similar to the pipeline decomposition documented by X/Twitter, but the implementation here is original and much smaller.

## Security and privacy model

This repository may be public. **Family message content and credentials are not stored in GitHub.** Runtime data lives in D1.

Family S is **not end-to-end encrypted**. Message bodies are stored as plaintext in the configured D1 database so the server can perform search, reply context, and timeline queries. Anyone with sufficient Cloudflare/D1 administrative access may be able to read that data. Use a trusted Cloudflare account, enable strong account security, and do not treat Family S as a zero-knowledge messenger.

### Secrets

Never commit real secrets. `.gitignore` excludes `.dev.vars`, `.env`, private keys, service-account files, and common credential files. CI also runs a repository secret scanner.

Required production secret:

- `FAMILY_SETUP_SECRET` — long random value used only to create the first owner account.

Store it as a Cloudflare encrypted secret / environment secret. Do not place it in `app.js`, HTML, GitHub source, or a public build variable.

`.dev.vars.example` only documents the variable name and contains no usable secret.

### Authentication

- Passwords: PBKDF2-SHA256, 240,000 iterations, random 16-byte salt, 256-bit derived output.
- Sessions: random 256-bit bearer token; only its SHA-256 hash is stored in D1.
- Session cookie: `HttpOnly; Secure; SameSite=Strict`.
- Invite codes: random 192-bit value; only its SHA-256 hash is stored in D1.
- Setup secret comparison is performed through fixed-size digests.
- A partial unique index permits only one `owner` row, closing concurrent-bootstrap races.
- Mutating browser requests reject cross-origin `Origin` values.
- Login attempts are limited per hashed IP+username bucket.
- Message send bursts are limited per user.
- API middleware allows only explicit routes/methods and validates message IDs and payload types before the main handler.
- Invalid client input is rejected as a 4xx response rather than leaking into generic server errors.
- Read markers are validated against the current time and also clamped in D1 to an existing visible message timestamp.

### Browser hardening

`_headers` sets CSP, frame denial, referrer restrictions, nosniff, COOP, and disables unnecessary browser permissions.

The service worker never caches `/api/` requests or responses. Static assets are network-first so an old cached JavaScript bundle does not indefinitely override a newer deployed client.

## Review fixes applied before merge

The pre-merge review found and fixed these issues:

1. concurrent first-user requests could theoretically create multiple owners — fixed with a D1 unique owner constraint;
2. a modified client could submit a future read timestamp — fixed with middleware validation plus database triggers that clamp reads to real message timestamps;
3. catch-all message routes accepted ambiguous subpaths — fixed with an exact route/method allowlist and UUID validation;
4. the first service-worker design was cache-first for static JavaScript and could retain stale client code — changed to network-first with stale-cache cleanup;
5. oversized login passwords could reach expensive password derivation — bounded before the authentication handler;
6. shared validators throw ordinary errors, which could otherwise become HTTP 500 — middleware now performs validation and converts bad requests into 4xx responses;
7. pin requests could coerce string values such as `"false"` to true — middleware now requires a real boolean.

## Cloudflare Pages deployment

### 1. Create a D1 database

Create a D1 database, then apply `schema.sql`.

### 2. Bind D1

Bind the D1 database to the Pages project with the binding name:

```text
FAMILY_DB
```

### 3. Configure the setup secret

Create a long random secret in Cloudflare Pages settings:

```text
FAMILY_SETUP_SECRET
```

Do not commit the value.

### 4. Deploy

The project is static and does not require a build step.

- Build command: leave empty (or run `npm run check`)
- Static output: repository root (`.`)

Cloudflare Pages deploys the `functions/` directory automatically.

### 5. Initialize the family

Open the deployed site, select **初回設定**, and enter the same `FAMILY_SETUP_SECRET` once to create the owner account. The database also enforces that only one owner may exist.

The owner can then create one-time invitation codes from the app.

## Local development

Node.js 22+ is used for checks/tests only.

```bash
npm test
npm run check
npm run security:check
```

For Cloudflare-local development, copy `.dev.vars.example` to `.dev.vars` and replace the placeholder locally. Never commit `.dev.vars`.

## Tests

The current suite has 11 unit tests covering:

- username normalization/validation;
- display-name and password bounds;
- message/search input bounds;
- reaction allowlisting;
- opaque cursor round-trip/rejection;
- timeline deduplication and chronological ordering;
- page-size clamping;
- reaction summary/current-user state;
- strict message route allowlisting;
- rejection of wrong authentication methods and unknown routes.

CI additionally performs JavaScript syntax checks, manifest parsing, and secret scanning.

## Important deployment limitation

Repository review and GitHub Actions validate the implementation, but a live Cloudflare D1 deployment has not been exercised from multiple real family devices in the target account. Live authentication, D1 schema application, mobile PWA install, and multi-device polling should be verified after deployment.

## Project structure

```text
Family_S/
├─ app.js
├─ index.html
├─ styles.css
├─ icon.svg
├─ manifest.webmanifest
├─ sw.js
├─ _headers
├─ schema.sql
├─ shared/
│  └─ chat.js
├─ functions/
│  └─ api/
│     ├─ _middleware.js
│     └─ [[path]].js
├─ scripts/
│  └─ check-secrets.mjs
├─ tests/
│  └─ chat.test.js
└─ .github/workflows/ci.yml
```

## Scope

Family S is not a clone of X/Twitter. The public X/Twitter repositories are used only as architectural study material for pipeline decomposition, feed ordering, filtering, conversation context, and pagination. No proprietary systems, private data, UI assets, brand elements, or source text are copied into this project.
