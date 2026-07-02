# Security Notes — CEE Fund Dashboard

Status of known issues and what still needs server-side work. Items 1 and 2 can only be
fixed in Firebase / Cloudflare — they cannot be fixed from this repo's client code.

## 1. Firebase database is publicly writable (HIGH — still open)

The dashboard reads and writes `https://cee-fund-dashboard-640ab-default-rtdb.firebaseio.com`
(`/ceeHoldings`, `/ceeHoldingsBackup`, `/ceeThesis`) with plain unauthenticated REST calls.
Anyone who views the page source can overwrite the club's holdings and thesis data with a
single `curl` command.

**Fix (pick one):**

- **Option A — Firebase rules + secret via the Worker (recommended).** In the Firebase
  console under *Realtime Database → Rules*, make the database read-only for the public:

  ```json
  {
    "rules": {
      ".read": true,
      ".write": false
    }
  }
  ```

  Then route writes through the Cloudflare Worker (`ceefund.wmaxe576.workers.dev`) using a
  Firebase Admin credential or database secret stored as a Worker secret, and have the
  Worker require the upload password before accepting a write.

- **Option B — Firebase Authentication.** Enable anonymous/email auth and set
  `".write": "auth != null"`, signing in officers from the admin panel.

## 2. Finnhub API key is embedded in the page (MEDIUM — still open)

`data.js` contains the Finnhub token in clear text. Anyone can lift it and exhaust the
free-tier rate limit. The Yahoo Finance calls already go through the Cloudflare Worker;
Finnhub calls should too:

1. In the Worker, add a route like `/fh/*` that forwards to `https://finnhub.io/api/v1/*`
   and appends `token=<key>` from a Worker secret.
2. In `app.js` (`fetchYF`), rewrite `finnhub.io` URLs to the Worker route the same way
   Yahoo URLs are rewritten today, and delete the `FINNHUB` constant from `data.js`.

## 3. Admin master code was in plain text (FIXED)

The master code is no longer stored in source. `data.js` holds only a SHA-256 hash
(`MASTER_HASH`), and `verifyMaster()` hashes the typed code before comparing. To change
the code, compute the new hash (browser console: `sha256('NEWCODE' + PW_SALT)`) and paste
it into `MASTER_HASH`.

## 4. Upload password was base64-encoded, not hashed (FIXED)

`localStorage` now stores `sha256(password + salt)` instead of `btoa(...)` (which is
reversible). Existing passwords in the old format still work once and are silently
migrated to the hashed format on first successful use.

**Remaining caveat:** all of the admin gating is client-side. It keeps casual visitors out
of the upload UI, but it does not protect the data itself — that protection has to come
from item 1.
