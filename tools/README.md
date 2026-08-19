# Performance rebuild

The Performance tab reads a precomputed series from Firebase (`/ceePerformance`)
so the browser never has to fetch years of price history. Rebuild it whenever you
export fresh transactions.

## Updating with new transactions

1. In Schwab, export transaction history for **both** accounts to CSV
   (History → Export). Keep the default columns:
   `Date, Action, Symbol, Description, Quantity, Price, Fees & Comm, Amount`
2. Save them over the existing files in `transactions/`:
   - `CEE_Fund_transactions.csv` (account ...948)
   - `Endowment_transactions.csv` (account ...047)
3. Upload the current holdings workbook through the dashboard first, so the
   anchor snapshot matches. Then set `ANCHOR` in `build-performance.js` to the
   snapshot's true as-of date (see note below).
4. Run:

```bash
node tools/build-performance.js && node tools/publish-performance.js
```

The first command fetches daily prices (cached in `tools/pxcache/`, delete it to
force a refresh) and writes `perf.json`. The second trims precision and PUTs the
result to `/ceePerformance`. Nothing else in the database is touched.

## How positions are rebuilt

The Schwab export is a **window**, not full fund history — positions bought
before the export's start date have sells with no matching buys. So the rebuild
does not accumulate from zero. Instead it **anchors on the known holdings
snapshot** and walks transactions backward to the start of the window and forward
to today. That needs no pre-window history.

Two details worth knowing:

- **Splits.** Daily closes from Yahoo are back-adjusted, so share counts are
  converted into the same split-adjusted space using Yahoo's split events. The
  Schwab `Stock Split` rows are therefore skipped — counting both would double up.
- **Anchor date.** The workbook filename is not reliable. `4.12.26` actually
  contained July prices and post-split share counts. The true date was found by
  matching the snapshot's stored prices against daily closes — it matched
  2026-07-07 with 0.00% error across 81 tickers. If a rebuild looks wrong, check
  this first; `datefind.js` in the scratchpad does it automatically.

## Return measures

- **Time-weighted (TWR)** removes deposits and withdrawals. This is the only
  number comparable to SPY, and it is what the Alpha figure uses.
- **Money-weighted (IRR)** is the annualised return on the dollars actually
  invested, so it reflects the timing and size of contributions.

The Endowment received $120,000 in wires over this window. Without stripping
those out, its growth would look far larger than the fund actually earned.

## Known gaps

- `DISH` has no price history on Yahoo (acquired), and two CUSIP-only symbols
  (`30231G102` old Exxon, `50187A107` LHC Group) cannot be priced. Their value is
  excluded from the days they were held.
- The Treasury bond (`91282CLW9`) is carried near par rather than marked to market.
