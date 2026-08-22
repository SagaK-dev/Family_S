# Family S

Family S is a private, family-only web chat designed for a small trusted group. It is implemented independently, with no X/Twitter branding or copied source code.

The architecture takes inspiration from publicly documented ideas in X/Twitter's open-source recommendation/feed code: separate candidate retrieval from filtering/deduplication, keep timeline ordering explicit, preserve conversation context, and use cursor-based pagination. Those ideas are adapted here to a private chronological family chat rather than a public recommendation feed.

References:

- `twitter/the-algorithm` — Home Mixer / Product Mixer public architecture
- `xai-org/x-algorithm` — current public X feed/recommendation code

## Features

- Family-only authentication with username + password.
- First-user bootstrap protected by a server-side `FAMILY_SETUP_SECRET`.
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
- Read markers / aggregate seen count.
- Family member list.
- Message send throttling and login-attempt throttling.
- Responsive phone/desktop interface.
- Installable PWA shell.
- Service worker explicitly excludes `/api/` from caching.
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

## Security model

This repository may be public. **Family message content and credentials are not stored in GitHub.** Runtime data lives in D1.

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
- Mutating browser requests reject cross-origin `Origin` values.
- Login attempts are limited per hashed IP+username bucket.
- Message send bursts are limited per user.

### Browser hardening

`_headers` sets CSP, frame denial, referrer restrictions, nosniff, COOP, and disables unnecessary browser permissions.

The service worker never caches `/api/` requests or responses.

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
- Build output directory: `/`

Cloudflare Pages deploys the `functions/` directory automatically.

### 5. Initialize the family

Open the deployed site, select **初回設定**, and enter the same `FAMILY_SETUP_SECRET` once to create the owner account. After one user exists, the bootstrap endpoint refuses additional initialization.

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

The current unit tests cover:

- username normalization/validation;
- display-name and password bounds;
- message/search input bounds;
- reaction allowlisting;
- opaque cursor round-trip/rejection;
- timeline deduplication and chronological ordering;
- page-size clamping;
- reaction summary/current-user state.

CI additionally performs JavaScript syntax checks, manifest parsing, and secret scanning.

## Important deployment limitation

The repository review can validate the implementation and CI, but it cannot prove a live Cloudflare D1 deployment until the target Cloudflare account is configured and the application is exercised there. Treat live multi-device behavior as a separate deployment verification step.

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
│     └─ [[path]].js
├─ scripts/
│  └─ check-secrets.mjs
├─ tests/
│  └─ chat.test.js
└─ .github/workflows/ci.yml
```

## Scope

Family S is not a clone of X/Twitter. The public X/Twitter repositories are used only as architectural study material for pipeline decomposition, feed ordering, filtering, conversation context, and pagination. No proprietary systems, private data, UI assets, brand elements, or source text are copied into this project.
