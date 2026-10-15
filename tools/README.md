# Keeping the dashboard current

Two things feed the dashboard, and they are refreshed separately.

| What | Source | How it updates |
|---|---|---|
| Holdings, sectors, cash, bond | the Excel workbook | you upload it in the dashboard |
| Performance history, trade ledger, dividends | the same upload | `node tools/build-performance.js && node tools/publish-performance.js` |

Everything now comes from one file. Uploading the workbook publishes the
holdings, the transaction ledger, the sector and symbol maps and the Price Data
tab to Firebase, and the rebuild reads all of it from there - no CSV export, no
file path on anyone's machine. The rebuild is still a separate step only because
it needs years of daily prices that a browser upload cannot practically fetch.

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

The reader looks for the Master workbook's four tabs first:

| Tab | What it carries |
|---|---|
| **Holdings Snapshot** | Fund · Ticker · Shares · Cost Basis (· Price Symbol), plus `Snapshot date` and a `Cash at snapshot` block |
| **Transactions** | the full ledger - see the columns below |
| **Settings** | sector per ticker, equity/ETF per ticker, symbol aliases, sector benchmark ETFs, the actions that count as external flows |
| **Price Data** | a Date column and one column per ticker of daily closes |

Nothing is read by position. Tabs are found by name, the header row by its
labels, and each column by its header text, so a column can move, a tab can be
added, or a block can shift down the sheet without breaking the read. A row left
in the snapshot with no shares is treated as sold out, not as a holding. If the
Holdings Snapshot tab is missing, the reader falls back to the older layout
below; if Settings is missing, the dashboard's own built-in maps are used.

The Price Data tab is published to its own Firebase node, `/ceePriceHistory`,
because `/ceeHoldings` is downloaded by every visitor on every page load and the
price table is about a megabyte. Only the rebuild reads it.

#### The older layout (still read if there is no snapshot tab)

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

## Checking that the workbook, the dashboard and the broker agree

```bash
python tools/reconcile.py "C:\Users\<you>\Downloads\CEE Fund Portfolios - Master.xlsx"
```

Run it after every upload. It is deliberately written from scratch rather than
reusing the dashboard's own parser, so when the two disagree that means
something. It reads nothing but the workbook, the published Firebase nodes and
the Schwab position exports sitting in Downloads, and it writes nothing.

It reports, in order of how much each matters:

1. **The Holdings Snapshot against the broker's own position export.** The
   snapshot is what every holdings-driven figure on the dashboard is built from,
   so when it matches the custodian those figures are right by construction.
   Both funds currently match to the share and to the cent on all 102 positions.
2. **What the dashboard publishes against that snapshot.**
3. **The ledger against the broker** - the share changes between the two most
   recent position exports that no ticket explains, each priced, and whether the
   workbook's estimated-trades block already covers it.
4. **The published NAV against the Schwab month-end values** typed into the
   Statement Check tab. Those statement figures are the only fully independent
   check on the return engine, which is why it is worth typing in each month's
   numbers as they arrive.
5. **The end of the published series against today's holdings** - the series
   should land on shares x close + cash.
6. **The workbook against itself** - stale cached formulas, sold-out rows still
   carrying a value, and summary cells that disagree with the rows they total.

A `HIGH` finding means a figure on the dashboard is wrong and why. `NOTE` means
the rebuild is right but is leaning on an estimate rather than a real ticket.

### Estimated trades

The broker's transaction export lags its position export by several weeks. The
workbook bridges that gap itself: the Holdings Snapshot tab carries an
**Estimated trades (unconfirmed)** block, worked out by differencing two position
snapshots, with a date, a share change, the cash moved, and a count of how many
real tickets existed when it was built. The upload publishes the active ones and
the rebuild folds them into the ledger - a trade the ledger has never seen reads
as a position that was always that size, which is how September's rebalance once
appeared as thirteen shares of Broadcom held since 2022.

An estimate stops being applied as soon as a real ticket for it appears
(`Ledger rows at build` stops being zero) or the `Active` flag is cleared, so
pasting the real tickets in when the export arrives needs no other change.

## Rebuilding performance history

```bash
node tools/build-performance.js && node tools/publish-performance.js
```

Daily prices are cached in `tools/pxcache/` and re-fetched once a file is more
than 18 hours old, so rebuilding on a later day picks up the new closes. Before
2026-09-13 the cache never expired, which froze the series at 2026-09-04.

The build also writes `perf_holdings.json` - each position's daily value, its
purchases and sales, and its daily close - which publishes to
`/ceePerformanceHoldings`. The Performance tab downloads it only when a sector
is opened, and uses it to compute every position's figures for exactly the
dates on screen, preset or custom.

**If the build prints `unpriced tickers`, fix it before publishing.** A holding
with no price series is left out of the fund's value while it is held, and the
day it converts or is sold its value lands as a one-day gain. Two tools in
`build-performance.js` handle this:

- `ALIAS` - a symbol Schwab files under a CUSIP but which is the same security as
  a live ticker. ExxonMobil's pre-2026-07-02 shares (`30231G102`) are priced as
  `XOM`; before this, the reorganisation showed up as +$2,384 in one day.
- `PX_PROXY` - a holding with no history left anywhere, valued at the price the
  fund exited at: LHC Group (`50187A107`, cash merger at $170.00) and DISH
  (sold at $13.79).
- **The workbook's Price Data tab**, used wherever the provider has no close.
  A provider's history is not permanent: Yahoo now starts Energy Transfer at
  2026-07-17, so ET was missing from NAV for the two years the funds held it
  while its purchases still counted as money put to work, leaving Energy $1,502
  (CEE) and $1,659 (Endowment) short. The workbook's own closes fill that in.
  A ticker whose split falls inside the stretch being filled is skipped and
  reported, because the provider's closes are back-adjusted for splits and the
  workbook's are the raw price of the day.

Actions in `POS_FLOW` (Buy, Sell, Cash Merger) are what move money into or out
of a position; anything else that changes shares - dividend reinvestment, a
spin-off - counts as return.

**If the build prints `NOT WRITTEN`, nothing was changed.** The builder refuses to
write its output when a holding could not be priced on a day it was held - either
because its series is missing entirely or because the series does not reach back
far enough - because a
series with a missing holding looks plausible and is wrong (on 2026-09-22 Yahoo
throttled 17 downloads and the CEE Fund would have read $194k instead of $220k).
Each download is retried with backoff, a refused download is never cached, and if
every attempt fails the last good saved prices are used - so re-running a few
minutes later normally clears it.

There is nothing to edit before a rebuild. The anchor date, the share counts,
the cash balances, the ledger and the sector map all come from the latest
upload, so the sequence is always: upload the workbook in the dashboard, then
run the two commands above. Prices are cached in `tools/pxcache/`; delete it to
force a refresh.

This writes three Firebase nodes - `/ceePerformance`, `/ceeTransactions` and
`/ceePerformanceHoldings` - and touches nothing else. In particular it never
touches `/ceeThesis`, where the committee's written research lives.

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

## Conventions, written down

These are the choices two systems can make differently and both look right.
Where the workbook and the dashboard disagree, the figure below is what the
dashboard uses.

**Fees.** Schwab's `Amount` is the cash that actually moved and already carries
the fee - a sale of 60 XLY at $138.21 grosses $8,292.60 and is recorded as
$8,292.41 against a $0.19 fee. The `Fees` column is therefore for reporting
only. Subtracting it as well charged every fee twice, $76.60 across the ledger.

**External flows and the day they land.** A deposit or withdrawal has to be kept
out of the day's return, and there are two defensible ways to do it:

| | Formula | Assumes |
|---|---|---|
| Dashboard | `(NAV - flow) / prior NAV` | the money arrived at the close, so it earns nothing that day |
| Workbook | `NAV / (prior NAV + flow)` | the money was there from the open, so it earns the whole day |

Over the whole window the two differ by **0.13 points** on the Endowment's
since-inception return (it has taken $120,000 of wires) and **0.003 points** on
the CEE Fund's. The dashboard's convention is the one validated against the
Schwab statements, so align the workbook to it rather than the other way round,
and use the actual time of day wherever a ticket records it.

**The risk-free rate** comes from the workbook's Settings tab, dated and
sourced, so Sharpe and Jensen's alpha cannot differ between the two screens. It
used to be hard-coded here at 4.30% while the sheet said 4.24%.

**Period returns start from the close before the period.** Year-to-date is
measured from 31 December's close, not the first close of January - on an index
that went 100 (31 Dec), 102, 103 the old way read +0.98% instead of +3%. The
same rule applies to 1M, 3M, 1Y and the sector views, and to the benchmark
beside them. A custom date range is measured between the two closes picked.

**The Treasury note** has no daily price from any source we have, so it is
valued on a straight line between the price paid and the latest mark the
workbook carries, and held flat outside that span. Both ends are right and the
middle is an estimate, so treat the Endowment's history as approximate to within
a couple of hundred dollars and replace this with dated broker marks if they
become available.

**Since inception is not the same period in both systems.** The workbook's
stored history begins 2022-07-01; the published series begins 2022-08-15, where
the transaction ledger starts and therefore the earliest date positions can be
reconstructed for. The Performance tab prints its own window under the title.
The two "all history" figures are not directly comparable.

## Tickets dated after the snapshot

The Holdings Snapshot is a photograph of one day. Tickets typed in after that
day are now carried forward by the upload itself: shares, cash and cost basis
all move, positions open and close, and a newly bought ticker appears in the
holdings with a warning if it has no sector yet. The working loop is:

1. paste the new transactions into the Transactions tab
2. upload the workbook
3. rebuild: `node tools/build-performance.js && node tools/publish-performance.js`

Cost basis is calculated **chronologically**, under moving-average accounting.
Order matters: sell five of ten shares at a $100 basis and then buy five at $20
and the remaining basis is $150, because the sale takes half the pool before the
purchase adds $100. The workbook's own fund-tab formula pools post-snapshot buys
and sells and prorates the result, which gives $133.33 for that sequence, so
after a batch of transactions the dashboard and that cell can disagree. The
cleanest answer is to refresh the Holdings Snapshot from Schwab whenever a batch
goes in - which is what the snapshot is for.

The Performance tab names the upload its history was built from and warns when
the holdings have been uploaded again since. The rebuild is a separate step, so
without that the two dates sit on one screen with nothing to tell them apart.

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
  (`30231G102` old Exxon, `50187A107` LHC Group) cannot be priced from the
  provider. All three are valued by hand (`ALIAS` / `PX_PROXY`).
- A ticker filled from the workbook's Price Data tab carries raw closes, so a
  split in that stretch would be invisible. The builder refuses to fill such a
  ticker rather than guess, and says which one it skipped.
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

## Scholarship withdrawals

On 2026-09-02 $5,000.00 left the CEE Fund to fund scholarships. The five sells
placed on 08/31 (ADI 2, HD 2, RSPN 16, PLTR 6, SOFI 23) raised $3,893.73 and the
remaining $1,106.27 came from existing cash, taking the balance from $1,276.24
down to $169.92.

It is recorded as a `Wire Sent` with the description `SCHOLARSHIP DISBURSEMENT`.
Keeping the action as a wire matters: the engine treats it as an **external
flow**, so the money leaving is not counted as an investment loss. Only the
description changes; the classification stays the one the return maths expects.

Record future disbursements the same way. The Trades tab prints the description
under the action for any row without a ticker, so a cash movement always says
what it was for.
