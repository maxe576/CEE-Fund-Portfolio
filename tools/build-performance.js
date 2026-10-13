// CEE performance engine.
// Rebuilds daily NAV for both funds from the Schwab transaction history,
// anchored on the known 4/12/2026 holdings snapshot, and computes
// time-weighted return (benchmark-comparable) + money-weighted return (actual dollars).
const fs=require('fs'), https=require('https'), path=require('path');
const CACHE=path.join(__dirname,'pxcache');
if(!fs.existsSync(CACHE)) fs.mkdirSync(CACHE);
// Daily closes are cached per ticker, but only for 18 hours. The cache used to
// never expire, so a rebuild on a later day silently reused the old files and the
// performance series stayed frozen at the date the cache was first filled.
const CACHE_MAX_AGE_MS=18*3600e3;
// A file saved before the most recent close (4:15pm New York, weekdays) may hold an
// intraday price as its last bar, so it is stale however young it is.
function lastCloseMs(){
 const now=new Date(), ny=new Date(now.toLocaleString('en-US',{timeZone:'America/New_York'}));
 const offset=now.getTime()-ny.getTime();
 const c=new Date(ny); c.setHours(16,15,0,0);
 if(ny<c) c.setDate(c.getDate()-1);
 while(c.getDay()===0||c.getDay()===6) c.setDate(c.getDate()-1);
 return c.getTime()+offset;
}
const LAST_CLOSE_MS=lastCloseMs();
const cacheFresh=f=>{ const m=fs.statSync(f).mtimeMs; return Date.now()-m<CACHE_MAX_AGE_MS && m>=LAST_CLOSE_MS; };

/* ---------- csv (kept for the odd one-off import) ---------- */
function parseCSV(t){const rows=[];let row=[],cell='',q=false;
 for(let i=0;i<t.length;i++){const c=t[i];
  if(q){if(c==='"'){if(t[i+1]==='"'){cell+='"';i++}else q=false}else cell+=c}
  else if(c==='"')q=true; else if(c===','){row.push(cell);cell=''}
  else if(c==='\r'){} else if(c==='\n'){row.push(cell);rows.push(row);row=[];cell=''} else cell+=c}
 if(cell||row.length){row.push(cell);rows.push(row)} return rows.filter(r=>r.length>1)}
const money=s=>{if(!s)return 0;const n=parseFloat(String(s).replace(/[$,]/g,''));return isNaN(n)?0:n};
const num=s=>{if(!s)return 0;const n=parseFloat(String(s).replace(/,/g,''));return isNaN(n)?0:n};
const iso=s=>{const m=String(s).split(' as of ');const d=(m[1]||m[0]).trim().split('/');
 return d.length===3?`${d[2]}-${d[0].padStart(2,'0')}-${d[1].padStart(2,'0')}`:null};

const ALIAS={BRKB:'BRK.B', 'BRK/B':'BRK.B', RGI:'RSPN',          // Schwab symbol -> dashboard ticker
 // ExxonMobil's 2026-07-02 reorganisation: Schwab now files the pre-reorg shares
 // under the old CUSIP, which has no price series, so the holding dropped out of NAV
 // until the exchange and then reappeared as a one-day gain. Same company, same
 // shares, same XOM price history - so it is priced as XOM.
 '30231G102':'XOM'};
const YF   ={'BRK.B':'BRK-B'};                       // dashboard ticker -> Yahoo symbol
const norm=s=>ALIAS[s]||s;
const IS_CUSIP=s=>/^[0-9][0-9A-Z]{8}$/.test(s);
const BOND_CUSIP='91282CLW9';
// Holdings with no price history left anywhere, valued at the price the fund
// actually exited at. Left unpriced they are missing from NAV while held and their
// exit proceeds land as a one-day gain.
//   50187A107  LHC Group: cash merger into UnitedHealth, $170.00 a share on 2023-02-24
//   DISH       sold 2022-10-21 at $13.79; Yahoo no longer carries its history
const PX_PROXY={'50187A107':170.00,'DISH':13.79};
// Actions that move money into or out of a position. A cash merger is an exit just
// like a sale: without it the payout reads as a total loss on the position.
const POS_FLOW=new Set(['Buy','Sell','Cash Merger']);

const SH_IN=new Set(['Buy','Reinvest Shares','Spin-off','Reinvestment Adj']);
const SH_OUT=new Set(['Sell']);
const SH_DELTA=new Set(['Mandatory Reorg Exc','Cash Merger Adj']);
const SPLIT_ROW='Stock Split';                       // handled via Yahoo split factors instead
const INCOME=new Set(['Reinvest Dividend','Qual Div Reinvest','Qualified Dividend','Non-Qualified Div',
 'Special Qual Div','Cash Dividend','Pr Yr Non Qual Div','Pr Yr Div Reinvest','Bank Interest',
 'Bond Interest','Cash In Lieu','Cash Merger']);
const FEES=new Set(['Foreign Tax Paid','ADR Mgmt Fee']);
const EXTERNAL=new Set(['Wire Received','Wire Sent']);


/* ---------- prices ---------- */
function fetchJSON(url){return new Promise((res,rej)=>{
 const req=https.get(url,{headers:{'User-Agent':'Mozilla/5.0'}},r=>{let d='';r.on('data',c=>d+=c);
  r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})});
 req.on('error',rej); req.setTimeout(25000,()=>{req.destroy();rej(new Error('timeout'))});});}

async function getSeriesOnce(tk){
 const f=path.join(CACHE,tk.replace(/[^A-Z0-9.\-]/gi,'_')+'.json');
 if(fs.existsSync(f) && cacheFresh(f)){ const c=JSON.parse(fs.readFileSync(f,'utf8')); if(c&&c.ok) return c; }
 const y=YF[tk]||tk.replace('.','-');
 let out={px:{},splits:[],ok:false};
 try{
  const j=await fetchJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${y}?interval=1d&range=5y&events=split`);
  const r=j?.chart?.result?.[0];
  if(r&&r.timestamp){
   const cl=r.indicators.quote[0].close;
   r.timestamp.forEach((ts,i)=>{const c=cl[i];
    if(c!=null&&!isNaN(c)) out.px[new Date(ts*1000).toISOString().slice(0,10)]=+c.toFixed(4);});
   const sp=r.events?.splits;
   if(sp) Object.values(sp).forEach(s=>out.splits.push({
     date:new Date(s.date*1000).toISOString().slice(0,10),
     ratio:(s.numerator||1)/(s.denominator||1)}));
   out.ok=Object.keys(out.px).length>0;
  }
 }catch(e){ out.err=e.message; }
 if(out.ok) fs.writeFileSync(f,JSON.stringify(out));   // a refusal is never cached
 return out;
}
/* Yahoo refuses a burst of requests, and a refused request used to be written to the
   cache as if it were the answer - so every rebuild for the next 18 hours reused the
   failure and left that holding out of NAV (2026-09-22: AAPL, AMZN, BRK.B and 14
   others, the CEE Fund reading $194k instead of $220k). Now each ticker is retried
   with backoff, a failure is never cached, and if every attempt fails the last good
   saved prices are used instead. Holdings valued by hand (PX_PROXY) are not fetched. */
async function getSeries(tk){
 if(PX_PROXY[tk]!=null) return {px:{},splits:[],ok:false};
 const f=path.join(CACHE,tk.replace(/[^A-Z0-9.\-]/gi,'_')+'.json');
 let prev=null; try{ if(fs.existsSync(f)) prev=JSON.parse(fs.readFileSync(f,'utf8')); }catch(e){}
 for(let attempt=0;attempt<4;attempt++){
  const out=await getSeriesOnce(tk);
  if(out&&out.ok) return out;
  await new Promise(r=>setTimeout(r,1500*(attempt+1)*(attempt+1)));
 }
 if(prev&&prev.ok){
  console.warn(`  ${tk}: every download refused - using prices saved ${new Date(fs.statSync(f).mtimeMs).toISOString().slice(0,10)}`);
  return prev;
 }
 return {px:{},splits:[],ok:false};
}

/* The committee's own Price Data tab, published alongside the workbook.
   A price provider's history is not permanent: Yahoo now starts Energy Transfer
   at 2026-07-17, which left ET out of NAV for the two years the funds held it
   while its purchases still counted as money put to work - the Energy sector
   came out $1,502 (CEE) and $1,659 (Endowment) short. Where the provider has no
   close for a day, the workbook's close for that day is used instead.

   Splits are the one thing to be careful of here: the provider's closes are
   back-adjusted for later splits and the workbook's are the raw price of the
   day, so a ticker with a split inside the stretch being filled is left alone
   rather than valued on two different bases. */
function fillFromWorkbook(S,tickers,WB){
 if(!WB||!WB.dates||!WB.dates.length) return;
 const used=[],skipped=[];
 for(const tk of tickers){
  const col=WB.px[tk]; if(!col) continue;
  const ser=S[tk]||(S[tk]={px:{},splits:[],ok:false});
  const gaps=[];
  WB.dates.forEach((d,i)=>{ const v=col[i]; if(v!=null&&ser.px[d]==null) gaps.push([d,v]); });
  if(!gaps.length) continue;
  const from=gaps[0][0];
  if((ser.splits||[]).some(sp=>sp.date>=from)){ skipped.push(tk); continue; }
  gaps.forEach(([d,v])=>{ ser.px[d]=v; });
  ser.ok=Object.keys(ser.px).length>0;
  used.push(`${tk} ${gaps.length}d from ${from}`);
 }
 if(used.length) console.log(`  workbook prices filled provider gaps: ${used.join(', ')}`);
 if(skipped.length) console.log(`  workbook prices skipped (split inside the gap): ${skipped.join(', ')}`);
}

async function pool(items,n,fn){const res=[];let i=0;
 await Promise.all(Array.from({length:n},async()=>{while(i<items.length){const k=i++;res[k]=await fn(items[k],k)}}));
 return res}

/* ---------- helpers ---------- */
const get=u=>new Promise((res,rej)=>https.get(u,r=>{let d='';r.on('data',c=>d+=c);
 r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})}).on('error',rej));

function tradingDays(pxMap,from,to){
 return Object.keys(pxMap).filter(d=>d>=from&&d<=to).sort();
}
// XIRR via bisection on the discount rate
function xirr(flows){ // [{date, amt}] with final value as a positive flow
 const t0=new Date(flows[0].date);
 const yrs=f=>(new Date(f.date)-t0)/(365.25*864e5);
 const npv=r=>flows.reduce((s,f)=>s+f.amt/Math.pow(1+r,yrs(f)),0);
 let lo=-0.95,hi=10;
 if(npv(lo)*npv(hi)>0) return null;
 for(let i=0;i<200;i++){const mid=(lo+hi)/2; (npv(lo)*npv(mid)<=0?hi=mid:lo=mid);}
 return (lo+hi)/2;
}

(async()=>{
 /* Everything comes from the workbook the dashboard uploaded, published at
    /ceeHoldings: the Holdings Snapshot is the anchor (its date, share counts and
    cash), the Transactions tab is the ledger, and the Settings maps say which
    sector each ticker belongs to, which symbols are the same security, and which
    actions move money in or out of the funds. Nothing is read from a CSV sitting
    on one person's computer any more, so a rebuild needs only the latest upload -
    which is also what lets this run unattended. */
 const live=await get('https://cee-fund-dashboard-640ab-default-rtdb.firebaseio.com/ceeHoldings.json');
 if(!live||!live.endowment||!live.ceeFund){ console.error('No uploaded holdings found at /ceeHoldings.'); process.exit(1); }
 const ANCHOR=String(live.asOf||'').slice(0,10);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(ANCHOR)){
  console.error('The uploaded holdings carry no snapshot date. Upload the Master workbook (its Holdings Snapshot tab dates the anchor).');
  process.exit(1);
 }
 const asMap=v=>Array.isArray(v)?Object.fromEntries(v.filter(x=>Array.isArray(x)&&x.length>=2)):(v||{});
 // The workbook's Price Data tab rides in its own node: /ceeHoldings is fetched by
 // every visitor on every page load and this table is about a megabyte.
 let WBPX=null;
 try{
  const ph=await get('https://cee-fund-dashboard-640ab-default-rtdb.firebaseio.com/ceePriceHistory.json');
  if(ph&&Array.isArray(ph.dates)&&ph.dates.length){
   WBPX={dates:ph.dates,px:asMap(ph.px)};
   console.log(`workbook prices: ${ph.dates.length} days, ${Object.keys(WBPX.px).length} tickers (${ph.dates[0]} -> ${ph.dates[ph.dates.length-1]})`);
  }
 }catch(e){ console.warn('no workbook price history available:',e.message); }
 const st=live.settings||{};
 const SYMBOL_MAP=asMap(st.symbolMap), SECTOR_MAP=asMap(st.sectorMap), TYPE_MAP=asMap(st.typeMap);
 const normSym=x=>{ const t=String(x||'').trim().toUpperCase(); return SYMBOL_MAP[t]||ALIAS[t]||t; };
 // The workbook lists the actions that move capital in or out; fall back to the built-in pair.
 if(Array.isArray(st.flowActions)&&st.flowActions.length){ EXTERNAL.clear(); st.flowActions.forEach(a=>EXTERNAL.add(String(a).trim())); }

 const FUNDS=[{name:'CEE Fund',key:'ceeFund'},{name:'Endowment',key:'endowment'}];
 const sectorOf={}, typeOf={};
 for(const [tk,sec] of Object.entries(SECTOR_MAP)) if(sec) sectorOf[normSym(tk)]=sec;
 for(const [tk,ty] of Object.entries(TYPE_MAP)) typeOf[normSym(tk)]=ty==='etf'?'etf':'equity';
 for(const f of FUNDS){
  const lf=live[f.key]||{};
  (lf.equities||[]).forEach(h=>{ const t=normSym(h.ticker); sectorOf[t]=h.sector||sectorOf[t]||'Other'; typeOf[t]='equity'; });
  (lf.etfs||[]).forEach(h=>{ const t=normSym(h.ticker); sectorOf[t]=h.sector||sectorOf[t]||'Other'; typeOf[t]='etf'; });
 }

 const ledgerRows=Array.isArray(live.transactions)?live.transactions:[];
 if(!ledgerRows.length){ console.error('The uploaded holdings carry no transactions.'); process.exit(1); }
 const universe=new Set();
 for(const f of FUNDS){
  // One ledger covers both funds; split it and put it in the shape the walk expects.
  f.tx=ledgerRows.filter(t=>String(t.fund||'').trim()===f.name)
   .map(t=>({date:String(t.date||'').slice(0,10),action:String(t.action||'').trim(),
     sym:t.ticker?normSym(t.ticker):'',qty:+t.shares||0,price:+t.price||0,fee:+t.fees||0,
     amt:+t.amount||0,fund:f.name,desc:t.desc||t.description||''}))
   .filter(t=>/^\d{4}-\d{2}-\d{2}$/.test(t.date)&&t.action)
   .sort((a,b)=>a.date.localeCompare(b.date));
  const lf=live[f.key]||{}, shares={}, type={};
  [...(lf.equities||[]),...(lf.etfs||[])].forEach(h=>{ const t=normSym(h.ticker); if(h.shares) shares[t]=h.shares; type[t]=h.type==='etf'?'etf':'equity'; });
  // The Treasury is held outside the equity and ETF lists.
  (lf.bond?(Array.isArray(lf.bond)?lf.bond:[lf.bond]):[]).forEach(b=>{
   if(b&&b.ticker&&b.shares){ shares[normSym(b.ticker)]=b.shares; type[normSym(b.ticker)]='bond'; sectorOf[normSym(b.ticker)]='Fixed Income'; }
  });
  f.positions={shares,cash:+lf.cash||0,type};
  f.tx.forEach(t=>{ if(t.sym&&!IS_CUSIP(t.sym)) universe.add(t.sym); });
  Object.keys(shares).forEach(t=>{ if(!IS_CUSIP(t)) universe.add(t);
   if(!typeOf[t]) typeOf[t]=type[t]||'equity';
   if(!sectorOf[t]) sectorOf[t]='Other'; });
 }
 console.log(`anchor ${ANCHOR} from ${live.source||'the uploaded workbook'} - ${ledgerRows.length} ledger rows, ` +
   `${FUNDS.map(f=>f.name+' '+Object.keys(f.positions.shares).length).join(', ')} positions`);

 const BENCH=['SPY','QQQ','VTI','VOO','XLK','XLF','XLV','XLY','XLC','XLI','XLP','XLE','XLU','XLB','XLRE','AGG'];
 BENCH.forEach(b=>universe.add(b));
 const tickers=[...universe].sort();
 console.log(`fetching daily history for ${tickers.length} tickers...`);

 const seriesArr=await pool(tickers,4,getSeries);   // 8 at once is what Yahoo throttled
 const S={}; tickers.forEach((t,i)=>S[t]=seriesArr[i]);
 fillFromWorkbook(S,tickers,WBPX);
 const failed=tickers.filter(t=>!S[t].ok);
 console.log(`  ok=${tickers.length-failed.length}  failed=${failed.length}${failed.length?' -> '+failed.join(', '):''}`);

 // split factor: product of ratios strictly AFTER date (Yahoo prices are back-adjusted)
 function splitFactor(tk,date){
  const sp=S[tk]?.splits||[]; let f=1;
  for(const s of sp) if(s.date>date) f*=s.ratio;
  return f;
 }
 const calendar=tradingDays(S['SPY'].px,'2022-08-15','2026-12-31');
 // A session that has not closed has no close yet: Yahoo reports the latest trade,
 // and a series built mid-session bakes that in (how 2026-09-04 came to carry
 // intraday prices). Leave today out until 4:15pm New York time.
 {
  const ny=new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
  const todayNY=ny.getFullYear()+'-'+String(ny.getMonth()+1).padStart(2,'0')+'-'+String(ny.getDate()).padStart(2,'0');
  if(calendar.length&&calendar[calendar.length-1]===todayNY&&ny.getHours()*60+ny.getMinutes()<16*60+15){
   calendar.pop(); console.log('  leaving out '+todayNY+': the session has not closed');
  }
 }

 const HOLD={funds:{}};   // per-position daily series for the sector drill-down
 const OUT={generatedAt:new Date().toISOString(),anchor:ANCHOR,dates:calendar,funds:{},meta:{}};

 for(const f of FUNDS){
  // anchor positions in ADJUSTED share space, taken from the positions export
  const anchorAdj={};
  for(const [tk,q] of Object.entries(f.positions.shares)){
   anchorAdj[tk]=IS_CUSIP(tk)?q:q*splitFactor(tk,ANCHOR);
  }
  let anchorCash=f.positions.cash||0;

  // transactions in adjusted space (Stock Split rows dropped - factor handles them)
  const tx=f.tx.filter(t=>t.action!==SPLIT_ROW).map(t=>{
   const fac=t.sym&&!IS_CUSIP(t.sym)?splitFactor(t.sym,t.date):1;
   let dq=0;
   if(SH_IN.has(t.action))dq=t.qty; else if(SH_OUT.has(t.action))dq=-t.qty;
   else if(SH_DELTA.has(t.action))dq=t.qty;
   let dc=0;
   if(SH_IN.has(t.action)||SH_OUT.has(t.action)||SH_DELTA.has(t.action)||INCOME.has(t.action)||FEES.has(t.action)||EXTERNAL.has(t.action))dc=t.amt;
   return {...t,dq:dq*fac,dc:dc-(t.fee||0),ext:EXTERNAL.has(t.action)?t.amt:0};
  });

  // walk BACK from anchor to build the position/cash state at the window start
  const pos={},cashAt={};
  Object.assign(pos,anchorAdj);
  let cash=anchorCash;
  const pre=tx.filter(t=>t.date<=ANCHOR).sort((a,b)=>b.date.localeCompare(a.date));
  for(const t of pre){ if(t.dq&&t.sym) pos[t.sym]=(pos[t.sym]||0)-t.dq; cash-=t.dc; }
  // clamp sub-share drift from snapshot/log timing
  for(const k of Object.keys(pos)) if(pos[k]<0&&pos[k]>-1.5) pos[k]=0;

  // now walk FORWARD across the calendar, applying each day's transactions
  const byDate={};
  tx.forEach(t=>{(byDate[t.date]=byDate[t.date]||[]).push(t)});

  const nav=[],flows=[],eqNav=[],etfNav=[],eqFlow=[],etfFlow=[],secNav={},secFlow={},missing=new Set();
  // Days a holding was held but could not be priced. These do not show up in
  // `missing` - the series exists, it just does not reach back far enough - and
  // they are what made the sector totals and the position totals disagree.
  const unpricedDays={};
  // Per-position daily value and flow, so we can report what WE earned on a
  // holding rather than what the security did. Buying NVDA in March means our
  // return starts in March, not on 1 January.
  const tkVal={},tkFlow={};
  const start=calendar[0];
  // transactions dated before the calendar starts must be re-applied up front,
  // otherwise the backward walk removed them and nothing puts them back
  for(const t of tx.filter(t=>t.date<calendar[0])){ if(t.dq&&t.sym) pos[t.sym]=(pos[t.sym]||0)+t.dq; cash+=t.dc; }
  let anchorPos=null, anchorCashDbg=null;
  for(const d of calendar){
   for(const t of (byDate[d]||[])){ if(t.dq&&t.sym) pos[t.sym]=(pos[t.sym]||0)+t.dq; cash+=t.dc; }
   if(anchorPos===null&&d>=ANCHOR){ anchorPos=Object.assign({},pos); anchorCashDbg=cash; }
   let total=cash,eq=0,etf=0; const sec={};
   for(const [tk,sh] of Object.entries(pos)){
    if(Math.abs(sh)<1e-6) continue;
    let px;
    if(tk===BOND_CUSIP) px=0.99;                       // Treasury par proxy
    else if(PX_PROXY[tk]!=null) px=PX_PROXY[tk];      // no history left: exit price
    else { const ser=S[tk]; if(!ser||!ser.ok){missing.add(tk);continue;}
           px=ser.px[d]; if(px==null){ // carry last known close
             const keys=Object.keys(ser.px); let last=null;
             for(let i=keys.length-1;i>=0;i--) if(keys[i]<=d){last=ser.px[keys[i]];break;}
             px=last; }
           if(px==null){ (unpricedDays[tk]=unpricedDays[tk]||{days:0,first:d,last:d}).days++;
             unpricedDays[tk].last=d; continue; } }
    const v=sh*px; total+=v;
    const ty=typeOf[tk]||'equity';
    if(ty==='etf')etf+=v; else eq+=v;
    const sname=sectorOf[tk]||'Other';
    sec[sname]=(sec[sname]||0)+v;
    if(!tkVal[tk]) tkVal[tk]=new Array(nav.length).fill(0);
    tkVal[tk].push(+v.toFixed(2));
   }
   // pad positions not held today, and record each one's purchases/sales
   for(const k of Object.keys(tkVal)) if(tkVal[k].length<nav.length+1) tkVal[k].push(0);
   const tkFlowDay={};
   for(const t of (byDate[d]||[])){
    if(!t.sym) continue;
    if(!POS_FLOW.has(t.action)) continue;
    tkFlowDay[t.sym]=(tkFlowDay[t.sym]||0)-t.amt;
   }
   // A ticket on a holding we could not value still happened. Give it a series of
   // zeros so the flow is kept: dropping it is how Energy's sector total came to
   // show purchases the position series knew nothing about.
   for(const k of Object.keys(tkFlowDay)) if(!tkVal[k]) tkVal[k]=new Array(nav.length+1).fill(0);
   for(const k of Object.keys(tkVal)){
    if(!tkFlow[k]) tkFlow[k]=new Array(tkVal[k].length-1).fill(0);
    tkFlow[k].push(+(tkFlowDay[k]||0).toFixed(2));
   }
   // Per-sector flows: only outright Buy/Sell count as allocation decisions.
   // Dividend reinvestment is left as internal growth because it IS return.
   const secFlowDay={};
   for(const t of (byDate[d]||[])){
    if(!t.sym) continue;
    if(!POS_FLOW.has(t.action)) continue;
    const sname=sectorOf[t.sym]||'Other';
    secFlowDay[sname]=(secFlowDay[sname]||0)-t.amt;   // buy amt is negative -> positive inflow
   }
   for(const k of [...Object.keys(sec),...Object.keys(secFlowDay)]) if(!(k in secFlow)) secFlow[k]=new Array(nav.length).fill(0);
   for(const k of Object.keys(secFlow)) secFlow[k].push(+(secFlowDay[k]||0).toFixed(2));
   // same idea for the equity / ETF sleeves so their returns are real returns
   let eqF=0,etF=0;
   for(const t of (byDate[d]||[])){
    if(!t.sym||!POS_FLOW.has(t.action)) continue;
    if((typeOf[t.sym]||'equity')==='etf') etF-=t.amt; else eqF-=t.amt;
   }
   eqFlow.push(+eqF.toFixed(2)); etfFlow.push(+etF.toFixed(2));
   const dayFlow=(byDate[d]||[]).reduce((s,t)=>s+t.ext,0);
   nav.push(+total.toFixed(2)); flows.push(+dayFlow.toFixed(2));
   eqNav.push(+eq.toFixed(2)); etfNav.push(+etf.toFixed(2));
   // A sector first held partway through the calendar has to start with zeros for the
   // days before it existed. Without them its series began at index 0, and the padding
   // below then added a second entry every day until it caught up, so the early part
   // of the series was shifted in time (CEE Utilities was misdated through mid-2024;
   // Endowment Broad Market never lined up at all).
   for(const [k,v] of Object.entries(sec)){ (secNav[k]=secNav[k]||new Array(nav.length-1).fill(0)).push(+v.toFixed(2)); }
   // pad sectors that had no holdings this day
   for(const k of Object.keys(secNav)) if(secNav[k].length<nav.length) secNav[k].push(0);
  }

  // time-weighted index (external flows removed)
  const twr=[100];
  for(let i=1;i<nav.length;i++){
   const prev=nav[i-1]||1, r=prev>0?((nav[i]-flows[i])-prev)/prev:0;
   twr.push(+(twr[i-1]*(1+r)).toFixed(4));
  }
  // money-weighted (XIRR): flows out = investment, final NAV = positive
  const xf=[{date:calendar[0],amt:-nav[0]}];
  calendar.forEach((d,i)=>{if(flows[i])xf.push({date:d,amt:-flows[i]})});
  xf.push({date:calendar[calendar.length-1],amt:nav[nav.length-1]});
  const irr=xirr(xf);

  // chain-linked TWR index per sector (allocation flows removed)
  const secTwr={};
  for(const [s,series] of Object.entries(secNav)){
   const fl=secFlow[s]||[]; const idx=[100];
   for(let i=1;i<series.length;i++){
    const prev=series[i-1];
    const r=prev>100?((series[i]-(fl[i]||0))-prev)/prev:0;   // ignore near-zero bases
    idx.push(+(idx[i-1]*(1+r)).toFixed(4));
   }
   secTwr[s]=idx;
  }
  /* Per-holding, per-period results.
     ourRet chain-links daily returns only across days the position was actually
     held, with purchases and sales removed - so it answers "what did this
     position earn us", not "what did the security do". */
  const PERIOD_KEYS=['1W','1M','3M','6M','YTD','1Y','3Y','5Y','ALL'];
  const startIdxFor=p=>{
   const last=calendar[calendar.length-1];
   if(p==='ALL') return 0;
   const end=new Date(last+'T00:00:00'); let from;
   if(p==='YTD') from=new Date(Date.UTC(end.getUTCFullYear(),0,1));
   else{ from=new Date(end); const n=parseInt(p);
    if(p.endsWith('W')) from.setDate(from.getDate()-7*n);
    else if(p.endsWith('M')) from.setMonth(from.getMonth()-n);
    else from.setFullYear(from.getFullYear()-n); }
   const iso=from.toISOString().slice(0,10);
   for(let i=0;i<calendar.length;i++) if(calendar[i]>=iso) return i;
   return 0;
  };
  const holdings={};
  const endI=calendar.length-1;
  for(const [tk,vals] of Object.entries(tkVal)){
   const fl=tkFlow[tk]||[];
   const perPeriod={};
   for(const p of PERIOD_KEYS){
    const s0=startIdxFor(p);
    let idx=null, gain=0, firstHeld=null, started=false;
    for(let i=Math.max(s0,1);i<=endI;i++){
     const prev=vals[i-1], cur=vals[i], f=fl[i]||0;
     if(prev>0.005){
      if(!started){ idx=1; started=true; firstHeld=firstHeld||calendar[i-1]; }
      idx*= (1+((cur-f)-prev)/prev);
      gain+=(cur-f)-prev;
     } else if(cur>0.005 && !started){ firstHeld=calendar[i]; }
    }
    // the security's own return over the same window, for contrast
    let sret=null;
    const ser=S[tk];
    if(ser&&ser.ok){
     const a=ser.px[calendar[s0]],b=ser.px[calendar[endI]];
     if(a>0&&b>0) sret=+((b/a-1)*100).toFixed(2);
    }
    if(started) perPeriod[p]={r:+((idx-1)*100).toFixed(2),g:Math.round(gain),from:firstHeld,s:sret};
   }
   if(Object.keys(perPeriod).length) holdings[tk]=perPeriod;
  }

  const sleeveTwr=(series,fl)=>{const idx=[100];
   for(let i=1;i<series.length;i++){const prev=series[i-1];
    const r=prev>100?((series[i]-(fl[i]||0))-prev)/prev:0;
    idx.push(+(idx[i-1]*(1+r)).toFixed(4));} return idx;};
  /* Per-position daily value and buy/sell flows, exported so the dashboard can
     compute any window - preset or custom - from the same numbers the sector
     totals are built from. Only runs of non-zero days are kept, as [startIdx, values].
     Negative values stay in: a sale the history cannot match to a purchase leaves a
     negative position, and it is in the sector totals, so it has to be here too. */
  const runsOf=vals=>{ const runs=[]; let cur=null;
   vals.forEach((v,i)=>{ if(Math.abs(v)>0.005){ if(!cur){ cur=[i,[]]; runs.push(cur); } cur[1].push(v); } else cur=null; });
   return runs; };
  HOLD.funds[f.key]=Object.entries(tkVal).map(([tk,vals])=>{
   const fl=(tkFlow[tk]||[]).map((amt,i)=>[i,amt]).filter(x=>Math.abs(x[1])>0.004);
   return [tk, runsOf(vals), fl];
  }).filter(r=>r[1].length||r[2].length);
  OUT.funds[f.key]={
   name:f.name, nav, flows, eqNav, etfNav, twr, sectors:secNav, sectorTwr:secTwr,
   eqTwr:sleeveTwr(eqNav,eqFlow), etfTwr:sleeveTwr(etfNav,etfFlow), eqFlow, etfFlow,
   holdings, sectorFlows:secFlow,
   irr: irr!=null?+(irr*100).toFixed(2):null,
   externalFlows:+flows.reduce((a,b)=>a+b,0).toFixed(2),   // wires only, excl. opening NAV
   startNav:nav[0], endNav:nav[nav.length-1],
   missingPrices:[...missing],
   unpricedDays
  };
  const twrTotal=(twr[twr.length-1]/twr[0]-1)*100;
  console.log(`\n${f.name}`);
  console.log(`  window ${calendar[0]} -> ${calendar[calendar.length-1]}  (${calendar.length} trading days)`);
  console.log(`  NAV  $${nav[0].toLocaleString()}  ->  $${nav[nav.length-1].toLocaleString()}`);
  console.log(`  external capital wired : $${OUT.funds[f.key].externalFlows.toLocaleString()}`);
  console.log(`  TIME-weighted return   : ${twrTotal.toFixed(2)}%   (comparable to SPY)`);
  console.log(`  MONEY-weighted (IRR)   : ${irr!=null?(irr*100).toFixed(2)+'%/yr':'n/a'}`);
  if(missing.size) console.log(`  unpriced tickers: ${[...missing].join(', ')}`);
  for(const [tk,u] of Object.entries(unpricedDays))
   console.log(`  ${tk}: held but no price on ${u.days} day${u.days>1?'s':''} (${u.first} -> ${u.last})`);
 }

 // benchmarks over the same calendar
 OUT.bench={};
 for(const b of BENCH){ if(!S[b]?.ok) continue;
  const arr=calendar.map(d=>{const p=S[b].px[d]; return p??null;});
  for(let i=1;i<arr.length;i++) if(arr[i]==null) arr[i]=arr[i-1];
  if(arr[0]==null) continue;
  OUT.bench[b]=arr.map(v=>v==null?null:+v.toFixed(4));
 }
 OUT.meta.sectorOf=sectorOf; OUT.meta.typeOf=typeOf;

 {
  const unpriced=Object.values(OUT.funds).flatMap(f=>[
   ...(f.missingPrices||[]).map(t=>`${f.name}: ${t} (no price history at all)`),
   ...Object.entries(f.unpricedDays||{}).map(([t,u])=>`${f.name}: ${t} (held ${u.days} day${u.days>1?'s':''} with no price, ${u.first} -> ${u.last})`)
  ]);
  if(unpriced.length){
   console.error('\nNOT WRITTEN - these holdings could not be priced for days they were held, so the fund values would be wrong:\n  '+unpriced.join('\n  '));
   console.error("Add the missing closes to the workbook's Price Data tab and re-upload, re-run in a few minutes,");
   console.error('or add the symbol to ALIAS / PX_PROXY if it will never price again.');
   process.exit(1);
  }
 }
 // \u2500\u2500 TRANSACTION LEDGER ──────────────────────────────────────────────────────
 // Published separately so the Performance tab does not pay to download it.
 // Compact keys: d date, f fund, a action, t ticker, q shares, p price, m amount.
 const DIV_ACTIONS=new Set([...INCOME].filter(a=>a!=='Cash Merger'));
 // A trade price is the raw price paid that day; the "price now" it gets
 // compared against is split-adjusted. Without the factor between them, a
 // 4-for-1 split reads as a 75% collapse. sf carries that factor so the two
 // sides of every comparison sit on the same basis.
 const ledger=[];
 for(const f of FUNDS){
  for(const t of f.tx){
   const sf=t.sym&&!IS_CUSIP(t.sym)?splitFactor(t.sym,t.date):1;
   const rec={d:t.date,f:f.key==='ceeFund'?'C':'E',a:t.action,t:t.sym||null,
    q:t.qty||null,p:t.price||null,m:t.amt||0,e:t.fee||0,desc:t.desc||''};
   if(Math.abs(sf-1)>1e-9) rec.sf=+sf.toFixed(6);
   ledger.push(rec);
  }
 }
 ledger.sort((a,b)=>b.d.localeCompare(a.d));
 // Latest close per ticker, so the ledger can show what a trade did afterwards
 const lastPx={};
 for(const tk of tickers){ const ser=S[tk]; if(!ser||!ser.ok) continue;
  const keys=Object.keys(ser.px); if(keys.length) lastPx[tk]=ser.px[keys[keys.length-1]]; }
 // Every split that touched a ticker we have traded, so the ledger can say
 // which one moved a given row.
 const splitsOut={};
 for(const tk of tickers){ const sp=S[tk]?.splits||[]; if(sp.length) splitsOut[tk]=sp.map(x=>[x.date,+x.ratio.toFixed(4)]); }
 const LEDGER={generatedAt:OUT.generatedAt,asOf:calendar[calendar.length-1],
   tx:ledger, lastPx:Object.entries(lastPx), splits:Object.entries(splitsOut),
   dividendActions:[...DIV_ACTIONS], externalActions:[...EXTERNAL]};
 fs.writeFileSync(path.join(__dirname,'ledger.json'),JSON.stringify(LEDGER));
 console.log(`ledger.json: ${ledger.length} transactions, ${Object.keys(lastPx).length} last prices ` +
   `(${(fs.statSync(path.join(__dirname,'ledger.json')).size/1024).toFixed(0)} KB)`);
 // Daily closes for every position we held (last close carried over gaps), so the
 // drill-down can show what the security itself did over any window.
 const heldTk=new Set(); Object.values(HOLD.funds).forEach(list=>list.forEach(r=>heldTk.add(r[0])));
 HOLD.px=[...heldTk].filter(tk=>S[tk]&&S[tk].ok).map(tk=>{
  const arr=calendar.map(d=>{ const p=S[tk].px[d]; return p??null; });
  for(let i=1;i<arr.length;i++) if(arr[i]==null) arr[i]=arr[i-1];
  const o=arr.findIndex(v=>v!=null); if(o<0) return null;
  return [tk,o,arr.slice(o).map(v=>+v.toFixed(v<10?4:2))];
 }).filter(Boolean);
 HOLD.generatedAt=OUT.generatedAt; HOLD.n=calendar.length; HOLD.first=calendar[0]; HOLD.last=calendar[calendar.length-1];
 fs.writeFileSync(path.join(__dirname,'perf_holdings.json'),JSON.stringify(HOLD));
 console.log(`perf_holdings.json: ${Object.values(HOLD.funds).map(l=>l.length).join(' + ')} positions, ${HOLD.px.length} price series ` +
   `(${(fs.statSync(path.join(__dirname,'perf_holdings.json')).size/1024).toFixed(0)} KB)`);
 fs.writeFileSync(path.join(__dirname,'perf.json'),JSON.stringify(OUT));
 const spy=OUT.bench.SPY;
 console.log(`\nSPY over same window: ${((spy[spy.length-1]/spy[0]-1)*100).toFixed(2)}%`);
 console.log(`wrote perf.json (${(fs.statSync(path.join(__dirname,'perf.json')).size/1024).toFixed(0)} KB)`);
})();
