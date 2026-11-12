"""Bring Vanguard's month-end ETF holdings up to today and publish them.

The dashboard's look-through breaks each ETF into the stocks inside it. Every
other issuer publishes holdings daily. Vanguard publishes them once a month, as
of month end, a few weeks late - so by the middle of the following month its
funds are being read on weights six weeks old, and in a fast market that is a
long way out. On 12 November 2026 VOO's 30 September list still had Nvidia at
8.39% of the fund when the index held 6.39%.

There is nothing fresher to fetch. But the disclosure gives the number of shares
of each stock the fund held, and an index fund barely changes those between
rebalances: what moves the weights is price. So this re-prices them:

    weight today = weight at month end
                   x (stock's close today / stock's close at month end)
                   / (fund's close today  / fund's close at month end)

Dividing by the fund's own move is what makes it a weight again, and it needs no
other stock's price, so it is right for each name on its own even where the list
is incomplete (VTI's 3,600 names are read 500 deep).

It is an estimate, and it is tested every night. VOO and SPY hold the same
index, and State Street publishes SPY daily, so VOO re-priced is compared with
what SPY actually holds. On the day this was written the published month-end
weights were 12.9 points away from the truth in total and the re-priced ones
1.6, with the worst single stock 0.25 points out. If that gap ever opens up the
script refuses to publish, and the dashboard falls back to Vanguard's figures
as published, dated as what they are.

What re-pricing cannot see: a stock added to an index since month end is
missing until Vanguard's next disclosure, and one removed lingers.

    python tools/etf-holdings.py            # fetch, check, publish
    python tools/etf-holdings.py --dry-run  # fetch and print, publish nothing

Run by the nightly workflow. Writes one Firebase node, /ceeEtfHoldings, and
touches nothing else.
"""
import sys, os, json, time, datetime, importlib.util, urllib.request

FB = "https://cee-fund-dashboard-640ab-default-rtdb.firebaseio.com/"
NODE = FB + "ceeEtfHoldings.json"
UA = {"User-Agent": "Mozilla/5.0 (CEE Fund dashboard; ETF look-through)"}
VANGUARD = "https://investor.vanguard.com/vmf/api/{}/portfolio-holding/stock.json"
SPARK = "https://query1.finance.yahoo.com/v8/finance/spark?symbols={}&range={}&interval=1d"

MIN_PRICED = 97.0      # per cent of a fund's listed weight that must be re-priced
MAX_SUM_SHIFT = 2.5    # points the weights may gain or lose in total by being re-priced
MAX_INDEX_GAP = 5.0    # points, in total, VOO re-priced may sit from SPY's real weights
MAX_MOVE = 4.0         # a price that quadrupled or quartered is a bad match, not a move
STALE_DAYS = 6         # a constituent whose last close is this far behind the fund's is not priced


def get_json(url, tries=3):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                return json.load(r)
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(2 * (attempt + 1))


def funds_held():
    """The stock ETFs either fund owns that could be Vanguard's, from the published holdings.

    The published record does not always carry the fund's name - it can hold the
    ticker in its place - so this goes by Vanguard's naming, a V and two or three
    letters, and lets Vanguard itself say no: a ticker it does not recognise is
    skipped with a line in the log.
    """
    out = set()
    for key in ("endowment", "ceeFund"):
        for e in get_json(FB + "ceeHoldings/" + key + "/etfs.json") or []:
            tk = str((e or {}).get("ticker") or "").upper()
            named = "vanguard" in str(e.get("company") or "").lower()
            shaped = len(tk) in (3, 4) and tk.startswith("V") and tk.isalpha()
            if (named or shaped) and e.get("sector") != "Fixed Income":
                out.add(tk)
    return sorted(out)


def vanguard(tk):
    """Month-end date, how many names the fund holds, and (ticker, name, weight %) rows."""
    j = get_json(VANGUARD.format(tk))
    rows = []
    for e in (j.get("fund") or {}).get("entity") or []:
        sym = str(e.get("ticker") or "").strip().upper().replace(" ", ".").replace("/", ".")
        try:
            pct, mv = float(e.get("percentWeight") or 0), float(e.get("marketValue") or 0)
        except ValueError:
            continue
        if sym and pct > 0:
            rows.append([sym, str(e.get("longName") or e.get("shortName") or "").strip(), pct, mv])
    if len(rows) < 10:
        raise ValueError(f"{tk}: only {len(rows)} usable rows from Vanguard")
    # Published weights carry two decimals. Market values carry more, so use them
    # for the split and the published weights only for the scale.
    mv_sum, pct_sum = sum(r[3] for r in rows), sum(r[2] for r in rows)
    if mv_sum > 0 and all(r[3] > 0 for r in rows):
        for r in rows:
            r[2] = r[3] / mv_sum * pct_sum
    return str(j.get("asOfDate") or "")[:10], int(j.get("size") or len(rows)), [(r[0], r[1], r[2]) for r in rows]


def closes(symbols, rng, have):
    """Fill `have` (ticker -> {date: close}) for every symbol not already in it."""
    todo = [s for s in symbols if s not in have]
    for i in range(0, len(todo), 20):
        chunk = todo[i:i + 20]
        try:
            j = get_json(SPARK.format(",".join(s.replace(".", "-") for s in chunk), rng))
        except Exception:
            j = None
        if j is None and len(chunk) > 1:        # one unknown symbol fails the whole request
            for one in chunk:
                closes([one], rng, have)
            continue
        for s in chunk:
            d = (j or {}).get(s.replace(".", "-")) or {}
            have[s] = {datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%d"): c
                       for t, c in zip(d.get("timestamp") or [], d.get("close") or []) if c}
        time.sleep(0.2)
    return have


def at(series, day):
    ds = [d for d in series if d <= day]
    return (max(ds), series[max(ds)]) if ds else (None, None)


def reprice(tk, as_of, rows, px):
    fund = px.get(tk) or {}
    _, f0 = at(fund, as_of)
    if not fund or not f0:
        raise ValueError(f"{tk}: no fund price on or before {as_of}")
    priced = max(fund)
    fund_move = fund[priced] / f0
    floor = (datetime.date.fromisoformat(priced) - datetime.timedelta(days=STALE_DAYS)).isoformat()
    out, unpriced = [], []
    for sym, name, w in rows:
        s = px.get(sym) or {}
        _, p0 = at(s, as_of)
        d1, p1 = at(s, priced)
        move = (p1 / p0) if (p0 and p1) else None
        if move is None or d1 < floor or not (1 / MAX_MOVE < move < MAX_MOVE):
            unpriced.append(sym)
            out.append((sym, name, w))            # left at the published weight, and counted
        else:
            out.append((sym, name, w * move / fund_move))
    out.sort(key=lambda r: -r[2])
    listed = sum(r[2] for r in rows)
    left = sum(w for sym, _, w in rows if sym in set(unpriced))
    return dict(priced=priced, rows=out, unpriced=unpriced,
                priced_pct=(listed - left) / listed * 100 if listed else 0,
                before=listed, after=sum(r[2] for r in out), fund_move=fund_move)


def index_check(voo_rows):
    """VOO re-priced against what SPY really holds. None if State Street cannot be read."""
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        spec = importlib.util.spec_from_file_location("iw", os.path.join(here, "index-weights.py"))
        iw = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(iw)
        spy, spy_date = iw.spy_weights()
    except Exception as e:
        print(f"   index check unavailable: {e}")
        return None
    ours = {sym: w for sym, _, w in voo_rows}
    both = set(ours) & set(spy)
    if len(both) < 400:
        print(f"   index check unavailable: only {len(both)} names in common")
        return None
    gaps = sorted(((abs(ours[t] - spy[t]), t) for t in both), reverse=True)
    return dict(against="SPY", date=str(spy_date)[:10], names=len(both),
                totalGap=round(sum(g for g, _ in gaps), 2),
                worst=round(gaps[0][0], 3), worstTicker=gaps[0][1])


def main():
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    dry = "--dry-run" in sys.argv
    tickers = funds_held()
    print(f"Vanguard stock ETFs held: {', '.join(tickers) or 'none'}")
    if not tickers:
        return 0

    listings = {}
    for tk in tickers:
        try:
            listings[tk] = vanguard(tk)
            as_of, size, rows = listings[tk]
            print(f"   {tk}: {len(rows)} of {size} names as of {as_of}, {sum(r[2] for r in rows):.1f}% of the fund")
        except Exception as e:
            print(f"   {tk}: skipped - {e}")
    if not listings:
        print("nothing could be read from Vanguard - leaving the published node alone")
        return 1

    oldest = min(v[0] for v in listings.values())
    age = (datetime.date.today() - datetime.date.fromisoformat(oldest)).days
    rng = "3mo" if age < 75 else "6mo" if age < 165 else "1y"
    symbols = sorted({r[0] for v in listings.values() for r in v[2]} | set(listings))
    print(f"pricing {len(symbols)} symbols over {rng} ...")
    px = closes(symbols, rng, {})
    print(f"   {sum(1 for s in symbols if px.get(s))} priced")

    funds, problems = {}, []
    for tk, (as_of, size, rows) in listings.items():
        try:
            r = reprice(tk, as_of, rows, px)
        except Exception as e:
            problems.append(f"{tk}: {e}")
            continue
        shift = r["after"] - r["before"]
        line = (f"   {tk}: {as_of} -> {r['priced']}, fund {(r['fund_move']-1)*100:+.2f}%, "
                f"{r['priced_pct']:.1f}% of weight re-priced, weights sum {r['before']:.2f} -> {r['after']:.2f}")
        if r["priced_pct"] < MIN_PRICED:
            problems.append(f"{tk}: only {r['priced_pct']:.1f}% of weight could be re-priced")
            print(line + "  REFUSED"); continue
        if abs(shift) > MAX_SUM_SHIFT:
            problems.append(f"{tk}: weights moved {shift:+.2f} points in total, which re-pricing alone cannot do")
            print(line + "  REFUSED"); continue
        print(line + (f"  ({len(r['unpriced'])} left as published: {', '.join(r['unpriced'][:6])})" if r["unpriced"] else ""))
        funds[tk] = dict(asOf=as_of, priced=r["priced"], listed=size, unpriced=r["unpriced"][:40],
                         coverage=round(r["after"], 2),
                         holdings=[dict(s=s, n=n[:44], w=round(w, 4)) for s, n, w in r["rows"]])
        funds[tk]["_rows"] = r["rows"]

    check = None
    if "VOO" in funds:
        check = index_check(funds["VOO"]["_rows"])
        if check:
            print(f"index check: VOO re-priced vs SPY as held on {check['date']}: {check['totalGap']} points apart "
                  f"in total over {check['names']} names, worst {check['worst']} ({check['worstTicker']})")
            if check["totalGap"] > MAX_INDEX_GAP:
                print(f"REFUSING TO PUBLISH: that is past {MAX_INDEX_GAP} points, so the method is not to be trusted today")
                return 1
    for f in funds.values():
        f.pop("_rows", None)

    for p in problems:
        print("   ! " + p)
    if not funds:
        print("no fund passed its checks - leaving the published node alone")
        return 1

    out = dict(updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
               method="month-end share counts re-priced to the latest close", funds=funds, check=check)
    if dry:
        print(f"--dry-run: {len(funds)} funds ready, nothing written")
        for tk, f in funds.items():
            print(f"   {tk} top 5: " + ", ".join(f"{h['s']} {h['w']:.2f}%" for h in f["holdings"][:5]))
        return 0
    req = urllib.request.Request(NODE, data=json.dumps(out).encode(), method="PUT",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        print(f"published {len(funds)} funds to /ceeEtfHoldings: HTTP {r.status}")
    back = get_json(NODE)
    print("read back: " + ", ".join(f"{tk} {len(f['holdings'])} names priced {f['priced']}"
                                    for tk, f in sorted(back["funds"].items())))
    return 0 if not problems else 2


if __name__ == "__main__":
    sys.exit(main())
