# Security Notes — CEE Fund Dashboard

Current status of known issues. Everything below reflects what is actually in
`index.html` today, which is the only file the site loads.

> **History note.** An earlier pass fixed items 3 and 4 below, but those fixes
> lived in a separate `app.js` that a later rewrite replaced with the current
> single-file `index.html`. The fixes did not carry over, so both items are open
> again. `app.js`, `data.js` and `styles.css` have since been deleted — they were
> dead files that no longer matched the live site.

## 1. Firebase database is publicly writable (HIGH — open)

The dashboard reads and writes
`https://cee-fund-dashboard-640ab-default-rtdb.firebaseio.com` (`/ceeHoldings`,
`/ceeHoldingsBackup`, `/ceeThesis`, `/ceePerformance`) with unauthenticated REST
calls. Anyone who views the page source can overwrite the club's holdings,
thesis notes and performance history with a single `curl` command.

**Fix (pick one):**

- **Option A — rules + a secret held by the Worker (recommended).** In the
  Firebase console under *Realtime Database → Rules*, make the database
  read-only to the public:

  ```json
  {
    "rules": {
      ".read": true,
      ".write": false
    }
  }
  ```

  Then route writes through the Cloudflare Worker
  (`ceefund.wmaxe576.workers.dev`) using a database secret stored as a Worker
  secret, and have the Worker require the upload password before writing.

- **Option B — Firebase Authentication.** Enable auth and set
  `".write": "auth != null"`, signing officers in from the admin panel.

## 2. Finnhub API key is embedded in the page (MEDIUM — open)

`index.html` contains the Finnhub token in clear text, so anyone can lift it and
exhaust the free-tier rate limit. Yahoo Finance calls already go through the
Cloudflare Worker; Finnhub should too:

1. Add a route to the Worker (e.g. `/fh/*`) that forwards to
   `https://finnhub.io/api/v1/*` and appends `token=<key>` from a Worker secret.
2. In `fetchYF`, rewrite `finnhub.io` URLs to that route the same way Yahoo URLs
   are rewritten today, then delete the `FINNHUB` constant.

## 3. Admin master code is in plain text (MEDIUM — open)

`const MASTER_CODE = 'CEEFUND2026';` sits in the page source, so the admin gate
is decorative against anyone who opens developer tools.

**Fix:** store only a SHA-256 hash and hash the typed input before comparing, so
the code itself never appears in source.

## 4. Upload password is base64-encoded, not hashed (MEDIUM — open)

`verifyUploadPw` compares `btoa(password + salt)`. Base64 is an encoding, not a
hash — anything stored that way is trivially reversible.

**Fix:** store `sha256(password + salt)` instead, and accept the old `btoa`
value once so existing passwords migrate on first successful use.

## 5. Thesis saves overwrite the whole node (MEDIUM — open)

Thesis writes use `PUT` against `/ceeThesis`, which replaces the entire node with
whatever that browser holds in memory. A member with a stale tab can therefore
erase everyone else's research.

**Fix:** use `PATCH` scoped to the record being edited (RTDB's merge/update
operation), so a save can only touch the fields it changed.

> Note: the performance data at `/ceePerformance` is written only by
> `tools/publish-performance.js`, not by the browser, so it is not exposed to
> this particular failure — but it is still covered by item 1.

## Client-side gating is not protection

The hidden admin panel (triple-click the logo, or type `ceeadmin`) keeps casual
visitors out of the upload UI. It does not protect the data, because every check
runs in the visitor's own browser. Only item 1 does that.
