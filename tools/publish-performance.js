// Trim precision and publish the performance series to a NEW Firebase node.
// /ceePerformance is additive - no existing node is read or modified.
const fs=require('fs'),path=require('path'),https=require('https');
const P=JSON.parse(fs.readFileSync(path.join(__dirname,'perf.json'),'utf8'));
const r0=a=>a.map(v=>v==null?null:Math.round(v));
const r2=a=>a.map(v=>v==null?null:+v.toFixed(2));

// Firebase keys cannot contain . # $ [ ] / - store ticker maps as arrays instead
const metaArr=Object.keys(P.meta.sectorOf||{}).map(t=>[t,P.meta.sectorOf[t],P.meta.typeOf[t]||'equity']);
const OUT={generatedAt:P.generatedAt,anchor:P.anchor,dates:P.dates,funds:{},bench:{},tickers:metaArr};
for(const [k,f] of Object.entries(P.funds)){
 const sec={},secTwr={},secFlow={};
 for(const [s,v] of Object.entries(f.sectors)) sec[s]=r0(v);
 for(const [s,v] of Object.entries(f.sectorTwr||{})) secTwr[s]=r2(v);
 // purchases/sales per sector - needed to measure the effect of entry timing
 for(const [s,v] of Object.entries(f.sectorFlows||{})) secFlow[s]=r0(v);
 OUT.funds[k]={name:f.name,nav:r0(f.nav),flows:r0(f.flows),eqNav:r0(f.eqNav),etfNav:r0(f.etfNav),
  twr:r2(f.twr),eqTwr:r2(f.eqTwr||[]),etfTwr:r2(f.etfTwr||[]),
  eqFlow:r0(f.eqFlow||[]),etfFlow:r0(f.etfFlow||[]),
  sectors:sec,sectorTwr:secTwr,sectorFlows:secFlow,irr:f.irr,externalFlows:f.externalFlows,
  missingPrices:f.missingPrices,
  // ticker keys can contain '.', which Firebase forbids - store as pairs
  holdings:Object.entries(f.holdings||{}).map(([tk,v])=>[tk,v])};
}
for(const [b,v] of Object.entries(P.bench)) OUT.bench[b]=r2(v);

function put(node,obj){
 return new Promise((res,rej)=>{
  const body=JSON.stringify(obj);
  console.log(`  ${node}: ${(body.length/1024).toFixed(0)} KB`);
  const u=new URL(`https://cee-fund-dashboard-640ab-default-rtdb.firebaseio.com/${node}.json`);
  const req=https.request({hostname:u.hostname,path:u.pathname+u.search,method:'PUT',
   headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},r=>{
   let d='';r.on('data',c=>d+=c);
   r.on('end',()=>{console.log(`  -> status ${r.statusCode}`); r.statusCode===200?res():rej(new Error(d.slice(0,200)));});
  });
  req.on('error',rej); req.write(body); req.end();
 });
}

(async()=>{
 console.log('publishing:');
 await put('ceePerformance',OUT);
 fs.writeFileSync(path.join(__dirname,'perf.min.json'),JSON.stringify(OUT));
 const lp=path.join(__dirname,'ledger.json');
 if(fs.existsSync(lp)) await put('ceeTransactions',JSON.parse(fs.readFileSync(lp,'utf8')));
 else console.log('  (no ledger.json - run build-performance.js first)');
 console.log('done');
})().catch(e=>{console.error('FAILED:',e.message);process.exit(1);});
