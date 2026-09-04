// CEE performance engine.
// Rebuilds daily NAV for both funds from the Schwab transaction history,
// anchored on the known 4/12/2026 holdings snapshot, and computes
// time-weighted return (benchmark-comparable) + money-weighted return (actual dollars).
const fs=require('fs'), https=require('https'), path=require('path');
const CACHE=path.join(__dirname,'pxcache');
if(!fs.existsSync(CACHE)) fs.mkdirSync(CACHE);

/* ---------- csv ---------- */
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

const ALIAS={BRKB:'BRK.B', 'BRK/B':'BRK.B', RGI:'RSPN'};              // Schwab symbol -> dashboard ticker
const YF   ={'BRK.B':'BRK-B'};                       // dashboard ticker -> Yahoo symbol
const norm=s=>ALIAS[s]||s;
const IS_CUSIP=s=>/^[0-9][0-9A-Z]{8}$/.test(s);
const BOND_CUSIP='91282CLW9';

const SH_IN=new Set(['Buy','Reinvest Shares','Spin-off','Reinvestment Adj']);
const SH_OUT=new Set(['Sell']);
const SH_DELTA=new Set(['Mandatory Reorg Exc','Cash Merger Adj']);
const SPLIT_ROW='Stock Split';                       // handled via Yahoo split factors instead
const INCOME=new Set(['Reinvest Dividend','Qual Div Reinvest','Qualified Dividend','Non-Qualified Div',
 'Special Qual Div','Cash Dividend','Pr Yr Non Qual Div','Pr Yr Div Reinvest','Bank Interest',
 'Bond Interest','Cash In Lieu','Cash Merger']);
const FEES=new Set(['Foreign Tax Paid','ADR Mgmt Fee']);
const EXTERNAL=new Set(['Wire Received','Wire Sent']);

function load(p,fund){
 const rows=parseCSV(fs.readFileSync(p,'utf8')),h=rows[0].map(x=>x.trim()),ix=n=>h.indexOf(n);
 const out=[];
 for(let i=1;i<rows.length;i++){const r=rows[i];const a=(r[ix('Action')]||'').trim();if(!a)continue;
  out.push({date:iso(r[ix('Date')]),action:a,sym:norm((r[ix('Symbol')]||'').trim()),
   qty:num(r[ix('Quantity')]),price:money(r[ix('Price')]),fee:money(r[ix('Fees & Comm')]),
   amt:money(r[ix('Amount')]),fund});}
 return out.filter(t=>t.date).sort((a,b)=>a.date.localeCompare(b.date));
}

/* ---------- prices ---------- */
function fetchJSON(url){return new Promise((res,rej)=>{
 const req=https.get(url,{headers:{'User-Agent':'Mozilla/5.0'}},r=>{let d='';r.on('data',c=>d+=c);
  r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})});
 req.on('error',rej); req.setTimeout(25000,()=>{req.destroy();rej(new Error('timeout'))});});}

async function getSeries(tk){
 const f=path.join(CACHE,tk.replace(/[^A-Z0-9.\-]/gi,'_')+'.json');
 if(fs.existsSync(f)) return JSON.parse(fs.readFileSync(f,'utf8'));
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
 fs.writeFileSync(f,JSON.stringify(out));
 return out;
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

/* Positions export -> the anchor the reconstruction is pinned to.
   Reading the dated Schwab file rather than the holdings node means the anchor
   date is never in doubt. The earlier version trusted Firebase, whose as-of date
   had to be recovered by matching prices because a workbook filename said April
   while its contents were actually July. */
function loadPositions(p){
 const rows=parseCSV(fs.readFileSync(p,'utf8'));
 const h=rows.findIndex(r=>r[0]==='Symbol');
 const hdr=rows[h].map(x=>x.trim());
 const ix=n=>hdr.findIndex(c=>c.startsWith(n));
 const iQty=ix('Qty'), iMv=ix('Mkt Val'), iType=ix('Asset Type');
 const out={shares:{},cash:0,type:{}};
 for(let i=h+1;i<rows.length;i++){
  const r=rows[i]; if(!r||!r[0]) continue;
  const sym=r[0].trim();
  if(sym==='Positions Total') continue;
  if(sym.startsWith('Cash')){ out.cash=money(r[iMv]); continue; }
  const tk=norm(sym), q=num(r[iQty]), at=(r[iType]||'').trim();
  if(!q) continue;
  out.shares[tk]=q;
  out.type[tk]=at.startsWith('ETF')?'etf':at.startsWith('Fixed')?'bond':'equity';
 }
 return out;
}

(async()=>{
 // Anchor = the as-of date carried in the positions export filenames.
 const ANCHOR='2026-09-02';
 const DL='C:\\Users\\Wmaxe\\Downloads\\';
 const FUNDS=[
  {name:'CEE Fund',key:'ceeFund',
   file:DL+'CEE_Fund_Portfolio_XXX948_Transactions_20260812-085629.csv',
   pos:DL+'CEE Fund Portfolio-Positions-2026-09-02-140153.csv'},
  {name:'Endowment',key:'endowment',
   file:DL+'CEE_Fund_Mngd_Endow_XXX047_Transactions_20260812-085807.csv',
   pos:DL+'CEE Fund Mngd Endow-Positions-2026-09-02-140132.csv'}];

 // Sector labels stay with the dashboard holdings, where the committee maintains
 // them; the positions export supplies share counts and cash.
 const live=await get('https://cee-fund-dashboard-640ab-default-rtdb.firebaseio.com/ceeHoldings.json');
 const sectorOf={}, typeOf={};
 for(const f of FUNDS){const lf=live[f.key]||{};
  (lf.equities||[]).forEach(h=>{sectorOf[h.ticker]=h.sector||'Other';typeOf[h.ticker]='equity'});
  (lf.etfs||[]).forEach(h=>{sectorOf[h.ticker]=h.sector||'Other';typeOf[h.ticker]='etf'});}

 const universe=new Set();
 // Transactions after the last CSV export, reconstructed from the August
 // statements and validated to reproduce the 9/2 positions exactly.
 const extraPath=path.join(__dirname,'new_tx.json');
 const extra=fs.existsSync(extraPath)?JSON.parse(fs.readFileSync(extraPath,'utf8')):[];
 for(const f of FUNDS){ f.tx=load(f.file,f.name); f.positions=loadPositions(f.pos);
  for(const [d,fund,t,a,q,pr,amt] of extra){
   if(fund!==f.name) continue;
   f.tx.push({date:d,action:a,sym:norm(t||''),qty:q||0,price:pr||0,fee:0,amt:amt||0,fund:f.name});
  }
  f.tx.sort((x,y)=>x.date.localeCompare(y.date));
  f.tx.forEach(t=>{if(t.sym&&!IS_CUSIP(t.sym))universe.add(t.sym)});
  Object.keys(f.positions.shares).forEach(t=>{ if(!IS_CUSIP(t)) universe.add(t);
   if(!typeOf[t]) typeOf[t]=f.positions.type[t]||'equity';
   if(!sectorOf[t]) sectorOf[t]='Other'; }); }
 const BENCH=['SPY','QQQ','VTI','VOO','XLK','XLF','XLV','XLY','XLC','XLI','XLP','XLE','XLU','XLB','XLRE','AGG'];
 BENCH.forEach(b=>universe.add(b));
 const tickers=[...universe].sort();
 console.log(`fetching daily history for ${tickers.length} tickers...`);

 const seriesArr=await pool(tickers,8,getSeries);
 const S={}; tickers.forEach((t,i)=>S[t]=seriesArr[i]);
 const failed=tickers.filter(t=>!S[t].ok);
 console.log(`  ok=${tickers.length-failed.length}  failed=${failed.length}${failed.length?' -> '+failed.join(', '):''}`);

 // split factor: product of ratios strictly AFTER date (Yahoo prices are back-adjusted)
 function splitFactor(tk,date){
  const sp=S[tk]?.splits||[]; let f=1;
  for(const s of sp) if(s.date>date) f*=s.ratio;
  return f;
 }
 const calendar=tradingDays(S['SPY'].px,'2022-08-15','2026-12-31');

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
    else { const ser=S[tk]; if(!ser||!ser.ok){missing.add(tk);continue;}
           px=ser.px[d]; if(px==null){ // carry last known close
             const keys=Object.keys(ser.px); let last=null;
             for(let i=keys.length-1;i>=0;i--) if(keys[i]<=d){last=ser.px[keys[i]];break;}
             px=last; }
           if(px==null) continue; }
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
    if(t.action!=='Buy'&&t.action!=='Sell') continue;
    tkFlowDay[t.sym]=(tkFlowDay[t.sym]||0)-t.amt;
   }
   for(const k of Object.keys(tkVal)){
    if(!tkFlow[k]) tkFlow[k]=new Array(tkVal[k].length-1).fill(0);
    tkFlow[k].push(+(tkFlowDay[k]||0).toFixed(2));
   }
   // Per-sector flows: only outright Buy/Sell count as allocation decisions.
   // Dividend reinvestment is left as internal growth because it IS return.
   const secFlowDay={};
   for(const t of (byDate[d]||[])){
    if(!t.sym) continue;
    if(t.action!=='Buy'&&t.action!=='Sell') continue;
    const sname=sectorOf[t.sym]||'Other';
    secFlowDay[sname]=(secFlowDay[sname]||0)-t.amt;   // buy amt is negative -> positive inflow
   }
   for(const k of Object.keys(sec)) if(!(k in secFlow)) secFlow[k]=new Array(nav.length).fill(0);
   for(const k of Object.keys(secFlow)) secFlow[k].push(+(secFlowDay[k]||0).toFixed(2));
   // same idea for the equity / ETF sleeves so their returns are real returns
   let eqF=0,etF=0;
   for(const t of (byDate[d]||[])){
    if(!t.sym||(t.action!=='Buy'&&t.action!=='Sell')) continue;
    if((typeOf[t.sym]||'equity')==='etf') etF-=t.amt; else eqF-=t.amt;
   }
   eqFlow.push(+eqF.toFixed(2)); etfFlow.push(+etF.toFixed(2));
   const dayFlow=(byDate[d]||[]).reduce((s,t)=>s+t.ext,0);
   nav.push(+total.toFixed(2)); flows.push(+dayFlow.toFixed(2));
   eqNav.push(+eq.toFixed(2)); etfNav.push(+etf.toFixed(2));
   for(const [k,v] of Object.entries(sec)){ (secNav[k]=secNav[k]||[]).push(+v.toFixed(2)); }
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
  OUT.funds[f.key]={
   name:f.name, nav, flows, eqNav, etfNav, twr, sectors:secNav, sectorTwr:secTwr,
   eqTwr:sleeveTwr(eqNav,eqFlow), etfTwr:sleeveTwr(etfNav,etfFlow), eqFlow, etfFlow,
   holdings, sectorFlows:secFlow,
   irr: irr!=null?+(irr*100).toFixed(2):null,
   externalFlows:+flows.reduce((a,b)=>a+b,0).toFixed(2),   // wires only, excl. opening NAV
   startNav:nav[0], endNav:nav[nav.length-1],
   missingPrices:[...missing]
  };
  const twrTotal=(twr[twr.length-1]/twr[0]-1)*100;
  console.log(`\n${f.name}`);
  console.log(`  window ${calendar[0]} -> ${calendar[calendar.length-1]}  (${calendar.length} trading days)`);
  console.log(`  NAV  $${nav[0].toLocaleString()}  ->  $${nav[nav.length-1].toLocaleString()}`);
  console.log(`  external capital wired : $${OUT.funds[f.key].externalFlows.toLocaleString()}`);
  console.log(`  TIME-weighted return   : ${twrTotal.toFixed(2)}%   (comparable to SPY)`);
  console.log(`  MONEY-weighted (IRR)   : ${irr!=null?(irr*100).toFixed(2)+'%/yr':'n/a'}`);
  if(missing.size) console.log(`  unpriced tickers: ${[...missing].join(', ')}`);
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

 // ── TRANSACTION LEDGER ──────────────────────────────────────────────────────
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
    q:t.qty||null,p:t.price||null,m:t.amt||0,e:t.fee||0};
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
 fs.writeFileSync(path.join(__dirname,'perf.json'),JSON.stringify(OUT));
 const spy=OUT.bench.SPY;
 console.log(`\nSPY over same window: ${((spy[spy.length-1]/spy[0]-1)*100).toFixed(2)}%`);
 console.log(`wrote perf.json (${(fs.statSync(path.join(__dirname,'perf.json')).size/1024).toFixed(0)} KB)`);
})();
