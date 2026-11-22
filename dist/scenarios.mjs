/** Procurement scenario configurations and comparison UI. No storage or network. */
import {t,translateSystemText} from './i18n.mjs';

export const MAX_SCENARIOS = 6;
export const MAX_COMPARE = 3;
const NAME_LIMIT = 80;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const clone = value => structuredClone(value);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const displayScore = value => (value * 100).toFixed(2);
const fold = value => value.normalize('NFKC').toLocaleLowerCase();

function cleanName(value) {
  if (typeof value !== 'string') throw new Error(t("请填写方案名称。", "Enter a scenario name."));
  const name = value.trim();
  if (!name || name.length > NAME_LIMIT || /[\u0000-\u001f\u007f]/.test(name)) throw new Error(t("方案名称应为 1–80 个字符，不能包含换行或控制字符。", "Scenario names must contain 1–80 characters, with no line breaks or control characters."));
  return name;
}

function checkData(data) {
  if (!data || !Array.isArray(data.suppliers) || data.suppliers.length < 2 || !Array.isArray(data.criteria) || data.criteria.length < 2) throw new Error(t("请先建立有效的供应商评估。", "Create a valid supplier assessment first."));
  const ids = new Set();
  for (const criterion of data.criteria) {
    if (!criterion || typeof criterion.id !== 'string' || ids.has(criterion.id)) throw new Error(t("评价指标编号无效或重复。", "Criterion IDs are invalid or duplicated."));
    ids.add(criterion.id);
    checkWeights(criterion, criterion.name ?? criterion.id);
  }
}

function checkWeights(criterion, label) {
  if (![criterion.lower, criterion.modal, criterion.upper].every(value => typeof value === 'number' && Number.isFinite(value)) || !(0 < criterion.lower && criterion.lower <= criterion.modal && criterion.modal <= criterion.upper)) throw new Error(t(`指标「${label}」的重要程度无效，请满足 0 < 最低值 ≤ 常用值 ≤ 最高值。`, `Invalid importance for “${label}”. Use 0 < lower ≤ typical ≤ upper.`));
}

/** Excludes weights so saved scenarios remain usable when only the baseline weights change. */
export function scenarioDataSignature(data) {
  checkData(data);
  return JSON.stringify({
    suppliers: data.suppliers.map(supplier => ({id:supplier.id,name:supplier.name,values:supplier.values})),
    criteria: data.criteria.map(criterion => ({id:criterion.id,name:criterion.name,type:criterion.type})),
  });
}

function isoDate(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) throw new Error(t("方案记录时间无效。", "Invalid scenario timestamp."));
  return new Date(value).toISOString();
}

/** Strict, bounded restore validation; discards extra properties from imported JSON. */
export function normalizeScenarios(data, raw = []) {
  checkData(data);
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_SCENARIOS) throw new Error(t(`最多保存 ${MAX_SCENARIOS} 个采购方案。`, `Save up to ${MAX_SCENARIOS} procurement scenarios.`));
  const signature = scenarioDataSignature(data), ids = new Set(), names = new Set();
  const expected = new Map(data.criteria.map(criterion => [criterion.id, criterion]));
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.id !== 'string' || !SAFE_ID.test(entry.id) || ['baseline','constructor','prototype'].includes(entry.id) || ids.has(entry.id)) throw new Error(t(`第 ${index + 1} 个方案的编号无效或重复。`, `Scenario ${index + 1} has an invalid or duplicate ID.`));
    const name = cleanName(entry.name);
    if (names.has(fold(name))) throw new Error(t(`方案名称「${name}」重复，请使用不同名称。`, `Duplicate scenario name “${name}”. Use a unique name.`));
    if (entry.datasetSignature !== undefined && entry.datasetSignature !== signature) throw new Error(t(`方案「${name}」对应的供应商或指标已变化，请重新创建该方案。`, `Suppliers or criteria have changed for “${name}”. Create the scenario again.`));
    if (!Array.isArray(entry.criteria) || entry.criteria.length !== expected.size) throw new Error(t(`方案「${name}」的指标数量与当前评估不一致。`, `The criterion count in “${name}” does not match the current assessment.`));
    const configured = new Map();
    for (const value of entry.criteria) {
      if (!value || typeof value !== 'object' || !expected.has(value.id) || configured.has(value.id)) throw new Error(t(`方案「${name}」含有未知或重复指标。`, `Scenario “${name}” contains unknown or duplicate criteria.`));
      checkWeights(value, expected.get(value.id).name);
      configured.set(value.id, {id:value.id,lower:value.lower,modal:value.modal,upper:value.upper});
    }
    const createdAt = isoDate(entry.createdAt, '1970-01-01T00:00:00.000Z');
    const updatedAt = isoDate(entry.updatedAt, createdAt);
    ids.add(entry.id); names.add(fold(name));
    return {id:entry.id,name,createdAt,updatedAt,datasetSignature:signature,criteria:data.criteria.map(criterion => configured.get(criterion.id))};
  });
}

function makeId() {
  if (globalThis.crypto?.randomUUID) return `scenario_${globalThis.crypto.randomUUID()}`;
  return `scenario_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`;
}

/** Changes only relative importance; preserves each saved lower/modal/upper ratio. */
export function editScenario(data, scenario, name, modals) {
  const current = normalizeScenarios(data, [scenario])[0];
  if (!Array.isArray(modals) || modals.length !== current.criteria.length) throw new Error(t("请为每项指标填写重要程度。", "Enter an importance value for each criterion."));
  const criteria = current.criteria.map((criterion, index) => {
    const modal = modals[index];
    if (typeof modal !== 'number' || !Number.isFinite(modal) || modal <= 0) throw new Error(t(`指标「${data.criteria[index].name}」的重要程度必须大于零。`, `Importance for “${data.criteria[index].name}” must be greater than zero.`));
    const ratio = modal / criterion.modal;
    const next = {id:criterion.id,lower:criterion.lower * ratio,modal,upper:criterion.upper * ratio};
    checkWeights(next, data.criteria[index].name);
    return next;
  });
  return {...current,name:cleanName(name),criteria,updatedAt:new Date().toISOString()};
}

export function createScenario(data, name, modals = data.criteria.map(criterion => criterion.modal)) {
  const now = new Date().toISOString();
  const scenario = {id:makeId(),name:cleanName(name),createdAt:now,updatedAt:now,datasetSignature:scenarioDataSignature(data),criteria:data.criteria.map(({id,lower,modal,upper})=>({id,lower,modal,upper}))};
  return editScenario(data,scenario,name,modals);
}

/** Returns the entire unchanged supplier population, with only criterion weights overridden. */
export function scenarioInput(data, scenario) {
  const canonical = normalizeScenarios(data,[scenario])[0];
  return {...clone(data),criteria:data.criteria.map((criterion,index)=>({...clone(criterion),...canonical.criteria[index]}))};
}

function centerWeights(criteria) {
  const values = criteria.map(criterion => criterion.lower / 3 + criterion.modal / 3 + criterion.upper / 3);
  const max = Math.max(...values), sum = values.reduce((total,value)=>total + value / max,0);
  return values.map(value => value / max / sum);
}

function resultRows(data,result) {
  if (!result || !Array.isArray(result.suppliers) || result.suppliers.length !== data.suppliers.length) throw new Error(t("方案计算未返回完整供应商结果，请重试。", "Scenario calculation returned incomplete supplier results. Try again."));
  const found = new Map(), expected = new Set(data.suppliers.map(supplier => supplier.id));
  for (const row of result.suppliers) {
    if (!row || !expected.has(row.id) || found.has(row.id) || !Number.isFinite(row.baseline) || !Number.isInteger(row.wsmRank) || row.wsmRank < 1 || row.wsmRank > data.suppliers.length) throw new Error(t("方案评分或排名格式不正确，请重试。", "Invalid scenario scores or ranks. Try again."));
    found.set(row.id,row);
  }
  return found;
}

function eligibleSet(data,eligibleIds) {
  if (eligibleIds == null) return null;
  if (!Array.isArray(eligibleIds) && !(eligibleIds instanceof Set)) throw new Error(t("准入供应商清单格式不正确。", "Invalid eligible supplier list."));
  const ids = new Set(eligibleIds);
  return new Set(data.suppliers.map(supplier => supplier.id).filter(id => ids.has(id)));
}

/** Pure comparison model. Filtering changes displayed order only, never original scores. */
export function scenarioComparison(data,baseline,computed = [],{eligibleIds=null,eligibleOnly=true}={}) {
  checkData(data);
  const qualified = eligibleSet(data,eligibleIds);
  const shown = data.suppliers.filter(supplier => !eligibleOnly || qualified === null || qualified.has(supplier.id));
  const definitions = [{id:'baseline',name:t("当前评估", "Current assessment"),result:baseline},...computed.map(item=>({id:item.scenario.id,name:item.scenario.name,result:item.result}))];
  const columns = definitions.map(definition => {
    const map = resultRows(data,definition.result);
    const sorted = shown.map(supplier => ({id:supplier.id,name:supplier.name,score:map.get(supplier.id).baseline,originalRank:map.get(supplier.id).wsmRank})).sort((a,b)=>a.originalRank-b.originalRank || data.suppliers.findIndex(s=>s.id===a.id)-data.suppliers.findIndex(s=>s.id===b.id));
    for(let index=0;index<sorted.length;index++) sorted[index].rank = eligibleOnly && qualified !== null ? index && sorted[index].score===sorted[index-1].score ? sorted[index-1].rank : index+1 : sorted[index].originalRank;
    return {...definition,rows:sorted,byId:new Map(sorted.map(row=>[row.id,row])),top:sorted.slice(0,3)};
  });
  const base = columns[0];
  for (const column of columns) for (const row of column.rows) row.change = base.byId.get(row.id).rank - row.rank;
  return {columns,rows:base.rows,filtered:eligibleOnly&&qualified!==null,qualifiedCount:qualified?.size??null,total:data.suppliers.length};
}

/** Sequential async runner that rejects stale completions after a newer revision. */
export function createScenarioRunner(workerRun) {
  if (typeof workerRun !== 'function') throw new Error(t("方案计算服务尚未就绪。", "The scenario calculation service is unavailable."));
  let revision=0;
  return {
    invalidate(){revision++;},
    async run(data,scenarios,onProgress=()=>{}) {
      const token=++revision,canonical=normalizeScenarios(data,scenarios),completed=[];
      for(let index=0;index<canonical.length;index++) {
        if(token!==revision)return {stale:true,completed:[]};
        onProgress(index,canonical.length,canonical[index]);
        const candidate=scenarioInput(data,canonical[index]);
        try {
          const result=await workerRun(candidate);
          if(token!==revision)return {stale:true,completed:[]};
          resultRows(data,result);
          completed.push({scenario:canonical[index],result});
        } catch(error) {
          if(token!==revision)return {stale:true,completed:[]};
          throw new Error(t(`方案「${canonical[index].name}」计算失败：${error?.message||t("请稍后重试。", "Try again later.")}`, `Scenario “${canonical[index].name}” failed: ${translateSystemText(error?.message)||t("请稍后重试。", "Try again later.")}`));
        }
      }
      return {stale:false,completed};
    },
  };
}

function csvCell(value) {
  let text=String(value??'');
  if(typeof value!=='number'&&/^[\s\u0000-\u001f]*[=+\-@]/.test(text))text=`'${text}`;
  return /[",\r\n\t]/.test(text)?`"${text.replaceAll('"','""')}"`:text;
}

export function scenarioCSV(model) {
  const rows=[[t("ADAPT 采购方案对比", "ADAPT procurement scenario comparison")],[t("顺序口径", "Ranking scope"),model.filtered?t("仅通过准入的供应商，评分保留全部供应商计算口径", "Eligible suppliers only; scores retain the full supplier cohort"):t("全部供应商", "All suppliers")],[],[t("方案名称", "Scenario name"),t("公司名称", "Company name"),model.filtered?t("入围顺序", "Shortlist order"):t("综合排名", "Overall rank"),t("原排名", "Original rank"),t("综合评分（百分制）", "Overall score (out of 100)"),t("较当前评估的顺序变化", "Order change from current assessment")]];
  for(const column of model.columns)for(const row of column.rows)rows.push([column.name,row.name,row.rank,row.originalRank,Number(displayScore(row.score)),row.change]);
  return '\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}

function downloadCSV(csv) {
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),link=document.createElement('a');
  link.href=url;link.download=t("ADAPT_采购方案对比.csv", "ADAPT_Scenario_Comparison.csv");document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

/**
 * Mounts a self-contained view. onSave receives configurations only, never results.
 * workerRun(candidateData) may return minimal {suppliers:[{id,baseline,wsmRank}]}.
 */
export function mountScenario(container,options) {
  if(!container||typeof container.addEventListener!=='function')throw new Error(t("方案面板容器无效。", "Invalid scenario panel container."));
  let opts={scenarios:[],eligibleIds:null,canExport:true,...options},scenarios=[],selected=new Set(),editor=null,error='',busy=false,saving=false,exporting=false,removedId=null,progress='',alive=true,revision=0,model=null,contextRevision=0,pendingSaveKey=null;
  let eligibleOnly=opts.eligibleIds!=null;
  let computed=[],runner=createScenarioRunner(opts.workerRun);
  const q=selector=>container.querySelector(selector);
  function focusAction(action,id){
    const candidates=[...container.querySelectorAll(`[data-scenario-action="${action}"]`)];
    (id?candidates.find(control=>control.dataset.id===id):candidates[0])?.focus();
  }
  function invalidate(){revision++;runner.invalidate();busy=false;computed=[];model=null;progress='';}
  function selectedConfigs(){return scenarios.filter(scenario=>selected.has(scenario.id));}
  function errorText(exception){return translateSystemText(exception?.message)||t("操作未完成，请重试。", "The action could not be completed. Try again.");}
  function validateOptions(){
    checkData(opts.data);
    resultRows(opts.data,opts.result);
    scenarios=normalizeScenarios(opts.data,opts.scenarios);
    const known=new Set(scenarios.map(scenario=>scenario.id));
    selected=new Set([...selected].filter(id=>known.has(id)));
  }
  function editMarkup(){
    if(!editor)return '';
    const reference=editor.original.criteria;
    const weights=centerWeights(reference);
    return `<form class="extension-form scenario-editor" data-scenario-form>
      <div class="extension-toolbar"><label>${t("方案名称", "Scenario name")}<input name="scenario-name" type="text" maxlength="80" required value="${esc(editor.name)}" autocomplete="off" ${saving?'disabled':''}></label></div>
      <div class="table-scroll"><table><thead><tr><th scope="col">${t("评价指标", "Criterion")}</th><th scope="col">${t("原评分权重", "Original weight")}</th><th scope="col">${t("方案相对重要程度", "Scenario relative importance")}</th></tr></thead><tbody>${opts.data.criteria.map((criterion,index)=>`<tr><td>${esc(criterion.name)}</td><td>${(weights[index]*100).toFixed(1)}%</td><td><input data-scenario-weight="${index}" type="number" min="0" step="any" required value="${editor.modals[index]}" aria-label="${esc(t(`${criterion.name}方案重要程度`, `${criterion.name}: scenario importance`))}" ${saving?'disabled':''}></td></tr>`).join('')}</tbody></table></div>
      <div class="extension-toolbar"><p class="small-label">${t("相对值，无须合计为 100。", "Relative values; no need to total 100.")}</p><div class="scenario-form-actions"><button type="button" class="button secondary" data-scenario-action="cancel-edit" ${saving?'disabled':''}>${t("取消", "Cancel")}</button><button type="submit" class="button primary" ${saving?'disabled':''}>${saving?t("正在保存", "Saving"):t("保存方案", "Save scenario")}</button></div></div>
    </form>`;
  }
  function emphasis(scenario){
    const weights=centerWeights(scenario.criteria),base=centerWeights(opts.data.criteria);
    const changes=weights.map((weight,index)=>({index,weight,diff:weight-base[index]})).filter(item=>Math.abs(item.diff)>.00005).sort((a,b)=>Math.abs(b.diff)-Math.abs(a.diff)).slice(0,2);
    return changes.length?changes.map(item=>`${opts.data.criteria[item.index].name} ${(item.weight*100).toFixed(1)}%`).join(' · '):t("沿用当前评价重点", "Current priorities retained");
  }
  function configMarkup(){
    if(!scenarios.length)return editor?'':`<div class="extension-empty">${t("暂无方案", "No scenarios")}</div>`;
    return `<div class="table-scroll"><table class="scenario-config-table"><thead><tr><th scope="col">${t("对比", "Compare")}</th><th scope="col">${t("方案名称", "Scenario name")}</th><th scope="col">${t("评价重点", "Priorities")}</th>${opts.readOnly?'':`<th scope="col">${t("操作", "Actions")}</th>`}</tr></thead><tbody>${scenarios.map(scenario=>`<tr><td><input type="checkbox" data-scenario-select="${esc(scenario.id)}" aria-label="${esc(t(`选择方案 ${scenario.name}`, `Select scenario ${scenario.name}`))}" ${selected.has(scenario.id)?'checked':''} ${busy||saving?'disabled':''}></td><td>${esc(scenario.name)}</td><td class="small-label">${esc(emphasis(scenario))}</td>${opts.readOnly?'':`<td class="scenario-row-actions">${removedId===scenario.id?`<span>${t("删除该方案？", "Delete this scenario?")}</span><button class="text-button" type="button" data-scenario-action="confirm-remove" data-id="${esc(scenario.id)}" ${saving?'disabled':''}>${t("确认删除", "Delete")}</button><button class="text-button" type="button" data-scenario-action="cancel-remove" ${saving?'disabled':''}>${t("取消", "Cancel")}</button>`:`<button class="text-button" type="button" data-scenario-action="edit" data-id="${esc(scenario.id)}" ${busy||saving?'disabled':''}>${t("编辑", "Edit")}</button><button class="text-button" type="button" data-scenario-action="remove" data-id="${esc(scenario.id)}" ${busy||saving?'disabled':''}>${t("删除", "Delete")}</button>`}</td>`}</tr>`).join('')}</tbody></table></div>`;
  }
  function buildModel(){
    const chosen=selectedConfigs();
    if(!chosen.length||computed.length!==chosen.length||computed.some(item=>!selected.has(item.scenario.id)))return null;
    return scenarioComparison(opts.data,opts.result,computed,{eligibleIds:opts.eligibleIds,eligibleOnly});
  }
  function resultMarkup(){
    model=buildModel();
    if(!model)return '';
    if(!model.rows.length)return `<div class="extension-empty">${t("暂无合格供应商，可切换为全部供应商。", "No eligible suppliers. Switch to all suppliers.")}</div>`;
    const columns=model.columns,rankLabel=model.filtered?t("入围顺序", "Shortlist order"):t("综合排名", "Overall rank");
    const summary=column=>{
      const higher=column.rows.filter(row=>row.change>0).length,lower=column.rows.filter(row=>row.change<0).length;
      return column.id==='baseline'?t("当前基准", "Current baseline"):higher||lower?t(`${higher} 家上升 · ${lower} 家下降`, `${higher} moved up · ${lower} moved down`):t("顺序保持一致", "Order unchanged");
    };
    return `<div class="scenario-comparison" aria-label="${t('采购方案比较结果', 'Scenario comparison results')}">
      <div class="table-scroll"><table class="scenario-summary-table"><thead><tr><th scope="col">${t("对比项", "Comparison")}</th>${columns.map(column=>`<th scope="col">${esc(column.name)}</th>`).join('')}</tr></thead><tbody><tr><th scope="row">${t("首位供应商", "Top supplier")}</th>${columns.map(column=>`<td>${esc(column.top[0]?.name??'—')}</td>`).join('')}</tr><tr><th scope="row">${t("前三候选", "Top three")}</th>${columns.map(column=>`<td>${column.top.map(row=>esc(row.name)).join(t('、', ', '))||'—'}</td>`).join('')}</tr><tr><th scope="row">${t(`${rankLabel}变化`, `${rankLabel} changes`)}</th>${columns.map(column=>`<td>${summary(column)}</td>`).join('')}</tr></tbody></table></div>
      <p class="small-label scenario-results-note">${model.filtered?t(`入围 ${model.qualifiedCount} 家 · 评分基于全部 ${model.total} 家。 `, `${model.qualifiedCount} eligible · scores based on all ${model.total} suppliers. `):''}${t('＋上升 · −下降', '+ moved up · − moved down')}</p>
      <div class="table-scroll"><table class="scenario-results-table"><thead><tr><th rowspan="2" scope="col">${t("供应商", "Supplier")}</th>${columns.map(column=>`<th colspan="3" scope="colgroup">${esc(column.name)}</th>`).join('')}</tr><tr>${columns.map(()=>`<th scope="col">${rankLabel}</th><th scope="col">${t("综合评分", "Overall score")}</th><th scope="col">${t("较当前", "Change")}</th>`).join('')}</tr></thead><tbody>${model.rows.map(baseline=>`<tr><th scope="row">${esc(baseline.name)}</th>${columns.map(column=>{
        const row=column.byId.get(baseline.id);
        return `<td>${row.rank}${model.filtered?`<span class="small-label scenario-original-rank">${t(`原第 ${row.originalRank} 名`, `Originally #${row.originalRank}`)}</span>`:''}</td><td>${t(`${displayScore(row.score)} 分`, `${displayScore(row.score)} pts`)}</td><td><span class="pill${row.change>0?' positive':row.change<0?' negative':''}">${column.id==='baseline'?'—':row.change>0?`+${row.change}`:String(row.change)}</span></td>`;
      }).join('')}</tr>`).join('')}</tbody></table></div>
    </div>`;
  }
  function render(){
    if(!alive)return;
    const results=resultMarkup();
    container.innerHTML=`<section class="panel extension-section scenario-section" aria-label="${t('采购方案对比', 'Procurement scenarios')}" aria-busy="${busy||saving}">
      <div class="panel-heading"><div><h2>${t('采购方案对比', 'Procurement scenarios')}</h2></div>${opts.readOnly?'':`<button class="button secondary" type="button" data-scenario-action="create" ${busy||saving||editor||scenarios.length>=MAX_SCENARIOS?'disabled':''}>${t("新建方案", "New scenario")}</button>`}</div>
      ${error?`<div class="extension-error" role="alert">${esc(error)}</div>`:''}
      ${editMarkup()}${configMarkup()}
      ${scenarios.length?`<div class="extension-toolbar scenario-comparison-toolbar"><div><span class="pill">${t(`当前评估 + ${selected.size} 个方案`, `Current assessment + ${selected.size} scenarios`)}</span></div><div class="scenario-form-actions">${opts.eligibleIds!=null?`<label class="scenario-filter"><input type="checkbox" data-scenario-eligible ${eligibleOnly?'checked':''} ${busy?'disabled':''}>${t("仅看通过准入的供应商", "Eligible suppliers only")}</label>`:''}${opts.canExport?`<button class="button secondary" type="button" data-scenario-action="export" ${!model||busy||exporting?'disabled':''}>${t("导出对比", "Export comparison")}</button>`:''}<button class="button primary" type="button" data-scenario-action="compare" ${!selected.size||busy||saving||editor?'disabled':''}>${busy?t("正在计算", "Calculating"):t("生成对比", "Compare")}</button></div></div>`:''}
      <div class="scenario-progress" role="status" aria-live="polite">${busy?esc(progress):''}</div>${results}
    </section>`;
  }
  async function persist(next,action,scenario){
    if(opts.readOnly)throw new Error(t("此项目为只读。", "This project is read-only."));
    if(typeof opts.onSave!=='function')throw new Error(t("当前评估暂不能保存方案。", "Scenarios cannot be saved for the current assessment."));
    const signature=JSON.stringify({contextId:opts.contextId,data:opts.data}),contextToken=contextRevision;
    const canonical=normalizeScenarios(opts.data,next);
    pendingSaveKey=JSON.stringify(canonical);
    saving=true;render();
    try{
      const saved=await opts.onSave(clone(canonical),{action,id:scenario.id,name:scenario.name});
      if(saved===false)throw new Error(t("方案未保存，请重试。", "The scenario was not saved. Try again."));
      if(!alive||contextToken!==contextRevision||JSON.stringify({contextId:opts.contextId,data:opts.data})!==signature)return false;
      scenarios=canonical;opts.scenarios=clone(canonical);editor=null;removedId=null;error='';
      invalidate();return true;
    }finally{pendingSaveKey=null;if(alive){saving=false;render();}}
  }
  function startEditor(scenario=null){
    if(busy||saving||opts.readOnly)return;
    if(!scenario&&scenarios.length>=MAX_SCENARIOS){error=t(`最多保存 ${MAX_SCENARIOS} 个方案，请先删除不再使用的方案。`, `Save up to ${MAX_SCENARIOS} scenarios. Remove an unused scenario first.`);render();return;}
    const original=scenario??createScenario(opts.data,t("未命名方案", "Untitled scenario"));
    editor={id:scenario?.id??null,original,name:scenario?.name??'',modals:original.criteria.map(criterion=>criterion.modal)};
    error='';removedId=null;render();q('[name="scenario-name"]')?.focus();
  }
  async function saveEditor(){
    if(!editor||saving)return;
    try{
      const edited=editScenario(opts.data,editor.original,editor.name,editor.modals);
      if(scenarios.some(scenario=>scenario.id!==edited.id&&fold(scenario.name)===fold(edited.name)))throw new Error(t("已有同名方案，请换一个名称。", "A scenario with this name already exists. Use a different name."));
      const next=editor.id?scenarios.map(scenario=>scenario.id===edited.id?edited:scenario):[...scenarios,edited];
      const action=editor.id?'edit':'create';
      if(await persist(next,action,edited)){if(selected.size<MAX_COMPARE)selected.add(edited.id);render();}
    }catch(exception){error=errorText(exception);render();}
  }
  async function compare(){
    if(busy||saving||editor)return;
    const chosen=selectedConfigs();
    if(!chosen.length){error=t("请至少选择一个方案，再与当前评估比较。", "Select at least one scenario to compare with the current assessment.");render();return;}
    if(chosen.length>MAX_COMPARE){error=t(`每次最多比较 ${MAX_COMPARE} 个方案。`, `Compare up to ${MAX_COMPARE} scenarios at a time.`);render();return;}
    error='';busy=true;computed=[];model=null;
    const token=++revision;
    try{
      const completion=await runner.run(opts.data,chosen,(index,total,scenario)=>{progress=t(`正在计算「${scenario.name}」 · ${index+1}/${total}`, `Calculating “${scenario.name}” · ${index+1}/${total}`);render();});
      if(!alive||completion.stale||token!==revision)return;
      computed=completion.completed;
    }catch(exception){if(alive&&token===revision)error=errorText(exception);}
    finally{if(alive&&token===revision){busy=false;progress='';render();}}
  }
  async function exportComparison(){
    if(!model||busy||exporting||!opts.canExport)return;
    const csv=scenarioCSV(model);
    exporting=true;
    render();
    try{
      const authorized=await opts.onExport?.();
      if(authorized!==false&&alive)downloadCSV(csv);
    }catch(exception){if(alive)error=errorText(exception);}
    finally{exporting=false;if(alive)render();}
  }
  function handleClick(event){
    const target=event.target.closest('[data-scenario-action]');
    if(!target||!container.contains(target))return;
    const action=target.dataset.scenarioAction,id=target.dataset.id;
    if(opts.readOnly&&action!=='compare'&&action!=='export')return;
    if(action==='create')startEditor();
    if(action==='edit')startEditor(scenarios.find(scenario=>scenario.id===id));
    if(action==='cancel-edit'){const previous=editor?.id;editor=null;error='';render();focusAction(previous?'edit':'create',previous);}
    if(action==='remove'&&!busy&&!saving){removedId=id;render();}
    if(action==='cancel-remove'){const previous=removedId;removedId=null;render();focusAction('remove',previous);}
    if(action==='confirm-remove'&&!busy&&!saving){const removed=scenarios.find(scenario=>scenario.id===id);if(removed)persist(scenarios.filter(scenario=>scenario.id!==id),'remove',removed).then(saved=>{if(saved){selected.delete(id);render();}}).catch(exception=>{error=errorText(exception);render();});}
    if(action==='compare')compare();
    if(action==='export')void exportComparison();
  }
  function handleInput(event){
    if(!editor)return;
    if(event.target.name==='scenario-name')editor.name=event.target.value;
    if(event.target.matches('[data-scenario-weight]'))editor.modals[Number(event.target.dataset.scenarioWeight)]=event.target.value===''?NaN:Number(event.target.value);
  }
  function handleChange(event){
    if(event.target.matches('[data-scenario-select]')){
      if(busy||saving)return;
      const id=event.target.dataset.scenarioSelect;
      if(event.target.checked&&selected.size>=MAX_COMPARE){error=t(`最多选择 ${MAX_COMPARE} 个方案。`, `Select up to ${MAX_COMPARE} scenarios.`);render();return;}
      event.target.checked?selected.add(id):selected.delete(id);error='';invalidate();render();
    }
    if(event.target.matches('[data-scenario-eligible]')){eligibleOnly=event.target.checked;error='';render();}
  }
  function handleSubmit(event){if(event.target.matches('[data-scenario-form]')){event.preventDefault();saveEditor();}}
  container.addEventListener('click',handleClick);container.addEventListener('input',handleInput);container.addEventListener('change',handleChange);container.addEventListener('submit',handleSubmit);
  try{validateOptions();}catch(exception){error=errorText(exception);}
  render();
  return {
    isDirty(){return editor!==null||saving;},
    update(next={}){
      if(!alive)return;
      const oldSignature=JSON.stringify({data:opts.data,result:opts.result,scenarios:opts.scenarios,contextId:opts.contextId});
      const oldData=JSON.stringify({data:opts.data,contextId:opts.contextId}),oldScenarios=JSON.stringify(opts.scenarios);
      const hadEligibility=opts.eligibleIds!=null;
      opts={...opts,...next};
      if(JSON.stringify({data:opts.data,contextId:opts.contextId})!==oldData||(JSON.stringify(opts.scenarios)!==oldScenarios&&JSON.stringify(opts.scenarios)!==pendingSaveKey))contextRevision++;
      if(next.workerRun){runner.invalidate();runner=createScenarioRunner(next.workerRun);}
      if(JSON.stringify({data:opts.data,result:opts.result,scenarios:opts.scenarios,contextId:opts.contextId})!==oldSignature){invalidate();editor=null;removedId=null;}
      if(!hadEligibility&&opts.eligibleIds!=null)eligibleOnly=true;
      if(opts.eligibleIds==null)eligibleOnly=false;
      try{validateOptions();error='';}catch(exception){error=errorText(exception);computed=[];model=null;}
      render();
    },
    destroy(){alive=false;invalidate();container.removeEventListener('click',handleClick);container.removeEventListener('input',handleInput);container.removeEventListener('change',handleChange);container.removeEventListener('submit',handleSubmit);container.replaceChildren();},
    exportCSV(){if(!model)throw new Error(t("请先生成方案对比。", "Generate a scenario comparison first."));return scenarioCSV(model);},
  };
}
