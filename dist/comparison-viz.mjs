/** Evidence-only comparison charts. All scores and feasible bounds come from the caller. */
import {t,getLocale} from './i18n.mjs';

const instances=new WeakMap();
let sequence=0;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const clamp=(value,low,high)=>Math.max(low,Math.min(high,value));
const number=(value,digits=2)=>{
  if(value!==0&&Number(value.toFixed(digits))===0)return value.toExponential(2).replace(/\.?0+e/,'e').replace('e-','e−');
  return Number(value).toLocaleString(getLocale(),{maximumFractionDigits:digits});
};
const percent=(value,digits=1)=>`${number(value*100,digits)}%`;
const score=value=>{
  const points=value*100;
  const rounded=Number(points.toPrecision(5));
  return `${rounded>0?'+':''}${number(Object.is(rounded,-0)?0:rounded,8)}`;
};
const points=value=>`${score(value)} ${t('分','pts')}`;
const axisScore=value=>Math.abs(value*100)>0&&Math.abs(value*100)<.001
  ?`${value>0?'+':''}${(value*100).toExponential(2).replace(/\.?0+e/,'e').replace('e-','e−')}`:score(value);
const interval=(low,high)=>low===high?points(low):`${score(low)} — ${score(high)} ${t('分','pts')}`;
const instruction=()=>t('使用左右方向键查看数据，Home 和 End 跳至两端；按 Tab 查看各范围。','Use Left and Right arrows to inspect data, Home and End for the endpoints, and Tab for the ranges.');

function button(key,kind,label,value){
  return `<button type="button" class="comparison-viz__key" data-viz-feature="${key}" aria-pressed="false"><span class="comparison-viz__swatch comparison-viz__swatch--${kind}" aria-hidden="true"></span><span>${esc(label)}<strong>${esc(value)}</strong></span></button>`;
}

function mount(container,kind,markup){
  if(!container||typeof container.replaceChildren!=='function')throw new TypeError('A chart container is required.');
  instances.get(container)?.destroy();
  const id=`comparison-viz-${++sequence}`;
  container.innerHTML=`<div class="comparison-viz comparison-viz--${kind}">${markup(id)}</div>`;
  const root=container.firstElementChild,svg=root.querySelector('svg'),detail=root.querySelector('[data-viz-detail]');
  const controller=new AbortController();
  let observer=null;
  const instance={
    root,svg,detail,id,
    on(target,event,handler){target.addEventListener(event,handler,{signal:controller.signal});},
    observe(draw){
      let width=-1;
      const update=()=>{const next=root.getBoundingClientRect().width;if(Math.abs(next-width)<1)return;width=next;draw();};
      if(typeof ResizeObserver!=='undefined'){observer=new ResizeObserver(update);observer.observe(root);}
      update();
    },
    show(key,label,value,description=''){
      root.querySelectorAll('button[data-viz-feature]').forEach(control=>control.setAttribute('aria-pressed',String(control.dataset.vizFeature===key)));
      detail.dataset.idle='false';detail.removeAttribute('aria-hidden');
      detail.innerHTML=`<span class="comparison-viz__detail-label">${esc(label)}</span><strong>${esc(value)}</strong>${description?`<span class="comparison-viz__detail-note" title="${esc(description)}">${esc(description)}</span>`:''}`;
    },
    destroy(){
      controller.abort();observer?.disconnect();
      if(instances.get(container)===instance){instances.delete(container);container.replaceChildren();}
    },
  };
  instances.set(container,instance);
  return instance;
}

function chartWidth(root){return Math.max(260,Math.min(1600,root.getBoundingClientRect().width||760));}
function coordinate(svg,event,width){return (event.clientX-svg.getBoundingClientRect().left)/svg.getBoundingClientRect().width*width;}
function ticks(low,high,count){
  const raw=(high-low)/count;
  if(!(raw>0)||!Number.isFinite(raw))return [low];
  const power=10**Math.floor(Math.log10(raw));
  if(!(power>0))return [low,high];
  const fraction=raw/power;
  const multiple=[1,2,2.5,5,10].reduce((best,value)=>Math.abs(Math.log(value/fraction))<Math.abs(Math.log(best/fraction))?value:best,1);
  const step=multiple*power,start=Math.ceil(low/step-1e-10)*step,values=[];
  for(let index=0;index<20;index++){
    const value=start+index*step;if(value>high+step*1e-10)break;
    values.push(Math.abs(value)<step*1e-10?0:Number(value.toPrecision(12)));
  }
  return values;
}
function rangeRail(low,high,y,x,kind,key){
  const left=x(low),right=x(high);
  return `<g data-viz-${key} data-viz-hit="${key}"><line class="comparison-viz__rail comparison-viz__rail--${kind}" x1="${left}" x2="${right}" y1="${y}" y2="${y}"/><path class="comparison-viz__rail-cap comparison-viz__rail-cap--${kind}" d="M${left},${y-4}v8M${right},${y-4}v8"/><rect class="comparison-viz__hit" x="${left-6}" y="${y-10}" width="${Math.max(12,right-left+12)}" height="20"/></g>`;
}

/** pair is the existing oriented engine result; score units remain 0–1 internally. */
export function renderPairHistogram(container,{pair,aName='A',bName='B',delta,coverage,currentGap}={}){
  if(!pair||![pair.min,pair.max,pair.lo,pair.hi,delta,coverage].every(finite)||pair.min>pair.max||pair.lo>pair.hi||delta<0||coverage<0||coverage>1)throw new TypeError('Invalid pair chart evidence.');
  const histogram=Array.isArray(pair.histogram)?pair.histogram:[];
  if(histogram.some(bin=>!bin||![bin.left,bin.right,bin.probability].every(finite)||bin.left>bin.right||bin.probability<0||bin.probability>1))throw new TypeError('Invalid histogram evidence.');
  const coverageLabel=t(`${percent(coverage)} 情景范围`,`${percent(coverage)} scenario interval`);
  const positive=finite(pair.prob)?pair.prob:null;
  const negative=finite(pair.probReverse)?pair.probReverse:finite(pair.prob)&&finite(pair.probTie)?1-pair.prob-pair.probTie:null;
  const instance=mount(container,'pair',id=>`
    <div class="comparison-viz__outcomes"><span title="${esc(bName)}"><b aria-hidden="true">← B</b> ${t('得分更高','scores higher')}${negative!==null?`<strong>${percent(negative,2)}</strong>`:''}</span>${finite(pair.probTie)&&pair.probTie>0?`<span class="comparison-viz__tie">${t('同分','Tied')} <strong>${percent(pair.probTie,2)}</strong></span>`:''}<span title="${esc(aName)}"><b aria-hidden="true">A →</b> ${t('得分更高','scores higher')}${positive!==null?`<strong>${percent(positive,2)}</strong>`:''}</span></div>
    <svg class="comparison-viz__plot" tabindex="0" role="slider" aria-orientation="horizontal" aria-label="${esc(t(`${aName}减${bName}的评分差情景分布`, `Scenario distribution of ${aName} minus ${bName} score`))}" aria-valuemin="1" aria-valuemax="${Math.max(1,histogram.length)}" aria-valuenow="1" aria-describedby="${id}-keys ${id}-detail"></svg>
    <div class="comparison-viz__legend" role="group" aria-label="${t('图例与范围','Legend and ranges')}">
      ${button('central','central',coverageLabel,interval(pair.lo,pair.hi))}
      ${button('feasible','feasible',t('全部允许设置','All allowed settings'),interval(pair.min,pair.max))}
      ${button('tolerance','tolerance',t('可接受差异','Tolerance'),`±${number(delta*100,6)} ${t('分','pts')}`)}
      ${finite(currentGap)?button('current','current',t('当前评分差','Current score gap'),points(currentGap)):''}
    </div><output id="${id}-detail" class="comparison-viz__detail" data-viz-detail data-idle="true" aria-hidden="true" aria-live="polite"></output>
    <span id="${id}-keys" class="comparison-viz__sr">${instruction()}</span>`);
  const {root,svg}=instance;
  const binCount=histogram.length;
  let index=binCount?histogram.reduce((best,bin,i)=>bin.probability>histogram[best].probability?i:best,0):0;
  let selected='central';
  let min=Math.min(pair.min,pair.lo,-delta,0,...histogram.map(bin=>bin.left),finite(currentGap)?currentGap:0);
  let max=Math.max(pair.max,pair.hi,delta,0,...histogram.map(bin=>bin.right),finite(currentGap)?currentGap:0);
  const padding=(max-min||.02)*.08;min-=padding;max+=padding;
  const peak=Math.max(...histogram.map(bin=>bin.probability),.001);

  function binText(){const bin=histogram[index];return bin?`${interval(bin.left,bin.right)}; ${t('情景占比','scenario share')} ${percent(bin.probability,3)}`:t('没有分布数据','No histogram data');}
  function show(feature){
    selected=feature;
    if(feature==='bin'){
      const bin=histogram[index];if(!bin)return;
      instance.show('',t('情景评分差','Scenario score gap'),interval(bin.left,bin.right),t(`该区间占 ${percent(bin.probability,3)} 情景`,`This bin contains ${percent(bin.probability,3)} of scenarios`));
    }else if(feature==='central')instance.show(feature,coverageLabel,interval(pair.lo,pair.hi),t('中间情景的评分差范围','Central scenario score-gap interval'));
    else if(feature==='feasible')instance.show(feature,t('全部允许设置','All allowed settings'),interval(pair.min,pair.max),t('精确可行评分差范围','Exact feasible score-gap range'));
    else if(feature==='tolerance')instance.show(feature,t('可接受差异','Tolerance'),`±${number(delta*100,6)} ${t('分','pts')}`,finite(pair.within)?t(`${percent(pair.within,2)} 情景在此范围内`,`${percent(pair.within,2)} of scenarios fall within this band`):'');
    else if(feature==='current'&&finite(currentGap))instance.show(feature,t('当前评分差','Current score gap'),points(currentGap),currentGap===0?t('当前评分相同','Current scores are equal'):t(`${currentGap>0?aName:bName} 当前评分更高`,`${currentGap>0?aName:bName} currently scores higher`));
    svg.setAttribute('aria-valuenow',String(index+1));svg.setAttribute('aria-valuetext',binText());
    draw();
  }
  function draw(){
    const width=chartWidth(root),height=292,L=45,R=17,T=26,base=178;
    const x=value=>L+(value-min)/(max-min)*(width-L-R);
    svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
    const y=value=>base-value/peak*(base-T-12);
    const zero=x(0),bandLeft=x(-delta),bandRight=x(delta),tickCount=width<420?3:5;
    let markup=`<g aria-hidden="true"><text class="comparison-viz__axis-label" x="${L}" y="12">${t('情景占比','Scenario share')}</text>`;
    for(const value of [peak/2,peak])markup+=`<line class="comparison-viz__grid" x1="${L}" x2="${width-R}" y1="${y(value)}" y2="${y(value)}"/><text class="comparison-viz__tick" x="${L-8}" y="${y(value)+4}" text-anchor="end">${percent(value,1)}</text>`;
    markup+=`<g data-viz-tolerance data-viz-hit="tolerance"><rect class="comparison-viz__tolerance" x="${bandLeft}" y="${T}" width="${Math.max(1,bandRight-bandLeft)}" height="${base-T}"/><path class="comparison-viz__tolerance-edge" d="M${bandLeft},${T}V${base}M${bandRight},${T}V${base}"/></g>`;
    histogram.forEach((bin,i)=>{
      const left=x(bin.left),right=x(bin.right),pointMass=bin.left===bin.right,binWidth=pointMass?8:Math.max(.6,right-left-.7);
      const selectedBin=selected==='bin'&&index===i,center=(left+right)/2;
      const fill=bin.right<=0?'negative':bin.left>=0?'positive':'mixed';
      if(bin.left<0&&bin.right>0){
        markup+=`<rect class="comparison-viz__bin comparison-viz__bin--negative" x="${left+.35}" y="${y(bin.probability)}" width="${Math.max(.1,zero-left-.35)}" height="${base-y(bin.probability)}"/><rect class="comparison-viz__bin comparison-viz__bin--positive" x="${zero}" y="${y(bin.probability)}" width="${Math.max(.1,right-zero-.35)}" height="${base-y(bin.probability)}"/>`;
      }else markup+=`<rect class="comparison-viz__bin comparison-viz__bin--${fill}" x="${pointMass?center-4:left+.35}" y="${y(bin.probability)}" width="${binWidth}" height="${base-y(bin.probability)}"/>`;
      if(selectedBin)markup+=`<rect class="comparison-viz__selection" x="${pointMass?center-6:left-1}" y="${y(bin.probability)-2}" width="${pointMass?12:Math.max(3,right-left+2)}" height="${Math.max(5,base-y(bin.probability)+3)}" rx="2"/>`;
      markup+=`<rect class="comparison-viz__hit" data-viz-bin="${i}" x="${pointMass?center-10:left}" y="${T}" width="${pointMass?20:Math.max(.6,right-left)}" height="${base-T}"/>`;
    });
    markup+=`<line class="comparison-viz__axis" x1="${L}" x2="${width-R}" y1="${base}" y2="${base}"/><line class="comparison-viz__zero" data-viz-zero x1="${zero}" x2="${zero}" y1="${T}" y2="${base+4}"/>`;
    for(const value of ticks(min,max,tickCount))if(Math.abs(x(value)-zero)>25)markup+=`<text class="comparison-viz__tick" x="${x(value)}" y="${base+18}" text-anchor="middle">${axisScore(value)}</text>`;
    markup+=`<text class="comparison-viz__zero-label" x="${zero}" y="${base+18}" text-anchor="middle">0</text><text class="comparison-viz__axis-label" x="${(L+width-R)/2}" y="${base+37}" text-anchor="middle">A − B ${t('（分）','(pts)')}</text>`;
    markup+=rangeRail(pair.lo,pair.hi,base+59,x,'central','central')+rangeRail(pair.min,pair.max,base+82,x,'feasible','feasible');
    if(finite(currentGap))markup+=`<g data-viz-current data-viz-hit="current"><line class="comparison-viz__current-line" x1="${x(currentGap)}" x2="${x(currentGap)}" y1="${T}" y2="${base}"/><path class="comparison-viz__current-marker" d="M${x(currentGap)-5},${T-4}L${x(currentGap)+5},${T-4}L${x(currentGap)},${T+3}Z"/><rect class="comparison-viz__hit" x="${x(currentGap)-7}" y="${T-9}" width="14" height="15"/></g>`;
    markup+='</g>';
    svg.innerHTML=markup;
  }
  instance.on(svg,'keydown',event=>{
    if(!binCount||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();index=event.key==='Home'?0:event.key==='End'?binCount-1:clamp(index+(event.key==='ArrowRight'?1:-1),0,binCount-1);show('bin');
  });
  instance.on(svg,'focus',()=>{if(binCount)show('bin');});
  instance.on(svg,'pointermove',event=>{
    const feature=event.target.closest('[data-viz-hit]')?.dataset.vizHit;
    if(feature){show(feature);return;}
    const bin=event.target.closest('[data-viz-bin]');if(bin){index=Number(bin.dataset.vizBin);show('bin');}
  });
  instance.on(svg,'click',event=>{const feature=event.target.closest('[data-viz-hit]')?.dataset.vizHit;const bin=event.target.closest('[data-viz-bin]');if(feature)show(feature);else if(bin){index=Number(bin.dataset.vizBin);show('bin');}});
  root.querySelectorAll('button[data-viz-feature]').forEach(control=>{
    const inspect=()=>show(control.dataset.vizFeature);
    instance.on(control,'focus',inspect);instance.on(control,'pointerenter',inspect);instance.on(control,'click',inspect);
  });
  svg.setAttribute('aria-valuenow',String(index+1));svg.setAttribute('aria-valuetext',binText());instance.observe(draw);
  return {destroy:()=>instance.destroy()};
}

/** Only draws the supplied one-dimensional score-gap path and app-computed feasible interval. */
export function renderSensitivityChart(container,{aName='A',bName='B',criterionName='',currentWeight,feasibleLow,feasibleHigh,intercept,slope,crossover=null,inPath=false,inDomain=false}={}){
  if(![currentWeight,feasibleLow,feasibleHigh,intercept,slope].every(finite)||currentWeight<0||currentWeight>1||feasibleLow<0||feasibleHigh>1||feasibleLow>feasibleHigh)throw new TypeError('Invalid sensitivity chart evidence.');
  const hasCrossover=inPath===true&&finite(crossover)&&crossover>=0&&crossover<=1;
  const xmax=Math.min(1,Math.max(feasibleHigh*1.2,currentWeight*1.4,.3,hasCrossover?crossover*1.08:0));
  const valueAt=weight=>intercept+slope*weight;
  const values=[valueAt(0),valueAt(xmax),0];
  let ymin=Math.min(...values),ymax=Math.max(...values);const pad=(ymax-ymin||.02)*.18;ymin-=pad;ymax+=pad;
  const instance=mount(container,'sensitivity',id=>`
    <svg class="comparison-viz__plot" tabindex="0" role="slider" aria-orientation="horizontal" aria-label="${esc(t(`${criterionName}权重与${aName}减${bName}的评分差`,`Score gap for ${aName} minus ${bName} as ${criterionName} weight changes`))}" aria-valuemin="0" aria-valuemax="${xmax*100}" aria-valuenow="${currentWeight*100}" aria-describedby="${id}-keys ${id}-detail"></svg>
    <div class="comparison-viz__legend" role="group" aria-label="${t('图例与范围','Legend and ranges')}">
      ${button('current','current',t('当前权重','Current weight'),percent(currentWeight,2))}
      ${button('feasible','path',t('允许调整范围','Feasible weight range'),`${percent(feasibleLow,2)} — ${percent(feasibleHigh,2)}`)}
      ${hasCrossover?button('crossover',inDomain?'crossover':'outside',t('评分相同点','Crossover'),percent(crossover,2)):button('path','extension',t('评分变化路径','Score-gap path'),t('无顺序变化点','No crossover'))}
    </div><output id="${id}-detail" class="comparison-viz__detail" data-viz-detail data-idle="true" aria-hidden="true" aria-live="polite"></output>
    <span id="${id}-keys" class="comparison-viz__sr">${instruction()}</span>`);
  const {root,svg}=instance;
  let inspected=currentWeight,selected='current',geometry;
  const isAllowed=weight=>weight>=feasibleLow-1e-12&&weight<=feasibleHigh+1e-12;
  function direction(gap){return Math.abs(gap)<1e-14?t('两家评分相同','The scores are equal'):t(`${gap>0?aName:bName} 得分更高`,`${gap>0?aName:bName} scores higher`);}
  function show(feature,weight){
    selected=feature;
    if(finite(weight))inspected=clamp(weight,0,xmax);
    if(feature==='current'){inspected=currentWeight;instance.show(feature,t('当前权重','Current weight'),`${percent(currentWeight,2)} · ${points(valueAt(currentWeight))}`,direction(valueAt(currentWeight)));}
    else if(feature==='feasible')instance.show(feature,t('允许调整范围','Feasible weight range'),`${percent(feasibleLow,2)} — ${percent(feasibleHigh,2)}`,t('蓝色实线为允许范围内的评分变化','The solid blue segment is within the feasible range'));
    else if(feature==='crossover'&&hasCrossover){inspected=crossover;instance.show(feature,t('评分相同点','Crossover'),`${percent(crossover,2)} · 0 ${t('分','pts')}`,inDomain?t('在允许调整范围内','Within the feasible range'):t('超出当前允许调整范围','Outside the current feasible range'));}
    else if(feature==='path')instance.show(feature,t('评分变化路径','Score-gap path'),t('没有评分相同点','No crossover'),t('虚线表示允许范围外的延伸','The dashed line extends outside the feasible range'));
    else instance.show('',t('权重 · 评分差','Weight · score gap'),`${percent(inspected,2)} · ${points(valueAt(inspected))}`,`${direction(valueAt(inspected))} · ${isAllowed(inspected)?t('允许范围内','Within feasible range'):t('允许范围外','Outside feasible range')}`);
    svg.setAttribute('aria-valuenow',String(inspected*100));
    svg.setAttribute('aria-valuetext',`${percent(inspected,2)}; ${points(valueAt(inspected))}; ${direction(valueAt(inspected))}`);
    draw();
  }
  function draw(){
    const width=chartWidth(root),height=width<420?275:266,L=57,R=20,T=26,B=44;
    const x=value=>L+value/xmax*(width-L-R),y=value=>T+(ymax-value)/(ymax-ymin)*(height-T-B),bottom=height-B;
    geometry={width,L,R,T,bottom,x};svg.setAttribute('viewBox',`0 0 ${width} ${height}`);
    let markup=`<g aria-hidden="true"><text class="comparison-viz__axis-label" x="${L}" y="12">A − B ${t('（分）','(pts)')}</text><g data-viz-feasible data-viz-hit="feasible"><rect class="comparison-viz__feasible-band" x="${x(feasibleLow)}" y="${T}" width="${Math.max(1,x(feasibleHigh)-x(feasibleLow))}" height="${bottom-T}"/><path class="comparison-viz__feasible-edge" d="M${x(feasibleLow)},${T}V${bottom}M${x(feasibleHigh)},${T}V${bottom}"/></g>`;
    for(const value of ticks(ymin,ymax,4))if(Math.abs(y(value)-y(0))>15)markup+=`<line class="comparison-viz__grid" x1="${L}" x2="${width-R}" y1="${y(value)}" y2="${y(value)}"/><text class="comparison-viz__tick" x="${L-9}" y="${y(value)+4}" text-anchor="end">${axisScore(value)}</text>`;
    markup+=`<line class="comparison-viz__zero" data-viz-zero x1="${L}" x2="${width-R}" y1="${y(0)}" y2="${y(0)}"/><text class="comparison-viz__zero-label" x="${L-9}" y="${y(0)+4}" text-anchor="end">0</text><path class="comparison-viz__path-extension" data-viz-path d="M${x(0)},${y(valueAt(0))}L${x(xmax)},${y(valueAt(xmax))}"/><path class="comparison-viz__path-feasible" d="M${x(feasibleLow)},${y(valueAt(feasibleLow))}L${x(feasibleHigh)},${y(valueAt(feasibleHigh))}"/>`;
    for(const value of ticks(0,xmax,width<420?3:5))markup+=`<text class="comparison-viz__tick" x="${x(value)}" y="${bottom+19}" text-anchor="middle">${percent(value,0)}</text>`;
    markup+=`<text class="comparison-viz__axis-label" x="${(L+width-R)/2}" y="${height-4}" text-anchor="middle">${t('指标评分权重','Criterion weight')}</text><g data-viz-current data-viz-hit="current"><line class="comparison-viz__current-line" x1="${x(currentWeight)}" x2="${x(currentWeight)}" y1="${T}" y2="${bottom}"/><circle class="comparison-viz__current-point" cx="${x(currentWeight)}" cy="${y(valueAt(currentWeight))}" r="5"/><circle class="comparison-viz__hit" cx="${x(currentWeight)}" cy="${y(valueAt(currentWeight))}" r="13"/></g>`;
    if(hasCrossover){const cx=x(crossover),cy=y(0);markup+=`<g data-viz-crossover data-viz-hit="crossover" data-viz-in-domain="${inDomain}"><path class="comparison-viz__crossover${inDomain?'':' comparison-viz__crossover--outside'}" d="M${cx},${cy-6}L${cx+6},${cy}L${cx},${cy+6}L${cx-6},${cy}Z"/><circle class="comparison-viz__hit" cx="${cx}" cy="${cy}" r="14"/></g>`;}
    if(selected==='inspect')markup+=`<line class="comparison-viz__inspect-line" x1="${x(inspected)}" x2="${x(inspected)}" y1="${T}" y2="${bottom}"/><circle class="comparison-viz__inspect-point" cx="${x(inspected)}" cy="${y(valueAt(inspected))}" r="4"/>`;
    svg.innerHTML=markup+'</g>';
  }
  instance.on(svg,'keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
    event.preventDefault();const step=xmax/(event.shiftKey?10:100);
    show('inspect',event.key==='Home'?0:event.key==='End'?xmax:inspected+(event.key==='ArrowRight'?step:-step));
  });
  instance.on(svg,'focus',()=>show('inspect',inspected));
  function inspectPointer(event){
    const feature=event.target.closest('[data-viz-hit]')?.dataset.vizHit;
    if(feature==='current'||feature==='crossover'){show(feature);return;}
    const {width,L,R}=geometry,position=coordinate(svg,event,width);
    if(position>=L&&position<=width-R)show('inspect',(position-L)/(width-L-R)*xmax);
  }
  instance.on(svg,'pointermove',inspectPointer);instance.on(svg,'click',inspectPointer);
  root.querySelectorAll('button[data-viz-feature]').forEach(control=>{
    const inspect=()=>show(control.dataset.vizFeature);
    instance.on(control,'focus',inspect);instance.on(control,'pointerenter',inspect);instance.on(control,'click',inspect);
  });
  svg.setAttribute('aria-valuetext',`${percent(currentWeight,2)}; ${points(valueAt(currentWeight))}; ${direction(valueAt(currentWeight))}`);instance.observe(draw);
  return {destroy:()=>instance.destroy()};
}
