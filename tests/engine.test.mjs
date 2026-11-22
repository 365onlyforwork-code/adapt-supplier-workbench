import test from 'node:test';
import assert from 'node:assert/strict';
import {analyze,reclassify,createPCG64,quantile,classify,validateInput,scenarioScores,isWeightFeasible} from '../dist/engine.mjs';
import {PAPER_DATA} from './fixtures/benchmark.mjs';

const clone=()=>structuredClone(PAPER_DATA);
const close=(actual,expected,tolerance=1e-12)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} differs from ${expected}`);
const small=()=>({...clone(),sampleCount:1000});

test('PCG64 binary64 uniforms exactly match NumPy default_rng(20261101)',()=>{
  const expected=[.591570716712382,.35801643314122533,.48392823954474307,.9865675105514101,.13594114155666692,.0010437313434191742,.5183032854572411,.26553539446590535,.4326033483773125,.4338660652715507];
  const random=createPCG64();
  assert.deepEqual(Array.from({length:10},random),expected);
  assert.throws(()=>createPCG64(1),/20261101/);
});

test('paper 200k simulation reproduces published scores, ranks, RSI, pair intervals and exact bounds',()=>{
  const {result}=analyze(PAPER_DATA);
  assert.deepEqual(result.sorted,['S3','S5','S1','S4','S2']);
  const gold=[
    [.7508183920473317,.4255392772355079,.8851227795193315,.844175],
    [.6979908099828815,.40564955601461694,.837130651477394,.99996],
    [.9279214343634563,.8019052686304934,0,1],
    [.7336396672372887,.44124552096109976,.7177799201551368,.846105],
    [.7994714238519988,.5617566314175452,.4776146133137516,.99801],
  ];
  result.suppliers.forEach((s,i)=>{
    [s.baseline,s.topsis,s.vikor,s.rsi].forEach((v,j)=>close(v,gold[i][j]));
    close(s.rankProb.reduce((a,b)=>a+b,0),1);
  });
  const pair=result.pairs.find(x=>x.a==='S1'&&x.b==='S4');
  assert.equal(pair.prob,.846145);
  close(pair.lo,-.009487305063052892);
  close(pair.hi,.04509868112635155);
  close(pair.min,-.03734115347018571);
  close(pair.max,.07941719679868663);
  close(result.delta,.01741898669549809);
  assert.equal(pair.status,'未解决');
  close(pair.histogram.reduce((total,bin)=>total+bin.probability,0),1);
  assert.equal(result.engine.vertexCount,64);
});

test('linear quantiles equal a separately sorted reference, including repeats and endpoints',()=>{
  const random=createPCG64();
  for(const length of [1,2,7,100,1001]) {
    const input=Array.from({length},()=>Math.round(random()*100)/100),ordered=[...input].sort((a,b)=>a-b);
    for(const q of [0,.001,.05,.25,.5,.95,1]) {
      const p=(length-1)*q,a=ordered[Math.floor(p)],b=ordered[Math.ceil(p)];
      close(quantile(Float64Array.from(input),q),a+(b-a)*(p-Math.floor(p)));
    }
  }
});

test('reclassification preserves draws and winner probabilities and changes interval/classification',()=>{
  const original=analyze(PAPER_DATA),before=original.cache.scores[0][25];
  const changed=reclassify(original.cache,.75,.05);
  assert.equal(changed.cache,original.cache);
  assert.equal(changed.cache.scores[0][25],before);
  const first=original.result.pairs.find(x=>x.a==='S1'&&x.b==='S4');
  const second=changed.result.pairs.find(x=>x.a==='S1'&&x.b==='S4');
  assert.equal(first.prob,second.prob);
  assert.equal(second.status,'等效');
  assert.ok(second.lo>first.lo && second.hi<first.hi);
  close(changed.result.suppliers[0].score5,original.result.suppliers[0].score5);
  assert.equal(changed.result.p,.75);
});

test('equivalence has priority over separation and boundaries are strict',()=>{
  assert.equal(classify(.001,.005,.01),'等效');
  assert.equal(classify(.001,.02,.01),'可分');
  assert.equal(classify(-.01,.01,.01),'未解决');
  assert.equal(classify(-.001,0,.01),'等效');
});

test('identical suppliers share ranks, never acquire artificial wins, and constant columns stay finite',()=>{
  const data={suppliers:[{id:'A',values:[2,4]},{id:'B',values:[2,4]}],criteria:[{id:'X',type:'cost',lower:1,modal:1,upper:1},{id:'Y',type:'benefit',lower:1,modal:1,upper:1}],sampleCount:50};
  const {result}=analyze(data);
  for(const supplier of result.suppliers) {
    assert.equal(supplier.wsmRank,1);assert.equal(supplier.topsisRank,1);assert.equal(supplier.vikorRank,1);
    assert.equal(supplier.topsis,.5);assert.equal(supplier.vikor,0);assert.equal(supplier.rsi,1);
    assert.deepEqual(supplier.rankProb,[1,0]);
  }
  assert.equal(result.delta,.01);assert.equal(result.engine.defaultDeltaFallback,true);
  assert.equal(result.pairs[0].prob,0);assert.equal(result.pairs[0].probTie,1);
  assert.equal(result.pairs[0].status,'等效');
  assert.equal(result.pairs[0].min,0);assert.equal(result.pairs[0].max,0);
  assert.ok(result.engine.notes.length);
});

test('a constant criterion is ignored for margin and VIKOR while preserving its weight',()=>{
  const data=small();for(const supplier of data.suppliers) supplier.values[1]=7;
  const {result}=analyze(data);
  assert.equal(result.deltaImpacts[1],null);
  assert.ok(result.weights[1]>0);
  result.suppliers.forEach(s=>assert.ok([s.baseline,s.topsis,s.vikor,s.lo,s.hi].every(Number.isFinite)));
});

test('generic maximum dimensions produce all 435 pairs and 1024 exact vertices',()=>{
  const criteria=Array.from({length:10},(_,j)=>({id:`C${j}`,type:j%2?'cost':'benefit',lower:1,modal:2,upper:3}));
  const suppliers=Array.from({length:30},(_,i)=>({id:`S${i}`,values:criteria.map((_,j)=>1+((i+1)*(j+3)%37))}));
  const {result}=analyze({suppliers,criteria,sampleCount:200});
  assert.equal(result.suppliers.length,30);assert.equal(result.pairs.length,435);assert.equal(result.engine.vertexCount,1024);
  result.pairs.forEach(pair=>{
    assert.ok(pair.min<=pair.lo+1e-12 && pair.lo<=pair.hi && pair.hi<=pair.max+1e-12);
    close(pair.prob+pair.probReverse+pair.probTie,1);
  });
});

test('cost inversion and preference scenarios obey the normalized-box feasibility test',()=>{
  const data=clone();
  const result=scenarioScores(data,[.17,.33,.16,.14,.11,.09]);
  assert.equal(result.feasible,true);
  assert.equal(result.suppliers.find(s=>s.id==='S4').rank,3);
  close(result.suppliers.find(s=>s.id==='S3').score,.9345454545454547);
  assert.equal(isWeightFeasible([.17,.21,.28,.14,.12,.08],data.criteria),false);
  assert.equal(isWeightFeasible([.17,.22,.17,.14,.22,.08],data.criteria),false);
  assert.equal(isWeightFeasible([0,1,0,0,0,0],data.criteria),false);
  const {result:analysis}=analyze({...data,sampleCount:2});
  close(analysis.normalized[0][0],2/3);
});

test('input errors reject invalid shapes, weights, scores, identifiers and parameters',()=>{
  const mutations=[
    d=>d.suppliers.splice(1),d=>d.criteria.splice(1),d=>d.suppliers[0].values.pop(),
    d=>d.suppliers[0].values[0]=0,d=>d.suppliers[0].values[0]=-1,d=>d.suppliers[0].values[0]=NaN,
    d=>d.criteria[0].lower=0,d=>d.criteria[0].modal=d.criteria[0].upper+1,
    d=>d.criteria[0].type='unknown',d=>d.suppliers[1].id=d.suppliers[0].id,
    d=>d.criteria[1].id=d.criteria[0].id,d=>d.p=1,d=>d.p=0,d=>d.delta=-1,
    d=>d.sampleCount=1.5,d=>d.sampleCount=200001,d=>d.seed=5,
  ];
  for(const mutate of mutations) {const d=small();mutate(d);assert.throws(()=>validateInput(d));}
  assert.throws(()=>reclassify(null,.9,.1));
});

test('analysis does not mutate input and is deterministic',()=>{
  const data=small(),before=JSON.stringify(data);
  const first=analyze(data).result,second=analyze(data).result;
  assert.equal(JSON.stringify(data),before);assert.deepEqual(first,second);
});

test('worker protocol returns analysis, reclassification, progress and useful errors',async()=>{
  const posts=[];let listener;
  globalThis.self={addEventListener:(type,fn)=>{assert.equal(type,'message');listener=fn;},postMessage:message=>posts.push(message)};
  await import('../dist/worker.js');
  listener({data:{type:'analyze',id:1,data:small()}});
  assert.ok(posts.some(message=>message.type==='progress'&&message.id===1));
  assert.ok(posts.some(message=>message.type==='result'&&message.id===1&&message.result.suppliers.length===5));
  listener({data:{type:'reclassify',id:2,p:.8,delta:.1}});
  assert.ok(posts.some(message=>message.type==='result'&&message.id===2&&message.result.p===.8));
  listener({data:{type:'analyze',id:3,data:{}}});
  assert.ok(posts.some(message=>message.type==='error'&&message.id===3&&typeof message.error==='string'));
  delete globalThis.self;
});
