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
 const sec={},secTwr={};
 for(const [s,v] of Object.entries(f.sectors)) sec[s]=r0(v);
 for(const [s,v] of Object.entries(f.sectorTwr||{})) secTwr[s]=r2(v);
 OUT.funds[k]={name:f.name,nav:r0(f.nav),flows:r0(f.flows),eqNav:r0(f.eqNav),etfNav:r0(f.etfNav),
  twr:r2(f.twr),eqTwr:r2(f.eqTwr||[]),etfTwr:r2(f.etfTwr||[]),
  sectors:sec,sectorTwr:secTwr,irr:f.irr,externalFlows:f.externalFlows,
  missingPrices:f.missingPrices,
  // ticker keys can contain '.', which Firebase forbids - store as pairs
  holdings:Object.entries(f.holdings||{}).map(([tk,v])=>[tk,v])};
}
for(const [b,v] of Object.entries(P.bench)) OUT.bench[b]=r2(v);

const body=JSON.stringify(OUT);
console.log(`payload ${(body.length/1024).toFixed(0)} KB`);
const u=new URL('https://cee-fund-dashboard-640ab-default-rtdb.firebaseio.com/ceePerformance.json');
const req=https.request({hostname:u.hostname,path:u.pathname,method:'PUT',
 headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
 let d='';res.on('data',c=>d+=c);
 res.on('end',()=>{console.log('status',res.statusCode);
  fs.writeFileSync(path.join(__dirname,'perf.min.json'),body);
  console.log('also wrote perf.min.json for local preview');});
});
req.on('error',e=>console.error('ERR',e.message));
req.write(body);req.end();
