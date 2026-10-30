<p align="center">
  <img src="assets/header-site-map.svg" alt="Nexus Mods site map & official API study" width="100%" />
</p>

<p align="center">
  <a href="../README.md"><kbd> ← README </kbd></a>&ensp;·&ensp;
  <a href="../PRIVACY.md"><kbd> 🔒 Privacy </kbd></a>&ensp;·&ensp;
  <a href="../.github/CONTRIBUTING.md"><kbd> 🤝 Contributing </kbd></a>&ensp;·&ensp;
  <a href="../CHANGELOG.md"><kbd> 📋 Changelog </kbd></a>
</p>

<img src="assets/divider.svg" alt="" width="100%" />


This is a study of how nexusmods.com is structured and which **official, documented** interfaces could replace the extension's DOM scraping and internal endpoints. Like the <a href="https://github.com/mytechnotalent/Reverse-Engineering"><kbd>Reverse-Engineering</kbd></a> course, it works from observation, but only through legitimate sources:

- the public API documentation,
- public GraphQL schema introspection (which Nexus serves without authentication),
- the open-source official clients (<a href="https://github.com/Nexus-Mods/Vortex"><kbd>Vortex</kbd></a>, <a href="https://github.com/Nexus-Mods/NexusMods.App"><kbd>NexusMods.App</kbd></a>, <a href="https://github.com/Nexus-Mods/node-nexus-api"><kbd>node-nexus-api</kbd></a>),
- this repository's own code.

Nothing here touches Cloudflare protection, Premium gating or authentication. The download-link logic is out of scope and is not changed by this document.

*Observed 2026-10-12. Nexus changes the site often, so treat every selector and field as "true on that date".*

---

## 1. Hosts

| Host | What it is | Used by the extension today |
|---|---|---|
| `www.nexusmods.com` | Main site. A Next.js app (`#__next`, `__NEXT_DATA__`, `/_next/static/<buildId>/`) with some legacy server-rendered pages | Content scripts, `GenerateDownloadUrl` form endpoint |
| `users.nexusmods.com` | Account/sign-in (`/auth/sign_in`), OAuth authorization server | Sign-in redirect detection (`content/auth.js`) |
| `api.nexusmods.com/v1/*` | Public REST API. Needs an `apikey` header (or OAuth bearer); otherwise **401** | — |
| `api.nexusmods.com/v2/graphql` | Public GraphQL API (v2). Anonymous reads work; introspection is open; CORS allows the site origin with credentials and `*` without | — |
| `api-router.nexusmods.com/graphql` | The router the website itself calls. Same schema as v2 | `ndc.js` collection queries |
| `graphql.nexusmods.com` | Human-readable v2 reference | docs only |
| `wss://sso.nexusmods.com` | Legacy websocket SSO that issues an app-scoped API key | — |
| `nxm://` | Protocol handler links that mod managers receive | Vortex/NMM download mode (`parseNxmDownloadLink`) |

## 2. Page types and routes

These are the routes as `page-check.js`'s `pageTypeOf`, `main.js`'s `extractRouteDetails` and `nnw.js`'s `MOD_PAGE_PATTERN` classify them.

| Page type (`debugPageType` / page-check) | Route | Notes |
|---|---|---|
| `collection` | `/{gameDomain}/collections/{slug}` and `/…/revisions/{n}` (also `/games/{game}/collections/…`) | `slug` is 6 base-36 characters. No revision means the latest published one |
| `mod` | `/{gameDomain}/mods/{modId}` (optionally `/games/…`) | Tabs are a query string: `?tab=description\|files\|images\|posts\|bugs\|logs` |
| `mod-file` | `/{gameDomain}/mods/{modId}?tab=files&file_id={fileId}` | Slow/fast download chooser. `&nmm=1` is the "Mod manager download" variant |
| sign-in | `users.nexusmods.com/auth/sign_in?…` | Detected so runs stop with a "sign in" error instead of retrying |
| other | home, game hubs, search, users, news | Not actionable. The poll rate drops to idle |

Identifiers you can rely on:
- `gameDomain` (e.g. `skyrimspecialedition`) is stable and is the key for v1 and for many v2 arguments.
- `gameId` is numeric (Skyrim SE = 1704). v2 `mod`/`modFiles` need it. The extension recovers it from `[data-game-id]`/`[game-id]` or from the download endpoint's response.
- `modId` and `fileId` are numeric per game. v2 also has global `uid`s (`modsByUid`, `modFilesByUid`).
- A collection is identified by `slug` plus a `revisionNumber`. Revisions are immutable once published; `latest` flags the current one.

## 3. DOM anchors the extension depends on (fragility register)

| Anchor | Where | Purpose | Fragility | Official-API replacement |
|---|---|---|---|---|
| `#mainContent .next-container`, `#mainContent > div > div.relative > div.next-container` | `main.js` `findCollectionHost` | Mount point for the control deck | Medium (layout) | None needed; mounting is a UI concern |
| `.bg-surface-low.w-full.space-y-3.rounded-lg.p-4.mt-4` | `main.js` legacy host | Old collection layout | **High** (Tailwind utility chain) | Same as above. Keep only as a fallback |
| `mod-file-download[file-id]` | `nnw.js` | Web component on the files tab, carrying the file id | Medium | v2 `modFiles(modId, gameId)` gives the full file list |
| `#slowDownloadButton` | `nnw.js` | Slow-download button | Medium | none (download flow; out of scope) |
| `mod-file-download[filesize-bytes][is-managed-download-enabled][is-nmm-download][user-is-logged-in]` | `nnw.js` `offersResumableChoice` | Whether *Slow download* opens Nexus's standard-or-resumable chooser instead of starting (over 500 MB, and `showSaveFilePicker` must exist) | Medium | none (download flow; out of scope) |
| Chooser `[role="dialog"]`/`.nxm-modal-content` with *Standard download* / *Resumable download*; *Pause*, *Resume Download*, *direct download* buttons on the progress panel | `nnw.js` `largeFileChoiceOf`, `isDirectDownloadControl`, `nexusResumableShown` | Resumable downloads (beta). Labels are English-only on Nexus; kept in `selectors.js` `TEXT` | High (beta UI) | none |
| `.accordion-downloads`, `h3[id^="…"]` | `nnw.js` | File groups on the files tab | High | v2 `modFiles{ category, primary }` |
| `[data-game-id]`, `[game-id]` | `nnw.js getGameId` | Numeric game id | Medium | v2 `game(domainName){ id }`. Cache it per domain; it never changes |
| `#section .wrap > #featured`, `.bg-nexus-premium-gradient` | `nnw.js` | Ad/upsell hiding | High | none (cosmetic) |
| `__NEXT_DATA__`, `/_next/static/<id>/_buildManifest.js` | `page-check.js detectBuild` | Nexus deploy id for reports | Low | n/a, already the right approach |
| Sign-out link and profile menu | `page-check.js` | Signed-in detection | Medium | v2 `user`/`preferences` with credentials (see §7, P3) |

## 4. SPA navigation behaviour

- The site is a Next.js app. Moving between mods, tabs and collections uses `history.pushState`, and a content script **cannot observe** those calls.
- How `main.js` copes: it listens for `popstate` and for the Navigation API's `navigate` event where available. A poll compares `origin+pathname+search`: fast on actionable pages, idle elsewhere. `handleRouteChange` is debounced and serialized through a promise chain, so the deck cannot race its own setup.
- A `MutationObserver` re-roots itself when Next swaps `#mainContent`. A self-heal tick remounts the deck if a re-render wiped it.
- Tab changes (`?tab=files`) re-render without a route change, so `nnw.js` observes for `mod-file-download` elements appearing.
- **Recommendation:** keep this design. The poll is the only universally reliable signal. Moving data reads to the API (§6) shrinks what has to happen *after* a navigation to "find a mount point", which makes the race window harmless.

## 5. Data sources

### 5.1 What the extension calls today

| Call | Endpoint | Auth | Status |
|---|---|---|---|
| `CollectionRevisionMods` | `api-router.nexusmods.com/graphql` | site cookies | Same schema as public v2 |
| `CollectionRevisions` | same | site cookies | Same |
| `GenerateDownloadUrl` | `www.nexusmods.com/Core/Libs/Common/Managers/Downloads` | site session | Internal form endpoint; download flow is **out of scope** |
| `/api/files/…` pages | `www.nexusmods.com` | site session | Internal |

### 5.2 Official GraphQL v2 (`https://api.nexusmods.com/v2/graphql`)

Introspection is public. The top-level queries relevant to the extension:

| Query | Arguments | Useful fields |
|---|---|---|
| `collection` | `slug, domainName, viewAdultContent` | revisions list, `latestPublishedRevision`, game |
| `collectionRevision` | `slug, revision, domainName, viewAdultContent` | `revisionNumber, latest, status, modCount, totalSize, modFiles{ fileId optional updatePolicy version file{…} }, externalResources, collectionChangelog, gameVersions, installationInfo` |
| `mod` | `modId, gameId` | `name, version, updatedAt, status, adultContent, endorsements, downloads, viewerEndorsed, viewerTracked, viewerDownloaded, viewerUpdateAvailable, modRequirements` |
| `modFiles` | `modId, gameId` | `fileId, name, version, category, primary, size/sizeInBytes, date, changelogText, uri` |
| `legacyModsByDomain` | `ids[{gameDomain, modId}], offset, count` | **batch** mod metadata in one request |
| `modsByUid` / `modFilesByUid` | `uids, offset, count` | batch by global uid |
| `fileHash` | `md5` | identify an archive from its hash |
| `game` | `id` or `domainName` | numeric id ⇄ domain |
| `mods` / `collectionsV2` | `filter, sort, facets, offset, count` | search |

Mutations exist for `createModEndorsement` / `abstainFromModEndorsement` and `trackMod` / `untrackMod`. They act as the signed-in user and need a session or OAuth token.

**Observed behaviour:**
- Anonymous queries succeed.
- Adult collections return `ADULT_CONTENT_BLOCKED` unless the viewer is signed in with adult content enabled. `viewAdultContent: true` alone is not enough anonymously.
- A wrong domain returns `NOT_FOUND`.
- The CORS preflight from `https://www.nexusmods.com` allows `credentials: true`, so a content script can call v2 with the user's own session exactly as the site does.

### 5.3 Official REST v1 (`https://api.nexusmods.com/v1`)

Requires an `apikey` header (user key or app key) or an OAuth bearer. Calls relevant here:
- `GET /users/validate.json`: key check, premium flag
- `GET /games/{game}/mods/{id}.json`, `…/files.json`, `…/changelogs.json`
- `GET /games/{game}/mods/updated.json?period=1d|1w|1m`: cheap update checks
- `POST /games/{game}/mods/{id}/endorse.json`, `…/abstain.json`
- `GET|POST|DELETE /user/tracked_mods.json`
- `GET /games/{game}/mods/md5_search/{md5}.json`
- `GET /games/{game}/mods/{id}/files/{fid}/download_link.json`: Premium only, or `?key=&expires=` taken from an `nxm://` link the website issued. Listed for completeness only. **The extension must not use it to get around Premium.**

### 5.4 `nxm://` protocol (from Vortex / NexusMods.App)

```
nxm://{gameDomain}/mods/{modId}/files/{fileId}?key={k}&expires={unix}&user_id={uid}
nxm://{gameDomain}/collections/{slug}/revisions/{n}
```

A mod manager registers the scheme. The website issues the `key`/`expires` pair after the user clicks "Mod manager download" (the free, slow path). The manager then calls `download_link.json` with that pair. The extension's NMM mode already only *forwards* these links.

### 5.5 Authentication options for apps

1. **Personal API key:** shown at nexusmods.com/users/myaccount?tab=api. Nexus allows it for personal tools, but it must not be shipped, and keys for other apps must not be reused (node-nexus-api README).
2. **SSO websocket** (`wss://sso.nexusmods.com`): issues an app-scoped key once the user approves at `nexusmods.com/sso?id=…`. Requires a **registered `appid`**.
3. **OAuth 2 + PKCE** (`users.nexusmods.com/oauth/*`): what current Vortex and NexusMods.App use. Requires a registered client id. It gives a JWT plus a refresh token.

For a browser extension running *on* nexusmods.com, the lowest-friction legitimate option is the **user's existing site session** (v2 with `credentials: 'include'`, as the website itself does). It needs no key handling. Options 2 and 3 need app registration with Nexus.

## 6. Rate limits and how to handle them

| API | Limit (Nexus help centre, June 2026) | Signals |
|---|---|---|
| v1 REST | 20,000 requests / 24 h per user, then 500 / h; resets at 00:00 GMT and on the hour | `X-RL-Daily-Limit/Remaining/Reset`, `X-RL-Hourly-Limit/Remaining/Reset`; **429** when exhausted |
| v2 GraphQL | Separate pool from v1 (third-party clients report this); no `X-RL-*` headers seen on anonymous calls | 429 and Cloudflare challenges when abused |
| Client-side (node-nexus-api / Vortex) | Token bucket: 300 burst (600 Premium), refilling 1 per second; resets to 0 on any 429 | — |

**Recommendations for the extension:**
- Add one `NexusApi` module with a token bucket: 60 burst, 1 per second, which is far below Vortex's. On a 429, back off for `Retry-After` or 60 s with jitter, then 2× up to 15 min.
- Show the countdown in the deck through the existing pause/interrupt UI.
- Batch: `legacyModsByDomain` takes many `{gameDomain, modId}` pairs. One request per 50 mods instead of 50.
- Cache: collection revisions are immutable, so cache `slug@revision` without expiry and only `latest` lookups for ~10 min. Cache mod metadata for 1 h and `game` ids forever.
- Identify the client. Send `Application-Name`/`Application-Version` only once a registered app exists; until then, use the site session like the page does.
- Never retry auth failures (401/403, `ADULT_CONTENT_BLOCKED`). Surface them as the existing typed errors.

## 7. What could move to the official API

| Feature | Today | Official source | Stability gain | Priority |
|---|---|---|---|---|
| Collection mod list | `api-router…/graphql` `collectionRevision` | Same query on **`api.nexusmods.com/v2/graphql`** (documented host) | Medium: documented host, same schema | **P1** |
| Collection revisions / "is there a newer revision" | `api-router` `collection.revisions` | v2 `collection{ latestPublishedRevision… }` + `collectionRevision{ latest }` | Medium | **P1** |
| Mod file list on the mod page (file ids, names, versions, primary, sizes) | DOM `mod-file-download`, accordions | v2 `modFiles(modId, gameId)` | **High**: removes the highest-churn selectors | **P1** |
| Game id lookup | DOM attributes and response sniffing | v2 `game(domainName){ id }`, cached | High | **P1** |
| Mod metadata in the deck (name, version, adult, status) | GraphQL `file.mod` subset | `legacyModsByDomain` batch | Low–medium | P2 |
| Update checks for history ("newer file than you downloaded") | not implemented | v2 `mod{ viewerUpdateAvailable, updatedAt }` or v1 `updated.json` | New feature, cheap | P2 |
| Optional-mod `updatePolicy` / exact-version pinning | not used | `CollectionRevisionMod.updatePolicy`, `version` | Correctness for collections | P2 |
| Endorse / track from the deck | not implemented | v2 `createModEndorsement`, `trackMod` (user session) | New feature. Must be explicit per-click user actions, never automatic | P3 |
| Signed-in / adult-content state | DOM heuristics | v2 `user` / `preferences` with credentials | Medium | P3 |
| Archive identification (Wabbajack import) | name/size matching | v2 `fileHash(md5)` | Higher match accuracy | P3 |
| Downloads | internal endpoint | — | **Out of scope.** No change; Premium-only API paths are not to be used | — |

## 8. Migration plan

**Phase 0: groundwork (no behaviour change)**
1. Add `src/content/nexus-api.js` with:
   - `query(name, gql, vars)` against `https://api.nexusmods.com/v2/graphql` using `credentials: 'include'`,
   - the token bucket and backoff from §6,
   - mapping onto the existing `Errors` codes, reusing `graphqlFault` and `nexus_api_changed`,
   - an in-memory plus `storage.session` cache.
2. Keep queries as named constants with a **schema contract test**: a CI job that introspects the public schema weekly and fails if a field the extension selects disappears. This is the "reverse engineering" early-warning system; it should run alongside `manifest-watch` and post to Discord when it fails.
3. Add `api` to `debugPageType` log entries so reports show which data source failed.

**Phase 1 (P1)**
1. Switch the two collection queries from `api-router` to `api.nexusmods.com/v2/graphql`, keeping `api-router` as a one-shot fallback on network or CORS failure. Verify adult collections still resolve with the session.
2. Resolve `gameId` via `game(domainName)` and cache it permanently. The DOM read becomes the fallback.
3. Build the mod-page file list from `modFiles`. The DOM is used only to *find where to draw buttons*, not for data. The page check gains an "API reachable" item.

**Phase 2 (P2)**
1. Batch metadata with `legacyModsByDomain` for decks of 50+ mods.
2. Honour `updatePolicy` (exact / latest / prefer) in collection runs, and show a "revision N+1 available" badge from `latest`.
3. Add an "updates available" view in history using `viewerUpdateAvailable`, throttled to once per mod per 6 h.

**Phase 3 (P3, needs a product decision)**
1. Endorse/track buttons, only as explicit user clicks, using the user's own session.
2. Hash-based Wabbajack matching via `fileHash`.
3. Optionally register the extension as a Nexus app (OAuth client id) if features outside the site context are ever wanted. Until then, no API keys are stored.

**Non-goals:** no change to the download/bypass path, no use of `download_link.json`, no parallel or segmented downloads, no Cloudflare or auth workarounds.

## 8a. Implementation status (2.10.0)

| Item | Status | Where |
|---|---|---|
| Central API module: token bucket (60 burst, 1/s), 429 backoff honouring `Retry-After` (60 s doubling to 15 min otherwise), memory and TTL cache, permanent cache for published revisions (`storage.local`, 20 entries), in-flight dedupe | ✅ | `src/content/nexus-api.js` |
| Weekly schema watch with Discord alert | ✅ | `tools/schema-watch.mjs`, `.github/workflows/schema-watch.yml`, snapshot `tests/fixtures/nexus-v2-schema.json` |
| P1 collection lookups via `api.nexusmods.com/v2/graphql`, router fallback on network/5xx/404/adult-blocked (never on 403/Cloudflare) | ✅ | `ndc.js` `fetchMods`/`fetchRevisions` |
| P1 game id via `game(domainName)` | ✅ | `nnw.js` `prefetchGameIdFromApi` (DOM is the fallback) |
| P1 mod-page file list from `modFiles`, DOM only for placement | ✅ (archived view: headers without `data-id` matched by unique name+version) | `nnw.js` `loadApiFileList` |
| P2 batched details (`legacyModsByDomain`, 50 per request) | ✅ | `ndc.ensureApiDetails` |
| P2 `updatePolicy` | ✅ badge for latest/prefer when Nexus is newer; opt-in **Follow curator update policy** swaps to the newest active file in the same group (`exact` never changes) | `ndc.applyUpdatePolicy`, `NexusApi.resolveByPolicy` |
| P2 newer-revision badge | ✅ | `ui-collection.js` `showNewerRevisionBadge` |
| P3 endorse/track | ✅ per-row buttons, one request per click, no retries | `ui-collection.js` `runModAction` |
| P3 hash matching | ✅ "Identify archives by hash" in the Wabbajack dialog: local MD5 → `fileHash`. Wabbajack's own xxHash64 values cannot be looked up | `wabbajack-importer.js` `identifyArchives` |
| Registering a Nexus app (OAuth client / SSO appid) | ❌ **not done, by decision.** A future option if features outside nexusmods.com tabs are wanted; it would add `Application-Name/Version` headers and per-app quotas | — |

Feature flags (in-page settings): **Use the official Nexus API** (default on; off restores pre-2.10 behaviour byte-for-byte for collection queries), **Follow curator update policy** (default off), **Endorse and track buttons** (default on, only with the API on).

## 9. Risks

- `api-router` versus the v2 host could differ in cookie or session handling for adult content. Phase 1 keeps the fallback and should be checked by a manual run on an adult-flagged collection while signed in.
- The v2 schema is versioned only implicitly, so the weekly introspection diff (Phase 0.2) is what turns silent breakage into a CI alert.
- Rate-limit headers are not exposed on anonymous v2 calls, so the client-side bucket is the only guard. Keep it conservative.

## Sources

- node-nexus-api README (auth, SSO, throttling): https://github.com/Nexus-Mods/node-nexus-api
- v2 reference: https://graphql.nexusmods.com/ and public introspection of `https://api.nexusmods.com/v2/graphql` (2026-10-12)
- Rate limits: https://help.nexusmods.com/article/105
- Vortex (nxm handling, OAuth, collections): https://github.com/Nexus-Mods/Vortex
- NexusMods.App: https://github.com/Nexus-Mods/NexusMods.App
- This repo: `src/content/main.js`, `nnw.js`, `ndc.js`, `page-check.js`, `auth.js`

<img src="assets/divider.svg" alt="" width="100%" />

<p align="center">
  <a href="https://github.com/thomasthanos"><img src="assets/footer.svg" alt="Built with care by ThomasThanos. Not affiliated with, endorsed by, or connected to Nexus Mods." width="100%" /></a>
</p>
