# Keeping the dashboard current

Two things feed the dashboard, and they are refreshed separately.

| What | Source | How it updates |
|---|---|---|
| Holdings, sectors, cash, bond | the Excel workbook | you upload it in the dashboard |
| Performance history, trade ledger, dividends | Schwab CSV exports | `node tools/build-performance.js && node tools/publish-performance.js` |

The workbook alone keeps every holdings-driven tab correct. The rebuild is only
needed when you want the Performance and Transactions tabs to reflect new
trades, because those need years of daily prices that a browser upload cannot
practically fetch.

## Updating the workbook (the usual case)

1. In Schwab, export **Positions** for both accounts to CSV.
2. Export **Transactions** for both accounts to CSV (History → Export).
3. Run `python tools/build-workbook.py` (paths are at the top of that file) to
   produce a fresh workbook, or edit the existing one by hand.
4. Upload it through the dashboard: type `ceeadmin`, enter the master code and
   upload password, choose the file.

### Sheet layout the upload expects

Three tabs: **Endowment**, **CEE Fund**, **Transactions**.

On the two position tabs, column **A must not be empty** — leave the title there.
Excel's used range starts at the first non-empty column, so an empty column A
shifts every column left by one and the parser reads company names as tickers.
That failure is quiet and produces "No equities parsed".

Columns, starting in **B**: Ticker · Company · Shares · Cost Basis · Avg Price ·
Market Price · Market Value · Day % · Day $ · G/L $ · G/L % · Sector · Beta.

- Percentages are decimals (0.0152, not 1.52%).
- A section header containing the letters "etf" switches following rows to the
  ETF sleeve. `Endowment ETF's` does this.
- A row with `Cash` in column B and a number in C sets the cash balance.
- A 9-character CUSIP (the Treasury note) is read as fixed income.

The Transactions tab starts in column **A**: Date · Fund · Ticker · Action ·
Shares · Price · Amount · Fees · Description. Rows without a share count are
kept — dividends, interest and wires carry their value in **Amount**.

## Rebuilding performance history

```bash
node tools/build-performance.js && node tools/publish-performance.js
```

Update the four file paths and `ANCHOR` at the top of `build-performance.js`
when new exports arrive. `ANCHOR` is the as-of date printed in the positions
filename. Prices are cached in `tools/pxcache/`; delete it to force a refresh.

This writes two Firebase nodes, `/ceePerformance` and `/ceeTransactions`, and
touches nothing else.

## How positions are rebuilt

The Schwab transaction export is a **window**, not full fund history — positions
bought before it begins have sells with no matching buys. So the rebuild does
not accumulate from zero. It **anchors on the positions export** and walks
transactions backward to the start of the window and forward to today.

Two details worth knowing:

- **Splits.** Yahoo's daily closes are back-adjusted, so share counts are
  converted into the same split-adjusted space using Yahoo's split events. The
  broker's `Stock Split` rows are skipped — counting both would double up.
- **Anchor date.** Take it from the positions filename, never from a workbook
  name. `CEE Fund Portfolios 4.12.26` actually contained July prices and
  post-split share counts, which cost real time to discover.

A rebuild reconciles to roughly 0.4% of the Schwab totals, because the export is
taken intraday while the rebuild values positions at that day's close.

## Return measures

- **Our Return** (Modified Dietz) is what the dollars actually at work earned,
  so buying before a rise is credited. It leads every view.
- **Time-weighted** removes the effect of deposits and timing. It is the
  stricter basis and what a GIPS-style comparison would use.
- **Money-weighted (IRR)** annualises the return on invested dollars.

The Endowment has received $120,000 in wires. Without separating those, its
growth looks far larger than the fund earned.

## Known gaps

- `DISH` (acquired) has no Yahoo price history, and two CUSIP-only symbols
  (`30231G102` old Exxon, `50187A107` LHC Group) cannot be priced. Their value
  is excluded from the days they were held.
- The Treasury note is carried near par rather than marked to market.
- `MBGL` (Mobility Global, spun off from ExxonMobil 07/01/2026) is defaulted to
  the Energy sector. Change it in the workbook if the committee prefers another.
