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

**Do not rebuild this workbook with openpyxl or any similar library.** Price,
Beta, Ticker and Day change are driven by Excel linked data types — the `_FV`
formulas that read the Stocks entity sitting in the Company column. A
load-and-save through openpyxl silently drops every `xl/richData` part,
`xl/metadata.xml` and all 103 rich-value cell markers, which turns every live
formula into an error while still producing a file that opens.

`tools/update-workbook.py` edits the workbook as a zip of XML parts instead. It
changes only the constants — Shares, Cost Basis, Cash and the Treasury market
value — refreshes the cached result of each formula cell so the file is accurate
before Excel recalculates, appends the Transactions sheet, and copies every
other part through byte for byte.

```bash
python tools/update-workbook.py      # paths are at the top of the file
```

Then:

1. **Open it in Excel** so the Stocks data types refresh. The formulas
   recalculate to live prices and betas at that point; the cached values written
   by the script are only a correct starting snapshot.
2. **Add any brand-new position by hand.** A Stocks data type cannot be created
   programmatically. Copy an existing row, type the company into the Company
   column, and use Data → Stocks to convert it. The `_FV` formulas fill in
   Ticker, Price, Beta and Day change automatically.
3. Save, then upload through the dashboard: type `ceeadmin`, enter the master
   code and upload password, choose the file.

### Sheet layout the upload expects

Three tabs: **Endowment**, **CEE Fund**, **Transactions**.

On the two position tabs, column **A must not be empty** — leave the title
there. Excel's used range starts at the first non-empty column, so an empty
column A shifts every column left by one and the parser reads company names as
tickers. That failure is quiet and reports "No equities parsed".

Columns, starting in **B**: Ticker · Company · Shares · Cost Basis · Avg Price ·
Market Price · Market Value · Day % · Day $ · G/L $ · G/L % · Sector · Beta.

- Percentages are decimals (0.0152, not 1.52%).
- A section header containing the letters "etf" switches following rows to the
  ETF sleeve. `Endowment ETF's` does this.
- A row with `Cash` in column B and a number in C sets the cash balance.
- The Treasury block runs its own header — Ticker · Name · Amount · Cost Basis ·
  Purchase Price · **Market Value in column G**, one to the left of where a
  holdings row keeps it. A 9-character CUSIP is read as fixed income.

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
- `MBGL` (Mobility Global, spun off from ExxonMobil 07/01/2026) is classified
  under Financials in the workbook.

## Transactions newer than the CSV export

The Schwab transaction CSVs lag the position exports. Anything in between is
reconstructed from the monthly statement — the Transaction Details section, the
Pending section for trades that settle after month end, and position deltas for
dividends that settle in the gap and appear in neither. Those rows live in
`tools/new_tx.json`, are folded into both the workbook and the rebuild, and
`tools/statement-transactions.py` re-validates them: applying them to the prior
positions must reproduce the new positions exactly.

Clear `new_tx.json` once a CSV export covers the same period, or the rows will
be counted twice.

## Open question on the CEE Fund

On 2026-09-02 the CEE Fund's cash reads $169.92. The 08/31 sales settled 09/01
and raised $3,893.67 on an opening balance of $1,276.24, which should leave
$5,169.91. The gap is exactly $5,000.00. Nothing in the August statement
accounts for it and the Endowment did not receive it, so it is recorded as a
wire out dated 09/02 to keep the ledger balanced. **This needs confirming** — if
it was a purchase that settles later, or a transfer, the entry should be
corrected.
