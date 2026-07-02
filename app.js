// CEE Fund Dashboard — application logic. Requires data.js to be loaded first.

console.log('%cCEE Dashboard build v28 — split into styles.css / data.js / app.js; rolling news dates; hashed admin credentials','color:#c9a84c;font-weight:bold;font-size:13px');

// ── DATE HELPERS ──────────────────────────────────────────────────────────────
// Rolling YYYY-MM-DD strings so API date windows never go stale.
const isoToday = () => new Date().toISOString().slice(0, 10);
const isoDaysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

// ── STATE ─────────────────────────────────────────────────────────────────────
let activeFund = 'endowment';
let activeSCPeriod = '1D';
let activeSCSector = null;
let currentSCView = 'top';
let historicalCache = {};
let newsCache = {};
let calCache = null;
let wsTargetCache = {};
let clubTargets = JSON.parse(localStorage.getItem('cee_club_targets') || '{}');
let livePrices = {};
let spxData = null;
let S = {};
let scChartRef = null;
let logoClickCount = 0;
let logoClickTimer = null;
let secretBuffer = '';

// ── INIT ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadHoldingsFromFirebase();
  buildState();
  renderAll();
  initWiTrades();
  if (localStorage.getItem('cee_upload_pw')) document.getElementById('uploadBtn').classList.add('visible');
  setTimeout(fetchSPX, 2000);
}

function buildState() {
  const fund = activeFund === 'endowment' ? RAW.endowment : RAW.ceeFund;
  const all = [...fund.equities, ...fund.etfs];
  const bondVal = activeFund === 'endowment' ? (RAW.endowment.bond?.marketValue || 0) : 0;
  const total = all.reduce((s,h) => s+(h.marketValue||0), 0) + (fund.cash||0) + bondVal;
  const equityTotal=all.filter(h=>!['Broad Market','Fixed Income'].includes(h.sector)).reduce((s,h)=>s+(h.marketValue||0),0)||1;
  S = { holdings:all, equities:fund.equities, etfs:fund.etfs, cash:fund.cash,
    bond: activeFund==='endowment'?fund.bond:null, total, equityTotal, fund:activeFund,
    fundName: activeFund==='endowment'?'Endowment':'CEE Fund',
    beta: all.reduce((s,h)=>s+(h.beta||1)*(h.marketValue||0),0)/(total||1) };
}

// ── RETURN CALCULATIONS ───────────────────────────────────────────────────────
function calcFundYTDReturn(fundKey) {
  const b = YTD_BASELINES[fundKey];
  if (!b) return 0;
  const fd = fundKey==='endowment'?RAW.endowment:RAW.ceeFund;
  const cur = [...fd.equities,...fd.etfs].reduce((s,h)=>s+(h.marketValue||0),0) + (fd.cash||0) + (fundKey==='endowment'?(RAW.endowment.bond?.marketValue||0):0);
  return (cur - b.jan1Total) / b.jan1Total * 100;
}

function calcReturn(holdings, fundKey) {
  const spMap = fundKey ? (START_PRICES[fundKey]||{}) : {};
  let totalStart=0, totalMV=0;
  for (const h of holdings) {
    const sp = spMap[h.ticker] || JAN1_PRICES[h.ticker] || null;
    totalMV += h.marketValue||0;
    totalStart += sp&&h.shares ? sp*h.shares : (h.costBasis||h.marketValue||0);
  }
  return totalStart>0 ? (totalMV-totalStart)/totalStart*100 : 0;
}

function calcSectors(holdings, total) {
  const m = {};
  for (const h of holdings) {
    const sec = h.sector||'Other';
    if (!m[sec]) m[sec] = {value:0, beta_num:0, holdings:[]};
    m[sec].value += h.marketValue||0;
    m[sec].beta_num += (h.beta||1)*(h.marketValue||0);
    m[sec].holdings.push(h);
  }
  // Diversification denominator = real sectors only (exclude Broad Market & Fixed Income),
  // so true sector weights sum to 100%. Matches the Investment Thesis tab basis.
  const SECTOR_EXCLUDE = ['Broad Market', 'Fixed Income'];
  const sectorBase = Object.entries(m).filter(([name])=>!SECTOR_EXCLUDE.includes(name)).reduce((s,[,d])=>s+d.value,0) || 1;
  return Object.entries(m).map(([name,d])=>({name,value:d.value,pct:d.value/sectorBase,beta:d.beta_num/(d.value||1),holdings:d.holdings})).sort((a,b)=>b.value-a.value);
}

// Core sector view = real GICS sectors only; Broad Market + Fixed Income holdings
// (index funds, bond ETFs) are excluded so sector weights describe active bets.
const CORE_EXCLUDE = ['Broad Market','Fixed Income'];
function coreSectorsOf(holdings) {
  const filt = holdings.filter(h => !CORE_EXCLUDE.includes(h.sector));
  const total = filt.reduce((s,h) => s + (h.marketValue||0), 0) || 1;
  return calcSectors(filt, total);
}

// ── RENDER ALL ────────────────────────────────────────────────────────────────
function renderAll() {
  renderKPIs(); renderSectorBarsOverview(); renderComposition();
  renderTop10(); renderHoldings('all'); renderSectorDetail();
  renderSectorBeta(); renderBenchmark(); renderSectorCards();
  if(typeof renderMcapBreakdown==='function') renderMcapBreakdown();
}

// ── SHOW TAB ──────────────────────────────────────────────────────────────────
function showTab(tab, btn) {
  document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t=>t.classList.remove('active'));
  const _tp=document.getElementById('tab-'+tab); if(!_tp)return; _tp.classList.add('active');
  btn.classList.add('active');
  if (tab==='news') loadNews('market');
  else if (tab==='calendar') loadCalendar('portfolio');
  else if (tab==='sectorcompare') renderSectorCards();
  else if (tab==='thesis') initThesisTab();
  else if (tab==='aum') renderAUM();
  else if (tab==='movers') { if(!moversData.week&&!moversData.month) loadMovers(); else renderMovers(activeMoversView); }
}

function switchFund(fund, btn) {
  activeFund = fund;
  document.querySelectorAll('.fund-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  buildState(); renderAll();
  document.getElementById('wiResults').classList.remove('show');
  // Refresh active tab if fund-specific
  const activeTab = document.querySelector('.nav-tab.active');
  if (activeTab) {
    const match = activeTab.getAttribute('onclick').match(/showTab\('(\w+)'/);
    const tab = match ? match[1] : '';
    if (tab==='news') { newsCache={}; loadNews('market'); }
    else if (tab==='calendar') { calCache=null; loadCalendar('portfolio'); }
    else if (tab==='thesis') initThesisTab();
    else if (tab==='aum') renderAUM();
    else if (tab==='movers') { if(!moversData.week&&!moversData.month) loadMovers(); else renderMovers(activeMoversView); }
    else if (tab==='sectorcompare') renderSectorCards();
  }
}

// ── KPIs ──────────────────────────────────────────────────────────────────────
function renderKPIs() {
  const tc=S.holdings.reduce((s,h)=>s+(h.costBasis||0),0);
  const tm=S.holdings.reduce((s,h)=>s+(h.marketValue||0),0);
  const tgl=tm-tc; const tglp=tc?tgl/tc*100:0;
  const ec=S.equities.reduce((s,h)=>s+(h.costBasis||0),0);
  const em=S.equities.reduce((s,h)=>s+(h.marketValue||0),0);
  const egl=em-ec; const eglp=ec?egl/ec*100:0;
  const ftc=S.etfs.reduce((s,h)=>s+(h.costBasis||0),0);
  const ftm=S.etfs.reduce((s,h)=>s+(h.marketValue||0),0);
  const fgl=ftm-ftc; const fglp=ftc?fgl/ftc*100:0;
  const dd=S.holdings.reduce((s,h)=>s+(h.dayDollar||0),0);
  document.getElementById('kpiGrid').innerHTML=`
    <div class="kpi accent"><div class="kpi-label">Total Fund Value</div><div class="kpi-value">${fmt(S.total)}</div><div class="kpi-sub">${S.fundName}</div></div>
    <div class="kpi accent"><div class="kpi-label">Total Gain / Loss</div><div class="kpi-value ${tgl>=0?'pos':'neg'}">${tgl>=0?'+':''}${fmt(Math.abs(tgl))}</div><div class="kpi-sub">${tglp>=0?'+':''}${tglp.toFixed(2)}% on cost basis</div></div>
    <div class="kpi"><div class="kpi-label">Equity G/L</div><div class="kpi-value ${egl>=0?'pos':'neg'}">${egl>=0?'+':''}${fmt(Math.abs(egl))}</div><div class="kpi-sub">${eglp>=0?'+':''}${eglp.toFixed(2)}% · ${S.equities.length} stocks</div></div>
    <div class="kpi"><div class="kpi-label">ETF G/L</div><div class="kpi-value ${fgl>=0?'pos':'neg'}">${fgl>=0?'+':''}${fmt(Math.abs(fgl))}</div><div class="kpi-sub">${fglp>=0?'+':''}${fglp.toFixed(2)}% · ${S.etfs.length} ETFs</div></div>
    <div class="kpi accent"><div class="kpi-label">Portfolio Beta</div><div class="kpi-value">${S.beta.toFixed(4)}</div><div class="kpi-sub">vs S&P 500 = 1.00</div></div>
    <div class="kpi"><div class="kpi-label">Today's Change</div><div class="kpi-value ${dd>=0?'pos':'neg'}">${dd>=0?'+':'−'}${fmt(Math.abs(dd))} <span style="font-size:13px">(${dd>=0?'+':''}${(dd/((S.total-dd)||1)*100).toFixed(2)}%)</span></div><div class="kpi-sub">Day P&L vs yesterday</div></div>
    <div class="kpi"><div class="kpi-label">Positions</div><div class="kpi-value">${S.holdings.length}</div><div class="kpi-sub">${S.equities.length} eq + ${S.etfs.length} ETFs</div></div>
    <div class="kpi"><div class="kpi-label">Cash</div><div class="kpi-value">${fmt(S.cash)}</div><div class="kpi-sub">${(S.cash/S.total*100).toFixed(1)}% of fund</div></div>
  `;
}

// ── SECTOR BARS ───────────────────────────────────────────────────────────────
function renderSectorBarsOverview() {
  const sectors = coreSectorsOf(S.holdings);
  const top8 = sectors.slice(0,8);
  const maxPct = Math.max(...top8.map(s=>s.pct));
  const colors = ['#0c2a5e','#1e40af','#1d4ed8','#2563eb','#3b82f6','#60a5fa','#93c5fd','#bfdbfe'];
  document.getElementById('sectorBarsOverview').innerHTML = top8.map((s,i)=>`
    <div class="sbr"><div class="sl" title="${s.name}">${s.name}</div>
    <div class="st"><div class="sf" style="width:${(s.pct/maxPct*100).toFixed(1)}%;background:${colors[i]}"></div></div>
    <div class="sp_">${(s.pct*100).toFixed(1)}%</div>
    <div class="sv">${fmtK(s.value)}</div></div>`).join('');
}

function renderComposition() {
  const eqV=S.equities.reduce((s,h)=>s+(h.marketValue||0),0);
  const etV=S.etfs.reduce((s,h)=>s+(h.marketValue||0),0);
  const bV=S.bond?S.bond.marketValue:0;
  const items=[{l:'Equities',v:eqV,c:'#0c2a5e'},{l:'ETFs',v:etV,c:'#2563eb'},{l:'Cash',v:S.cash,c:'#94a3b8'},...(bV?[{l:'Bond',v:bV,c:'#c9a84c'}]:[])];
  const tot=items.reduce((s,i)=>s+i.v,0);
  const mx=Math.max(...items.map(i=>i.v));
  document.getElementById('compositionBars').innerHTML=items.map(it=>`
    <div class="sbr"><div class="sl">${it.l}</div>
    <div class="st"><div class="sf" style="width:${(it.v/mx*100).toFixed(1)}%;background:${it.c}"></div></div>
    <div class="sp_">${(it.v/tot*100).toFixed(1)}%</div>
    <div class="sv">${fmtK(it.v)}</div></div>`).join('');
}

function renderTop10() {
  const sorted=[...S.holdings].sort((a,b)=>(b.marketValue||0)-(a.marketValue||0)).slice(0,10);
  document.getElementById('top10Table').innerHTML=`
    <tr><th>#</th><th>Ticker</th><th>Company</th><th>Type</th><th>Sector</th><th>Price</th><th>Market Value</th><th>Weight</th><th>Return</th><th>Beta</th></tr>
    ${sorted.map((h,i)=>`<tr><td style="color:var(--muted)">${i+1}</td>
    <td class="ticker-cell" style="white-space:nowrap"><a href="${irLink(h.ticker,h.company)}" target="_blank" rel="noopener" title="Open Investor Relations" onclick="event.stopPropagation()">${logoImg(h.ticker)}</a>${h.ticker}</td><td style="cursor:pointer" title="Open investment thesis" onclick="goToThesis('${h.ticker}')">${h.company} <span style="font-size:10px;color:var(--gold)">📋</span></td>
    <td><span class="badge type-${h.type}">${h.type.toUpperCase()}</span></td>
    <td>${h.sector}</td><td>${h.price?'$'+h.price.toFixed(2):'—'}</td>
    <td><strong>${fmt(h.marketValue||0)}</strong></td>
    <td>${((h.marketValue||0)/S.total*100).toFixed(2)}%</td>
    <td class="${(h.glPct||0)>=0?'pos':'neg'}">${h.glPct?((h.glPct*100).toFixed(1))+'%':'—'}</td>
    <td>${h.beta?h.beta.toFixed(2):'—'}</td></tr>`).join('')}`;
}

// ── HOLDINGS ──────────────────────────────────────────────────────────────────
function filterHoldings(type,btn){document.querySelectorAll('#tab-holdings .filter-btn').forEach(b=>b.classList.remove('active'));btn.classList.add('active');renderHoldings(type);}
let holdQuery='';
function holdingsSearchInput(v){holdQuery=(v||'').trim().toLowerCase();renderHoldings(holdLastFilter);}
let holdSortCol='marketValue';
let holdSortAsc=false;
let holdLastFilter='all';
function holdingsSortBy(col){
  if(holdSortCol===col){holdSortAsc=!holdSortAsc;}
  else{holdSortCol=col;holdSortAsc=false;}
  renderHoldings(holdLastFilter);
}
function renderHoldings(filter) {
  holdLastFilter=filter||'all';
  let h=filter==='equity'?S.equities:filter==='etf'?S.etfs:S.holdings;
  if (holdQuery) h=h.filter(x=>x.ticker.toLowerCase().includes(holdQuery)||(x.company||'').toLowerCase().includes(holdQuery));
  const _hd=holdSortAsc?1:-1;
  let sorted;
  if(holdSortCol==='ticker') sorted=[...h].sort((a,b)=>_hd*b.ticker.localeCompare(a.ticker));
  else if(holdSortCol==='glPct') sorted=[...h].sort((a,b)=>_hd*((b.glPct||0)-(a.glPct||0)));
  else if(holdSortCol==='dayPct') sorted=[...h].sort((a,b)=>_hd*((b.dayPct||0)-(a.dayPct||0)));
  else if(holdSortCol==='beta') sorted=[...h].sort((a,b)=>_hd*((b.beta||0)-(a.beta||0)));
  else if(holdSortCol==='glDollar') sorted=[...h].sort((a,b)=>_hd*((b.glDollar||0)-(a.glDollar||0)));
  else if(holdSortCol==='costBasis') sorted=[...h].sort((a,b)=>_hd*((b.costBasis||0)-(a.costBasis||0)));
  else if(holdSortCol==='price') sorted=[...h].sort((a,b)=>_hd*((b.price||0)-(a.price||0)));
  else if(holdSortCol==='avgCost') sorted=[...h].sort((a,b)=>_hd*((b.avgCost||0)-(a.avgCost||0)));
  else if(holdSortCol==='shares') sorted=[...h].sort((a,b)=>_hd*((b.shares||0)-(a.shares||0)));
  else sorted=[...h].sort((a,b)=>_hd*((b.marketValue||0)-(a.marketValue||0)));
  document.getElementById('holdingsTable').innerHTML=`
    <tr>
    <th style="cursor:pointer;user-select:none" onclick="holdingsSortBy('ticker')">Ticker ↕</th>
    <th>Company</th><th>Type</th><th>Sector</th>
    <th style="cursor:pointer;user-select:none" onclick="holdingsSortBy('shares')">Shares ↕</th>
    <th style="cursor:pointer;user-select:none" onclick="holdingsSortBy('avgCost')">Avg Cost ↕</th>
    <th style="cursor:pointer;user-select:none" onclick="holdingsSortBy('price')">Price ↕</th>
    <th style="cursor:pointer;user-select:none" onclick="holdingsSortBy('marketValue')">Market Value ↕</th>
    <th style="cursor:pointer;user-select:none" onclick="holdingsSortBy('marketValue')">Weight ↕</th>
    <th style="cursor:pointer;user-select:none" onclick="holdingsSortBy('costBasis')">Cost Basis ↕</th>
    <th style="cursor:pointer;user-select:none" onclick="holdingsSortBy('glDollar')">G/L $ ↕</th>
    <th style="cursor:pointer;user-select:none" onclick="holdingsSortBy('glPct')" title="Gain since the fund purchased this position — NOT year-to-date">Since Purch. % ↕</th>
    <th style="cursor:pointer;user-select:none" onclick="holdingsSortBy('dayPct')">Day % ↕</th>
    <th style="cursor:pointer;user-select:none" onclick="holdingsSortBy('beta')">Beta ↕</th>
    </tr>
    ${sorted.map(h=>`<tr>
    <td class="ticker-cell">${h.ticker}</td><td>${h.company}</td>
    <td><span class="badge type-${h.type}">${h.type.toUpperCase()}</span></td>
    <td>${h.sector||'—'}</td><td>${h.shares?h.shares.toFixed(3):'—'}</td>
    <td>${h.avgCost?'$'+h.avgCost.toFixed(2):'—'}</td>
    <td>${h.price?'$'+h.price.toFixed(2):'—'}</td>
    <td><strong>${fmt(h.marketValue||0)}</strong></td>
    <td>${((h.marketValue||0)/S.total*100).toFixed(2)}%</td>
    <td>${h.costBasis?'$'+fmt(h.costBasis):'—'}</td>
    <td class="${(h.glDollar||0)>=0?'pos':'neg'}">${h.glDollar?(h.glDollar>=0?'+':'')+' $'+fmt(Math.abs(h.glDollar)):'—'}</td>
    <td class="${(h.glPct||0)>=0?'pos':'neg'}">${h.glPct?(h.glPct>=0?'+':'')+((h.glPct*100).toFixed(1))+'%':'—'}</td>
    <td class="${(h.dayPct||0)>=0?'pos':'neg'}">${((h.dayPct||0)*100).toFixed(2)}%</td>
    <td>${h.beta?h.beta.toFixed(4):'—'}</td></tr>`).join('')}`;
}

// ── SECTORS ───────────────────────────────────────────────────────────────────
function renderSectorDetail() {
  const sectors=coreSectorsOf(S.holdings);
  const maxPct=Math.max(...sectors.map(s=>s.pct));
  const colors=['#0c2a5e','#1e40af','#1d4ed8','#2563eb','#3b82f6','#60a5fa','#93c5fd','#bfdbfe','#dbeafe','#eff6ff','#f0f9ff','#f8fafc','#f1f5f9','#e2e8f0'];
  document.getElementById('sectorDetail').innerHTML=sectors.map((s,i)=>`
    <div class="sbr"><div class="sl" title="${s.name}">${s.name}</div>
    <div class="st"><div class="sf" style="width:${(s.pct/maxPct*100).toFixed(1)}%;background:${colors[i%colors.length]}"></div></div>
    <div class="sp_">${(s.pct*100).toFixed(1)}%</div>
    <div class="sv">${fmtK(s.value)}</div>
    <div style="width:46px;text-align:right;font-size:11px;color:var(--gray);flex-shrink:0">${s.beta.toFixed(2)}β</div></div>`).join('');
  const allSectors=[...new Set(S.holdings.map(h=>h.sector))].sort();
  document.getElementById('sectorFilterRow').innerHTML=
    `<button class="filter-btn active" onclick="filterSectorHoldings('All',this)">All</button>`+
    allSectors.map(s=>`<button class="filter-btn" onclick="filterSectorHoldings('${s}',this)">${s}</button>`).join('');
  filterSectorHoldings('All',document.querySelector('#sectorFilterRow .filter-btn'));
}

function filterSectorHoldings(sector,btn){
  document.querySelectorAll('#sectorFilterRow .filter-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  const holdings=sector==='All'?S.holdings:S.holdings.filter(h=>h.sector===sector);
  const sorted=[...holdings].sort((a,b)=>(b.marketValue||0)-(a.marketValue||0));
  document.getElementById('sectorHoldingsTable').innerHTML=`
    <tr><th>Ticker</th><th>Company</th><th>Type</th><th>Sector</th><th>Market Value</th><th>Fund Weight</th><th>Sector Weight</th><th>Return</th><th>Beta</th></tr>
    ${sorted.map(h=>{
      const sT=sorted.reduce((s,x)=>s+(x.marketValue||0),0);
      return `<tr style="cursor:pointer" onclick="showTickerChart('${h.ticker}','${h.company}')" title="Click for price chart"><td class="ticker-cell">${h.ticker} 📈</td><td>${h.company}</td>
      <td><span class="badge type-${h.type}">${h.type.toUpperCase()}</span></td>
      <td>${h.sector}</td><td><strong>${fmt(h.marketValue||0)}</strong></td>
      <td>${((h.marketValue||0)/S.total*100).toFixed(2)}%</td>
      <td>${sector!=='All'?(((h.marketValue||0)/sT)*100).toFixed(2)+'%':'—'}</td>
      <td class="${(h.glPct||0)>=0?'pos':'neg'}">${h.glPct?((h.glPct*100).toFixed(1))+'%':'—'}</td>
      <td>${h.beta?h.beta.toFixed(4):'—'}</td></tr>`;
    }).join('')}`;
}

function renderSectorBeta() {
  const sectors=coreSectorsOf(S.holdings);
  document.getElementById('sectorBeta').innerHTML=`
    <div style="display:grid;grid-template-columns:1fr 1fr;font-size:10px;font-weight:700;color:var(--muted);padding-bottom:6px;border-bottom:1px solid var(--border);margin-bottom:8px"><span>Sector</span><span style="text-align:right">Beta · Weight</span></div>
    ${sectors.map(s=>`<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border)">
    <span style="font-size:11px;font-weight:600">${s.name}</span>
    <span><span style="font-size:13px;font-weight:700;color:${s.beta>1.2?'#d6453d':s.beta<0.8?'#159a51':'#1e293b'}">${s.beta.toFixed(2)}</span>
    <span style="font-size:11px;color:var(--muted);margin-left:8px">${(s.pct*100).toFixed(1)}%</span></span></div>`).join('')}`;
}

// ── SECTOR CARDS ──────────────────────────────────────────────────────────────
function renderSectorCards() {
  const sectors=coreSectorsOf(S.holdings);
  document.getElementById('sectorCards').innerHTML=`
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px">
    ${sectors.map(s=>{
      const secReturn=calcReturn(s.holdings,S.fund);
      return `<div class="sc-card" onclick="showSectorComparePeriod('${s.name}',this)">
        <div class="sc-name">${s.name}</div>
        <div class="perf-value ${secReturn>=0?'pos':'neg'}" style="font-size:16px">${secReturn>=0?'+':''}${secReturn.toFixed(1)}%</div>
        <div style="font-size:9px;color:var(--muted);margin-top:1px">return since purchase</div>
        <div style="font-size:10px;color:var(--muted);margin-top:2px">${(s.pct*100).toFixed(1)}% of eq. portfolio · β${s.beta.toFixed(2)}</div>
      </div>`;
    }).join('')}</div>`;
}

// ── BENCHMARK ─────────────────────────────────────────────────────────────────
function renderBenchmark() {
  const sectors=coreSectorsOf(S.holdings);
  const fundBeta=S.beta;
  document.getElementById('riskComparison').innerHTML=`
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;padding-bottom:6px;border-bottom:1px solid var(--border);margin-bottom:8px"><span>Metric</span><span style="text-align:center">${S.fundName}</span><span style="text-align:center">S&P 500</span></div>
    ${[['Beta',fundBeta.toFixed(4),'1.0000'],['Total Return',calcReturn(S.holdings,S.fund).toFixed(2)+'%','See chart'],['Positions',S.holdings.length,'500'],['Top Holding Wt',((Math.max(...S.holdings.map(h=>h.marketValue||0))/S.total)*100).toFixed(1)+'%','~7%'],['Cash Weight',(S.cash/S.total*100).toFixed(1)+'%','~0%']].map(([l,f,sp])=>`
    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px">
    <span style="color:var(--gray)">${l}</span><span style="text-align:center;font-weight:700;color:var(--navy)">${f}</span><span style="text-align:center;color:var(--gray)">${sp}</span></div>`).join('')}`;
  const rows=Object.keys(SP500_SECTORS).map(sec=>{
    const fs=sectors.find(s=>s.name===sec);
    const fp=fs?fs.pct*100:0;
    const sp=SP500_SECTORS[sec];
    return {sec,fp,sp,diff:fp-sp};
  }).sort((a,b)=>Math.abs(b.diff)-Math.abs(a.diff));
  document.getElementById('spSectorTable').innerHTML=rows.map(r=>`
    <div class="sp-row">
    <div style="font-weight:600;overflow:hidden;text-overflow:ellipsis">${r.sec}</div>
    <div style="text-align:right;font-weight:700;color:var(--navy)">${r.fp.toFixed(1)}%</div>
    <div style="height:14px;background:var(--bg);border-radius:3px;overflow:hidden"><div style="height:100%;background:#0c2a5e;width:${Math.min(r.fp/40*100,100).toFixed(1)}%;border-radius:3px"></div></div>
    <div style="text-align:right;color:var(--gray)">${r.sp.toFixed(1)}%</div>
    <div style="height:14px;background:var(--bg);border-radius:3px;overflow:hidden"><div style="height:100%;background:#f97316;width:${Math.min(r.sp/40*100,100).toFixed(1)}%;border-radius:3px"></div></div>
    <div style="text-align:right;font-weight:700;color:${r.diff>1?'#1e40af':r.diff<-1?'#d6453d':'#64748b'}">${r.diff>=0?'+':''}${r.diff.toFixed(1)}%</div></div>`).join('');
  const ow=rows.filter(r=>r.diff>1).length, uw=rows.filter(r=>r.diff<-1).length;
  document.getElementById('benchKpis').innerHTML=`
    <div class="kpi accent"><div class="kpi-label">Portfolio Beta</div><div class="kpi-value">${fundBeta.toFixed(4)}</div><div class="kpi-sub">${fundBeta>1?'More':'Less'} volatile than S&P</div></div>
    <div class="kpi"><div class="kpi-label">Overweight Sectors</div><div class="kpi-value" style="color:var(--blue)">${ow}</div><div class="kpi-sub">vs S&P 500</div></div>
    <div class="kpi"><div class="kpi-label">Underweight Sectors</div><div class="kpi-value" style="color:var(--red)">${uw}</div><div class="kpi-sub">vs S&P 500</div></div>
    <div class="kpi"><div class="kpi-label">S&P 500 (SPY)</div><div class="kpi-value" id="spxKpiVal">${spxData?'$'+spxData.c.toFixed(2):'Loading...'}</div><div class="kpi-sub" id="spxKpiSub">${spxData?(((spxData.c-spxData.pc)/spxData.pc*100)>=0?'+':'')+(((spxData.c-spxData.pc)/spxData.pc*100)).toFixed(2)+'% today':'Fetching live data'}</div></div>
  `;
}

// ── WHAT-IF MULTI-TRADE ───────────────────────────────────────────────────────
let wiTrades = [];
const ALL_SECTORS = ['Information Technology','Financials','Health Care','Consumer Discretionary','Communication Services','Industrials','Consumer Staples','Energy','Real Estate','Materials','Utilities','Fixed Income','Broad Market'];
const ALL_HOLDINGS = () => {
  const all = [...RAW.endowment.equities,...RAW.endowment.etfs,...RAW.ceeFund.equities,...RAW.ceeFund.etfs];
  const seen = new Set();
  return all.filter(h=>{if(seen.has(h.ticker))return false;seen.add(h.ticker);return true;});
};

function initWiTrades() {
  wiTrades = [];
  addWiTrade();
}

function addWiTrade() {
  const id = Date.now();
  wiTrades.push({id, action:'buy', ticker:'', shares:'', price:'', sector:'', beta:''});
  renderWiRows();
}

function removeWiTrade(id) {
  wiTrades = wiTrades.filter(t=>t.id!==id);
  if(wiTrades.length===0) addWiTrade();
  else renderWiRows();
}

function clearWiTrades() {
  wiTrades = [];
  addWiTrade();
  document.getElementById('wiResults').classList.remove('show');
}

function renderWiRows() {
  document.getElementById('wiTradeRows').innerHTML = wiTrades.map(t=>`
    <div class="wi-trade-row" id="wirow-${t.id}">
      <div class="fg"><label>Action</label>
        <select onchange="updateWiTrade(${t.id},'action',this.value)" style="padding:7px 6px">
          <option value="buy" ${t.action==='buy'?'selected':''}>BUY</option>
          <option value="sell" ${t.action==='sell'?'selected':''}>SELL</option>
        </select>
      </div>
      <div class="fg"><label>Ticker</label>
        <input type="text" value="${t.ticker}" placeholder="e.g. AAPL" style="text-transform:uppercase"
          oninput="updateWiTrade(${t.id},'ticker',this.value.toUpperCase())"
          onblur="wiAutoFill(${t.id})">
      </div>
      <div class="fg"><label>Shares</label>
        <input type="number" value="${t.shares}" placeholder="e.g. 10" min="0"
          oninput="updateWiTrade(${t.id},'shares',this.value)">
      </div>
      <div class="fg"><label>Price ($)</label>
        <input type="number" value="${t.price}" placeholder="e.g. 200.00" min="0" step="0.01"
          oninput="updateWiTrade(${t.id},'price',this.value)">
      </div>
      <div class="fg"><label>Sector</label>
        <select onchange="updateWiTrade(${t.id},'sector',this.value)" style="font-size:11px;padding:7px 4px;width:100%">
          <option value="">${t.sector?'':'-- Select Sector --'}</option>
          ${[...new Set(ALL_HOLDINGS().map(h=>h.sector).filter(s=>s&&s!=='Broad Market'&&s!=='Fixed Income'))].sort().map(s=>'<option value="'+s+'"'+(s===t.sector?' selected':'')+'>'+s+'</option>').join('')}
        </select>
      </div>
      <button class="wi-remove" onclick="removeWiTrade(${t.id})" title="Remove">×</button>
    </div>
  `).join('');
}

function updateWiTrade(id, field, val) {
  const t = wiTrades.find(t=>t.id===id);
  if(t) t[field] = val;
}

function wiAutoFill(id) {
  const t = wiTrades.find(t=>t.id===id);
  if(!t || !t.ticker) return;
  const h = ALL_HOLDINGS().find(x=>x.ticker===t.ticker);
  if(h) {
    if(!t.sector) {t.sector=h.sector; updateWiTrade(id,'sector',h.sector);}
    if(!t.beta) {t.beta=h.beta; updateWiTrade(id,'beta',h.beta);}
    if(!t.price&&h.price) {t.price=h.price.toFixed(2); updateWiTrade(id,'price',h.price.toFixed(2));}
    renderWiRows();
  }
}

function calcWhatIf() {
  // Validate
  const validTrades = wiTrades.filter(t=>t.ticker&&parseFloat(t.shares)>0&&parseFloat(t.price)>0);
  if(validTrades.length===0){alert('Please fill in at least one trade with ticker, shares, and price.');return;}

  const allH = ALL_HOLDINGS();
  const sectors = calcSectors(S.holdings, S.total);
  let newHoldings = [...S.holdings];
  let newTotal = S.total;
  let tradesSummary = [];

  for (const t of validTrades) {
    const shares = parseFloat(t.shares);
    const price = parseFloat(t.price);
    const value = shares * price;
    const existing = allH.find(h=>h.ticker===t.ticker);
    const sector = t.sector || existing?.sector || 'Unknown';
    const beta = parseFloat(t.beta) || existing?.beta || 1.0;

    if(t.action==='buy') {
      newHoldings.push({ticker:t.ticker,sector,marketValue:value,beta,type:'equity'});
      newTotal += value;
      tradesSummary.push(`BUY ${t.ticker} ${shares} shares @ $${price.toFixed(2)} = $${fmt(value)}`);
    } else {
      // Sell - reduce existing position
      const existIdx = newHoldings.findIndex(h=>h.ticker===t.ticker);
      if(existIdx>=0) {
        const existMV = newHoldings[existIdx].marketValue || 0;
        const sellMV = Math.min(value, existMV);
        newHoldings[existIdx] = {...newHoldings[existIdx], marketValue: existMV - sellMV};
        newHoldings = newHoldings.filter(h=>(h.marketValue||0)>0);
        newTotal -= sellMV;
      } else {
        newTotal -= value;
      }
      tradesSummary.push(`SELL ${t.ticker} ${shares} shares @ $${price.toFixed(2)} = $${fmt(value)}`);
    }
  }

  const newSectors=coreSectorsOf(newHoldings);
  const oldSectors=coreSectorsOf(S.holdings);
  const oldBeta = S.beta;
  const newBeta = newHoldings.reduce((s,h)=>s+(h.beta||1)*(h.marketValue||0),0)/(newTotal||1);
  const betaChange = newBeta - oldBeta;

  document.getElementById('wiGrid').innerHTML=`
    <div class="wi-card"><div class="wi-card-label">Trades (${validTrades.length})</div>
      ${tradesSummary.map(t=>`<div style="font-size:11px;padding:3px 0;border-bottom:1px solid var(--border)">${t}</div>`).join('')}
      <div style="margin-top:8px;font-size:11px;color:var(--muted)">Net portfolio change: ${newTotal>=S.total?'+':''}$${fmt(newTotal-S.total)}</div>
    </div>
    <div class="wi-card"><div class="wi-card-label">Portfolio Beta Impact</div>
      <div class="wi-row"><span class="lbl">Current Beta</span><span class="val">${oldBeta.toFixed(4)}</span></div>
      <div class="wi-row"><span style="color:var(--gold);font-size:14px">→</span><span class="val" style="color:${newBeta>oldBeta?'#d6453d':'#159a51'}">${newBeta.toFixed(4)}</span></div>
      <div style="font-size:11px;font-weight:600;margin-top:6px;color:${betaChange>0?'#d6453d':'#159a51'}">Beta ${betaChange>0?'increases':'decreases'} by ${Math.abs(betaChange).toFixed(4)} (${(betaChange/oldBeta*100).toFixed(2)}%)</div>
      <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--border);font-size:11px">
        <div class="wi-row"><span class="lbl">Current Total</span><span class="val">$${fmt(S.total)}</span></div>
        <div class="wi-row"><span class="lbl">New Total</span><span class="val">$${fmt(newTotal)}</span></div>
      </div>
    </div>
  `;

  const maxPct = Math.max(...newSectors.map(s=>s.pct));
  document.getElementById('wiSectorImpact').innerHTML=`
    <div style="display:grid;grid-template-columns:155px 1fr 60px 60px 60px 60px 60px;gap:6px;font-size:10px;font-weight:700;color:var(--muted);margin-bottom:8px;padding-bottom:4px;border-bottom:1px solid var(--border)">
    <span>Sector</span><span>Bar</span><span style="text-align:right">Before</span><span style="text-align:right">After</span><span style="text-align:right">Change</span><span style="text-align:right">S&P</span><span style="text-align:right">vs S&P</span></div>
    ${newSectors.map(ns=>{
      const os=typeof oldSectors!=='undefined'?oldSectors.find(s=>s.name===ns.name):sectors.find(s=>s.name===ns.name);
      const oldPct=os?os.pct:0;
      const change=ns.pct-oldPct;
      const spPct=(SP500_SECTORS[ns.name]||0)/100;
      const vssp=ns.pct-spPct;
      const changed=Math.abs(change)>0.0001;
      return `<div style="display:grid;grid-template-columns:155px 1fr 60px 60px 60px 60px 60px;gap:6px;align-items:center;padding:5px 0;border-bottom:1px solid var(--border);${changed?'background:#eff6ff;margin:0 -4px;padding:5px 4px;border-radius:4px;':''}">
      <div style="font-size:11px;font-weight:${changed?700:600};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ns.name}</div>
      <div style="height:12px;background:var(--bg);border-radius:3px;overflow:hidden"><div style="height:100%;background:${changed?'#3b82f6':'var(--navy)'};width:${(ns.pct/maxPct*100).toFixed(1)}%;border-radius:3px"></div></div>
      <div style="text-align:right;font-size:11px;color:var(--gray)">${(oldPct*100).toFixed(1)}%</div>
      <div style="text-align:right;font-size:11px;font-weight:${changed?700:400};color:${changed?'var(--blue)':'var(--text)'}">${(ns.pct*100).toFixed(1)}%</div>
      <div style="text-align:right;font-size:11px;font-weight:600;color:${change>0.001?'#d6453d':change<-0.001?'#159a51':'var(--gray)'} ">${change>=0?'+':''}${(change*100).toFixed(2)}%</div>
      <div style="text-align:right;font-size:11px;color:var(--gray)">${(spPct*100).toFixed(1)}%</div>
      <div style="text-align:right;font-size:11px;font-weight:600;color:${vssp>0.01?'#1e40af':vssp<-0.01?'#d6453d':'var(--gray)'} ">${vssp>=0?'+':''}${(vssp*100).toFixed(1)}%</div></div>`;
    }).join('')}`;
  // Sector beta before → after (only sectors your trades touched)
  (function(){
    const _rows=newSectors.map(ns=>{
      const os=typeof oldSectors!=='undefined'?oldSectors.find(s=>s.name===ns.name):null;
      if(!os)return '';
      const _d=(ns.beta||0)-(os.beta||0);
      if(Math.abs(_d)<0.005)return '';
      const _col=_d>0?'#d6453d':'#159a51';
      return '<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--border);font-size:12px"><span style="font-weight:600">'+ns.name+'</span><span>β'+os.beta.toFixed(2)+' → <strong style="color:'+_col+'">β'+ns.beta.toFixed(2)+'</strong> <span style="font-size:10px;color:'+_col+'">('+(_d>=0?'+':'')+_d.toFixed(2)+')</span></span></div>';
    }).filter(Boolean).join('');
    if(_rows)document.getElementById('wiSectorImpact').innerHTML+='<div style="margin-top:14px"><div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;margin-bottom:6px">Sector Beta Changes</div>'+_rows+'</div>';
  })();

  document.getElementById('wiResults').classList.add('show');
}

// ── PRICE TARGETS ─────────────────────────────────────────────────────────────
function loadPriceTargets() {
  const allH=ALL_HOLDINGS();
  renderTargetsTable(allH);
  // Fetch WS targets from Yahoo Finance
  const batchSize=5;
  (async()=>{
    for(let i=0;i<allH.length;i+=batchSize){
      await Promise.all(allH.slice(i,i+batchSize).map(async h=>{
        if(wsTargetCache[h.ticker]!==undefined)return;
        try{
          const url=`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${h.ticker}?modules=financialData`;
          const d=await fetchYF(url,6000);
          wsTargetCache[h.ticker]=d?.quoteSummary?.result?.[0]?.financialData?.targetMeanPrice?.raw||null;
        }catch(e){wsTargetCache[h.ticker]=null;}
      }));
      renderTargetsTable(allH);
      if(i+batchSize<allH.length)await new Promise(r=>setTimeout(r,300));
    }
  })();
}

function renderTargetsTable(allH) {
  const filter='All';
  let holdings=allH;
  if(filter==='Endowment')holdings=allH.filter(h=>RAW.endowment.equities.concat(RAW.endowment.etfs).some(e=>e.ticker===h.ticker));
  else if(filter==='CEE Fund')holdings=allH.filter(h=>RAW.ceeFund.equities.concat(RAW.ceeFund.etfs).some(e=>e.ticker===h.ticker));
  const sorted=[...holdings].sort((a,b)=>(b.marketValue||0)-(a.marketValue||0));
  const inEnd=t=>RAW.endowment.equities.concat(RAW.endowment.etfs).some(e=>e.ticker===t);
  const inCee=t=>RAW.ceeFund.equities.concat(RAW.ceeFund.etfs).some(e=>e.ticker===t);
  document.getElementById('targetsTable').innerHTML=`
    <tr><th>Ticker</th><th>Company</th><th>Fund</th><th>Current Price</th><th>Club Target</th><th>Club Upside</th><th>WS Target</th><th>WS Upside</th><th>We vs WS</th></tr>
    ${sorted.map(h=>{
      const price=h.price||0;
      const ct=clubTargets[h.ticker]||null;
      const wst=wsTargetCache[h.ticker]!==undefined?wsTargetCache[h.ticker]:'loading';
      const cu=ct&&price?(ct-price)/price*100:null;
      const wu=wst&&wst!=='loading'&&price?(wst-price)/price*100:null;
      const vsWS=cu!==null&&wu!==null?cu-wu:null;
      const ie=inEnd(h.ticker),ic=inCee(h.ticker);
      const fl=ie&&ic?'Both':ie?'Endowment':'CEE Fund';
      const fc=ie&&ic?'#fef9c3':ie?'#dbeafe':'#fce7f3';
      const ft=ie&&ic?'#854d0e':ie?'#1e40af':'#9d174d';
      return `<tr>
        <td class="ticker-cell">${h.ticker}</td><td>${h.company}</td>
        <td><span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px;background:${fc};color:${ft}">${fl}</span></td>
        <td><strong>${price?'$'+price.toFixed(2):'—'}</strong></td>
        <td contenteditable="true" style="color:var(--blue);font-weight:600;cursor:pointer;min-width:80px" onblur="saveClubTarget('${h.ticker}',this)" title="Click to edit">${ct?'$'+ct.toFixed(2):'Click to set'}</td>
        <td class="${cu===null?'':cu>=0?'pos':'neg'}" style="font-weight:700">${cu!==null?(cu>=0?'+':'')+cu.toFixed(1)+'%':'—'}</td>
        <td style="font-weight:600;color:var(--navy)">${wst==='loading'?'<span style="color:var(--muted);font-size:10px">Loading...</span>':wst?'$'+parseFloat(wst).toFixed(2):'N/A'}</td>
        <td class="${wu===null?'':wu>=0?'pos':'neg'}" style="font-weight:700">${wu!==null?(wu>=0?'+':'')+wu.toFixed(1)+'%':'—'}</td>
        <td style="font-weight:700;color:${vsWS===null?'var(--muted)':vsWS>0?'var(--blue)':vsWS<0?'var(--red)':'var(--gray)'}">${vsWS!==null?(vsWS>0?'↑ More bullish':vsWS<0?'↓ More bearish':'= In line'):'—'}${vsWS!==null?' <span style="font-size:10px;font-weight:400">('+(vsWS>=0?'+':'')+vsWS.toFixed(1)+'%)</span>':''}</td>
      </tr>`;
    }).join('')}`;
}

function saveClubTarget(ticker,cell){const v=parseFloat(cell.textContent.trim().replace('$','').replace('Click to set',''));if(!isNaN(v)&&v>0){clubTargets[ticker]=v;localStorage.setItem('cee_club_targets',JSON.stringify(clubTargets));const allH=ALL_HOLDINGS();renderTargetsTable(allH);}}
function filterTargets(filter,btn){renderTargetsTable(ALL_HOLDINGS());}

// ── NEWS ──────────────────────────────────────────────────────────────────────
let currentNewsFilter='market',currentNewsTicker='';
function filterNews(type,btn){
  document.querySelectorAll('#tab-news .filter-btn').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
  currentNewsFilter=type;
  if(type==='search')currentNewsTicker=document.getElementById('newsTickerInput').value.trim().toUpperCase();
  loadNews(type);
}
async function loadNews(type){
  const loadEl=document.getElementById('newsLoading'),listEl=document.getElementById('newsList');
  if(loadEl){loadEl.style.display='block';loadEl.textContent='Loading news...';}
  if(listEl)listEl.innerHTML='';
  const ck=type==='search'?`search_${currentNewsTicker}`:type;
  if(newsCache[ck]){renderNews(newsCache[ck]);if(loadEl)loadEl.style.display='none';return;}
  await new Promise(r=>setTimeout(r,500));
  try{
    let url='',data=null;
    if(type==='market')url=`https://finnhub.io/api/v1/news?category=general&token=${FINNHUB}`;
    else if(type==='search')url=`https://finnhub.io/api/v1/company-news?symbol=${currentNewsTicker}&from=${isoDaysAgo(30)}&to=${isoToday()}&token=${FINNHUB}`;
    else if(type==='portfolio'){
      const top5=[...S.holdings].sort((a,b)=>(b.marketValue||0)-(a.marketValue||0)).slice(0,5).map(h=>h.ticker);
      const allNews=[];
      for(const tk of top5){
        const d=await fetchYF(`https://finnhub.io/api/v1/company-news?symbol=${tk}&from=${isoDaysAgo(30)}&to=${isoToday()}&token=${FINNHUB}`,6000);
        if(d&&Array.isArray(d))allNews.push(...d.slice(0,4).map(n=>{return{...n,_ticker:tk};}));
        await new Promise(r=>setTimeout(r,500));
      }
      allNews.sort((a,b)=>b.datetime-a.datetime);
      newsCache[ck]=[...allNews].sort((a,b)=>(b.datetime||0)-(a.datetime||0)).slice(0,25);renderNews(newsCache[ck]);if(loadEl)loadEl.style.display='none';return;
    }
    if(url){data=await fetchYF(url,8000);}
    if(data&&Array.isArray(data)){newsCache[ck]=[...data].sort((a,b)=>(b.datetime||0)-(a.datetime||0)).slice(0,25);renderNews(newsCache[ck]);}
    else if(listEl)listEl.innerHTML='<div style="color:var(--muted);text-align:center;padding:20px">No news found. Try again in 30 seconds.</div>';
  }catch(e){if(listEl)listEl.innerHTML='<div style="color:var(--muted);text-align:center;padding:20px">Could not load news. Try again in 30 seconds.</div>';}
  if(loadEl)loadEl.style.display='none';
}
function renderNews(articles){
  const listEl=document.getElementById('newsList');
  if(document.getElementById('newsLoading'))document.getElementById('newsLoading').style.display='none';
  if(!articles?.length){if(listEl)listEl.innerHTML='<div style="color:var(--muted);text-align:center;padding:20px">No news found.</div>';return;}
  listEl.innerHTML=articles.map(a=>{
    const date=new Date(a.datetime*1000);
    const timeStr=date.toLocaleDateString('en-US',{month:'short',day:'numeric'})+' · '+date.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
    return `<div class="news-item">
      ${a._ticker?`<span class="ntk">${a._ticker}</span>`:''}
      <div class="news-headline"><a href="${a.url}" target="_blank" rel="noopener">${a.headline}</a></div>
      <div class="news-meta">${a.source} · ${timeStr}</div>
      ${a.summary?`<div style="font-size:11px;color:var(--gray);margin-top:4px;line-height:1.4">${a.summary.slice(0,180)}${a.summary.length>180?'...':''}</div>`:''}
    </div>`;
  }).join('');
}

// ── CALENDAR ──────────────────────────────────────────────────────────────────
function filterCalendar(type,btn){document.querySelectorAll('#tab-calendar .filter-btn').forEach(b=>b.classList.remove('active'));if(btn)btn.classList.add('active');loadCalendar(type);}
async function loadCalendar(type){
  const loadEl=document.getElementById('calLoading'),tableEl=document.getElementById('calTable');
  if(loadEl){loadEl.style.display='block';loadEl.textContent='Loading...';}
  if(tableEl)tableEl.innerHTML='';

  const nowDate=new Date();
  const from=nowDate.toISOString().split('T')[0];
  const futEnd=new Date(nowDate);futEnd.setDate(futEnd.getDate()+90);
  const to=futEnd.toISOString().split('T')[0];

  const allEquities=[...RAW.endowment.equities,...RAW.ceeFund.equities];
  const allHoldings=[...RAW.endowment.equities,...RAW.endowment.etfs,...RAW.ceeFund.equities,...RAW.ceeFund.etfs];
  const portTickers=new Set(allHoldings.map(h=>h.ticker));
  // IR map hoisted to global scope (see definitions above loadCalendar)

  try{

  // ── ECONOMIC EVENTS ─────────────────────────────────────────────────────────
  if(type==='economic'){
    if(!window.econCache){
      const fut90=new Date(nowDate);fut90.setDate(fut90.getDate()+90);
      const data=await fetchYF(`https://finnhub.io/api/v1/calendar/economic?from=${from}&to=${fut90.toISOString().split('T')[0]}&token=${FINNHUB}`,10000);
      window.econCache=(data?.economicCalendar||[]).filter(e=>(e.country||'').toUpperCase()==='US').sort((a,b)=>(a.date||'').localeCompare(b.date||''));
      if(!window.econCache.length&&!(data?.economicCalendar))window.econCache='unavailable';
    }
    if(window.econCache==='unavailable'){
      // Finnhub economic calendar is premium-gated — build a schedule from known public dates.
      const evts=[];
      const yr=nowDate.getFullYear();
      // FOMC 2026 meeting decision days (announced Fed schedule)
      const fomc={2026:['2026-01-28','2026-03-18','2026-04-29','2026-06-17','2026-07-29','2026-09-16','2026-10-28','2026-12-09']};
      (fomc[yr]||[]).forEach(d=>evts.push({date:d,event:'FOMC Rate Decision (scheduled)',impact:'high',estimate:'',prev:''}));
      // Jobs report: first Friday of each month
      for(let m=0;m<12;m++){
        const d=new Date(yr,m,1);
        while(d.getDay()!==5)d.setDate(d.getDate()+1);
        evts.push({date:d.toISOString().split('T')[0],event:'Nonfarm Payrolls / Jobs Report (scheduled)',impact:'high',estimate:'',prev:''});
      }
      // CPI: typically released mid-month (~10th-14th) for the prior month
      for(let m=0;m<12;m++){
        const d=new Date(yr,m,12);
        evts.push({date:d.toISOString().split('T')[0],event:'CPI Inflation Report (approx. mid-month)',impact:'high',estimate:'',prev:''});
      }
      // GDP advance estimates: late Jan/Apr/Jul/Oct
      ['01-29','04-29','07-29','10-29'].forEach(md=>evts.push({date:yr+'-'+md,event:'GDP Estimate Release (approx.)',impact:'medium',estimate:'',prev:''}));
      window.econCache=evts.filter(e=>e.date>=from).sort((a,b)=>a.date.localeCompare(b.date));
    }
    window.renderEconTable=function(impact,btn){
      if(btn){document.querySelectorAll('.econ-f').forEach(b=>b.classList.remove('active'));btn.classList.add('active');}
      const rows=(impact==='all'?window.econCache:window.econCache.filter(e=>(e.impact||'low')===impact)).slice(0,80);
      const ic=e=>e.impact==='high'?'#d6453d':e.impact==='medium'?'#f97316':'#94a3b8';
      const fbtns='<tr><td colspan="5" style="padding:6px 0;border:none"><span style="font-size:11px;color:var(--muted);margin-right:8px;font-weight:700">PRIORITY:</span>'
        +'<button class="filter-btn econ-f active" onclick="renderEconTable(\'all\',this)">All</button> '
        +'<button class="filter-btn econ-f" onclick="renderEconTable(\'high\',this)" style="color:#d6453d">🔴 High</button> '
        +'<button class="filter-btn econ-f" onclick="renderEconTable(\'medium\',this)" style="color:#f97316">🟠 Medium</button> '
        +'<button class="filter-btn econ-f" onclick="renderEconTable(\'low\',this)">⚪ Low</button></td></tr>';
      tableEl.innerHTML=fbtns.replace('colspan="5"','colspan="3"')+(rows.length?`<tr><th>Date</th><th>Event</th><th>Impact</th></tr>
        ${rows.map(e=>`<tr><td style="font-size:12px;font-weight:600">${e.date||'—'}</td><td style="font-weight:600">${e.event||'—'}</td>
          <td><span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:${ic(e)}22;color:${ic(e)}">${(e.impact||'low').toUpperCase()}</span></td></tr>`).join('')}`
        :'<tr><td colspan="3" style="text-align:center;color:var(--muted);padding:20px">No US events match this priority in the next 90 days.</td></tr>');
    };
    renderEconTable('all',null);
    if(loadEl)loadEl.style.display='none'; return;
  }

  // ── RECENT EARNINGS (with IR links) ─────────────────────────────────────────
  if(type==='recent'){
    const pastDate=new Date(nowDate);pastDate.setDate(pastDate.getDate()-30);
    const pastFrom=pastDate.toISOString().split('T')[0];
    const r=await fetchYF(`https://finnhub.io/api/v1/calendar/earnings?from=${pastFrom}&to=${from}&token=${FINNHUB}`,10000);
    const recentData=(r?.earningsCalendar||[]).filter(e=>portTickers.has(e.symbol)).sort((a,b)=>b.date.localeCompare(a.date)).slice(0,30);
    const bmoSpan='<span class="cal-bmo">Before Open</span>';
    const amcSpan='<span class="cal-amc">After Close</span>';
    tableEl.innerHTML=recentData.length?`<tr><th>Date</th><th>Ticker</th><th>Company</th><th>When</th><th>EPS Est.</th><th>EPS Actual</th><th>Surprise</th><th>IR Page</th></tr>
      ${recentData.map(e=>{
        const when=e.hour==='bmo'?bmoSpan:e.hour==='amc'?amcSpan:'—';
        const surprise=e.epsEstimate&&e.epsActual?((e.epsActual-e.epsEstimate)/Math.abs(e.epsEstimate)*100):null;
        const h=allHoldings.find(x=>x.ticker===e.symbol);
        return `<tr>
          <td style="font-size:12px">${e.date}</td>
          <td class="ticker-cell">${e.symbol}</td>
          <td>${h?.company||e.symbol}</td>
          <td>${when}</td>
          <td style="font-size:12px">${e.epsEstimate!=null?'$'+e.epsEstimate.toFixed(2):'—'}</td>
          <td style="font-size:12px;font-weight:600">${e.epsActual!=null?'$'+e.epsActual.toFixed(2):'—'}</td>
          <td class="${surprise>0?'pos':surprise<0?'neg':''}" style="font-size:12px;font-weight:700">${surprise!=null?(surprise>=0?'+':'')+surprise.toFixed(1)+'%':'—'}</td>
          <td><a href="${irLink(e.symbol,h?.company)}" target="_blank" style="font-size:11px;color:var(--blue);text-decoration:none">🏢 IR Page</a></td>
        </tr>`;
      }).join('')}`
      :'<tr><td colspan="8" style="text-align:center;color:var(--muted);padding:20px">No recent earnings from your portfolio found.</td></tr>';
    if(loadEl)loadEl.style.display='none'; return;
  }

  // ── DIVIDENDS (projected from Yahoo dividend history) ───────────────────────
  if(type==='dividends'){
    if(loadEl)loadEl.textContent='⏳ Loading dividend data...';
    const paid=[],upcoming=[];
    const divTickers=allHoldings.map(h=>h.ticker);
    const past90=new Date(nowDate);past90.setDate(past90.getDate()-90);
    const past90Str=past90.toISOString().split('T')[0];
    for(let i=0;i<divTickers.length;i+=5){
      await Promise.all(divTickers.slice(i,i+5).map(async tk=>{
        const yfTk=tk.replace('.','-');
        // Recently PAID — real ex-dates from Yahoo dividend history
        try{
          const d=await fetchYF(`https://query1.finance.yahoo.com/v8/finance/chart/${yfTk}?interval=3mo&range=1y&events=dividends`,5000);
          const divs=d?.chart?.result?.[0]?.events?.dividends;
          if(divs){Object.values(divs).forEach(dv=>{
            const dt=new Date(dv.date*1000).toISOString().split('T')[0];
            if(dt>=past90Str&&dt<=from)paid.push({ticker:tk,exDate:dt,amount:dv.amount});
          });}
        }catch(e){}
        // UPCOMING / announced — Yahoo calendarEvents (announced ex-div + pay dates)
        try{
          const q=await fetchYF(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yfTk}?modules=calendarEvents,summaryDetail`,6000);
          const res=q?.quoteSummary?.result?.[0];
          const exRaw=res?.calendarEvents?.exDividendDate?.raw||res?.summaryDetail?.exDividendDate?.raw;
          const payRaw=res?.calendarEvents?.dividendDate?.raw;
          const rate=res?.summaryDetail?.dividendRate?.raw;
          if(exRaw){
            const exDt=new Date(exRaw*1000).toISOString().split('T')[0];
            if(exDt>=from)upcoming.push({ticker:tk,exDate:exDt,payDate:payRaw?new Date(payRaw*1000).toISOString().split('T')[0]:null,annualRate:rate||null});
          }else if(payRaw){
            const payDt=new Date(payRaw*1000).toISOString().split('T')[0];
            if(payDt>=from)upcoming.push({ticker:tk,exDate:null,payDate:payDt,annualRate:rate||null});
          }
        }catch(e){}
      }));
      if(i+5<divTickers.length)await new Promise(r=>setTimeout(r,300));
      if(loadEl)loadEl.textContent=`⏳ ${Math.min(i+5,divTickers.length)}/${divTickers.length} checked...`;
    }
    paid.sort((a,b)=>b.exDate.localeCompare(a.exDate));
    upcoming.sort((a,b)=>(a.exDate||a.payDate||'z').localeCompare(b.exDate||b.payDate||'z'));
    const upRows=upcoming.map(d=>{
      const h=allHoldings.find(x=>x.ticker===d.ticker);
      return '<tr style="background:#f0fdf4"><td class="ticker-cell">'+d.ticker+'</td>'
        +'<td style="font-size:12px;font-weight:700">'+(d.exDate||'—')+'</td>'
        +'<td style="font-size:12px">'+(d.payDate||'—')+'</td>'
        +'<td style="font-weight:600">'+(d.annualRate?'$'+d.annualRate.toFixed(2)+'/yr':'—')+'</td>'
        +'<td><a href="'+irLink(d.ticker,h?.company)+'" target="_blank" style="font-size:11px;color:var(--blue);text-decoration:none">🏢 IR Page</a></td></tr>';
    }).join('');
    const paidRows=paid.map(d=>{
      const h=allHoldings.find(x=>x.ticker===d.ticker);
      return '<tr><td class="ticker-cell">'+d.ticker+'</td>'
        +'<td style="font-size:12px">'+d.exDate+'</td>'
        +'<td style="font-weight:600">$'+d.amount.toFixed(4)+'</td>'
        +'<td><a href="'+irLink(d.ticker,h?.company)+'" target="_blank" style="font-size:11px;color:var(--blue);text-decoration:none">🏢 IR Page</a></td></tr>';
    }).join('');
    tableEl.innerHTML=
      '<tr><td colspan="5" style="border:none;padding:8px 0 4px"><span style="font-size:12px;font-weight:800;color:#159a51">⏳ UPCOMING — ANNOUNCED</span></td></tr>'
      +(upcoming.length
        ?'<tr><th>Ticker</th><th>Ex-Date</th><th>Pay Date</th><th>Annual Rate</th><th>IR Page</th></tr>'+upRows
        :'<tr><td colspan="5" style="color:var(--muted);padding:10px;font-size:12px">No announced upcoming dividend dates were returned by the data source. Recently paid dividends are below.</td></tr>')
      +'<tr><td colspan="5" style="border:none;padding:16px 0 4px"><span style="font-size:12px;font-weight:800;color:var(--navy)">✅ RECENTLY PAID (last 90 days)</span></td></tr>'
      +(paid.length
        ?'<tr><th>Ticker</th><th>Ex-Date</th><th>Amount / Share</th><th>IR Page</th></tr>'+paidRows
        :'<tr><td colspan="5" style="color:var(--muted);padding:10px;font-size:12px">No dividends paid by your holdings in the last 90 days.</td></tr>');
    if(loadEl)loadEl.style.display='none'; return;
  }

  // ── STOCK SPLITS (Finnhub upcoming + Yahoo recent history) ──────────────────
  if(type==='splits'){
    if(loadEl)loadEl.textContent='⏳ Checking for stock splits...';
    const splitResults=[];
    // Announced future splits — free APIs only return executed splits, so confirmed
    // corporate actions are kept here. (Source: company 8-K filings.)
    const KNOWN_SPLITS=[
      {ticker:'CRWD',date:'2026-07-02',ratio:'4:1',note:'Record date 6/25; split-adjusted trading from 7/2'}
    ];
    KNOWN_SPLITS.forEach(k=>{
      const h=allEquities.find(x=>x.ticker===k.ticker);
      if(h)splitResults.push({ticker:k.ticker,company:h.company,date:k.date,ratio:k.ratio,upcoming:k.date>=from});
    });
    const past30=new Date(nowDate);past30.setDate(past30.getDate()-30);
    const pastFrom2=past30.toISOString().split('T')[0];
    const fut180=new Date(nowDate);fut180.setDate(fut180.getDate()+180);
    const splitTo=fut180.toISOString().split('T')[0];
    const splitTickers=allEquities.map(h=>h.ticker);
    for(let i=0;i<splitTickers.length;i+=4){
      await Promise.all(splitTickers.slice(i,i+4).map(async tk=>{
        const h=allEquities.find(x=>x.ticker===tk);
        // Try Finnhub split endpoint first (includes announced/upcoming splits)
        try{
          const fhS=await fetchYF(`https://finnhub.io/api/v1/stock/split?symbol=${tk}&from=${pastFrom2}&to=${splitTo}&token=${FINNHUB}`,5000);
          if(Array.isArray(fhS)&&fhS.length){
            fhS.forEach(s=>{
              splitResults.push({ticker:tk,company:h?.company||tk,date:s.date,ratio:s.toFactor+':'+s.fromFactor,upcoming:s.date>=from});
            });
            return; // got Finnhub data, skip Yahoo
          }
        }catch(e){}
        // Fallback: Yahoo historical split events (recent only)
        try{
          const yfTk=tk.replace('.','-');
          const d=await fetchYF(`https://query1.finance.yahoo.com/v8/finance/chart/${yfTk}?interval=3mo&range=1y&events=splits`,5000);
          const splits=d?.chart?.result?.[0]?.events?.splits;
          if(splits){
            Object.values(splits).forEach(s=>{
              const dt=new Date(s.date*1000).toISOString().split('T')[0];
              if(dt>=pastFrom2){
                splitResults.push({ticker:tk,company:h?.company||tk,date:dt,ratio:s.numerator+':'+s.denominator,upcoming:dt>=from});
              }
            });
          }
        }catch(e){}
      }));
      if(i+4<splitTickers.length)await new Promise(r=>setTimeout(r,400));
      if(loadEl)loadEl.textContent=`⏳ ${Math.min(i+4,splitTickers.length)}/${splitTickers.length} checked...`;
    }
    const dedup=[...new Map(splitResults.map(s=>[s.ticker+s.date,s])).values()].sort((a,b)=>a.date.localeCompare(b.date));
    tableEl.innerHTML=dedup.length?`<tr><th>Date</th><th>Ticker</th><th>Company</th><th>Split Ratio</th><th>Status</th><th>IR Page</th></tr>
      ${dedup.map(s=>`<tr style="${s.upcoming?'background:#f0fdf4;':''}">
        <td style="font-size:12px;font-weight:${s.upcoming?'700':'400'}">${s.date}</td>
        <td class="ticker-cell">${s.ticker}</td>
        <td>${s.company}</td>
        <td style="font-weight:700;color:var(--navy)">${s.ratio}</td>
        <td><span style="font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px;background:${s.upcoming?'#dcfce7':'#f1f5f9'};color:${s.upcoming?'#159a51':'#64748b'}">${s.upcoming?'⏳ Upcoming':'Recent'}</span></td>
        <td><a href="${irLink(s.ticker,s.company)}" target="_blank" style="font-size:11px;color:var(--blue);text-decoration:none">🏢 IR Page</a></td>
      </tr>`).join('')}`
      :'<tr><td colspan="6" style="text-align:center;color:var(--muted);padding:20px">No splits found (last 30 days or announced upcoming) for your holdings.</td></tr>';
    if(loadEl)loadEl.style.display='none'; return;
  }

  // ── UPCOMING EARNINGS (Portfolio + All) — Finnhub primary, Yahoo supplement ──
  if(!calCache){
    try{
      const _ec=JSON.parse(localStorage.getItem('cee_earnings_cache')||'null');
      if(_ec&&Date.now()-_ec.ts<43200000&&Array.isArray(_ec.data)&&_ec.data.length)calCache=_ec.data;
    }catch(e){}
  }
  if(!calCache){
    if(loadEl)loadEl.textContent='⏳ Fetching earnings calendar...';
    let fhList=[];
    // 1) Per-symbol queries for every portfolio equity — reliable on free tier
    for(let _i=0;_i<allEquities.length;_i+=4){
      await Promise.all(allEquities.slice(_i,_i+4).map(async h=>{
        try{
          const r=await fetchYF(`https://finnhub.io/api/v1/calendar/earnings?symbol=${h.ticker}&from=${from}&to=${to}&token=${FINNHUB}`,7000);
          (r?.earningsCalendar||[]).forEach(e=>fhList.push(e));
        }catch(e){}
      }));
      if(_i+4<allEquities.length)await new Promise(r=>setTimeout(r,350));
      if(loadEl)loadEl.textContent=`⏳ ${Math.min(_i+4,allEquities.length)}/${allEquities.length} holdings checked...`;
    }
    // 2) Broad market query so the "All" view has the full calendar
    try{
      const fhAll=await fetchYF(`https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${FINNHUB}`,12000);
      if(fhAll?.earningsCalendar)fhList=fhList.concat(fhAll.earningsCalendar);
    }catch(e){}
    calCache=[...new Map(fhList.map(e=>[e.symbol+e.date,e])).values()].sort((a,b)=>a.date.localeCompare(b.date));
    try{localStorage.setItem('cee_earnings_cache',JSON.stringify({ts:Date.now(),data:calCache}));}catch(e){}
    if(loadEl)loadEl.textContent='';
  }
  if(!calCache||!calCache.length){
    tableEl.innerHTML='<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px">No upcoming earnings found. Try refreshing.</td></tr>';
    if(loadEl)loadEl.style.display='none'; return;
  }
  const bmoS='<span class="cal-bmo">Before Open</span>';
  const amcS='<span class="cal-amc">After Close</span>';
  let filtered=type==='portfolio'?calCache.filter(e=>portTickers.has(e.symbol)):calCache;
  filtered=[...filtered].sort((a,b)=>a.date.localeCompare(b.date)).slice(0,80);
  tableEl.innerHTML=filtered.length?`<tr><th>Date</th><th>Ticker</th><th>Company</th><th>When</th><th>EPS Est.</th><th>In Portfolio</th><th>IR Page</th></tr>
    ${filtered.map(e=>{
      const inP=portTickers.has(e.symbol);
      const when=e.hour==='bmo'?bmoS:e.hour==='amc'?amcS:'—';
      const h=allHoldings.find(x=>x.ticker===e.symbol);
      return `<tr style="${inP?'background:#f0fdf4;':''}">
        <td style="font-size:12px;font-weight:${inP?'700':'400'}">${e.date}</td>
        <td class="ticker-cell">${e.symbol}</td>
        <td>${h?.company||e.name||e.symbol}</td>
        <td>${when}</td>
        <td style="font-size:12px">${e.epsEstimate!=null?'$'+Number(e.epsEstimate).toFixed(2):'—'}</td>
        <td>${inP?'<span style="font-size:10px;font-weight:700;padding:1px 6px;border-radius:3px;background:#dcfce7;color:#159a51">✓ Owned</span>':'—'}</td>
        <td><a href="${irLink(e.symbol,h?.company)}" target="_blank" style="font-size:11px;color:var(--blue);text-decoration:none">🏢 IR Page</a></td>
      </tr>`;
    }).join('')}`
    :`<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px">${type==='portfolio'?'No upcoming earnings for your holdings in the next 90 days.':'No earnings found.'}</td></tr>`;
  }catch(e){if(tableEl)tableEl.innerHTML='<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:20px">Could not load calendar data.</td></tr>';}
  if(loadEl)loadEl.style.display='none';
}

// ── LIVE PRICES ───────────────────────────────────────────────────────────────
async function fetchLivePrices(){
  if(window._pricesBusy)return; window._pricesBusy=1;
  document.getElementById('refreshLabel').textContent='Fetching 0%...';
  const tks=[...new Set([...RAW.endowment.equities,...RAW.endowment.etfs,...RAW.ceeFund.equities,...RAW.ceeFund.etfs].map(h=>h.ticker))];
  let updated=0; const failed=[];
  // Yahoo through the Cloudflare proxy — no Finnhub 60/min cap, so all tickers refresh in one pass.
  for(let i=0;i<tks.length;i+=6){
    await Promise.all(tks.slice(i,i+6).map(async tk=>{
      const yfTk=tk.replace('.','-');
      try{
        const d=await fetchYF(`https://query1.finance.yahoo.com/v8/finance/chart/${yfTk}?interval=1d&range=1d`,7000);
        const res=d?.chart?.result?.[0];
        const meta=res?.meta;
        const price=meta?.regularMarketPrice ?? (res?.indicators?.quote?.[0]?.close||[]).filter(x=>x!=null).pop();
        const prevC=meta?.chartPreviousClose ?? meta?.previousClose;
        if(price&&price>0){
          ['endowment','ceeFund'].forEach(fund=>{
            const src=fund==='endowment'?RAW.endowment:RAW.ceeFund;
            [...src.equities,...src.etfs].forEach(h=>{
              if(h.ticker===tk){
                const dd=prevC?price-prevC:0;
                h.dayPct=prevC?(price-prevC)/prevC:0;
                h.dayDollar=h.shares?dd*h.shares:0;
                h.price=price;
                h.marketValue=h.shares?h.shares*price:h.marketValue;
                h.glDollar=h.marketValue-(h.costBasis||0);
                h.glPct=h.costBasis?(h.marketValue-h.costBasis)/h.costBasis:0;
                updated++;
              }
            });
          });
          livePrices[tk]=price;
        } else { failed.push(tk); }
      }catch(e){ failed.push(tk); }
    }));
    document.getElementById('refreshLabel').textContent=`Fetching ${Math.round(Math.min(i+6,tks.length)/tks.length*100)}%...`;
    if(i+6<tks.length)await new Promise(res=>setTimeout(res,200));
  }
  if(updated>0){
    buildState();renderAll();
    recomputeYTDFromLive();
    document.getElementById('lastUpdate').textContent=`Live · ${new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'})}`;
  }
  if(failed.length)console.warn('Live price NOT updated for: '+failed.join(', ')+' (Yahoo returned no quote — check ticker mapping)');
  else console.log('Live prices updated for all '+tks.length+' tickers ✓');
  document.getElementById('refreshLabel').textContent='↻ Refresh Prices';
  window._pricesBusy=0;
}

async function refreshPrices(){await fetchLivePrices();await fetchSPX();}

async function fetchSPX(){
  try{
    const r=await fetch(`https://finnhub.io/api/v1/quote?symbol=SPY&token=${FINNHUB}`);
    if(r.status===429)return;
    const d=await r.json();
    if(d.c){
      spxData=d;const pct=(d.c-d.pc)/d.pc*100;
      const el=document.getElementById('spxPrice');if(el){el.textContent=`$${d.c.toFixed(2)} (${pct>=0?'+':''}${pct.toFixed(2)}%)`;el.className=pct>=0?'pos':'neg';}
      const st=document.getElementById('spxStats');if(st)st.innerHTML=`<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:12px"><div><span style="color:var(--muted)">Open:</span> <strong>$${d.o?.toFixed(2)||'—'}</strong></div><div><span style="color:var(--muted)">Prev Close:</span> <strong>$${d.pc?.toFixed(2)||'—'}</strong></div><div><span style="color:var(--muted)">High:</span> <strong>$${d.h?.toFixed(2)||'—'}</strong></div><div><span style="color:var(--muted)">Low:</span> <strong>$${d.l?.toFixed(2)||'—'}</strong></div></div>`;
      const kv=document.getElementById('spxKpiVal');if(kv)kv.textContent=`$${d.c.toFixed(2)}`;
      const ks=document.getElementById('spxKpiSub');if(ks){ks.textContent=`${pct>=0?'+':''}${pct.toFixed(2)}% today`;ks.className='kpi-sub '+(pct>=0?'pos':'neg');}
    }
  }catch(e){}
}

// ── YAHOO FINANCE FETCH ───────────────────────────────────────────────────────
const CF_PROXY = 'https://ceefund.wmaxe576.workers.dev';

// ── Finnhub rate governor: free tier = 60 calls/min. We cap at 50/min globally
// and share a backoff window across ALL callers when a 429 is seen.
const _fhTimes=[]; let _fhBackoffUntil=0;
async function _fhGate(){
  for(;;){
    const now=Date.now();
    if(now<_fhBackoffUntil){await new Promise(r=>setTimeout(r,Math.min(_fhBackoffUntil-now,3000)));continue;}
    while(_fhTimes.length&&now-_fhTimes[0]>61000)_fhTimes.shift();
    if(_fhTimes.length<50){_fhTimes.push(now);return;}
    await new Promise(r=>setTimeout(r,1400));
  }
}
function _fh429(){ _fhBackoffUntil=Date.now()+30000; console.warn('Finnhub rate limit hit — all Finnhub calls paused 30s'); }

async function fetchYF(url, ms=7000){
  const isFH=url.includes('finnhub.io');
  if(isFH)await _fhGate();
  const fetchUrl = url.includes('yahoo.com')
    ? CF_PROXY + '?url=' + encodeURIComponent(url)
    : url;
  try{
    const ctrl=new AbortController();
    const timer=setTimeout(()=>ctrl.abort(),ms);
    let r=await fetch(fetchUrl,{signal:ctrl.signal});
    clearTimeout(timer);
    if(isFH&&r.status===429){
      _fh429(); await _fhGate();           // wait out the shared backoff, then retry once
      r=await fetch(fetchUrl);
    }
    if(!r.ok)return null;
    return await r.json();
  }catch(e){return null;}
}

// ── PERIOD RETURNS via Yahoo Finance + Cloudflare Proxy ──────────────────────
const candleCache = {};

const YF_RANGES = {
  '1W':'5d', '1M':'1mo', '3M':'3mo', '6M':'6mo',
  '1Y':'1y', '3Y':'5y', '5Y':'5y', 'YTD':'ytd'
};
const YF_INTERVALS = {
  '1W':'1d', '1M':'1d', '3M':'1wk', '6M':'1wk',
  '1Y':'1wk', '3Y':'1mo', '5Y':'1mo', 'YTD':'1wk'
};

async function fetchCandleReturn(ticker, period) {
  if (period === '1D') return null; // handled via quote
  const cacheKey = ticker + '_' + period;
  if (candleCache[cacheKey] !== undefined) return candleCache[cacheKey];

  const yfTicker = ticker.replace('.', '-'); // Yahoo uses BRK-B not BRK.B
  let url;
  if (period === 'YTD') {
    const yr = new Date().getFullYear();
    // Jan-2 baselines never change during the year — cache them in localStorage
    window.ytdBase = window.ytdBase || (function(){ try{ const b=JSON.parse(localStorage.getItem('cee_ytd_base')||'null'); return (b&&b.yr===yr)?b.data:{}; }catch(e){ return {}; } })();
    window.ytdLast = window.ytdLast || {};
    let base = window.ytdBase[ticker];
    let freshCur = null;
    if (base === undefined || window.ytdLast[ticker] === undefined) {
      // One fetch gives BOTH the Jan-2 baseline AND a fresh current price (last close in the series)
      const r = await fetchYF(`https://query1.finance.yahoo.com/v8/finance/chart/${yfTicker}?interval=1d&range=1y`, 8000);
      const result = r?.chart?.result?.[0];
      const ts = result?.timestamp || [];
      const closes = result?.indicators?.quote?.[0]?.close || [];
      const jan1Ts = Math.floor(new Date(yr,0,1).getTime()/1000);
      const pts = ts.map((t,x)=>({t:Number(t),c:closes[x]})).filter(p=>p.c!=null&&!isNaN(p.c)&&p.t>=jan1Ts);
      if (!pts.length) { console.warn('YTD '+ticker+': no current-year closes returned'); candleCache[cacheKey]=null; return null; }
      base = { c: pts[0].c, dt: new Date(pts[0].t*1000).toISOString().split('T')[0] };
      // last close in the series = freshest market price from the SAME source as the baseline
      const metaPrice = result?.meta?.regularMarketPrice;
      freshCur = (metaPrice && metaPrice>0) ? metaPrice : pts[pts.length-1].c;
      window.ytdBase[ticker] = base;
      window.ytdLast[ticker] = freshCur;
      try{ localStorage.setItem('cee_ytd_base', JSON.stringify({yr:yr, data:window.ytdBase})); }catch(e){}
    }
    // Prefer the fresh Yahoo close from this fetch; then the live holdings price; never the stale snapshot alone
    const hLive = ALL_HOLDINGS().find(h=>h.ticker===ticker);
    let cur = freshCur || window.ytdLast[ticker] || (hLive && hLive.price ? hLive.price : null);
    if (cur === null) { candleCache[cacheKey]=null; return null; }
    const pct = (cur - base.c) / base.c * 100;
    window.ytdMeta = window.ytdMeta || {};
    window.ytdMeta[ticker] = { base: base.c.toFixed(2), baseDt: base.dt, last: cur.toFixed(2), pct: pct.toFixed(2) };
    console.log('YTD '+ticker+': Jan-2 close $'+base.c.toFixed(2)+' ('+base.dt+') → live $'+cur.toFixed(2)+' = '+(pct>=0?'+':'')+pct.toFixed(2)+'%');
    if (Math.abs(pct) > 80) console.warn('YTD '+ticker+' unusually large ('+pct.toFixed(1)+'%) — verify baseline above');
    candleCache[cacheKey] = parseFloat(pct.toFixed(2));
    return candleCache[cacheKey];
  }

  const range = YF_RANGES[period] || '1mo';
  const interval = YF_INTERVALS[period] || '1d';
  url = `https://query1.finance.yahoo.com/v8/finance/chart/${yfTicker}?interval=${interval}&range=${range}`;
  try {
    const r = await fetchYF(url, 8000);
    if (!r) { candleCache[cacheKey] = null; return null; }
    const result = r.chart?.result?.[0];
    if (!result) { candleCache[cacheKey] = null; return null; }
    const closes = result.indicators?.quote?.[0]?.close || [];
    let valid = closes.filter(x => x !== null && x !== undefined && !isNaN(x));
    if (valid.length < 2) { candleCache[cacheKey] = null; return null; }
    if (period==='3Y' && valid.length>36) valid=valid.slice(-37);
    const pct = (valid[valid.length-1] - valid[0]) / valid[0] * 100;
    if (Math.abs(pct) > 500) { candleCache[cacheKey] = null; return null; }
    candleCache[cacheKey] = parseFloat(pct.toFixed(2));
    return candleCache[cacheKey];
  } catch(e) { candleCache[cacheKey] = null; return null; }
}


function setSCPeriod(period,btn){
  activeSCPeriod=period;
  document.querySelectorAll('#scPeriodRow .period-btn').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  if(activeSCSector)renderSCChart(activeSCSector,currentSCView,period);
}

// ── ADMIN ─────────────────────────────────────────────────────────────────────
// Synchronous SHA-256 (hex) — used so no admin code or password ever sits in
// source or localStorage as recoverable text. Verified against FIPS test vectors.
function sha256(str){
  const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  let H=[0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const bytes=new TextEncoder().encode(str);
  const bitLen=bytes.length*8;
  const padded=new Uint8Array((((bytes.length+8)>>6)+1)<<6);
  padded.set(bytes); padded[bytes.length]=0x80;
  const dv=new DataView(padded.buffer);
  dv.setUint32(padded.length-4,bitLen>>>0);
  dv.setUint32(padded.length-8,Math.floor(bitLen/4294967296));
  const w=new Array(64);
  const rr=(x,n)=>(x>>>n)|(x<<(32-n));
  for(let i=0;i<padded.length;i+=64){
    for(let t=0;t<16;t++)w[t]=dv.getUint32(i+t*4);
    for(let t=16;t<64;t++){const s0=rr(w[t-15],7)^rr(w[t-15],18)^(w[t-15]>>>3);const s1=rr(w[t-2],17)^rr(w[t-2],19)^(w[t-2]>>>10);w[t]=(w[t-16]+s0+w[t-7]+s1)>>>0;}
    let [a,b,c,d,e,f,g,h]=H;
    for(let t=0;t<64;t++){const S1=rr(e,6)^rr(e,11)^rr(e,25);const ch=(e&f)^(~e&g);const t1=(h+S1+ch+K[t]+w[t])>>>0;const S0=rr(a,2)^rr(a,13)^rr(a,22);const maj=(a&b)^(a&c)^(b&c);const t2=(S0+maj)>>>0;h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;}
    H=[(H[0]+a)>>>0,(H[1]+b)>>>0,(H[2]+c)>>>0,(H[3]+d)>>>0,(H[4]+e)>>>0,(H[5]+f)>>>0,(H[6]+g)>>>0,(H[7]+h)>>>0];
  }
  return H.map(x=>x.toString(16).padStart(8,'0')).join('');
}
const PW_SALT='_ceefund_salt_2026';
function logoClick(){logoClickCount++;clearTimeout(logoClickTimer);logoClickTimer=setTimeout(()=>{logoClickCount=0;},2000);if(logoClickCount>=3){logoClickCount=0;openAdmin();}}
document.addEventListener('keypress',function(e){secretBuffer+=e.key.toLowerCase();if(secretBuffer.length>8)secretBuffer=secretBuffer.slice(-8);if(secretBuffer.includes('ceeadmin')){secretBuffer='';openAdmin();}});
function openAdmin(){document.getElementById('adminOverlay').classList.add('show');adminGoTo(0);if(localStorage.getItem('cee_upload_pw'))document.getElementById('uploadBtn').classList.add('visible');}
function closeAdmin(){document.getElementById('adminOverlay').classList.remove('show');['masterCodeInput','newPwInput','confirmPwInput','uploadPwInput'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});['masterError','pwError','pwSuccess','uploadPwError'].forEach(id=>{const el=document.getElementById(id);if(el)el.classList.remove('show');});}
function showUploadPrompt(){openAdmin();adminGoTo(localStorage.getItem('cee_upload_pw')?3:1);}
function adminGoTo(step){document.querySelectorAll('.admin-step').forEach(s=>s.classList.remove('show'));document.getElementById('adminStep'+step).classList.add('show');}
function verifyMaster(){if(sha256(document.getElementById('masterCodeInput').value.trim()+PW_SALT)===MASTER_HASH){document.getElementById('masterError').classList.remove('show');document.getElementById('masterCodeInput').value='';adminGoTo(2);}else{document.getElementById('masterError').classList.add('show');}}
function setPassword(){const pw=document.getElementById('newPwInput').value;const confirm=document.getElementById('confirmPwInput').value;if(pw.length<6){document.getElementById('pwError').textContent='Min 6 characters.';document.getElementById('pwError').classList.add('show');return;}if(pw!==confirm){document.getElementById('pwError').textContent='Passwords do not match.';document.getElementById('pwError').classList.add('show');return;}localStorage.setItem('cee_upload_pw',sha256(pw+PW_SALT));document.getElementById('pwError').classList.remove('show');document.getElementById('pwSuccess').classList.add('show');document.getElementById('uploadBtn').classList.add('visible');setTimeout(()=>{document.getElementById('pwSuccess').classList.remove('show');document.getElementById('newPwInput').value='';document.getElementById('confirmPwInput').value='';adminGoTo(0);},2000);}
function verifyUploadPw(){
  const stored=localStorage.getItem('cee_upload_pw');
  const pw=document.getElementById('uploadPwInput').value;
  const hashed=sha256(pw+PW_SALT);
  const legacy=btoa(pw+PW_SALT); // pre-v28 passwords were stored base64-encoded
  if(stored&&(hashed===stored||legacy===stored)){
    if(legacy===stored)localStorage.setItem('cee_upload_pw',hashed); // migrate old format
    document.getElementById('uploadPwError').classList.remove('show');
    document.getElementById('uploadPwInput').value='';
    adminGoTo(4);
  }else{document.getElementById('uploadPwError').classList.add('show');}
}
function resetToEmbedded(){if(confirm('Reset to original embedded data?'))location.reload();}

// ── EXCEL UPLOAD ──────────────────────────────────────────────────────────────
const COMPANY_NAMES={'GOOG':'Alphabet Inc.','META':'Meta Platforms','NFLX':'Netflix','TKO':'TKO Group','AMZN':'Amazon','HD':'Home Depot','COST':'Costco','KO':'Coca-Cola','WMT':'Walmart','XOM':'ExxonMobil','BRK.B':'Berkshire Hathaway','BX':'Blackstone','MA':'Mastercard','SPGI':'S&P Global','V':'Visa','TMUS':'T-Mobile','HCA':'HCA Healthcare','LLY':'Eli Lilly','PFE':'Pfizer','SYK':'Stryker','CAT':'Caterpillar','HWM':'Howmet Aerospace','SBGSF':'Safran SA','WM':'Waste Management','AAPL':'Apple','CRWD':'CrowdStrike','MSFT':'Microsoft','NVDA':'NVIDIA','ORCL':'Oracle','TSM':'TSMC','NUE':'Nucor','DLR':'Digital Realty','CEG':'Constellation Energy','ABBV':'AbbVie','ADI':'Analog Devices','COF':'Capital One','DAR':'Darling Ingredients','DIS':'Walt Disney','ET':'Energy Transfer','FSLR':'First Solar','GD':'General Dynamics','GOOGL':'Alphabet Inc.','GRMN':'Garmin','HOOD':'Robinhood','IREN':'Iris Energy','ISRG':'Intuitive Surgical','PANW':'Palo Alto Networks','PLTR':'Palantir','SOFI':'SoFi Technologies','SOUN':'SoundHound AI','TTWO':'Take-Two Interactive','VMC':'Vulcan Materials','FDIS':'Fidelity MSCI Consumer Disc ETF','FTEC':'Fidelity MSCI Info Tech ETF','IGV':'iShares Expanded Tech-Software ETF','NLR':'VanEck Uranium+Nuclear Energy ETF','PSCT':'Invesco S&P SmallCap IT ETF','QQQ':'Invesco QQQ (Nasdaq-100)','RSPN':'Invesco S&P 500 Equal Wt Industrials','SMH':'VanEck Semiconductor ETF','VCSH':'Vanguard Short-Term Corp Bond ETF','VFH':'Vanguard Financials ETF','VHT':'Vanguard Health Care ETF','VIS':'Vanguard Industrials ETF','VOO':'Vanguard S&P 500 ETF','VTI':'Vanguard Total Stock Market ETF','VUG':'Vanguard Growth ETF','XLB':'Materials Select Sector SPDR','XLC':'Communication Services SPDR','XLE':'Energy Select Sector SPDR','XLF':'Financial Select Sector SPDR','XLP':'Consumer Staples SPDR','XLU':'Utilities Select Sector SPDR','BILS':'SPDR Bloomberg 3-6 Mo T-Bill ETF','IYG':'iShares U.S. Financial Services ETF','IYJ':'iShares U.S. Industrials ETF','VGLT':'Vanguard Long-Term Treasury ETF','VGT':'Vanguard Information Technology ETF','VNQ':'Vanguard Real Estate ETF','XLV':'Health Care Select SPDR','XLY':'Consumer Discretionary SPDR'};
const ETF_SECTORS={'FDIS':'Consumer Discretionary','FTEC':'Information Technology','IGV':'Information Technology','NLR':'Energy','PSCT':'Information Technology','QQQ':'Information Technology','RSPN':'Industrials','SMH':'Information Technology','VCSH':'Fixed Income','VFH':'Financials','VHT':'Health Care','VIS':'Industrials','VOO':'Broad Market','VTI':'Broad Market','VUG':'Broad Market','XLB':'Materials','XLC':'Communication Services','XLE':'Energy','XLF':'Financials','XLP':'Consumer Staples','XLU':'Utilities','BILS':'Fixed Income','IYG':'Financials','IYJ':'Industrials','VGLT':'Fixed Income','VGT':'Information Technology','VNQ':'Real Estate','XLV':'Health Care','XLY':'Consumer Discretionary'};
const ETF_BETAS={'FDIS':0.9624,'FTEC':0.9793,'IGV':1.0154,'NLR':0.9375,'PSCT':0.5955,'QQQ':0.9525,'RSPN':1.0296,'SMH':1.5004,'VCSH':0.6346,'VFH':1.0567,'VHT':1.0063,'VIS':1.0457,'VOO':1.0001,'VTI':1.0016,'VUG':1.0208,'XLB':0.9859,'XLC':0.9451,'XLE':1.1061,'XLF':0.9984,'XLP':0.9908,'XLU':0.9976,'BILS':1.5414,'IYG':1.0856,'IYJ':0.9427,'VGLT':0.9988,'VGT':0.9815,'VNQ':1.0147,'XLV':1.0054,'XLY':0.9435};

function handleExcelUpload(input){
  const file=input.files[0];if(!file)return;
  const okEl=document.getElementById('uploadSuccess'),errEl=document.getElementById('uploadError');
  okEl.style.display='none';errEl.style.display='none';
  const reader=new FileReader();
  reader.onload=function(e){
    try{
      const data=new Uint8Array(e.target.result);const wb=XLSX.read(data,{type:'array',cellDates:true});
      const sheets=wb.SheetNames;
      const endSheet=wb.Sheets['Endowment'],ceeSheet=wb.Sheets['CEE Fund'];
      const txSheetName=sheets.find(s=>s.trim()==='Transactions'||s.trim()==='Transactions ');
      if(!endSheet||!ceeSheet||!txSheetName){errEl.textContent='Missing required sheets.';errEl.style.display='block';return;}
      const endR=parsePortfolioSheet(XLSX.utils.sheet_to_json(endSheet,{header:1,defval:null}),'Endowment');
      const ceeR=parsePortfolioSheet(XLSX.utils.sheet_to_json(ceeSheet,{header:1,defval:null}),'CEE Fund');
      const txR=parseTransactionsXLS(XLSX.utils.sheet_to_json(wb.Sheets[txSheetName],{header:1,defval:null}));
      // Validate before committing — a bad upload must not break the shared site
      if(!endR.equities.length || !ceeR.equities.length){errEl.textContent='Validation failed: no equities parsed in one or both funds. Upload aborted.';errEl.style.display='block';return;}
      RAW.endowment.equities=endR.equities;RAW.endowment.etfs=endR.etfs;RAW.endowment.cash=endR.cash;
      RAW.ceeFund.equities=ceeR.equities;RAW.ceeFund.etfs=ceeR.etfs;RAW.ceeFund.cash=ceeR.cash;
      TRANSACTIONS.length=0;txR.forEach(t=>TRANSACTIONS.push(t));
      buildState();renderAll();
      okEl.textContent=`✅ ${endR.equities.length} Endowment equities, ${endR.etfs.length} ETFs | ${ceeR.equities.length} CEE equities, ${ceeR.etfs.length} ETFs | ${txR.length} transactions`;
      okEl.style.display='block';document.getElementById('lastUpdate').textContent=`Uploaded: ${file.name}`;input.value='';
      // Push to Firebase so every visitor sees this upload on their next load
      saveHoldingsToFirebase(file.name);
    }catch(err){errEl.textContent='Error: '+err.message;errEl.style.display='block';}
  };
  reader.readAsArrayBuffer(file);
}

function parsePortfolioSheet(rows,fundName){
  const equities=[],etfs=[];let cash=0,inEtf=false;
  for(let i=0;i<rows.length;i++){
    const row=rows[i];if(!row||!row[1])continue;const cell=String(row[1]).trim();
    if(cell.toLowerCase().includes('etf')){inEtf=true;continue;}
    if(cell==='Cash'&&row[2]&&typeof row[2]==='number'){cash=row[2];continue;}
    if(cell==='Ticker'||!row[3]||typeof row[3]!=='number')continue;
    if(cell.length>8&&!cell.match(/^[A-Z.]+$/))continue;
    const tk=cell.replace('BRK/B','BRK.B');
    const h={ticker:tk,company:COMPANY_NAMES[tk]||tk,shares:row[3]||0,costBasis:row[4]||0,avgCost:row[5]||0,price:row[6]||0,marketValue:row[7]||(row[3]||0)*(row[6]||0),dayPct:row[8]||0,dayDollar:row[9]||0,glDollar:row[10]||0,glPct:row[11]||0,sector:inEtf?(ETF_SECTORS[tk]||'ETF'):(typeof row[12]==='string'?row[12]:'Unknown'),beta:inEtf?(ETF_BETAS[tk]||1.0):(typeof row[13]==='number'?row[13]:1.0),type:inEtf?'etf':'equity',fund:fundName};
    if(inEtf)etfs.push(h);else equities.push(h);
  }
  return{equities,etfs,cash,total:[...equities,...etfs].reduce((s,h)=>s+(h.marketValue||0),0)+cash};
}

function parseTransactionsXLS(rows){
  const tx=[];
  for(let i=1;i<rows.length;i++){
    const row=rows[i];if(!row||!row[0]||!row[2])continue;
    let dateVal=row[0],dateStr='';
    if(dateVal instanceof Date)dateStr=dateVal.toISOString().split('T')[0];
    else if(typeof dateVal==='number')dateStr=new Date((dateVal-25569)*86400*1000).toISOString().split('T')[0];
    else dateStr=String(dateVal).split('T')[0];
    tx.push({date:dateStr,fund:String(row[1]||'').trim(),ticker:String(row[2]||'').trim().replace('BRK/B','BRK.B'),action:String(row[3]||'').trim(),shares:typeof row[4]==='number'?row[4]:parseFloat(row[4])||0,price:typeof row[5]==='number'?row[5]:parseFloat(row[5])||0});
  }
  return tx.filter(t=>t.ticker&&t.shares>0).sort((a,b)=>a.date.localeCompare(b.date));
}

// ── UTILS ─────────────────────────────────────────────────────────────────────
function fmt(n){return Math.abs(n)>=1000000?(n/1000000).toFixed(2)+'M':Math.abs(n)>=1000?Math.round(Math.abs(n)).toLocaleString():Math.abs(n).toFixed(2);}
function fmtK(n){return n>=1000000?'$'+(n/1000000).toFixed(1)+'M':n>=1000?'$'+(n/1000).toFixed(0)+'K':'$'+n.toFixed(0);}

// ── SECTOR COMPARE ────────────────────────────────────────────────────────────


async function showSectorComparePeriod(sectorName,cardEl){
  document.querySelectorAll('.sc-card').forEach(c=>c.classList.remove('active'));
  if(cardEl)cardEl.classList.add('active');
  activeSCSector=sectorName;
  await renderSCChart(sectorName,'top',activeSCPeriod);
}

async function renderSCChart(sectorName, view, period) {
  activeSCSector = sectorName;
  currentSCView = view;
  const loadEl = document.getElementById('scPeriodLoading');
  if (loadEl) loadEl.textContent = '⏳ Loading...';
  const sectors=coreSectorsOf(S.holdings);
  const sec=sectors.find(s=>s.name===sectorName);
  if(!sec){if(loadEl)loadEl.textContent='';return;}
  const equities=sec.holdings.filter(h=>h.type==='equity');
  const etfs=sec.holdings.filter(h=>h.type==='etf');
  const benchmark=SECTOR_BENCHMARKS[sectorName]||'SPY';
  const returns={};

  if(period==='1D'){
    sec.holdings.forEach(h=>{returns[h.ticker]=h.dayPct!==undefined&&h.dayPct!==null?h.dayPct*100:null;});
    // Use Yahoo Finance for benchmark 1D (Finnhub candle is paid tier)
    try{
      const _bUrl=`https://query1.finance.yahoo.com/v8/finance/chart/${benchmark}?interval=1d&range=5d`;
      const _bData=await fetchYF(_bUrl,5000);
      const _bCl=(_bData?.chart?.result?.[0]?.indicators?.quote?.[0]?.close||[]).filter(x=>x!=null);
      returns[benchmark]=_bCl.length>=2?parseFloat(((_bCl[_bCl.length-1]-_bCl[_bCl.length-2])/_bCl[_bCl.length-2]*100).toFixed(2)):null;
    }catch(e){returns[benchmark]=null;}
  } else if(period==='YTD'){
    // TRUE year-to-date for every holding — same engine as the thesis table (Jan-2 anchor)
    if(loadEl)loadEl.textContent='⏳ Fetching YTD returns...';
    const _hs=sec.holdings;
    for(let _i=0;_i<_hs.length;_i+=8){
      await Promise.all(_hs.slice(_i,_i+8).map(async h=>{
        if(ytdCache[h.ticker]==null){const v=await fetchCandleReturn(h.ticker,'YTD');if(v!==null)ytdCache[h.ticker]=v;}
        returns[h.ticker]=ytdCache[h.ticker]!=null?ytdCache[h.ticker]:null;
      }));
      if(_i+8<_hs.length)await new Promise(r=>setTimeout(r,250));
    }
    const bv2=await fetchCandleReturn(benchmark,'YTD'); returns[benchmark]=bv2;
    if(loadEl)loadEl.textContent='';
  } else {
    // Use Finnhub candle data for reliable period returns
    if(loadEl)loadEl.textContent=`⏳ Fetching ${period} data...`;
    const benchRet = await fetchCandleReturn(benchmark, period);
    returns[benchmark] = benchRet;
    const tks=sec.holdings.map(h=>h.ticker);
    // Yahoo Finance via proxy - can batch more aggressively
    for(let i=0;i<tks.length;i+=8){
      await Promise.all(tks.slice(i,i+8).map(async tk=>{
        returns[tk] = await fetchCandleReturn(tk, period);
      }));
      if(i+8<tks.length)await new Promise(r=>setTimeout(r,300));
      if(loadEl)loadEl.textContent=`⏳ ${Math.min(i+8,tks.length)}/${tks.length} loaded...`;
    }
  }
  if(loadEl)loadEl.textContent='';

  const eqMV=equities.reduce((s,h)=>s+(h.marketValue||0),0)||1;
  const etfMV=etfs.reduce((s,h)=>s+(h.marketValue||0),0)||1;
  const secTotalMV=sec.holdings.reduce((s,h)=>s+(h.marketValue||0),0)||1;

  function wRet(holdings,totalMV){
    let sw=0,sr=0;
    holdings.forEach(h=>{if(returns[h.ticker]!==null&&returns[h.ticker]!==undefined){const w=(h.marketValue||0)/totalMV;sr+=returns[h.ticker]*w;sw+=w;}});
    return sw>0?sr/sw:null;
  }

  const eqReturn=equities.length>0?wRet(equities,eqMV):null;
  const etfReturn=etfs.length>0?wRet(etfs,etfMV):null;
  const sectorTotalReturn=wRet(sec.holdings,secTotalMV);
  const benchReturn=returns[benchmark]!==null&&returns[benchmark]!==undefined?returns[benchmark]:null;

  const fr=(v,lbl='')=>v!==null&&v!==undefined?`<span class="${v>=0?'pos':'neg'}">${v>=0?'+':''}${v.toFixed(2)}%</span>`:`<span style="color:var(--muted)">—</span>`;
  const frp=(v)=>v!==null&&v!==undefined?`${v>=0?'+':''}${v.toFixed(2)}%`:'—';

  const eqClick = view==='top' ? "renderSCChart('"+sectorName+"','equities','"+period+"')" : "";
  const etfClick = view==='top' ? "renderSCChart('"+sectorName+"','etfs','"+period+"')" : "";
  // Benchmark ETF beta: prefer live beta if the fund holds it, else published 5Y figures
  const BENCH_BETAS={XLK:1.42,XLI:1.05,XLF:1.00,XLV:0.65,XLE:0.95,XLY:1.15,XLC:1.00,XLP:0.55,XLU:0.70,XLB:1.05,VNQ:1.00,SMH:1.60,IYG:1.05,IYJ:1.05,NLR:0.95};
  const _bh=ALL_HOLDINGS().find(h=>h.ticker===benchmark);
  const benchBeta=_bh&&_bh.beta?_bh.beta:(BENCH_BETAS[benchmark]||1.00);
  const betaDiff=sec.beta-benchBeta;
  document.getElementById('scKpis').innerHTML=`
    <div class="perf-card" style="border-left:3px solid var(--gold)"><div class="perf-label">Sector Total (${period})</div><div class="perf-value">${fr(sectorTotalReturn)}</div><div class="perf-sub">Eq+ETF combined</div></div>
    <div class="perf-card" style="cursor:${view==='top'?'pointer':'default'}" onclick="${eqClick}"><div class="perf-label">Equities (${period})${view==='top'?' ▶':''}</div><div class="perf-value">${fr(eqReturn)}</div><div class="perf-sub">${equities.length} stocks</div></div>
    <div class="perf-card" style="cursor:${view==='top'?'pointer':'default'}" onclick="${etfClick}"><div class="perf-label">ETFs (${period})${view==='top'?' ▶':''}</div><div class="perf-value">${fr(etfReturn)}</div><div class="perf-sub">${etfs.length} ETFs</div></div>
    <div class="perf-card"><div class="perf-label">${benchmark} (${period})</div><div class="perf-value">${fr(benchReturn)}</div><div class="perf-sub">Sector benchmark</div></div>
    <div class="perf-card"><div class="perf-label">Alpha vs ${benchmark}</div><div class="perf-value">${sectorTotalReturn!==null&&benchReturn!==null?fr(sectorTotalReturn-benchReturn):'<span style="color:var(--muted)">—</span>'}</div><div class="perf-sub">Sector vs benchmark</div></div>
    <div class="perf-card"><div class="perf-label">Sector β vs ${benchmark} β</div><div class="perf-value"><span class="${betaDiff>0.05?'neg':betaDiff<-0.05?'pos':''}">β${sec.beta.toFixed(2)}</span> <span style="font-size:13px;color:var(--muted)">vs β${benchBeta.toFixed(2)}</span></div><div class="perf-sub">${betaDiff>=0?'+':''}${betaDiff.toFixed(2)} vs ${benchmark} — ${Math.abs(betaDiff)<0.05?'in line with':betaDiff>0?'riskier than':'more defensive than'} its benchmark</div></div>
    <div class="perf-card"><div class="perf-label">Sector Weight</div><div class="perf-value">${(sec.pct*100).toFixed(1)}%</div><div class="perf-sub">of ${S.fundName} · β${sec.beta.toFixed(2)}</div></div>`;

  document.getElementById('scChartTitle').textContent=`${sectorName} — ${period} vs ${benchmark}`;
  document.getElementById('sectorCompareDetail').style.display='block';

  let labels=[],vals=[],bgColors=[],borderColors=[];
  if(view==='top'){
    labels=['Equities','ETFs','Sector Total',benchmark];
    vals=[(eqReturn||0),(etfReturn||0),(sectorTotalReturn||0),(benchReturn||0)].map(v=>parseFloat((v||0).toFixed(2)));
    bgColors=['rgba(0,31,91,0.7)','rgba(157,23,77,0.7)','rgba(22,163,74,0.7)','rgba(249,115,22,0.8)'];
    borderColors=['#0c2a5e','#9d174d','#159a51','#f97316'];
  } else {
    const sorted=view==='equities'?[...equities].sort((a,b)=>(b.marketValue||0)-(a.marketValue||0)):[...etfs].sort((a,b)=>(b.marketValue||0)-(a.marketValue||0));
    labels=[...sorted.map(h=>h.ticker),benchmark];
    vals=[...sorted.map(h=>{const v=returns[h.ticker];return v!==null&&v!==undefined?parseFloat(v.toFixed(2)):0;}),parseFloat((benchReturn??0).toFixed(2))];
    bgColors=[...sorted.map(h=>(returns[h.ticker]??0)>=0?'rgba(0,31,91,0.7)':'rgba(220,38,38,0.7)'),'rgba(249,115,22,0.8)'];
    borderColors=[...sorted.map(h=>(returns[h.ticker]??0)>=0?'#0c2a5e':'#d6453d'),'#f97316'];
    const makeRow=h=>{
      const rv=returns[h.ticker]!==null&&returns[h.ticker]!==undefined?returns[h.ticker]:null;
      const tr=h.glPct?h.glPct*100:0;
      const _ytdV=ytdCache[h.ticker];
      const _ytdCls=_ytdV!=null?(_ytdV>=0?'pos':'neg'):'';
      const _ytdTxt=_ytdV!=null?(_ytdV>=0?'+':'')+_ytdV.toFixed(1)+'%':'—';
      const _ym=(window.ytdMeta||{})[h.ticker];
      const _ytdTip=_ym?'YTD math: $'+_ym.base+' ('+_ym.baseDt+') → $'+_ym.last+' = '+_ym.pct+'%':'YTD vs prior-year close';
      return `<tr style="cursor:pointer" onclick="showTickerChart('${h.ticker}','${h.company}')" title="Click for price chart"><td class="ticker-cell">${h.ticker} 📈</td><td>${h.company}</td>
      <td><strong>$${fmt(h.marketValue||0)}</strong></td>
      <td class="${rv!==null?(rv>=0?'pos':'neg'):''}">${rv!==null?frp(rv):'—'} <span style="font-size:9px;color:var(--muted)">(${period})</span></td>
      <td class="${_ytdCls}" title="${_ytdTip}" style="cursor:help">${_ytdTxt} <span style="font-size:9px;color:var(--muted)">(YTD)</span></td>
      <td class="${tr>=0?'pos':'neg'}">${tr>=0?'+':''}${(tr||0).toFixed(1)}% <span style="font-size:9px;color:var(--muted)">(return)</span></td>
      <td>${h.beta?h.beta.toFixed(2):'—'}</td></tr>`;};
    const hdr='<tr><th>Ticker</th><th>Company</th><th>Market Value</th><th>Period Return</th><th>YTD Return</th><th>Return</th><th>Beta</th></tr>';
    document.getElementById('scEqTable').innerHTML=hdr+equities.map(makeRow).join('');
    document.getElementById('scEtfTable').innerHTML=hdr+etfs.map(makeRow).join('');
  }

  if(scChartRef)scChartRef.destroy();
  const ctx=document.getElementById('scChart').getContext('2d');
  scChartRef=new Chart(ctx,{type:'bar',data:{labels,datasets:[{data:vals,backgroundColor:bgColors,borderColor:borderColors,borderWidth:1.5,borderRadius:4}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>`${c.label}: ${c.parsed.y>=0?'+':''}${c.parsed.y}%`}}},scales:{y:{ticks:{callback:v=>(v>=0?'+':'')+v+'%',font:{size:11}},grid:{color:'#f1f5f9'}},x:{ticks:{font:{size:11}},grid:{display:false}}},onClick:(e,els)=>{if(view!=='top'||!els.length)return;const i=els[0].index;if(i===0)renderSCChart(sectorName,'equities',period);else if(i===1)renderSCChart(sectorName,'etfs',period);}}});

  const leg=document.getElementById('scLegend');
  if(leg){
    if(view==='top'){leg.innerHTML=`<div class="legend-item"><div class="legend-dot" style="background:#0c2a5e"></div>Equities</div><div class="legend-item"><div class="legend-dot" style="background:#9d174d"></div>ETFs</div><div class="legend-item"><div class="legend-dot" style="background:#159a51"></div>Sector Total</div><div class="legend-item"><div class="legend-dot" style="background:#f97316"></div>${benchmark}</div>`;}
    else{leg.innerHTML=`<button onclick="renderSCChart('${sectorName}','top','${period}')" style="font-size:11px;padding:4px 12px;border:1px solid var(--border);border-radius:4px;background:white;cursor:pointer;color:var(--navy);font-weight:600">← Back to sector overview</button>`;}
  }
}



const MCAP_EMBEDDED = {"AAPL": 3100000, "MSFT": 3000000, "NVDA": 2800000, "GOOG": 2000000, "GOOGL": 2000000, "AMZN": 2100000, "META": 1400000, "BRK.B": 1050000, "TSM": 900000, "LLY": 700000, "V": 650000, "MA": 500000, "COST": 420000, "NFLX": 410000, "XOM": 480000, "WMT": 780000, "SPGI": 160000, "ISRG": 185000, "HD": 380000, "KO": 260000, "ABBV": 320000, "SYK": 145000, "CAT": 180000, "PANW": 120000, "ADI": 95000, "CRWD": 115000, "BX": 145000, "TMUS": 230000, "HCA": 75000, "ORCL": 480000, "CEG": 85000, "GD": 75000, "VMC": 32000, "HWM": 38000, "WM": 82000, "DLR": 55000, "COF": 65000, "NUE": 15000, "PLTR": 270000, "DIS": 195000, "TKO": 32000, "FSLR": 18000, "TTWO": 38000, "GRMN": 38000, "ET": 62000, "DAR": 6500, "SOUN": 4500, "SOFI": 12000, "IREN": 3200, "HOOD": 22000, "SBGSF": 45000, "PFE": 155000};
function getMcapTier(mcapM) {
  if (mcapM>=200000) return 'Mega Cap';
  if (mcapM>=10000) return 'Large Cap';
  if (mcapM>=2000) return 'Mid Cap';
  return 'Small Cap';
}
function formatMcap(mcapM) {
  if (mcapM>=1000000) return (mcapM/1000000).toFixed(1)+'T';
  if (mcapM>=1000) return (mcapM/1000).toFixed(0)+'B';
  return mcapM.toFixed(0)+'M';
}
async function fetchMcap(ticker) {
  try {
    const d = await fetchYF(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${FINNHUB}`, 5000);
    if (d && d.metric) {
      if (d.metric.marketCapitalization) {
        mcapCache[ticker] = d.metric.marketCapitalization;
        if (currentThesisTicker===ticker) document.getElementById('detailMcap').textContent = getMcapTier(mcapCache[ticker])+' ($'+formatMcap(mcapCache[ticker])+')';
        if (document.getElementById('mcapBreakdown')) renderMcapBreakdown();
      }
      const pe = d.metric['peNormalizedAnnual'] || d.metric['peBasicExclExtraTTM'] || d.metric['peTTM'];
      if (pe && !isNaN(pe) && pe > 0 && pe < 1000) {
        peCache[ticker] = parseFloat(pe.toFixed(1));
        if (currentThesisTicker===ticker) {
          const el = document.getElementById('detailPE');
          if (el) el.textContent = peCache[ticker] + 'x';
        }
      }
      renderThesisMasterTable(thesisFilter);
    }
  } catch(e) {}
}
async function fetchMcapsForThesis() {
  Object.entries(MCAP_EMBEDDED).forEach(([tk,mcap]) => { mcapCache[tk]=mcap; });
  renderMcapBreakdown();
  // Fetch P/E for ALL equities in current fund (not just missing mcap)
  const fd = activeFund==='endowment' ? RAW.endowment : RAW.ceeFund;
  // Only fetch tickers we don't already have cached (cache persists 24h)
  const tickers = [...new Set(fd.equities.map(h=>h.ticker))].filter(tk=>!(peCache[tk]&&mcapCache[tk]));
  if(tickers.length)console.log('Fetching P/E for '+tickers.length+' uncached tickers (rate-limited)');
  for (let i=0; i<tickers.length; i+=2) {
    await Promise.all(tickers.slice(i,i+2).map(tk => fetchMcap(tk)));
    if (i+2 < tickers.length) await new Promise(r=>setTimeout(r,800));
  }
  _savePeCache();
  renderThesisMasterTable(thesisFilter);
}
setTimeout(fetchMcapsForThesis, 2000);

function renderMcapBreakdown() {
  const tiers = {'Mega Cap':{color:'#7c3aed',bg:'#f5f3ff',holdings:[],value:0},'Large Cap':{color:'#1e40af',bg:'#eff6ff',holdings:[],value:0},'Mid Cap':{color:'#047857',bg:'#ecfdf5',holdings:[],value:0},'Small Cap':{color:'#b45309',bg:'#fffbeb',holdings:[],value:0}};
  S.holdings.filter(h=>h.type==='equity').forEach(h=>{
    const mcap=mcapCache[h.ticker];
    if(mcap){const tier=getMcapTier(mcap);tiers[tier].holdings.push(h);tiers[tier].value+=(h.marketValue||0);}
  });
  const totalVal=Object.values(tiers).reduce((s,t)=>s+t.value,0)||1;
  const el=document.getElementById('mcapBreakdown');
  if(!el)return;
  el.innerHTML=Object.entries(tiers).map(([name,t])=>`
    <div style="background:${t.bg};border:1px solid ${t.color}33;border-radius:8px;padding:14px;border-left:3px solid ${t.color}">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;color:${t.color};margin-bottom:4px">${name}</div>
      <div style="font-size:20px;font-weight:700;color:${t.color}">${(t.value/totalVal*100).toFixed(1)}%</div>
      <div style="font-size:11px;color:var(--muted);margin-top:2px">$${fmt(t.value)} · ${t.holdings.length} positions</div>
      <div style="font-size:10px;color:var(--muted);margin-top:6px">${t.holdings.slice(0,4).map(h=>h.ticker).join(', ')}${t.holdings.length>4?' +more':''}</div>
    </div>`).join('');
}
// ── INVESTMENT THESIS ─────────────────────────────────────────────────────────
const STORAGE_KEY = 'cee_thesis_data';
const SECTOR_THESIS_KEY = 'cee_sector_thesis';
const ETF_NOTES_KEY = 'cee_etf_notes';

// Investor Relations URLs
const IR_URLS = {"GOOG":"https://abc.xyz/investor/","GOOGL":"https://abc.xyz/investor/","META":"https://investor.fb.com","AMZN":"https://ir.aboutamazon.com","MSFT":"https://www.microsoft.com/en-us/investor","AAPL":"https://investor.apple.com","NVDA":"https://investor.nvidia.com","NFLX":"https://ir.netflix.net","TKO":"https://ir.tkogroupholdings.com","HD":"https://ir.homedepot.com","COST":"https://investor.costco.com","KO":"https://investors.coca-colacompany.com","WMT":"https://stock.walmart.com","XOM":"https://investor.exxonmobil.com","BRK.B":"https://www.berkshirehathaway.com","BX":"https://ir.blackstone.com","MA":"https://investor.mastercard.com","SPGI":"https://investor.spglobal.com","V":"https://investor.visa.com","TMUS":"https://investor.t-mobile.com","HCA":"https://investor.hcahealthcare.com","LLY":"https://investor.lilly.com","PFE":"https://investors.pfizer.com","SYK":"https://investors.stryker.com","CAT":"https://investors.caterpillar.com","HWM":"https://www.howmet.com/investors","SBGSF":"https://www.safran-group.com/investors","WM":"https://investors.wm.com","CRWD":"https://ir.crowdstrike.com","ORCL":"https://investor.oracle.com","TSM":"https://investor.tsmc.com","NUE":"https://www.nucor.com/investors","DLR":"https://ir.digitalrealty.com","CEG":"https://ir.constellationenergy.com","ABBV":"https://investors.abbvie.com","ADI":"https://investor.analog.com","COF":"https://ir.capitalone.com","DAR":"https://www.darlingii.com/investor-relations","DIS":"https://thewaltdisneycompany.com/investor-relations","ET":"https://ir.energytransfer.com","FSLR":"https://investor.firstsolar.com","GD":"https://investorrelations.gd.com","GRMN":"https://www.garmin.com/en-US/company/investor-relations","HOOD":"https://investors.robinhood.com","IREN":"https://ir.iren.com","ISRG":"https://isrg.gcs-web.com","PANW":"https://investors.paloaltonetworks.com","PLTR":"https://investors.palantir.com","SOFI":"https://investors.sofi.com","SOUN":"https://ir.soundhound.com","TTWO":"https://ir.take2games.com","VMC":"https://ir.vulcanmaterials.com","PGR":"https://investors.progressive.com","PINS":"https://investor.pinterest.com"};
const ETF_IR_URLS = {"QQQ":"https://www.invesco.com/qqq-etf/en/home.html","VOO":"https://investor.vanguard.com/investment-products/etfs/profile/voo","VTI":"https://investor.vanguard.com/investment-products/etfs/profile/vti","VGT":"https://investor.vanguard.com/investment-products/etfs/profile/vgt","VUG":"https://investor.vanguard.com/investment-products/etfs/profile/vug","VFH":"https://investor.vanguard.com/investment-products/etfs/profile/vfh","VHT":"https://investor.vanguard.com/investment-products/etfs/profile/vht","VIS":"https://investor.vanguard.com/investment-products/etfs/profile/vis","VNQ":"https://investor.vanguard.com/investment-products/etfs/profile/vnq","VCSH":"https://investor.vanguard.com/investment-products/etfs/profile/vcsh","VGLT":"https://investor.vanguard.com/investment-products/etfs/profile/vglt","XLF":"https://www.ssga.com/us/en/intermediary/etfs/funds/the-financial-select-sector-spdr-fund-xlf","XLK":"https://www.ssga.com/us/en/intermediary/etfs/funds/the-technology-select-sector-spdr-fund-xlk","XLV":"https://www.ssga.com/us/en/intermediary/etfs/funds/the-health-care-select-sector-spdr-fund-xlv","XLY":"https://www.ssga.com/us/en/intermediary/etfs/funds/the-consumer-discretionary-select-sector-spdr-fund-xly","XLE":"https://www.ssga.com/us/en/intermediary/etfs/funds/the-energy-select-sector-spdr-fund-xle","XLU":"https://www.ssga.com/us/en/intermediary/etfs/funds/the-utilities-select-sector-spdr-fund-xlu","XLB":"https://www.ssga.com/us/en/intermediary/etfs/funds/the-materials-select-sector-spdr-fund-xlb","XLC":"https://www.ssga.com/us/en/intermediary/etfs/funds/the-communication-services-select-sector-spdr-fund-xlc","XLP":"https://www.ssga.com/us/en/intermediary/etfs/funds/the-consumer-staples-select-sector-spdr-fund-xlp","SMH":"https://www.vaneck.com/us/en/investments/semiconductor-etf-smh/","NLR":"https://www.vaneck.com/us/en/investments/uranium-nuclear-etf-nlr/","IGV":"https://www.ishares.com/us/products/239750/","IYG":"https://www.ishares.com/us/products/239503/","IYJ":"https://www.ishares.com/us/products/239511/","FTEC":"https://institutional.fidelity.com/app/fund/etf/snapshot/FIIS_ETF_FTEC.html","FDIS":"https://institutional.fidelity.com/app/fund/etf/snapshot/FIIS_ETF_FDIS.html","PSCT":"https://www.invesco.com/us/financial-products/etfs/product-detail?audienceType=Investor&ticker=PSCT","RSPN":"https://www.invesco.com/us/financial-products/etfs/product-detail?audienceType=Investor&ticker=RSPN","BILS":"https://www.ssga.com/us/en/intermediary/etfs/funds/spdr-bloomberg-3-6-month-t-bill-etf-bils"};

// Tag colors
const TAG_COLORS = {'Growth':'#159a51','Aggressive':'#d6453d','Yield':'#f59e0b','Defensive':'#3b82f6'};
const TAG_BG = {'Growth':'#dcfce7','Aggressive':'#fee2e2','Yield':'#fef3c7','Defensive':'#dbeafe'};

// State
let thesisData = {};       // equity data keyed by ticker
let sectorThesis = {};     // sector thesis keyed by sector name
let etfNotes = {};         // ETF notes keyed by ticker
let mcapCache = {};        // market cap cache
const peCache = {};
const ytdCache = {};
// Restore P/E + mcap from localStorage (24h TTL) so revisits cost zero Finnhub calls
try{
  const _pc=JSON.parse(localStorage.getItem('cee_pe_cache')||'null');
  if(_pc&&Date.now()-_pc.ts<86400000){Object.assign(peCache,_pc.pe||{});Object.assign(typeof mcapCache!=='undefined'?mcapCache:{}, _pc.mcap||{});}
}catch(e){}
const IR_PAGES={AAPL:'https://investor.apple.com',ABBV:'https://investors.abbvie.com',ADI:'https://investor.analog.com',AMZN:'https://ir.aboutamazon.com','BRK.B':'https://www.berkshirehathaway.com',BX:'https://ir.blackstone.com',CAT:'https://investors.caterpillar.com',CEG:'https://investors.constellationenergy.com',COF:'https://investor.capitalone.com',COST:'https://investor.costco.com',CRWD:'https://ir.crowdstrike.com',DAR:'https://ir.darlingii.com',DIS:'https://thewaltdisneycompany.com/investor-relations/',DLR:'https://investor.digitalrealty.com',ET:'https://ir.energytransfer.com',FSLR:'https://investor.firstsolar.com',GD:'https://investorrelations.gd.com',GOOG:'https://abc.xyz/investor/',GOOGL:'https://abc.xyz/investor/',GRMN:'https://www.garmin.com/en-US/company/investors/',HCA:'https://investor.hcahealthcare.com',HD:'https://ir.homedepot.com',HOOD:'https://investors.robinhood.com',HWM:'https://ir.howmet.com',IREN:'https://investors.iren.com',ISRG:'https://isrg.intuitive.com',KO:'https://investors.coca-colacompany.com',LLY:'https://investor.lilly.com',MA:'https://investor.mastercard.com',META:'https://investor.atmeta.com',MSFT:'https://www.microsoft.com/en-us/investor',NFLX:'https://ir.netflix.net',NUE:'https://www.nucor.com/investors',NVDA:'https://investor.nvidia.com',ORCL:'https://investor.oracle.com',PANW:'https://investors.paloaltonetworks.com',PFE:'https://investors.pfizer.com',PLTR:'https://investors.palantir.com',SBGSF:'https://www.se.com/ww/en/about-us/investor-relations/',SOFI:'https://investors.sofi.com',SOUN:'https://investors.soundhound.com',SPGI:'https://investor.spglobal.com',SYK:'https://investors.stryker.com',TKO:'https://investor.tkogrp.com',TMUS:'https://investor.t-mobile.com',TSM:'https://investor.tsmc.com',TTWO:'https://ir.take2games.com',V:'https://investor.visa.com',VMC:'https://ir.vulcanmaterials.com',WM:'https://investors.wm.com',WMT:'https://stock.walmart.com',XOM:'https://investor.exxonmobil.com'};
const irLink=(tk,company)=>IR_PAGES[tk]||'https://www.google.com/search?q='+encodeURIComponent((company||tk)+' investor relations');
function logoImg(t,sz){sz=sz||18;return '<img src="https://financialmodelingprep.com/image-stock/'+String(t).replace('.','-')+'.png" alt="" style="width:'+sz+'px;height:'+sz+'px;border-radius:4px;vertical-align:-4px;margin-right:7px;object-fit:contain;background:#fff;border:1px solid #ececec" loading="lazy" onerror="this.style.display=\'none\'">';}
function goToThesis(tk){
  const btn=[...document.querySelectorAll('.nav-tab')].find(b=>(b.getAttribute('onclick')||'').includes("'thesis'"));
  if(btn)showTab('thesis',btn);
  setTimeout(()=>{try{openThesisDetail(tk);const p=document.getElementById('thesisDetailPanel');if(p&&p.scrollIntoView)p.scrollIntoView({behavior:'smooth',block:'start'});}catch(e){}},700);
}
function _savePeCache(){try{localStorage.setItem('cee_pe_cache',JSON.stringify({ts:Date.now(),pe:peCache,mcap:mcapCache}));}catch(e){}}
let thesisQuery='';
function thesisSearchInput(v){thesisQuery=(v||'').trim().toLowerCase();renderThesisMasterTable(thesisFilter);}
function thesisSearchGo(){
  if(!thesisQuery)return;
  const all=[...RAW.endowment.equities,...RAW.ceeFund.equities];
  const m=all.find(h=>h.ticker.toLowerCase()===thesisQuery)
        ||all.find(h=>h.ticker.toLowerCase().includes(thesisQuery)||(h.company||'').toLowerCase().includes(thesisQuery));
  if(m)openThesisDetail(m.ticker);
}
let thesisSortCol = 'weight';
let thesisSortAsc = false;
let currentThesisTicker = null;
let currentThesisSector = null;
let thesisFilter = 'all';
let sectorPieRef = null;
let thesisAutoSaveTimer = null;

// ── FIREBASE REALTIME DATABASE ───────────────────────────────────────────────
const FB_DB_URL = 'https://cee-fund-dashboard-640ab-default-rtdb.firebaseio.com';
const FB_NODE = '/ceeThesis';

// ── SHARED HOLDINGS SYNC (Firebase) ───────────────────────────────────────────
const FB_HOLDINGS_NODE = '/ceeHoldings';
const FB_HOLDINGS_BACKUP = '/ceeHoldingsBackup';
async function saveHoldingsToFirebase(srcName){
  try{
    // Back up the current live version first (rollback safety)
    try{ const cur=await fetch(FB_DB_URL+FB_HOLDINGS_NODE+'.json'); if(cur.ok){ const d=await cur.json(); if(d) await fetch(FB_DB_URL+FB_HOLDINGS_BACKUP+'.json',{method:'PUT',body:JSON.stringify(d)}); } }catch(e){}
    const payload={
      updatedAt:new Date().toISOString(),
      source:srcName||'upload',
      endowment:{equities:RAW.endowment.equities,etfs:RAW.endowment.etfs,cash:RAW.endowment.cash||0,bond:RAW.endowment.bond||null},
      ceeFund:{equities:RAW.ceeFund.equities,etfs:RAW.ceeFund.etfs,cash:RAW.ceeFund.cash||0},
      transactions:TRANSACTIONS
    };
    const r=await fetch(FB_DB_URL+FB_HOLDINGS_NODE+'.json',{method:'PUT',body:JSON.stringify(payload)});
    if(r.ok){ console.log('✅ Holdings synced to Firebase — all users will see this on refresh'); const ok=document.getElementById('uploadSuccess'); if(ok)ok.textContent+=' · ☁ Synced to all users'; }
    else console.warn('Holdings Firebase save returned',r.status);
  }catch(e){ console.warn('Holdings sync failed (kept locally):',e.message); }
}
async function loadHoldingsFromFirebase(){
  try{
    const r=await fetch(FB_DB_URL+FB_HOLDINGS_NODE+'.json');
    if(!r.ok) return false;
    const d=await r.json();
    if(!d || !d.endowment || !d.ceeFund) return false;
    // Validate before trusting shared data
    if(!Array.isArray(d.endowment.equities) || !d.endowment.equities.length) return false;
    if(!Array.isArray(d.ceeFund.equities) || !d.ceeFund.equities.length) return false;
    RAW.endowment.equities=d.endowment.equities; RAW.endowment.etfs=d.endowment.etfs||[]; RAW.endowment.cash=d.endowment.cash||0;
    if(d.endowment.bond)RAW.endowment.bond=d.endowment.bond;
    RAW.ceeFund.equities=d.ceeFund.equities; RAW.ceeFund.etfs=d.ceeFund.etfs||[]; RAW.ceeFund.cash=d.ceeFund.cash||0;
    if(Array.isArray(d.transactions)){ TRANSACTIONS.length=0; d.transactions.forEach(t=>TRANSACTIONS.push(t)); }
    if(d.updatedAt){ const dt=new Date(d.updatedAt); const lu=document.getElementById('lastUpdate'); if(lu)lu.textContent='Holdings as of '+dt.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
    console.log('✅ Shared holdings loaded from Firebase ('+(d.updatedAt||'unknown date')+')');
    return true;
  }catch(e){ console.warn('Holdings Firebase load failed, using embedded snapshot:',e.message); return false; }
}

function restoreKeysFromFirebase(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    const origKey = k.replace(/BRK_B/g, 'BRK.B');
    clean[origKey] = typeof v === 'object' && v !== null ? restoreKeysFromFirebase(v) : v;
  }
  return clean;
}

async function loadThesisFromStorage() {
  try {
    const r = await fetch(FB_DB_URL + FB_NODE + '.json');
    if (r.ok) {
      const d = await r.json();
      if (d) {
        thesisData = restoreKeysFromFirebase(d.thesis || {});
        sectorThesis = d.sectorThesis || {};
        etfNotes = restoreKeysFromFirebase(d.etfNotes || {});
        console.log('✅ Firebase loaded');
        return;
      }
    }
  } catch(e) { console.warn('Firebase load failed:', e.message); }
  try { const d = localStorage.getItem('cee_thesis_data'); if(d) thesisData = JSON.parse(d); } catch(e) {}
  try { const d = localStorage.getItem('cee_sector_thesis'); if(d) sectorThesis = JSON.parse(d); } catch(e) {}
  try { const d = localStorage.getItem('cee_etf_notes'); if(d) etfNotes = JSON.parse(d); } catch(e) {}
}

let fbSaveTimer=null, fbSavePending=false, fbSaving=false, fbLastSaveOk=false;

function scheduleSave() {
  localStorage.setItem('cee_thesis_data', JSON.stringify(thesisData));
  localStorage.setItem('cee_sector_thesis', JSON.stringify(sectorThesis));
  localStorage.setItem('cee_etf_notes', JSON.stringify(etfNotes));
  fbSavePending = true;
  clearTimeout(fbSaveTimer);
  fbSaveTimer = setTimeout(flushToFirebase, 2000);
}

function sanitizeFirebaseKeys(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    const safe = k.replace(/\./g,'_').replace(/#/g,'_').replace(/\$/g,'_').replace(/\[/g,'_').replace(/\]/g,'_');
    clean[safe] = typeof v === 'object' && v !== null ? sanitizeFirebaseKeys(v) : v;
  }
  return clean;
}

async function flushToFirebase() {
  if (fbSaving) { fbSaveTimer = setTimeout(flushToFirebase, 2000); return; }
  fbSaving = true; fbSavePending = false; fbLastSaveOk = false;
  try {
    const res = await fetch(FB_DB_URL + FB_NODE + '.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        thesis: sanitizeFirebaseKeys(thesisData),
        sectorThesis: sanitizeFirebaseKeys(sectorThesis),
        etfNotes: sanitizeFirebaseKeys(etfNotes)
      })
    });
    if (res.ok) {
      fbLastSaveOk = true;
      console.log('✅ Firebase saved');
    } else {
      const err = await res.text();
      console.warn('Firebase save failed:', res.status, err);
      const el = document.getElementById('equityThesisSaved');
      if (el) { el.textContent = '❌ Save error: ' + res.status; el.style.color='#d6453d'; }
    }
  } catch(e) {
    console.warn('Firebase error:', e.message);
    const el = document.getElementById('equityThesisSaved');
    if (el) { el.textContent = '❌ Network error'; el.style.color='#d6453d'; }
  }
  fbSaving = false;
}

async function saveThesisToStorage() { scheduleSave(); }
async function saveSectorThesisToStorage() { scheduleSave(); }
async function saveEtfNotesToStorage() { scheduleSave(); }
// ── INIT THESIS TAB ───────────────────────────────────────────────────────────
async function initThesisTab() {
  await loadThesisFromStorage();
  renderThesisSectorCards();
  renderThesisMasterTable('all');
  fetchMcapsForThesis();
  fetchYTDForThesis();
}
async function fetchYTDForThesis() {
  // Cover EVERYTHING: equities + ETFs across both funds, so ETF YTD shows everywhere
  const tks=[...new Set([
    ...RAW.endowment.equities.map(h=>h.ticker), ...RAW.endowment.etfs.map(h=>h.ticker),
    ...RAW.ceeFund.equities.map(h=>h.ticker),   ...RAW.ceeFund.etfs.map(h=>h.ticker),
    'SPY'])];
  for(let i=0;i<tks.length;i+=8){
    await Promise.all(tks.slice(i,i+8).map(async tk=>{
      if(ytdCache[tk]===undefined){const v=await fetchCandleReturn(tk,'YTD');if(v!==null)ytdCache[tk]=v;}
    }));
    if(i+8<tks.length)await new Promise(r=>setTimeout(r,300));
  }
  const _missing=tks.filter(tk=>ytdCache[tk]===undefined||ytdCache[tk]===null);
  if(_missing.length)console.warn('YTD could not be computed for: '+_missing.join(', ')+' — check ticker symbol mapping for these');
  else console.log('YTD loaded for all '+tks.length+' holdings ✓');
  renderThesisMasterTable(thesisFilter);
}

// ── SECTOR CARDS ──────────────────────────────────────────────────────────────
function renderThesisSectorCards() {
  const EXCLUDE = ['Broad Market', 'Fixed Income'];
  const sectors = calcSectors(S.holdings, S.total).filter(s => !EXCLUDE.includes(s.name)); // S.holdings already fund-filtered
  document.getElementById('thesisSectorCards').innerHTML = sectors.map(s => {
    const thesis = sectorThesis[s.name];
    const hasThesis = thesis && thesis.trim().length > 0;
    return `<div class="sc-card" onclick="openSectorThesis('${s.name}')" style="border-color:${hasThesis?'var(--gold)':'var(--border)'}">
      <div class="sc-name">${s.name}</div>
      <div style="font-size:10px;color:var(--muted);margin-top:4px">${(s.pct*100).toFixed(1)}% of ${S.fundName}</div>
      <div style="font-size:10px;margin-top:4px;color:${hasThesis?'#159a51':'var(--muted)'}">${hasThesis?'✅ Thesis written':'✏️ Add thesis'}</div>
    </div>`;
  }).join('');
}

// ── SECTOR THESIS ─────────────────────────────────────────────────────────────
function openSectorThesis(sectorName) {
  currentThesisSector = sectorName;
  document.getElementById('thesisSectorPanel').style.display = 'block';
  document.getElementById('thesisSectorName').textContent = sectorName;
  document.getElementById('sectorThesisText').value = sectorThesis[sectorName] || '';
  document.getElementById('sectorThesisSaved').textContent = '';
  document.getElementById('thesisDetailPanel').style.display = 'none';

  // Build holdings list
  const sectors = calcSectors(S.holdings, S.total);
  const sec = sectors.find(s => s.name === sectorName);
  if (!sec) return;

  const equities = sec.holdings.filter(h => h.type === 'equity');
  const etfs = sec.holdings.filter(h => h.type === 'etf');
  const totalMV = sec.holdings.reduce((s,h) => s+(h.marketValue||0), 0);

  // Pie chart
  if (sectorPieRef) sectorPieRef.destroy();
  const ctx = document.getElementById('sectorPieChart').getContext('2d');
  const eqMV = equities.reduce((s,h) => s+(h.marketValue||0), 0);
  const etfMV = etfs.reduce((s,h) => s+(h.marketValue||0), 0);
  sectorPieRef = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Equities', 'ETFs'],
      datasets: [{
        data: [parseFloat(eqMV.toFixed(2)), parseFloat(etfMV.toFixed(2))],
        backgroundColor: ['rgba(0,31,91,0.8)', 'rgba(157,23,77,0.7)'],
        borderWidth: 1
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { font: { size: 10 } } },
        tooltip: { callbacks: { label: c => `${c.label}: $${fmt(c.parsed)} (${(c.parsed/totalMV*100).toFixed(1)}%)` } }
      }
    }
  });

  // Sector composition bar — each holding as a segment sized by its share of the sector
  const compSorted = [...sec.holdings].sort((a,b)=>(b.marketValue||0)-(a.marketValue||0));
  const palette=['#0c2a5e','#c9a84c','#2057c9','#159a51','#d6453d','#7c3aed','#0891b2','#b45309','#be185d','#4d7c0f','#0f766e','#9333ea'];
  let _acc=0;
  const segs=compSorted.map((h,idx)=>{
    const w=totalMV>0?(h.marketValue||0)/totalMV*100:0;
    const col=h.type==='etf'?palette[idx%palette.length]+'cc':palette[idx%palette.length];
    const seg=`<div title="${h.ticker} — ${w.toFixed(1)}% of sector ($${fmt(h.marketValue||0)})" style="width:${w}%;background:${col};height:100%;display:inline-block;border-right:1px solid #fff"></div>`;
    _acc+=w; return seg;
  }).join('');
  const compBar = `
    <div style="margin-bottom:14px">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
        <span style="font-size:11px;font-weight:700;color:var(--navy);text-transform:uppercase">Sector Composition</span>
        <span style="font-size:10px;color:var(--muted)">${compSorted.length} holdings · $${fmt(totalMV)} total</span>
      </div>
      <div style="display:flex;width:100%;height:22px;border-radius:5px;overflow:hidden;box-shadow:inset 0 0 0 1px var(--border)">${segs}</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px 14px;margin-top:8px">
        ${compSorted.slice(0,8).map((h,idx)=>`<span style="display:inline-flex;align-items:center;gap:5px;font-size:10px;color:var(--gray)"><span style="width:9px;height:9px;border-radius:2px;background:${h.type==='etf'?palette[idx%palette.length]+'cc':palette[idx%palette.length]};display:inline-block"></span>${h.ticker} ${totalMV>0?((h.marketValue||0)/totalMV*100).toFixed(0):0}%</span>`).join('')}
        ${compSorted.length>8?`<span style="font-size:10px;color:var(--muted)">+${compSorted.length-8} more</span>`:''}
      </div>
    </div>`;

  // Holdings list
  const allHoldings = [...equities, ...etfs].sort((a,b) => (b.marketValue||0)-(a.marketValue||0));
  document.getElementById('sectorHoldingsList').innerHTML = compBar + allHoldings.map(h => {
    const td = thesisData[h.ticker];
    const tag = td?.tag;
    const hasThesis = td && (td.thesis || td.base);
    return `<div onclick="openThesisDetail('${h.ticker}')" style="display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid var(--border);cursor:pointer;border-radius:6px;transition:background 0.15s" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background='white'">
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-weight:700;color:var(--navy);width:50px">${logoImg(h.ticker)}${h.ticker}</span>
        <span style="font-size:12px;color:var(--gray)">${h.company}</span>
        <span class="badge type-${h.type}">${h.type.toUpperCase()}</span>
        ${tag ? `<span style="font-size:10px;font-weight:700;padding:1px 8px;border-radius:12px;background:${TAG_BG[tag]};color:${TAG_COLORS[tag]}">${tag}</span>` : ''}
      </div>
      <div style="display:flex;align-items:center;gap:12px">
        <span style="font-size:12px;font-weight:700">$${fmt(h.marketValue||0)}</span>
        <span style="font-size:11px;font-weight:700;color:var(--gold);min-width:46px;text-align:right" title="Share of this sector's market value">${totalMV>0?((h.marketValue||0)/totalMV*100).toFixed(1):'0.0'}%<div style="font-size:8px;color:var(--muted);font-weight:600;letter-spacing:.04em">of sector</div></span>
        <span style="font-size:11px;color:var(--muted);min-width:42px;text-align:right" title="Share of total fund">${((h.marketValue||0)/S.total*100).toFixed(1)}%<div style="font-size:8px;color:var(--muted);letter-spacing:.04em">of fund</div></span>
        <span style="font-size:11px;color:${hasThesis?'#159a51':'var(--muted)'}">${hasThesis?'✅':'✏️'}</span>
        <span style="color:var(--gray);font-size:14px">›</span>
      </div>
    </div>`;
  }).join('');

  document.getElementById('thesisSectorPanel').scrollIntoView({behavior:'smooth', block:'start'});
}

let sectorThesisSaveTimer = null;
function autoSaveSectorThesis() {
  clearTimeout(sectorThesisSaveTimer);
  sectorThesisSaveTimer = setTimeout(async () => {
    if (!currentThesisSector) return;
    sectorThesis[currentThesisSector] = document.getElementById('sectorThesisText').value;
    await saveSectorThesisToStorage();
    const el = document.getElementById('sectorThesisSaved');
    el.textContent = '✅ Saved';
    setTimeout(() => el.textContent = '', 2000);
    renderThesisSectorCards();
  }, 800);
}

// ── EQUITY/ETF DETAIL ─────────────────────────────────────────────────────────
async function fetchPEViaYahoo(ticker){
  try{
    const yfTk=ticker.replace('.','-');
    const r=await fetchYF(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${yfTk}?modules=summaryDetail,defaultKeyStatistics`,6000);
    const res=r?.quoteSummary?.result?.[0];
    const pe=res?.summaryDetail?.trailingPE?.raw || res?.defaultKeyStatistics?.forwardPE?.raw;
    if(pe && pe>0 && pe<2000){
      peCache[ticker]=parseFloat(pe.toFixed(1));
      if(currentThesisTicker===ticker){const el=document.getElementById('detailPE');if(el)el.textContent=peCache[ticker]+'x';}
      try{_savePeCache();}catch(e){}
    } else if(currentThesisTicker===ticker){const el=document.getElementById('detailPE');if(el)el.textContent='—';}
  }catch(e){ if(currentThesisTicker===ticker){const el=document.getElementById('detailPE');if(el)el.textContent='—';} }
}
function openThesisDetail(ticker) {
  currentThesisTicker = ticker;
  const allH = ALL_HOLDINGS();
  const h = allH.find(x => x.ticker === ticker);
  if (!h) return;

  document.getElementById('thesisDetailPanel').style.display = 'block';
  document.getElementById('thesisSectorPanel').style.display = 'none';
  document.getElementById('detailTicker').innerHTML = logoImg(ticker,26)+ticker;
  document.getElementById('detailCompany').textContent = h.company || '';

  // IR link
  const irUrl = h.type === 'etf' ? (ETF_IR_URLS[ticker] || '#') : (IR_URLS[ticker] || '#');
  document.getElementById('detailIR').href = irUrl;

  // Stats
  document.getElementById('detailPrice').textContent = h.price ? '$'+h.price.toFixed(2) : '—';
  document.getElementById('detailCost').textContent = h.avgCost ? '$'+h.avgCost.toFixed(2) : '—';
  document.getElementById('detailReturn').innerHTML = h.glPct ?
    `<span class="${h.glPct>=0?'pos':'neg'}">${h.glPct>=0?'+':''}${(h.glPct*100).toFixed(1)}%</span>` : '—';
  document.getElementById('detailWeight').textContent = ((h.marketValue||0)/S.total*100).toFixed(2)+'% of '+S.fundName;

  // P/E — read from cache immediately; fetch via Yahoo proxy if missing (no Finnhub 429)
  const peEl = document.getElementById('detailPE');
  if (peEl) {
    if (peCache[ticker] != null) peEl.textContent = peCache[ticker] + 'x';
    else { peEl.textContent = '…'; fetchPEViaYahoo(ticker); }
  }
  // Beta
  const betaEl = document.getElementById('detailBeta');
  if (betaEl) {
    const b = h.beta;
    betaEl.innerHTML = b ? `<span style="color:${b>1.2?'#d6453d':b<0.8?'#159a51':'var(--navy)'}">${b.toFixed(2)}</span>` : '—';
  }
  // Alpha = holding YTD − SPY YTD (same basis as the thesis table's Alpha column)
  const alphaEl = document.getElementById('detailAlpha');
  if (alphaEl) {
    const hy = ytdCache[ticker], spy = ytdCache['SPY'];
    if (hy != null && spy != null) { const a = hy - spy; alphaEl.innerHTML = `<span class="${a>=0?'pos':'neg'}">${a>=0?'+':''}${a.toFixed(1)}%</span>`; }
    else alphaEl.textContent = '—';
  }



  // Market cap
  const mcap = mcapCache[ticker];
  document.getElementById('detailMcap').textContent = mcap ? getMcapTier(mcap)+' ($'+formatMcap(mcap)+')' : 'Loading...';

  if (h.type === 'etf') {
    document.getElementById('detailEtfView').style.display = 'block';
    document.getElementById('detailEquityView').style.display = 'none';
    document.getElementById('detailTag').textContent = '';
    document.getElementById('etfNoteText').value = etfNotes[ticker] || '';
    document.getElementById('etfNoteSaved').textContent = '';
  } else {
    document.getElementById('detailEtfView').style.display = 'none';
    document.getElementById('detailEquityView').style.display = 'block';
    const td = thesisData[ticker] || {};

    // Price targets
    document.getElementById('ptFloor').value = td.floor || '';
    document.getElementById('ptBase').value = td.base || '';
    document.getElementById('ptHigh').value = td.high || '';
    updatePriceBar();

    // Tag
    document.querySelectorAll('.tag-btn').forEach(b => {
      const isActive = b.dataset.tag === td.tag;
      b.style.background = isActive ? TAG_BG[b.dataset.tag] : 'white';
      b.style.color = isActive ? TAG_COLORS[b.dataset.tag] : 'var(--gray)';
      b.style.borderColor = isActive ? TAG_COLORS[b.dataset.tag] : 'var(--border)';
      b.style.fontWeight = isActive ? '700' : '600';
    });

    // Show tag badge
    if (td.tag) {
      const tagEl = document.getElementById('detailTag');
      tagEl.textContent = td.tag;
      tagEl.style.background = TAG_BG[td.tag];
      tagEl.style.color = TAG_COLORS[td.tag];
    } else {
      document.getElementById('detailTag').textContent = '';
    }

    document.getElementById('thesisText').value = td.thesis || '';
    document.getElementById('catalystsText').value = td.catalysts || '';
    document.getElementById('risksText').value = td.risks || '';
    document.getElementById('equityThesisSaved').textContent = '';
  }

  document.getElementById('thesisDetailPanel').scrollIntoView({behavior:'smooth', block:'start'});

  // Fetch mcap if not cached
  if (!mcapCache[ticker]) fetchMcap(ticker);
}

function closeThesisDetail() {
  document.getElementById('thesisDetailPanel').style.display = 'none';
  if (currentThesisSector) {
    document.getElementById('thesisSectorPanel').style.display = 'block';
  }
}

// ── PRICE BAR ─────────────────────────────────────────────────────────────────
function updatePriceBar() {
  const floor = parseFloat(document.getElementById('ptFloor').value) || 0;
  const base = parseFloat(document.getElementById('ptBase').value) || 0;
  const high = parseFloat(document.getElementById('ptHigh').value) || 0;
  const allH = ALL_HOLDINGS();
  const h = allH.find(x => x.ticker === currentThesisTicker);
  const current = h?.price || 0;

  if (!floor && !base && !high) { document.getElementById('priceBarContainer').style.display = 'none'; return; }
  document.getElementById('priceBarContainer').style.display = 'block';

  const minP = Math.min(floor||current, current) * 0.95;
  const maxP = Math.max(high||current, current) * 1.05;
  const range = maxP - minP || 1;
  const pct = v => ((v - minP) / range * 100).toFixed(1) + '%';

  if (floor) { document.getElementById('priceFloorMark').style.left = pct(floor); document.getElementById('priceFloorLabel').style.left = pct(floor); document.getElementById('priceFloorLabel').textContent = '$'+floor.toFixed(0); }
  document.getElementById('priceCurrentMark').style.left = pct(current);
  document.getElementById('priceCurrentLabel').style.left = pct(current);
  if (base) { document.getElementById('priceTargetMark').style.left = pct(base); document.getElementById('priceTargetLabel').style.left = pct(base); document.getElementById('priceTargetLabel').textContent = '$'+base.toFixed(0); }
  if (high) { document.getElementById('priceHighMark').style.left = pct(high); document.getElementById('priceHighLabel').style.left = pct(high); document.getElementById('priceHighLabel').textContent = '$'+high.toFixed(0); }

  const fillStart = floor ? pct(Math.min(floor, current)) : '0%';
  const fillEnd = high ? pct(Math.max(high, current)) : '100%';
  document.getElementById('priceBarFill').style.left = fillStart;
  document.getElementById('priceBarFill').style.width = `calc(${fillEnd} - ${fillStart})`;

  let upsideHtml = '';
  if (current > 0) {
    if (base) { const u = (base-current)/current*100; upsideHtml += `<span style="font-weight:700;color:${u>=0?'#f97316':'#d6453d'}">Base: ${u>=0?'+':''}${u.toFixed(1)}%</span>`; }
    if (high) { const u = (high-current)/current*100; upsideHtml += `<span style="font-weight:700;color:#159a51">High: +${u.toFixed(1)}%</span>`; }
    if (floor) { const d = (floor-current)/current*100; upsideHtml += `<span style="font-weight:700;color:#d6453d">Floor: ${d.toFixed(1)}%</span>`; }
  }
  document.getElementById('priceUpsideRow').innerHTML = upsideHtml;
}

// ── TAG ───────────────────────────────────────────────────────────────────────
function selectTag(tag, btn) {
  if (!thesisData[currentThesisTicker]) thesisData[currentThesisTicker] = {};
  thesisData[currentThesisTicker].tag = tag;
  scheduleSave(); // save tag immediately
  document.querySelectorAll('.tag-btn').forEach(b => {
    const isActive = b.dataset.tag === tag;
    b.style.background = isActive ? TAG_BG[b.dataset.tag] : 'white';
    b.style.color = isActive ? TAG_COLORS[b.dataset.tag] : 'var(--gray)';
    b.style.borderColor = isActive ? TAG_COLORS[b.dataset.tag] : 'var(--border)';
    b.style.fontWeight = isActive ? '700' : '600';
  });
  const tagEl = document.getElementById('detailTag');
  tagEl.textContent = tag;
  tagEl.style.background = TAG_BG[tag];
  tagEl.style.color = TAG_COLORS[tag];
  autoSaveEquityThesis();
}

// ── AUTO SAVE ─────────────────────────────────────────────────────────────────
function autoSaveEquityThesis() {
  clearTimeout(thesisAutoSaveTimer);
  thesisAutoSaveTimer = setTimeout(saveThesisNow, 800);
}

async function saveThesisNow() {
  if (!currentThesisTicker) return;
  if (!thesisData[currentThesisTicker]) thesisData[currentThesisTicker] = {};
  const td = thesisData[currentThesisTicker];
  td.floor = parseFloat(document.getElementById('ptFloor').value) || null;
  td.base = parseFloat(document.getElementById('ptBase').value) || null;
  td.high = parseFloat(document.getElementById('ptHigh').value) || null;
  td.thesis = document.getElementById('thesisText').value;
  td.catalysts = document.getElementById('catalystsText').value;
  td.risks = document.getElementById('risksText').value;
  await saveThesisToStorage();
  const el = document.getElementById('equityThesisSaved');
  if (el) { el.textContent = '✅ Saved for everyone'; setTimeout(() => el.textContent = '', 2000); }
  renderThesisMasterTable(thesisFilter);
}

let etfAutoSaveTimer = null;
function autoSaveEtfNote() {
  clearTimeout(etfAutoSaveTimer);
  etfAutoSaveTimer = setTimeout(async () => {
    if (!currentThesisTicker) return;
    etfNotes[currentThesisTicker] = document.getElementById('etfNoteText').value;
    await saveEtfNotesToStorage();
    const el = document.getElementById('etfNoteSaved');
    if (el) { el.textContent = '✅ Saved'; setTimeout(() => el.textContent = '', 2000); }
  }, 800);
}

// ── MARKET CAP ────────────────────────────────────────────────────────────────







// ── MASTER TABLE ──────────────────────────────────────────────────────────────
function thesisSortBy(col) {
  if (thesisSortCol===col) thesisSortAsc=!thesisSortAsc;
  else { thesisSortCol=col; thesisSortAsc=false; }
  renderThesisMasterTable(thesisFilter);
}
function filterThesisEquities(tag, btn) {
  thesisFilter=tag;
  document.querySelectorAll('#tab-thesis .filter-btn').forEach(b=>b.classList.remove('active'));
  if (btn && btn.tagName==='BUTTON') btn.classList.add('active');
  renderThesisMasterTable(tag);
}


function sortThesisTable(sort) { renderThesisMasterTable(thesisFilter, sort); }

function renderThesisMasterTable(filter, sort) {
  const EXCLUDE = ['Broad Market', 'Fixed Income'];
  const fundData = activeFund === 'endowment' ? RAW.endowment : RAW.ceeFund;
  const allH = fundData.equities.filter(h => !EXCLUDE.includes(h.sector));
  let holdings = allH;

  // Apply filters
  if (filter && filter !== 'all') {
    if (['Growth','Aggressive','Yield','Defensive'].includes(filter)) {
      holdings = holdings.filter(h => thesisData[h.ticker]?.tag === filter);
    } else if (filter === 'beta-high') { holdings = holdings.filter(h => (h.beta||1) > 1.2);
    } else if (filter === 'beta-mid')  { holdings = holdings.filter(h => (h.beta||1) >= 0.8 && (h.beta||1) <= 1.2);
    } else if (filter === 'beta-low')  { holdings = holdings.filter(h => (h.beta||1) < 0.8);
    }
  }
  const capFilter = document.getElementById('mcapFilter')?.value || '';
  if (capFilter && capFilter !== 'all' && capFilter !== '') {
    holdings = holdings.filter(h => mcapCache[h.ticker] && getMcapTier(mcapCache[h.ticker]) === capFilter);
  }

  // Live search filter (ticker or company name)
  if (thesisQuery) {
    holdings = holdings.filter(h=>h.ticker.toLowerCase().includes(thesisQuery)||(h.company||'').toLowerCase().includes(thesisQuery));
  }
  // Sort by thesisSortCol (set by clicking column headers)
  const _dir = thesisSortAsc ? 1 : -1;
  if (thesisSortCol === 'beta') holdings = [...holdings].sort((a,b) => _dir*((a.beta||0)-(b.beta||0)));
  else if (thesisSortCol === 'pe') holdings = [...holdings].sort((a,b) => _dir*((peCache[a.ticker]||0)-(peCache[b.ticker]||0)));
  else if (thesisSortCol === 'ytd') holdings = [...holdings].sort((a,b) => _dir*((ytdCache[a.ticker]||0)-(ytdCache[b.ticker]||0)));
  else if (thesisSortCol === 'alpha') holdings = [...holdings].sort((a,b) => _dir*(((ytdCache[a.ticker]||0)-(ytdCache['SPY']||0))-((ytdCache[b.ticker]||0)-(ytdCache['SPY']||0))));
  else if (thesisSortCol === 'upside') holdings = [...holdings].sort((a,b) => { const au=thesisData[a.ticker]?.base&&a.price?(thesisData[a.ticker].base-a.price)/a.price:-999; const bu=thesisData[b.ticker]?.base&&b.price?(thesisData[b.ticker].base-b.price)/b.price:-999; return _dir*(au-bu); });
  else if (thesisSortCol === 'return') holdings = [...holdings].sort((a,b) => _dir*((a.glPct||0)-(b.glPct||0)));
  else if (thesisSortCol==='upside') holdings=[...holdings].sort((a,b)=>{
    const au=thesisData[a.ticker]?.base&&a.price?(thesisData[a.ticker].base-a.price)/a.price:-999;
    const bu=thesisData[b.ticker]?.base&&b.price?(thesisData[b.ticker].base-b.price)/b.price:-999;
    return _dir*(au-bu);
  });
  else if (thesisSortCol==='return') holdings=[...holdings].sort((a,b)=>_dir*((a.glPct||0)-(b.glPct||0)));
  else holdings=[...holdings].sort((a,b)=>_dir*((b.marketValue||0)-(a.marketValue||0)));

  document.getElementById('thesisCount').textContent = `(${holdings.length} equities)`;
  document.getElementById('thesisMasterTable').innerHTML = `
    <tr>
  <th>Ticker</th><th>Company</th><th>Sector</th><th>Market Cap</th><th>Tag</th>
  <th style="cursor:pointer;user-select:none" onclick="thesisSortBy('beta')">Beta ↕</th>
  <th style="cursor:pointer;user-select:none" onclick="thesisSortBy('pe')">P/E ↕</th>
  <th style="cursor:pointer;user-select:none" onclick="thesisSortBy('ytd')">YTD ↕</th>
  <th style="cursor:pointer;user-select:none" onclick="thesisSortBy('alpha')">Alpha ↕</th>
  <th style="cursor:pointer;user-select:none" onclick="thesisSortBy('weight')" title="Weight within this fund (Endowment or CEE), not the combined total">% of ${S.fundName} ↕</th>
  <th>Price</th><th>Base Target</th><th style="cursor:pointer;user-select:none" onclick="thesisSortBy('upside')">Upside ↕</th><th style="cursor:pointer;user-select:none" onclick="thesisSortBy('return')" title="Gain since the fund purchased this position — NOT year-to-date">Since Purch. ↕</th><th>Thesis</th>
</tr>
    ${holdings.map(h => {
      const td = thesisData[h.ticker] || {};
      const mcap = mcapCache[h.ticker];
      const tier = mcap ? getMcapTier(mcap) : '—';
      const tierColor = {'Mega Cap':'#7c3aed','Large Cap':'#1e40af','Mid Cap':'#047857','Small Cap':'#b45309'}[tier]||'var(--gray)';
      const upside = td.base && h.price ? (td.base - h.price)/h.price*100 : null;
      const hasThesis = td.thesis || td.catalysts || td.risks;
      const _ytdV = ytdCache[h.ticker];
      const _ytdCls = _ytdV != null ? (_ytdV >= 0 ? 'pos' : 'neg') : '';
      const _ytdTxt = _ytdV != null ? (_ytdV >= 0 ? '+' : '') + _ytdV.toFixed(1) + '%' : '—';
      const _ym = (window.ytdMeta||{})[h.ticker];
      const _ytdTip = _ym ? 'YTD math: $'+_ym.base+' (close '+_ym.baseDt+') → $'+_ym.last+' = '+_ym.pct+'%. Prices are split-adjusted.' : 'YTD vs prior-year close';
      return `<tr onclick="openThesisDetail('${h.ticker}')" style="cursor:pointer" onmouseover="this.style.background='#f8fafc'" onmouseout="this.style.background=''">
        <td class="ticker-cell" style="white-space:nowrap">${logoImg(h.ticker)}${h.ticker}</td>
        <td>${h.company}</td>
        <td style="font-size:11px">${h.sector||'—'}</td>
        <td><span style="font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px;background:${tierColor}22;color:${tierColor}">${tier}</span></td>
        <td>${td.tag?'<span style="font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px;background:'+TAG_BG[td.tag]+';color:'+TAG_COLORS[td.tag]+'">'+td.tag+'</span>':'—'}</td>
        <td style="font-weight:600;color:${(h.beta||1)>1.2?'#d6453d':(h.beta||1)<0.8?'#159a51':'var(--navy)'}">${h.beta?h.beta.toFixed(2):'—'}</td>
        <td style="font-size:12px">${peCache[h.ticker]?peCache[h.ticker]+'x':'—'}</td>
        <td class="${_ytdCls}" title="${_ytdTip}" style="cursor:help">${_ytdTxt}</td>
        <td class="${ytdCache[h.ticker]!=null&&ytdCache['SPY']!=null?(ytdCache[h.ticker]-ytdCache['SPY'])>=0?'pos':'neg':''}" style="font-weight:700">${ytdCache[h.ticker]!=null&&ytdCache['SPY']!=null?(ytdCache[h.ticker]-ytdCache['SPY']>=0?'+':'')+(ytdCache[h.ticker]-ytdCache['SPY']).toFixed(1)+'%':'—'}</td>
        <td style="font-size:11px">${(h.marketValue/S.equityTotal*100).toFixed(1)}%</td>
        <td>${h.price?'$'+h.price.toFixed(2):'—'}</td>
        <td style="font-weight:600">${td.base?'$'+td.base.toFixed(2):'—'}</td>
        <td class="${upside===null?'':upside>=0?'pos':'neg'}" style="font-weight:700">${upside!==null?(upside>=0?'+':'')+upside.toFixed(1)+'%':'—'}</td>
        <td class="${(h.glPct||0)>=0?'pos':'neg'}">${h.glPct!=null?((h.glPct>=0?'+':'')+(h.glPct*100).toFixed(1)+'%'):'—'}</td>
        <td style="font-size:11px;color:${hasThesis?'#159a51':'var(--muted)'}">${hasThesis?'✅ Written':'✏️ Empty'}</td>
      </tr>`;
    }).join('')}`;
}


// ── MOVERS TAB ────────────────────────────────────────────────────────────────
let moversData = { week: null, month: null };
let activeMoversView = 'week';

async function loadMovers() {
  const loadEl = document.getElementById('moversLoading');
  const content = document.getElementById('moversContent');
  if (loadEl) loadEl.textContent = '⏳ Fetching data...';
  content.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">Loading price data from Finnhub...</div>';

  // Get all unique holdings from active fund
  const holdings = [...S.equities, ...S.etfs];
  const tickers = [...new Set(holdings.map(h => h.ticker))];

  // Fetch week returns
  if (loadEl) loadEl.textContent = `⏳ Loading 1W data (0/${tickers.length})...`;
  const weekReturns = {};
  for (let i = 0; i < tickers.length; i += 5) {
    await Promise.all(tickers.slice(i, i+5).map(async tk => {
      weekReturns[tk] = await fetchCandleReturn(tk, '1W');
    }));
    if (i + 5 < tickers.length) await new Promise(r => setTimeout(r, 1100));
    if (loadEl) loadEl.textContent = `⏳ Loading 1W data (${Math.min(i+5,tickers.length)}/${tickers.length})...`;
  }

  // Fetch month returns
  if (loadEl) loadEl.textContent = `⏳ Loading 1M data (0/${tickers.length})...`;
  const monthReturns = {};
  for (let i = 0; i < tickers.length; i += 5) {
    await Promise.all(tickers.slice(i, i+5).map(async tk => {
      monthReturns[tk] = await fetchCandleReturn(tk, '1M');
    }));
    if (i + 5 < tickers.length) await new Promise(r => setTimeout(r, 1100));
    if (loadEl) loadEl.textContent = `⏳ Loading 1M data (${Math.min(i+5,tickers.length)}/${tickers.length})...`;
  }

  moversData.week = weekReturns;
  moversData.month = monthReturns;
  if (loadEl) loadEl.textContent = '';
  renderMovers(activeMoversView);
}

function showMovers(view, btn) {
  activeMoversView = view;
  document.querySelectorAll('#tab-movers .filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  if (moversData.week || moversData.month) renderMovers(view);
}

function renderMovers(view) {
  const content = document.getElementById('moversContent');
  const returns = view === 'week' ? moversData.week : moversData.month;
  const threshold = view === 'week' ? 5 : 10;
  const label = view === 'week' ? '1W' : '1M';
  if (!returns) {
    content.innerHTML = '<div style="text-align:center;padding:30px;color:var(--muted)">Click Refresh to load data</div>';
    return;
  }

  const holdings = [...S.equities, ...S.etfs];
  const movers = holdings
    .filter(h => returns[h.ticker] !== null && returns[h.ticker] !== undefined)
    .map(h => ({ ...h, periodReturn: returns[h.ticker] }))
    .filter(h => Math.abs(h.periodReturn) >= threshold)
    .sort((a, b) => b.periodReturn - a.periodReturn);

  const gainers = movers.filter(h => h.periodReturn > 0);
  const losers = movers.filter(h => h.periodReturn < 0);

  if (movers.length === 0) {
    content.innerHTML = `<div style="text-align:center;padding:40px;color:var(--muted)">
      <div style="font-size:24px;margin-bottom:8px">✅</div>
      <div style="font-size:14px;font-weight:600">No ${label} movers above ${threshold}% threshold</div>
      <div style="font-size:12px;margin-top:4px">All holdings within normal range</div>
    </div>`;
    return;
  }

  const makeCard = (h, isGainer) => `
    <div onclick="loadMoverNews('${h.ticker}','${h.company}')" style="background:${isGainer?'#f0fdf4':'#fff5f5'};border:1px solid ${isGainer?'#86efac':'#fca5a5'};border-radius:8px;padding:14px;cursor:pointer;transition:all 0.2s" onmouseover="this.style.transform='translateY(-2px)'" onmouseout="this.style.transform=''">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px">
        <div>
          <span style="font-size:16px;font-weight:800;color:var(--navy)">${h.ticker}</span>
          <span class="badge type-${h.type}" style="margin-left:6px">${h.type.toUpperCase()}</span>
        </div>
        <div style="font-size:18px;font-weight:800;color:${isGainer?'#159a51':'#d6453d'}">${h.periodReturn>=0?'+':''}${h.periodReturn.toFixed(1)}%</div>
      </div>
      <div style="font-size:11px;color:var(--gray);margin-bottom:6px">${h.company}</div>
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--muted)">
        <span>Price: ${h.price?'$'+h.price.toFixed(2):'—'}</span>
        <span>MV: $${fmt(h.marketValue||0)}</span>
        <span>Wt: ${((h.marketValue||0)/S.total*100).toFixed(1)}%</span>
      </div>
      <div style="font-size:10px;color:var(--muted);margin-top:6px;text-align:center">📰 Click for news →</div>
    </div>`;

  content.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
      <div>
        <div style="font-size:12px;font-weight:700;color:#159a51;text-transform:uppercase;margin-bottom:10px;display:flex;align-items:center;gap:6px">
          <span style="font-size:16px">🚀</span> Top Gainers (${label} ≥+${threshold}%) · ${gainers.length} stocks
        </div>
        ${gainers.length > 0 
          ? `<div style="display:grid;gap:10px">${gainers.map(h => makeCard(h, true)).join('')}</div>`
          : `<div style="padding:20px;text-align:center;color:var(--muted);background:#f8fafc;border-radius:8px;font-size:12px">No gainers above +${threshold}%</div>`}
      </div>
      <div>
        <div style="font-size:12px;font-weight:700;color:#d6453d;text-transform:uppercase;margin-bottom:10px;display:flex;align-items:center;gap:6px">
          <span style="font-size:16px">📉</span> Top Losers (${label} ≤-${threshold}%) · ${losers.length} stocks
        </div>
        ${losers.length > 0
          ? `<div style="display:grid;gap:10px">${[...losers].reverse().map(h => makeCard(h, false)).join('')}</div>`
          : `<div style="padding:20px;text-align:center;color:var(--muted);background:#f8fafc;border-radius:8px;font-size:12px">No losers below -${threshold}%</div>`}
      </div>
    </div>`;
}

async function loadMoverNews(ticker, company) {
  const panel = document.getElementById('moversNewsPanel');
  const loadEl = document.getElementById('moversNewsLoading');
  const listEl = document.getElementById('moversNewsList');
  document.getElementById('moversNewsTicker').textContent = ticker;
  document.getElementById('moversNewsCompany').textContent = company;
  panel.style.display = 'block';
  listEl.innerHTML = '';
  loadEl.style.display = 'block';
  loadEl.textContent = 'Loading news...';
  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });

  try {
    const today = new Date();
    const from = new Date(today); from.setDate(from.getDate() - 30);
    const fromStr = from.toISOString().split('T')[0];
    const toStr = today.toISOString().split('T')[0];
    const data = await fetchYF(`https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${fromStr}&to=${toStr}&token=${FINNHUB}`, 8000);
    loadEl.style.display = 'none';
    if (!data || !data.length) {
      listEl.innerHTML = '<div style="color:var(--muted);text-align:center;padding:20px">No recent news found for ' + ticker + '</div>';
      return;
    }
    const articles = data.slice(0, 10);
    listEl.innerHTML = articles.map(a => {
      const date = new Date(a.datetime * 1000);
      const dateStr = date.toLocaleDateString('en-US', {month:'short',day:'numeric'}) + ' · ' + date.toLocaleTimeString('en-US', {hour:'numeric',minute:'2-digit'});
      return `<div class="news-item">
        <div class="news-headline"><a href="${a.url}" target="_blank" rel="noopener">${a.headline}</a></div>
        <div class="news-meta">${a.source} · ${dateStr}</div>
        ${a.summary ? `<div style="font-size:11px;color:var(--gray);margin-top:4px;line-height:1.4">${a.summary.slice(0,200)}${a.summary.length>200?'...':''}</div>` : ''}
      </div>`;
    }).join('');
  } catch(e) {
    loadEl.style.display = 'none';
    listEl.innerHTML = '<div style="color:var(--muted);text-align:center;padding:20px">Could not load news. Try again.</div>';
  }
}


// ── TOTAL AUM ──────────────────────────────────────────────────────────────────
function renderAUM(){
  const E=RAW.endowment,C=RAW.ceeFund;
  const aE=[...E.equities,...E.etfs],aC=[...C.equities,...C.etfs],all=[...aE,...aC];
  const eMV=aE.reduce((s,h)=>s+(h.marketValue||0),0)+(E.cash||0)+(E.bond?.marketValue||0);
  const cMV=aC.reduce((s,h)=>s+(h.marketValue||0),0)+(C.cash||0);
  const tot=eMV+cMV,allMV=all.reduce((s,h)=>s+(h.marketValue||0),0)||1;
  const beta=all.reduce((s,h)=>s+(h.beta||1)*(h.marketValue||0),0)/allMV;
  document.getElementById('aumKpis').innerHTML=`
    <div class="kpi accent"><div class="kpi-label">Total AUM</div><div class="kpi-value">$${fmt(tot)}</div><div class="kpi-sub">Endowment + CEE Fund</div></div>
    <div class="kpi"><div class="kpi-label">Endowment</div><div class="kpi-value">$${fmt(eMV)}</div><div class="kpi-sub">${(eMV/tot*100).toFixed(1)}% of AUM</div></div>
    <div class="kpi"><div class="kpi-label">CEE Fund</div><div class="kpi-value">$${fmt(cMV)}</div><div class="kpi-sub">${(cMV/tot*100).toFixed(1)}% of AUM</div></div>
    <div class="kpi"><div class="kpi-label">Combined Beta</div><div class="kpi-value">${beta.toFixed(3)}</div><div class="kpi-sub">${beta>1?'Higher':'Lower'} than S&P</div></div>
    <div class="kpi"><div class="kpi-label">Unique Tickers</div><div class="kpi-value">${new Set(all.map(h=>h.ticker)).size}</div><div class="kpi-sub">Across both funds</div></div>
    <div class="kpi"><div class="kpi-label">Total Equity MV</div><div class="kpi-value">$${fmt([...E.equities,...C.equities].reduce((s,h)=>s+(h.marketValue||0),0))}</div><div class="kpi-sub">Combined equities</div></div>
    ${(()=>{const _dd=all.reduce((s,h)=>s+(h.dayDollar||0),0);const _pct=_dd/((tot-_dd)||1)*100;return '<div class="kpi"><div class="kpi-label">Today\'s Change</div><div class="kpi-value '+(_dd>=0?'pos':'neg')+'">'+(_dd>=0?'+':'−')+fmt(Math.abs(_dd))+' <span style="font-size:13px">('+(_dd>=0?'+':'')+_pct.toFixed(2)+'%)</span></div><div class="kpi-sub">Combined day P&L</div></div>';})()}`;
  const EXCL=['Broad Market','Fixed Income'],fAll=all.filter(h=>!EXCL.includes(h.sector)),fT=fAll.reduce((s,h)=>s+(h.marketValue||0),0)||1;
  const secs=calcSectors(fAll,fT),cols=['#0c2a5e','#1e40af','#2563eb','#3b82f6','#60a5fa','#93c5fd','#bfdbfe','#dbeafe'],mp=Math.max(...secs.map(s=>s.pct));
  document.getElementById('aumSectors').innerHTML=secs.map((s,i)=>`<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><div style="min-width:130px;font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.name}</div><div class="st" style="flex:1"><div class="sf" style="width:${(s.pct/mp*100).toFixed(1)}%;background:${cols[i%8]}"></div></div><div class="sp_">${(s.pct*100).toFixed(1)}%</div></div>`).join('');
  const eqMV=[...E.equities,...C.equities].reduce((s,h)=>s+(h.marketValue||0),0),etfMV=[...E.etfs,...C.etfs].reduce((s,h)=>s+(h.marketValue||0),0),cash=(E.cash||0)+(C.cash||0),bond=E.bond?.marketValue||0;
  const assets=[{n:'Equities',v:eqMV,c:'#0c2a5e'},{n:'ETFs',v:etfMV,c:'#1e40af'},{n:'Cash',v:cash,c:'#159a51'},{n:'Bonds',v:bond,c:'#f59e0b'}].filter(a=>a.v>0);
  const aT=assets.reduce((s,a)=>s+a.v,0)||1,mA=Math.max(...assets.map(a=>a.v));
  document.getElementById('aumComposition').innerHTML=assets.map(a=>`<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px"><div style="min-width:70px;font-size:12px;font-weight:600">${a.n}</div><div class="st" style="flex:1"><div class="sf" style="width:${(a.v/mA*100).toFixed(1)}%;background:${a.c}"></div></div><div class="sp_">${(a.v/aT*100).toFixed(1)}%</div><div style="font-size:11px;color:var(--muted);min-width:80px;text-align:right">$${fmt(a.v)}</div></div>`).join('');
  const tiers={'Mega Cap':{c:'#7c3aed',b:'#f5f3ff',h:[],v:0},'Large Cap':{c:'#1e40af',b:'#eff6ff',h:[],v:0},'Mid Cap':{c:'#047857',b:'#ecfdf5',h:[],v:0},'Small Cap':{c:'#b45309',b:'#fffbeb',h:[],v:0}};
  all.filter(h=>h.type==='equity').forEach(h=>{const m=mcapCache[h.ticker];if(m){const t=getMcapTier(m);if(tiers[t]){tiers[t].h.push(h.ticker);tiers[t].v+=(h.marketValue||0);}}});
  const tT=Object.values(tiers).reduce((s,t)=>s+t.v,0)||1;
  document.getElementById('aumMcap').innerHTML=Object.entries(tiers).map(([n,t])=>`<div style="background:${t.b};border:1px solid ${t.c}33;border-radius:8px;padding:14px;border-left:3px solid ${t.c}"><div style="font-size:11px;font-weight:700;text-transform:uppercase;color:${t.c}">${n}</div><div style="font-size:20px;font-weight:700;color:${t.c}">${(t.v/tT*100).toFixed(1)}%</div><div style="font-size:11px;color:var(--muted)">$${fmt(t.v)} · ${[...new Set(t.h)].length} positions</div><div style="font-size:10px;color:var(--muted);margin-top:4px">${[...new Set(t.h)].slice(0,4).join(', ')}${[...new Set(t.h)].length>4?' +more':''}</div></div>`).join('');
  const mm={};
  aE.forEach(h=>{if(!mm[h.ticker])mm[h.ticker]={...h,eMV:0,cMV:0};mm[h.ticker].eMV+=(h.marketValue||0);});
  aC.forEach(h=>{if(!mm[h.ticker])mm[h.ticker]={...h,eMV:0,cMV:0};mm[h.ticker].cMV+=(h.marketValue||0);});
  const rows=Object.values(mm).map(h=>({...h,tMV:(h.eMV||0)+(h.cMV||0)})).sort((a,b)=>b.tMV-a.tMV);
  document.getElementById('aumCount').textContent=rows.length+' holdings';
  const hdr='<tr><th>Ticker</th><th>Company</th><th>Sector</th><th>Type</th><th>Endowment</th><th>CEE Fund</th><th>Combined MV</th><th>% AUM</th><th>Beta</th></tr>';
  const rowHtml=h=>`<tr><td class="ticker-cell">${h.ticker}</td><td>${h.company}</td><td style="font-size:11px">${h.sector||'—'}</td><td><span class="badge type-${h.type}">${h.type.toUpperCase()}</span></td><td>${h.eMV?'$'+fmt(h.eMV):'—'}</td><td>${h.cMV?'$'+fmt(h.cMV):'—'}</td><td><strong>$${fmt(h.tMV)}</strong></td><td>${(h.tMV/tot*100).toFixed(2)}%</td><td>${h.beta?h.beta.toFixed(2):'—'}</td></tr>`;
  document.getElementById('aumTop15').innerHTML=hdr+rows.slice(0,15).map(rowHtml).join('');
  document.getElementById('aumTable').innerHTML=hdr+rows.map(rowHtml).join('');
}

// ── TICKER CHART MODAL ─────────────────────────────────────────────────────────
let tcRef=null,tcTk=null;
function closeTickerChart(){document.getElementById('tickerModal').style.display='none';if(tcRef){tcRef.destroy();tcRef=null;}}
async function showTickerChart(ticker,company){
  tcTk=ticker;
  document.getElementById('tickerModal').style.display='block';
  document.getElementById('tcTicker').textContent=ticker;
  document.getElementById('tcCompany').textContent=company||'';
  document.getElementById('tcReturn').textContent='';
  const h=S.holdings.find(x=>x.ticker===ticker)||ALL_HOLDINGS().find(x=>x.ticker===ticker);
  const ytd=ytdCache[ticker];
  document.getElementById('tcStats').innerHTML=`
    <div style="background:#f8fafc;border-radius:8px;padding:12px;border-left:3px solid var(--navy)"><div style="font-size:10px;color:var(--muted);text-transform:uppercase;font-weight:700">YTD Return</div><div class="${ytd!=null?(ytd>=0?'pos':'neg'):''}" style="font-size:18px;font-weight:800">${ytd!=null?(ytd>=0?'+':'')+ytd.toFixed(1)+'%':'Loading...'}</div></div>
    <div style="background:#f8fafc;border-radius:8px;padding:12px;border-left:3px solid var(--gold)"><div style="font-size:10px;color:var(--muted);text-transform:uppercase;font-weight:700">Cost Return</div><div class="${(h?.glPct||0)>=0?'pos':'neg'}" style="font-size:18px;font-weight:800">${h?.glPct!=null?(h.glPct>=0?'+':''+(h.glPct*100).toFixed(1)+'%'):'—'}</div></div>
    <div style="background:#f8fafc;border-radius:8px;padding:12px;border-left:3px solid var(--blue)"><div style="font-size:10px;color:var(--muted);text-transform:uppercase;font-weight:700">Market Value</div><div style="font-size:18px;font-weight:800">$${h?fmt(h.marketValue):'—'}</div></div>
    <div style="background:#f8fafc;border-radius:8px;padding:12px;border-left:3px solid ${(h?.beta||1)>1.2?'#d6453d':'#159a51'}"><div style="font-size:10px;color:var(--muted);text-transform:uppercase;font-weight:700">Beta</div><div style="font-size:18px;font-weight:800">β${h?.beta?h.beta.toFixed(2):'—'}</div></div>`;
  await loadTickerChart('3M',document.querySelector('#tickerModal .tc-btn.active'));
  loadTickerNews(ticker);
}
async function loadTickerChart(period,btn){
  if(!tcTk)return;
  document.querySelectorAll('#tickerModal .tc-btn').forEach(b=>b.classList.remove('active'));
  if(btn)btn.classList.add('active');
  const ranges={'1W':'5d','1M':'1mo','3M':'3mo','6M':'6mo','YTD':'ytd','1Y':'1y'};
  const intervals={'1W':'1d','1M':'1d','3M':'1d','6M':'1wk','YTD':'1wk','1Y':'1wk'};
  const url=`https://query1.finance.yahoo.com/v8/finance/chart/${tcTk}?interval=${intervals[period]||'1d'}&range=${ranges[period]||'3mo'}`;
  const data=await fetchYF(url,8000);
  if(!data)return;
  const res=data.chart?.result?.[0];if(!res)return;
  const pts=(res.timestamp||[]).map((t,i)=>({t,c:(res.indicators?.quote?.[0]?.close||[])[i]})).filter(x=>x.c!=null);
  if(pts.length<2)return;
  const labels=pts.map(x=>new Date(x.t*1000).toLocaleDateString('en-US',{month:'short',day:'numeric'}));
  const prices=pts.map(x=>x.c);
  let pct=(prices[prices.length-1]-prices[0])/prices[0]*100;
  if(period==='YTD'){
    const _v=await fetchCandleReturn(tcTk,'YTD');   // Jan-2-anchored, verified engine
    if(_v!==null)pct=_v;
  }
  const re=document.getElementById('tcReturn');
  re.textContent=(pct>=0?'+':'')+pct.toFixed(2)+'% ('+period+')';re.className=pct>=0?'pos':'neg';re.style.cssText='font-weight:700;font-size:15px';
  if(tcRef)tcRef.destroy();
  const col=pct>=0?'#159a51':'#d6453d';
  tcRef=new Chart(document.getElementById('tcCanvas').getContext('2d'),{type:'line',data:{labels,datasets:[{label:tcTk,data:prices,borderColor:col,backgroundColor:col+'18',borderWidth:2,pointRadius:0,fill:true,tension:0.3}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>'$'+c.parsed.y.toFixed(2)}}},scales:{y:{ticks:{callback:v=>'$'+v.toFixed(0)},grid:{color:'#f1f5f9'}},x:{ticks:{maxTicksLimit:8,font:{size:10}},grid:{display:false}}}}});
}
async function loadTickerNews(ticker){
  const el=document.getElementById('tcNews');el.innerHTML='<div style="font-size:12px;color:var(--muted)">Loading news...</div>';
  try{
    const t=new Date(),f=new Date(t);f.setDate(f.getDate()-30);
    const d=await fetchYF(`https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${f.toISOString().slice(0,10)}&to=${t.toISOString().slice(0,10)}&token=${FINNHUB}`,8000);
    if(!d?.length){el.innerHTML='<div style="font-size:12px;color:var(--muted)">No recent news.</div>';return;}
    el.innerHTML='<div style="font-size:13px;font-weight:700;color:var(--navy);margin-bottom:8px">Recent News</div>'+[...d].sort((a,b)=>(b.datetime||0)-(a.datetime||0)).slice(0,8).map(a=>`<div class="news-item" style="margin-bottom:8px"><div class="news-headline"><a href="${a.url}" target="_blank">${a.headline}</a></div><div class="news-meta">${a.source} · ${new Date(a.datetime*1000).toLocaleDateString('en-US',{month:'short',day:'numeric'})}</div>${a.summary?'<div style="font-size:11px;color:var(--gray);margin-top:3px">'+a.summary.slice(0,150)+'...</div>':''}</div>`).join('');
  }catch(e){el.innerHTML='<div style="font-size:12px;color:var(--muted)">Could not load news.</div>';}
}

window.addEventListener('load', () => {
  init();
  // Auto-refresh live prices on load (the embedded prices are only a build-time snapshot)
  setTimeout(()=>{ fetchLivePrices().catch(()=>{}); }, 1200);
  // Background-load YTD for every holding (equities + ETFs, both funds) so all tabs are ready
  setTimeout(()=>{ fetchYTDForThesis().catch(()=>{}); }, 2500);
  // (build badge removed per request)
});
