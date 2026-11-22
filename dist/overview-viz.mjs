import {t,getLocale} from './i18n.mjs';

const instances=new WeakMap();
let tooltipNumber=0;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const number=(value,digits=2)=>value!==0&&Math.abs(value)<10**(-digits)?value.toExponential(2):value.toFixed(digits);
const methodValue=(supplier,method)=>supplier[method==='wsm'?'baseline':method];
const methodRank=(supplier,method)=>supplier[method==='wsm'?'wsmRank':method==='topsis'?'topsisRank':'vikorRank'];
const shownScore=(value,method)=>finite(value)?number(method==='vikor'?value:value*100,method==='vikor'?3:2):'—';
const rankLabel=rank=>t(`第 ${rank} 名`,`Rank ${rank}`);
const nameOf=supplier=>String(supplier.name??supplier.id??'');

function niceStep(value){
  const power=10**Math.floor(Math.log10(value));
  return [1,2,2.5,5,10].find(step=>step*power>=value-1e-12)*power;
}

function scoreAxis(suppliers,method){
  const values=[];
  for(const supplier of suppliers){
    const value=methodValue(supplier,method);
    if(finite(value))values.push(value);
    if(method==='wsm'&&finite(supplier.score5)&&finite(supplier.score95)&&supplier.score5<=supplier.score95)values.push(supplier.score5,supplier.score95);
  }
  if(!values.length)return {min:0,max:1,ticks:[0,.5,1]};
  const minimum=Math.min(...values),maximum=Math.max(...values),span=maximum-minimum;
  const padding=Math.max(span*.12,.015),center=(minimum+maximum)/2;
  const low=Math.max(0,span<.06?center-.04:minimum-padding);
  const high=Math.min(Math.max(1,maximum),span<.06?center+.04:maximum+padding);
  const step=niceStep(Math.max(high-low,.02)/3);
  let min=Math.max(0,Math.floor((low+1e-12)/step)*step);
  let max=Math.min(Math.max(1,maximum),Math.ceil((high-1e-12)/step)*step);
  if(max-min<1e-12){min=Math.max(0,minimum-.05);max=Math.max(min+.05,maximum);}
  min=Number(min.toPrecision(12));max=Number(max.toPrecision(12));
  const ticks=[];
  for(let value=min;value<=max+step*1e-8;value+=step)ticks.push(Number(value.toPrecision(12)));
  if(max-ticks.at(-1)>step*1e-6)ticks.push(max);
  return {min,max,ticks};
}

function axisLabel(value,method){
  return new Intl.NumberFormat(getLocale(),{maximumFractionDigits:method==='vikor'?3:2,useGrouping:false}).format(method==='vikor'?value:value*100);
}

function exactPercent(value){
  const percent=value*100;
  if(percent>0&&percent<.000001)return `${percent.toExponential(4)}%`;
  if(percent<100&&100-percent<.000001)return `${percent.toPrecision(15)}%`;
  return `${new Intl.NumberFormat(getLocale(),{maximumFractionDigits:6,useGrouping:false}).format(percent)}%`;
}

function cellPercent(value){
  if(!finite(value)||value<0||value>1)return '—';
  if(value===0)return '0';
  if(value===1)return '100';
  if(value<.001)return '&lt;0.1';
  if(value>.999)return '&gt;99.9';
  return (value*100).toFixed(1).replace(/\.0$/,'');
}

function probabilityStyle(probability){
  if(!finite(probability)||probability<0||probability>1)return '';
  const level=Math.sqrt(probability),start=[245,248,253],end=[36,88,213];
  const channels=start.map((value,index)=>Math.round(value+level*(end[index]-value)));
  const luminance=rgb=>rgb.map(value=>{const channel=value/255;return channel<=.04045?channel/12.92:((channel+.055)/1.055)**2.4;}).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
  const light=luminance(channels),ink=luminance([20,37,66]);
  const whiteContrast=1.05/(light+.05),inkContrast=(light+.05)/(ink+.05);
  const color=Math.max(whiteContrast,inkContrast)<4.5?'#000':whiteContrast>inkContrast?'#fff':'#142542';
  return `background:rgb(${channels.join(',')});color:${color}`;
}

function begin(container,className){
  if(!container?.ownerDocument)throw new TypeError(t('图表需要有效的容器。','A valid chart container is required.'));
  const focused=container.contains(container.ownerDocument.activeElement)?container.ownerDocument.activeElement:null;
  instances.get(container)?.destroy();
  container.classList.add(className);
  const doc=container.ownerDocument,view=doc.defaultView,listeners=[];
  const tooltip=doc.createElement('div');
  tooltip.id=`overview-viz-tooltip-${++tooltipNumber}`;
  tooltip.className='ov-viz-tooltip';tooltip.dataset.vizTooltip='';tooltip.role='tooltip';tooltip.hidden=true;
  doc.body.append(tooltip);
  let anchor=null,pinned=false,destroyed=false;
  const on=(node,event,handler,options)=>{node.addEventListener(event,handler,options);listeners.push(()=>node.removeEventListener(event,handler,options));};
  function hide(){
    anchor?.removeAttribute('aria-describedby');anchor?.classList.remove('is-inspected');
    anchor=null;pinned=false;tooltip.hidden=true;
  }
  function show(target,markup){
    if(destroyed||!target?.isConnected)return;
    if(anchor!==target){anchor?.removeAttribute('aria-describedby');anchor?.classList.remove('is-inspected');}
    anchor=target;target.setAttribute('aria-describedby',tooltip.id);target.classList.add('is-inspected');
    tooltip.innerHTML=markup;tooltip.hidden=false;
    const bounds=target.getBoundingClientRect(),size=tooltip.getBoundingClientRect();
    const width=doc.documentElement.clientWidth,height=view.innerHeight;
    const top=bounds.top-size.height-9>=8?bounds.top-size.height-9:Math.min(height-size.height-8,bounds.bottom+9);
    tooltip.style.left=`${Math.max(8,Math.min(bounds.left+bounds.width/2-size.width/2,width-size.width-8))}px`;
    tooltip.style.top=`${Math.max(8,top)}px`;
  }
  function inspect(selector,describe){
    const targetOf=event=>event.target.closest?.(selector);
    on(container,'pointerover',event=>{const target=targetOf(event);if(target&&event.pointerType!=='touch'){pinned=false;show(target,describe(target));}});
    on(container,'pointerdown',event=>{const target=targetOf(event);if(target&&event.pointerType==='touch'){pinned=true;show(target,describe(target));}});
    on(container,'pointerleave',()=>{if(!pinned&&!container.contains(doc.activeElement))hide();});
    on(container,'focusin',event=>{const target=targetOf(event);if(target)view.requestAnimationFrame(()=>show(target,describe(target)));});
    on(container,'focusout',event=>{if(!container.contains(event.relatedTarget))hide();});
    on(container,'click',event=>{const target=targetOf(event);if(target)show(target,describe(target));});
    on(doc,'pointerdown',event=>{if(!container.contains(event.target)&&!tooltip.contains(event.target))hide();});
    on(doc,'keydown',event=>{if(event.key==='Escape')hide();});
    on(view,'scroll',hide,true);on(view,'resize',hide);
  }
  const instance={focused,on,inspect,hide,show,destroy(){
    destroyed=true;hide();for(const remove of listeners)remove();tooltip.remove();container.classList.remove(className);
    if(instances.get(container)===instance)instances.delete(container);
  }};
  instances.set(container,instance);
  return instance;
}

/** Purely presentational: input values, ranks and probability arrays are never changed. */
export function renderScorePlot(container,suppliers,method='wsm'){
  if(!['wsm','topsis','vikor'].includes(method))method='wsm';
  const instance=begin(container,'ov-score-viz'),previous=instance.focused?.closest('[data-score-supplier]')?.dataset.scoreSupplier;
  const rows=[...(Array.isArray(suppliers)?suppliers:[])].sort((a,b)=>{
    const av=methodValue(a,method),bv=methodValue(b,method);
    if(!finite(av))return finite(bv)?1:0;if(!finite(bv))return -1;
    return method==='vikor'?av-bv:bv-av;
  });
  if(!rows.length){container.innerHTML=`<p class="ov-viz-empty">${t('暂无供应商数据。','No supplier data.')}</p>`;return instance;}
  const axis=scoreAxis(rows,method),position=value=>Math.max(0,Math.min(100,(value-axis.min)/(axis.max-axis.min)*100));
  const hasRanges=method==='wsm'&&rows.some(row=>finite(row.score5)&&finite(row.score95)&&row.score5<=row.score95);
  const unit=method==='vikor'?t('指数','index'):t('分','points');
  const axisDescription=t(`评分轴 ${axisLabel(axis.min,method)}–${axisLabel(axis.max,method)} ${unit}`,`Score axis ${axisLabel(axis.min,method)}–${axisLabel(axis.max,method)} ${unit}`);
  container.dataset.axisMin=axis.min;container.dataset.axisMax=axis.max;container.dataset.method=method;
  const grid=axis.ticks.map(value=>`<span class="ov-score-gridline" style="left:${position(value)}%"></span>`).join('');
  container.innerHTML=`<div class="ov-score-caption"><span>${axisDescription}</span><span>${method==='vikor'?t('低值优先','Lower is better'):t('高值优先','Higher is better')}</span></div>
    <div class="ov-score-scroll">
    <div class="ov-score-axis-row" aria-hidden="true"><span>${t('供应商','Supplier')}</span><div class="ov-score-axis">${axis.ticks.map(value=>`<span style="left:${position(value)}%">${axisLabel(value,method)}</span>`).join('')}</div><span class="ov-score-value-heading">${method==='vikor'?'VIKOR':t('评分','Score')}</span></div>
    <div class="ov-score-rows" role="list" aria-label="${escape(t(`${method.toUpperCase()}供应商得分比较`,`${method.toUpperCase()} supplier scores`))}">
      ${rows.map((supplier,index)=>{
        const value=methodValue(supplier,method),range=method==='wsm'&&finite(supplier.score5)&&finite(supplier.score95)&&supplier.score5<=supplier.score95;
        const name=nameOf(supplier),rank=methodRank(supplier,method),label=`${name} · ${shownScore(value,method)} ${unit}${range?` · ${t('90% 评分范围','90% score range')} ${shownScore(supplier.score5,method)}–${shownScore(supplier.score95,method)} ${unit}`:''}`;
        return `<div class="ov-score-row${rank===1?' is-leader':''}" role="listitem" tabindex="${previous?String(supplier.id)===previous?'0':'-1':index===0?'0':'-1'}" data-score-supplier="${escape(supplier.id)}" data-method="${method}" data-value="${finite(value)?value:''}"${range?` data-range-low="${supplier.score5}" data-range-high="${supplier.score95}"`:''} aria-label="${escape(label)}">
          <span class="ov-score-name" title="${escape(name)}"><span class="ov-score-rank">${rank??'—'}</span><span>${escape(name)}</span></span>
          <div class="ov-score-track" data-axis-track data-axis-min="${axis.min}" data-axis-max="${axis.max}" aria-hidden="true">${grid}${range?`<span class="ov-score-interval" data-range-low="${supplier.score5}" data-range-high="${supplier.score95}" style="left:${position(supplier.score5)}%;width:${position(supplier.score95)-position(supplier.score5)}%"></span><span class="ov-score-cap ov-score-cap-low" style="left:${position(supplier.score5)}%"></span><span class="ov-score-cap ov-score-cap-high" style="left:${position(supplier.score95)}%"></span>`:''}${finite(value)?`<span class="ov-score-dot" style="left:${position(value)}%"></span>`:''}</div>
          <span class="ov-score-value">${shownScore(value,method)}</span>
        </div>`;
      }).join('')}
    </div></div><div class="ov-score-legend"><span><i class="ov-score-key-dot"></i>${t('当前评分','Current score')}</span>${hasRanges?`<span><i class="ov-score-key-range"></i>${t('90% 评分范围','90% score range')}</span>`:''}</div>`;
  const byId=new Map(rows.map(row=>[String(row.id),row]));
  instance.inspect('[data-score-supplier]',target=>{
    const supplier=byId.get(target.dataset.scoreSupplier),value=methodValue(supplier,method),range=method==='wsm'&&finite(supplier.score5)&&finite(supplier.score95)&&supplier.score5<=supplier.score95;
    return `<strong>${escape(nameOf(supplier))}</strong><dl><div><dt>${t('当前评分','Current score')}</dt><dd>${shownScore(value,method)} ${unit}</dd></div>${range?`<div><dt>${t('90% 评分范围','90% score range')}</dt><dd>${shownScore(supplier.score5,method)}–${shownScore(supplier.score95,method)} ${unit}</dd></div>`:''}<div><dt>${t('原排名','Baseline rank')}</dt><dd>${methodRank(supplier,method)??'—'}</dd></div></dl>`;
  });
  const targets=[...container.querySelectorAll('[data-score-supplier]')];
  instance.on(container,'focusin',event=>{
    const target=event.target.closest('[data-score-supplier]');
    if(target)targets.forEach(row=>row.tabIndex=row===target?0:-1);
  });
  instance.on(container,'keydown',event=>{
    const index=targets.indexOf(event.target.closest('[data-score-supplier]'));
    if(index<0)return;
    const next={ArrowUp:Math.max(0,index-1),ArrowDown:Math.min(targets.length-1,index+1),Home:0,End:targets.length-1}[event.key];
    if(next===undefined)return;event.preventDefault();
    targets.forEach((target,i)=>target.tabIndex=i===next?0:-1);targets[next].focus({preventScroll:true});targets[next].scrollIntoView({block:'nearest',inline:'nearest'});
  });
  if(instance.focused)(targets.find(target=>target.dataset.scoreSupplier===previous)??targets[0]).focus({preventScroll:true});
  return instance;
}

export function renderRankMap(container,suppliers){
  const instance=begin(container,'ov-rank-viz');
  const previous=instance.focused?.closest('[data-rank-supplier]');
  const previousId=previous?.dataset.rankSupplier,previousRank=previous?.dataset.rank;
  const rows=[...(Array.isArray(suppliers)?suppliers:[])].sort((a,b)=>b.baseline-a.baseline),n=rows.length;
  if(!n){container.innerHTML=`<p class="ov-viz-empty">${t('暂无名次数据。','No rank data.')}</p>`;return instance;}
  container.innerHTML=`<div class="ov-rank-caption"><span>${t('各名次出现比例（%）','Frequency at each rank (%)')}</span><span class="ov-rank-scale" aria-hidden="true"><span>0</span><i></i><span>100</span></span></div>
    <div class="ov-rank-scroll" role="region" aria-label="${t('名次出现比例','Rank probability distribution')}">
      <table class="ov-rank-table" style="min-width:${168+n*42}px" aria-label="${t('供应商名次分布，数值为百分比','Supplier rank distribution, values in percent')}">
        <colgroup><col style="width:168px">${Array.from({length:n},()=>'<col>').join('')}</colgroup>
        <thead><tr><th scope="col" class="ov-rank-corner">${t('供应商 / 名次','Supplier / rank')}</th>${Array.from({length:n},(_,index)=>`<th scope="col" data-rank-heading="${index+1}" aria-label="${rankLabel(index+1)}">${index+1}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((supplier,row)=>`<tr><th scope="row" title="${escape(nameOf(supplier))}"><span>${escape(nameOf(supplier))}</span></th>${Array.from({length:n},(_,col)=>{
          const probability=supplier.rankProb?.[col],valid=finite(probability)&&probability>=0&&probability<=1;
          const label=`${nameOf(supplier)} · ${rankLabel(col+1)} · ${valid?exactPercent(probability):t('暂无数据','No data')}`;
          const selected=previousId?String(supplier.id)===previousId&&String(col+1)===previousRank:row===0&&col===0;
          return `<td><button type="button" class="ov-rank-cell${probability===0?' is-zero':''}" tabindex="${selected?'0':'-1'}" data-rank-supplier="${escape(supplier.id)}" data-rank="${col+1}" data-row="${row}"${valid?` data-probability="${probability}"`:''} style="${probabilityStyle(probability)}" aria-label="${escape(label)}">${cellPercent(probability)}</button></td>`;
        }).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>`;
  const byId=new Map(rows.map(row=>[String(row.id),row]));
  instance.inspect('[data-rank-supplier]',target=>{
    const supplier=byId.get(target.dataset.rankSupplier),rank=Number(target.dataset.rank),value=supplier.rankProb?.[rank-1];
    return `<strong>${escape(nameOf(supplier))}</strong><dl><div><dt>${rankLabel(rank)}</dt><dd>${finite(value)?exactPercent(value):t('暂无数据','No data')}</dd></div></dl>`;
  });
  const targets=[...container.querySelectorAll('[data-rank-supplier]')];
  instance.on(container,'focusin',event=>{
    const target=event.target.closest('[data-rank-supplier]');
    if(target)targets.forEach(button=>button.tabIndex=button===target?0:-1);
  });
  instance.on(container,'keydown',event=>{
    const target=event.target.closest('[data-rank-supplier]');if(!target)return;
    const row=Number(target.dataset.row),col=Number(target.dataset.rank)-1;
    let next;
    if(event.key==='ArrowLeft')next=row*n+Math.max(0,col-1);
    if(event.key==='ArrowRight')next=row*n+Math.min(n-1,col+1);
    if(event.key==='ArrowUp')next=Math.max(0,row-1)*n+col;
    if(event.key==='ArrowDown')next=Math.min(n-1,row+1)*n+col;
    if(event.key==='Home')next=event.ctrlKey?0:row*n;
    if(event.key==='End')next=event.ctrlKey?targets.length-1:row*n+n-1;
    if(next===undefined)return;event.preventDefault();
    targets.forEach((button,index)=>button.tabIndex=index===next?0:-1);targets[next].focus({preventScroll:true});targets[next].scrollIntoView({block:'nearest',inline:'nearest'});
  });
  if(instance.focused)(targets.find(target=>target.dataset.rankSupplier===previousId&&target.dataset.rank===previousRank)??targets[0]).focus({preventScroll:true});
  return instance;
}
