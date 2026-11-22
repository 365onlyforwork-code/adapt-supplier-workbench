/** ADAPT numerical engine. No network or DOM dependencies. */
export const FIXED_SEED = 20261101;
const MASK128 = (1n << 128n) - 1n;
const MASK64 = (1n << 64n) - 1n;
const MULTIPLIER = 47026247687942121848144207491837523525n;
const INITIAL_STATE = 7504949154524691974618690407509731351n;
const INCREMENT = 120828123915794330068514532496447324367n;
const EPSILON = 1e-12;

/** NumPy PCG64 state produced by SeedSequence(20261101); exact binary64 uniforms. */
export function createPCG64(seed = FIXED_SEED) {
  if (Number(seed) !== FIXED_SEED) throw new Error('复现引擎固定使用种子 20261101。');
  let state = INITIAL_STATE;
  return () => {
    state = (state * MULTIPLIER + INCREMENT) & MASK128;
    const x = ((state >> 64n) ^ state) & MASK64;
    const r = state >> 122n;
    const raw = ((x >> r) | (x << ((64n - r) & 63n))) & MASK64;
    return Number(raw >> 11n) / 9007199254740992;
  };
}

function finiteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label}必须是有限数值。`);
  return value;
}

function probability(p) {
  finiteNumber(p,'覆盖概率');
  if (!(p > 0 && p < 1)) throw new Error('覆盖概率必须大于 0 且小于 1。');
  return p;
}

function tolerance(delta) {
  if (delta == null) return null;
  finiteNumber(delta,'容差');
  if (delta < 0) throw new Error('容差不能为负数。');
  return delta;
}

export function validateInput(input) {
  if (!input || typeof input !== 'object') throw new Error('请提供数据对象。');
  const {suppliers,criteria} = input;
  if (!Array.isArray(suppliers) || suppliers.length < 2 || suppliers.length > 30) throw new Error('供应商数量应为 2–30。');
  if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10) throw new Error('准则数量应为 2–10。');
  const checkIds = (rows,label) => {
    const ids = new Set();
    for (const row of rows) {
      if (!row || typeof row.id !== 'string' || !row.id.trim() || ids.has(row.id)) throw new Error(`${label} id 必须非空且唯一。`);
      ids.add(row.id);
    }
  };
  checkIds(suppliers,'供应商'); checkIds(criteria,'准则');
  for (const c of criteria) {
    if (!['cost','benefit'].includes(c.type)) throw new Error(`${c.id} 的类型应为 cost 或 benefit。`);
    for (const key of ['lower','modal','upper']) finiteNumber(c[key],`${c.id} ${key}`);
    if (!(0 < c.lower && c.lower <= c.modal && c.modal <= c.upper)) throw new Error(`${c.id} 权重必须满足 0 < 下限 ≤ 众数 ≤ 上限。`);
  }
  for (const s of suppliers) {
    if (!Array.isArray(s.values) || s.values.length !== criteria.length) throw new Error(`${s.id} 的评分数量与准则不一致。`);
    s.values.forEach((x,j) => {
      finiteNumber(x,`${s.id}/${criteria[j].id} 评分`);
      if (!(x > 0)) throw new Error(`${s.id}/${criteria[j].id} 评分必须大于 0。`);
    });
  }
  const sampleCount = input.sampleCount ?? 200000;
  if (!Number.isInteger(sampleCount) || sampleCount < 1 || sampleCount > 200000) throw new Error('抽样数应为 1–200000 的整数。');
  const seed = input.seed ?? FIXED_SEED;
  if (Number(seed) !== FIXED_SEED) throw new Error('复现引擎固定使用种子 20261101。');
  return {
    suppliers:suppliers.map(s=>({id:s.id,name:String(s.name ?? s.id),values:[...s.values]})),
    criteria:criteria.map(c=>({...c,name:String(c.name ?? c.id)})),
    sampleCount,seed:FIXED_SEED,p:probability(input.p ?? .9),delta:tolerance(input.delta),
  };
}

function normalizedWeights(values) {
  let sum = 0;
  for (const x of values) sum += x;
  if (Number.isFinite(sum)) return values.map(x=>x/sum);
  const max = Math.max(...values);
  const scaled = values.map(x=>x/max);
  const total = scaled.reduce((a,b)=>a+b,0);
  return scaled.map(x=>x/total);
}

/** Equal scores share a competition rank; input order only resolves display order. */
export function rankValues(values, ascending = false) {
  const order = Array.from({length:values.length},(_,i)=>i).sort((a,b)=>(ascending ? values[a]-values[b] : values[b]-values[a]) || a-b);
  const ranks = Array(values.length);
  for (let k=0;k<order.length;k++) {
    ranks[order[k]] = k && values[order[k]]===values[order[k-1]] ? ranks[order[k-1]] : k+1;
  }
  return {order,ranks};
}

function normalizeMatrix(data) {
  const columns = data.criteria.map((_,j)=>data.suppliers.map(s=>s.values[j]));
  const minima = columns.map(col=>Math.min(...col));
  const maxima = columns.map(col=>Math.max(...col));
  return data.suppliers.map(s=>s.values.map((x,j)=>data.criteria[j].type==='cost' ? minima[j]/x : x/maxima[j]));
}

function baselineMethods(matrix,weights) {
  const n=matrix.length,m=weights.length;
  const best = weights.map((_,j)=>Math.max(...matrix.map(row=>row[j])));
  const worst = weights.map((_,j)=>Math.min(...matrix.map(row=>row[j])));
  const wsm=[],topsis=[],totalLoss=[],maxLoss=[];
  for(let i=0;i<n;i++) {
    let score=0,positive=0,negative=0,total=0,max=0;
    for(let j=0;j<m;j++) {
      const weighted=matrix[i][j]*weights[j];
      score+=weighted;
      positive+=(weighted-best[j]*weights[j])**2;
      negative+=(weighted-worst[j]*weights[j])**2;
      const range=best[j]-worst[j];
      const loss=range>0 ? (best[j]-matrix[i][j])/range*weights[j] : 0;
      total+=loss; max=Math.max(max,loss);
    }
    wsm.push(score);
    const dp=Math.sqrt(positive),dn=Math.sqrt(negative);
    topsis.push(dp+dn>0 ? dn/(dp+dn) : .5);
    totalLoss.push(total); maxLoss.push(max);
  }
  const minS=Math.min(...totalLoss),rangeS=Math.max(...totalLoss)-minS;
  const minR=Math.min(...maxLoss),rangeR=Math.max(...maxLoss)-minR;
  const vikor=totalLoss.map((s,i)=>.5*(rangeS>0 ? (s-minS)/rangeS : 0)+.5*(rangeR>0 ? (maxLoss[i]-minR)/rangeR : 0));
  return {wsm,topsis,vikor,wsmRanking:rankValues(wsm),topsisRanking:rankValues(topsis),vikorRanking:rankValues(vikor,true)};
}

function defaultMargin(matrix,weights) {
  const impacts=weights.map((weight,j)=>{
    const unique=[...new Set(matrix.map(row=>row[j]))].sort((a,b)=>a-b);
    let gap=Infinity;
    for(let i=1;i<unique.length;i++) if(unique[i]>unique[i-1]) gap=Math.min(gap,unique[i]-unique[i-1]);
    return Number.isFinite(gap) ? weight*gap : null;
  });
  const positive=impacts.filter(x=>x!==null && x>0);
  return {value:positive.length ? Math.min(...positive) : .01,impacts,fallback:!positive.length};
}

function vertices(criteria) {
  const rows=[];
  for(let mask=0;mask<2**criteria.length;mask++) {
    rows.push(normalizedWeights(criteria.map((c,j)=>mask & 1<<j ? c.upper : c.lower)));
  }
  return rows;
}

// In-place quickselect: quantiles remain linear time without sorting each 200k pair.
function select(values,k,left=0,right=values.length-1) {
  while(left<right) {
    const pivot=values[(left+right)>>1];
    let i=left,j=right;
    while(i<=j) {
      while(values[i]<pivot) i++;
      while(values[j]>pivot) j--;
      if(i<=j) {const t=values[i];values[i]=values[j];values[j]=t;i++;j--;}
    }
    if(k<=j) right=j;
    else if(k>=i) left=i;
    else return values[k];
  }
  return values[k];
}

/** NumPy's default linear quantile interpolation. Mutates the supplied work array. */
export function quantile(values,q) {
  const position=(values.length-1)*q,low=Math.floor(position),high=Math.ceil(position);
  const a=select(values,low);
  if(low===high) return a;
  const b=select(values,high);
  const fraction=position-low;
  // This symmetric form matches numpy._lerp's precision near the upper endpoint.
  return fraction>=.5 ? b-(b-a)*(1-fraction) : a+(b-a)*fraction;
}

export function classify(lo,hi,delta) {
  if(-delta<lo && hi<delta) return '等效';
  if(lo>0 || hi<0) return '可分';
  return '未解决';
}

export function isWeightFeasible(weight,criteria) {
  if(!Array.isArray(weight) || weight.length!==criteria.length || weight.some(x=>!Number.isFinite(x)||x<=0)) return false;
  const w=normalizedWeights(weight);
  return Math.max(...criteria.map((c,j)=>c.lower/w[j])) <= Math.min(...criteria.map((c,j)=>c.upper/w[j]))+EPSILON;
}

/** Deterministic preference scenario; it does not change the Monte Carlo measure. */
export function scenarioScores(data,weight) {
  const input=validateInput(data);
  if(!Array.isArray(weight)||weight.length!==input.criteria.length||weight.some(x=>!Number.isFinite(x)||x<0)||!weight.some(x=>x>0)) throw new Error('情景权重应为非负有限数值，且至少有一项大于 0。');
  const weights=normalizedWeights(weight),matrix=normalizeMatrix(input);
  const methods=baselineMethods(matrix,weights);
  return {weights,feasible:isWeightFeasible(weights,input.criteria),sorted:methods.wsmRanking.order.map(i=>input.suppliers[i].id),suppliers:input.suppliers.map((s,i)=>({id:s.id,name:s.name,score:methods.wsm[i],rank:methods.wsmRanking.ranks[i]}))};
}

/** Returns a serializable result and a private cache for same-sample reclassification. */
export function analyze(input,{onProgress=()=>{}}={}) {
  const data=validateInput(input),matrix=normalizeMatrix(data),n=matrix.length,m=data.criteria.length,N=data.sampleCount;
  const weights=normalizedWeights(data.criteria.map(c=>c.lower/3+c.modal/3+c.upper/3));
  const methods=baselineMethods(matrix,weights),margin=defaultMargin(matrix,weights);
  const scores=Array.from({length:n},()=>new Float64Array(N));
  const rankCounts=Array.from({length:n},()=>new Uint32Array(n));
  const sums=new Float64Array(n),random=createPCG64(data.seed),draw=new Array(m),order=new Array(n);
  onProgress(.02);
  for(let sample=0;sample<N;sample++) {
    let sum=0;
    for(let j=0;j<m;j++) {draw[j]=data.criteria[j].lower+(data.criteria[j].upper-data.criteria[j].lower)*random();sum+=draw[j];}
    if(Number.isFinite(sum)) for(let j=0;j<m;j++) draw[j]/=sum;
    else {const stable=normalizedWeights(draw);for(let j=0;j<m;j++) draw[j]=stable[j];}
    for(let i=0;i<n;i++) {
      let s=0;for(let j=0;j<m;j++) s+=matrix[i][j]*draw[j];
      scores[i][sample]=s;sums[i]+=s;order[i]=i;
    }
    // Insertion sort avoids allocating 200,000 temporary rank arrays.
    for(let i=1;i<n;i++) {
      const key=order[i],value=scores[key][sample];let k=i-1;
      while(k>=0 && scores[order[k]][sample]<value) {order[k+1]=order[k];k--;}
      order[k+1]=key;
    }
    let rank=1;
    for(let k=0;k<n;k++) {
      if(k && scores[order[k]][sample]!==scores[order[k-1]][sample]) rank=k+1;
      rankCounts[order[k]][rank-1]++;
    }
    if((sample+1)%10000===0) onProgress(.02+.58*(sample+1)/N);
  }
  const cornerWeights=vertices(data.criteria),pairs=[];
  const sorted=methods.wsmRanking.order;
  for(let ai=0;ai<n;ai++) for(let bi=ai+1;bi<n;bi++) {
    const a=sorted[ai],b=sorted[bi];let min=Infinity,max=-Infinity;
    for(const w of cornerWeights) {let gap=0;for(let j=0;j<m;j++) gap+=w[j]*(matrix[a][j]-matrix[b][j]);min=Math.min(min,gap);max=Math.max(max,gap);}
    pairs.push({aIndex:a,bIndex:b,min,max});
  }
  const cache={data,matrix,weights,methods,margin,scores,sums,rankCounts,pairs,vertexCount:cornerWeights.length};
  return reclassify(cache,data.p,data.delta,{onProgress,valueStart:.6});
}

/** p/delta only: reuse exactly the same score samples; no new random draws. */
export function reclassify(cache,p=.9,delta=null,{onProgress=()=>{},valueStart=0}={}) {
  probability(p); tolerance(delta);
  if(!cache?.scores || !cache?.data) throw new Error('请先完成一次分析。');
  const {data,matrix,weights,methods,margin,scores,sums,rankCounts}=cache;
  const N=data.sampleCount,n=data.suppliers.length,d=delta??margin.value,q=(1-p)/2;
  const suppliers=data.suppliers.map((s,i)=>{
    const work=scores[i].slice();
    return {id:s.id,name:s.name,baseline:methods.wsm[i],wsmRank:methods.wsmRanking.ranks[i],topsis:methods.topsis[i],topsisRank:methods.topsisRanking.ranks[i],vikor:methods.vikor[i],vikorRank:methods.vikorRanking.ranks[i],mean:sums[i]/N,lo:quantile(work,q),hi:quantile(work,1-q),score5:quantile(work,.05),score95:quantile(work,.95),rsi:rankCounts[i][methods.wsmRanking.ranks[i]-1]/N,rankProb:Array.from(rankCounts[i],x=>x/N)};
  });
  const pairs=[],work=new Float64Array(N);
  for(let k=0;k<cache.pairs.length;k++) {
    const pair=cache.pairs[k],a=pair.aIndex,b=pair.bIndex;
    let positive=0,tied=0,reverse=0,within=0,sampleMin=Infinity,sampleMax=-Infinity;
    for(let sample=0;sample<N;sample++) {
      const difference=scores[a][sample]-scores[b][sample];work[sample]=difference;
      if(difference>0) positive++;else if(difference<0) reverse++;else tied++;
      if(Math.abs(difference)<=d) within++;
      sampleMin=Math.min(sampleMin,difference);sampleMax=Math.max(sampleMax,difference);
    }
    const counts=new Uint32Array(sampleMin===sampleMax?1:40),width=(sampleMax-sampleMin)/counts.length;
    for(const difference of work) counts[width>0?Math.min(counts.length-1,Math.floor((difference-sampleMin)/width)):0]++;
    const histogram=Array.from(counts,(count,bin)=>({left:sampleMin+bin*width,right:sampleMin+(bin+1)*width,probability:count/N}));
    const lo=quantile(work,q),hi=quantile(work,1-q);
    pairs.push({a:data.suppliers[a].id,b:data.suppliers[b].id,prob:positive/N,probTie:tied/N,probReverse:reverse/N,within:within/N,lo,hi,min:pair.min,max:pair.max,status:classify(lo,hi,d),histogram});
    onProgress(valueStart+(1-valueStart)*(k+1)/cache.pairs.length);
  }
  const result={
    sorted:methods.wsmRanking.order.map(i=>data.suppliers[i].id),suppliers,pairs,weights:[...weights],normalized:matrix.map(row=>[...row]),criteria:data.criteria.map(c=>({...c})),delta:d,defaultDelta:margin.value,deltaImpacts:margin.impacts,p,sampleCount:N,seed:data.seed,
    engine:{name:'ADAPT / NumPy-compatible PCG64',version:'1.0.0',rng:'PCG64 XSL-RR 128/64',numpySeedCompatible:true,seed:data.seed,sampleCount:N,measure:'独立均匀抽取原始区间权重，再归一化；不是归一化权重域上的均匀测度。',interval:'同一批权重样本下得分差的中央概率区间；不是均值的置信区间。',rankTies:'competition：相同得分共享名次；显示顺序保留输入顺序。',vertexCount:cache.vertexCount,exactBounds:'枚举原始区间盒的全部 2^准则数 端点，再归一化，求线性分式得分差的精确上下界。',defaultDeltaFallback:margin.fallback,notes:margin.fallback?['所有准则评分均无差异，默认容差回退为 0.01。']:[],normalization:'成本 min/x，效益 x/max；权重为归一化三角重心。',scoreIntervalProbability:p},
  };
  return {result,cache};
}
