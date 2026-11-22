/**
 * Same-origin, browser-local project history. Nothing is sent over a network.
 *
 * Call recordAnalysis ONLY after a successful engine result. It stores the input
 * dataset and compact computed summary, not Monte Carlo samples or engine caches.
 * This storage envelope is independent of the existing .adapt.json file format.
 *
 * API:
 *   const store = createProjectStore(); // projectStore is the shared instance
 *   store.recordAnalysis({projectId?,data,result,kind?,p?,delta?})
 *     -> {project,persisted,changed}
 *   store.listProjects() -> newest-updated first, compact list records
 *   store.getProject(id) -> complete project (including resumable .data), or null
 *   store.listActivities(limit=20) -> newest first
 *   store.removeProject(id) -> {removed,persisted}
 *   store.storageStatus() -> {persistent,warning}
 *
 * Kinds: import, reopen, settings, comparison, resume, eligibility, scenarios, decision. Consecutive comparison
 * events for the same project are coalesced within 60 seconds. Reading/resuming
 * an unchanged project never changes updatedAt or adds a synthetic activity.
 *
 * Pass delta:null for automatic tolerance, a number for an explicit tolerance.
 * If omitted, data.delta is retained. p defaults to the successful result's p.
 * getProject(id).data includes these exact preferences for analyze(project.data).
 * Every returned object is a copy. Storage failure retains work in memory and
 * returns persisted:false; storageStatus().warning can be shown to the user.
 * Reads and writes refresh other tabs' saved records before merging local edits.
 * Concurrent edits to the same project follow last-write-wins semantics; this
 * synchronous localStorage API is not a cross-tab transaction or database lock.
 */
import {validateInput} from './engine.mjs';

export const PROJECT_STORAGE_KEY='adapt-dashboard.projects.v1';
const VERSION=1;
const ACTIVITY_LIMIT=100;
const LABELS={import:'导入新项目',reopen:'打开评估文件',settings:'更新指标设置',comparison:'调整比较选项',resume:'继续评估',eligibility:'保存准入条件',scenarios:'更新评估方案',decision:'保存采购决策'};
const KINDS=new Set(Object.keys(LABELS));
const clone=value=>JSON.parse(JSON.stringify(value));
const has=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=200;
const validDate=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));

function defaultStorage(){
  try{return {storage:globalThis.localStorage??null,warning:globalThis.localStorage?'':'当前环境不支持本地存储，项目仅保留在本次会话中。'};}
  catch{return {storage:null,warning:'浏览器禁止本地存储，项目仅保留在本次会话中。'};}
}

let fallbackId=0;
function makeId(){
  return globalThis.crypto?.randomUUID?.()??`adapt-${Date.now().toString(36)}-${(++fallbackId).toString(36)}`;
}

function cleanDataset(data,p,delta){
  const validated=validateInput({...data,p,delta});
  // Preserve title/source/example and existing input metadata without changing
  // the file format. Canonical engine fields are independently validated.
  return {...clone(data),...validated,p,delta};
}

function summarize(result,data){
  const n=data.suppliers.length,m=data.criteria.length,ids=new Set(data.suppliers.map(s=>s.id));
  const count=n*(n-1)/2;
  if(!result||!Array.isArray(result.suppliers)||result.suppliers.length!==n||!Array.isArray(result.pairs)||result.pairs.length!==count) throw new Error('仅能保存已成功完成的分析结果。');
  const suppliedIds=new Set();
  for(const supplier of result.suppliers){
    if(!ids.has(supplier.id)||suppliedIds.has(supplier.id)||!finite(supplier.baseline)||!Number.isInteger(supplier.wsmRank)||supplier.wsmRank<1||supplier.wsmRank>n) throw new Error('分析结果与项目供应商不匹配。');
    suppliedIds.add(supplier.id);
  }
  const pairIds=new Set(),counts={'未解决':0,'等效':0,'可分':0};
  for(const pair of result.pairs){
    const id=JSON.stringify([pair.a,pair.b].sort());
    if(!ids.has(pair.a)||!ids.has(pair.b)||pair.a===pair.b||pairIds.has(id)||!has(counts,pair.status)||!finite(pair.prob)||pair.prob<0||pair.prob>1||!finite(pair.lo)||!finite(pair.hi)||pair.lo>pair.hi) throw new Error('成对比较结果无效，项目未保存。');
    pairIds.add(id);counts[pair.status]++;
  }
  if(!finite(result.p)||result.p<=0||result.p>=1||!finite(result.delta)||result.delta<0) throw new Error('分析比较选项无效，项目未保存。');
  const leaders=result.suppliers.filter(s=>s.wsmRank===1);
  if(!leaders.length) throw new Error('分析结果缺少首位供应商。');
  return {supplierCount:n,criterionCount:m,comparisonCount:count,unresolvedCount:counts['未解决'],equivalentCount:counts['等效'],separableCount:counts['可分'],leaderIds:leaders.map(s=>s.id),leaderNames:leaders.map(s=>s.name??s.id),bestScore:Math.max(...result.suppliers.map(s=>s.baseline)),sampleCount:data.sampleCount,p:result.p,delta:result.delta};
}

function validateSummary(summary,data){
  const n=data.suppliers.length,count=n*(n-1)/2;
  if(!summary||summary.supplierCount!==n||summary.criterionCount!==data.criteria.length||summary.comparisonCount!==count) throw new Error('项目摘要无效');
  for(const key of ['unresolvedCount','equivalentCount','separableCount']) if(!Number.isInteger(summary[key])||summary[key]<0||summary[key]>count) throw new Error('项目比较计数无效');
  if(summary.unresolvedCount+summary.equivalentCount+summary.separableCount!==count) throw new Error('项目比较计数不完整');
  if(!Array.isArray(summary.leaderIds)||!summary.leaderIds.length||new Set(summary.leaderIds).size!==summary.leaderIds.length||summary.leaderIds.some(id=>!data.suppliers.some(s=>s.id===id))) throw new Error('项目首位供应商无效');
  if(!Array.isArray(summary.leaderNames)||summary.leaderNames.length!==summary.leaderIds.length||summary.leaderNames.some(name=>typeof name!=='string')) throw new Error('项目首位供应商名称无效');
  if(!finite(summary.bestScore)||!finite(summary.delta)||summary.delta<0||!finite(summary.p)||summary.p<=0||summary.p>=1||summary.sampleCount!==data.sampleCount) throw new Error('项目摘要参数无效');
  return clone(summary);
}

function readProject(value){
  if(!value||!validId(value.id)||!validDate(value.createdAt)||!validDate(value.updatedAt)||Date.parse(value.updatedAt)<Date.parse(value.createdAt)) throw new Error('项目标识或时间无效');
  const options=value.preferences;
  if(!options||!finite(options.p)||options.p<=0||options.p>=1||!(options.delta===null||finite(options.delta)&&options.delta>=0)) throw new Error('项目偏好无效');
  const data=cleanDataset(value.data,options.p,options.delta);
  const summary=validateSummary(value.resultSummary,data);
  if(summary.p!==options.p||options.delta!==null&&summary.delta!==options.delta) throw new Error('项目选项与结果不一致');
  return {id:value.id,createdAt:value.createdAt,updatedAt:value.updatedAt,data,preferences:{p:options.p,delta:options.delta,deltaMode:options.delta===null?'auto':'explicit'},source:clone(data.source??null),resultSummary:summary};
}

function listRecord(project){
  const s=project.resultSummary;
  return {id:project.id,title:String(project.data.title||'未命名评估项目'),status:s.unresolvedCount?'needs-review':'complete',statusLabel:s.unresolvedCount?'待明确':'评估完成',createdAt:project.createdAt,updatedAt:project.updatedAt,supplierCount:s.supplierCount,criterionCount:s.criterionCount,unresolvedCount:s.unresolvedCount,source:clone(project.source),resultSummary:clone(s),preferences:clone(project.preferences)};
}

/** Dependency injection makes storage-denial/corruption handling testable. */
export function createProjectStore(options={}){
  const detected=has(options,'storage')?{storage:options.storage,warning:options.storage?'':'当前未启用本地存储，项目仅保留在本次会话中。'}:defaultStorage();
  const storage=detected.storage,key=options.key??PROJECT_STORAGE_KEY,now=options.now??(()=>new Date().toISOString()),idFactory=options.idFactory??makeId;
  let projects=[],activities=[],warning=detected.warning,persistent=!!storage,lastRaw=Symbol('unread');
  // Unsaved changes survive a refresh after a denied/quota-exceeded write.
  const dirtyProjects=new Set(),dirtyActivities=new Set(),removedProjects=new Set();

  function refresh(){
    if(!storage)return;
    try{
      const raw=storage.getItem(key);
      if(raw===lastRaw)return;
      const envelope=raw?JSON.parse(raw):{version:VERSION,projects:[],activities:[]};
      if(!envelope||envelope.version!==VERSION||!Array.isArray(envelope.projects)||!Array.isArray(envelope.activities)) throw new Error('存储版本或结构无效');
      let skipped=0;
      const savedProjects=new Map();
      for(const value of envelope.projects){
        try{const project=readProject(value);if(savedProjects.has(project.id))throw new Error('重复项目');savedProjects.set(project.id,project);}
        catch{skipped++;}
      }
      const savedActivities=new Map();
      for(const activity of envelope.activities){
        const valid=activity&&validId(activity.id)&&!savedActivities.has(activity.id)&&savedProjects.has(activity.projectId)&&KINDS.has(activity.kind)&&validDate(activity.timestamp)&&typeof activity.projectTitle==='string'&&typeof activity.label==='string'&&typeof activity.detail==='string';
        if(valid)savedActivities.set(activity.id,clone(activity));else skipped++;
      }
      for(const project of projects)if(dirtyProjects.has(project.id))savedProjects.set(project.id,project);
      for(const id of removedProjects)savedProjects.delete(id);
      for(const activity of activities)if(dirtyActivities.has(activity.id))savedActivities.set(activity.id,activity);
      projects=[...savedProjects.values()];
      activities=[...savedActivities.values()].filter(activity=>savedProjects.has(activity.projectId)).sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp)).slice(0,ACTIVITY_LIMIT);
      lastRaw=raw;
      if(!dirtyProjects.size&&!dirtyActivities.size&&!removedProjects.size)persistent=true;
      if(skipped)warning=`已忽略 ${skipped} 条损坏的本地记录，其余项目可继续使用。`;
    }catch{
      // A bad read must never discard an earlier valid snapshot or unsaved work.
      // Do not overwrite corrupt storage until an actual successful analysis.
      persistent=false;
      warning='本地历史无法读取，当前可继续评估；新项目会优先保存，失败时保留在本次会话中。';
    }
  }
  refresh();

  function persist(){
    if(!storage){persistent=false;return false;}
    try{
      // A different tab may have saved since the last list/read operation.
      refresh();
      const serialized=JSON.stringify({version:VERSION,projects,activities});
      storage.setItem(key,serialized);
      lastRaw=serialized;
      dirtyProjects.clear();dirtyActivities.clear();removedProjects.clear();
      persistent=true;
      if(!warning.startsWith('已忽略')) warning='';
      return true;
    }catch{
      persistent=false;warning='浏览器本地存储不可用或空间不足，当前项目仍保留在本次会话中。';return false;
    }
  }

  function timestamp(){
    const value=now(),iso=value instanceof Date?value.toISOString():value;
    if(!validDate(iso)) throw new Error('项目时间无效。');
    return new Date(iso).toISOString();
  }

  function addActivity(project,kind,at){
    const detail=kind==='comparison'?`覆盖 ${Number((project.preferences.p*100).toFixed(2))}% · ${project.preferences.delta===null?'自动容差':`容差 ${project.preferences.delta}`}`:`${project.resultSummary.supplierCount} 家供应商 · ${project.resultSummary.criterionCount} 项指标`;
    const last=activities[0];
    const coalesce=kind==='comparison'&&last?.projectId===project.id&&last.kind===kind&&Date.parse(at)-Date.parse(last.timestamp)>=0&&Date.parse(at)-Date.parse(last.timestamp)<60000;
    const entry={id:coalesce?last.id:idFactory(),projectId:project.id,projectTitle:String(project.data.title||'未命名评估项目'),kind,label:LABELS[kind],detail,timestamp:at};
    if(!validId(entry.id)) throw new Error('活动标识无效。');
    if(coalesce) activities[0]=entry;else activities.unshift(entry);
    dirtyActivities.add(entry.id);
    activities=activities.slice(0,ACTIVITY_LIMIT);
  }

  return {
    listProjects(){refresh();return projects.map(listRecord).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));},
    getProject(id){refresh();const project=projects.find(p=>p.id===id);return project?clone(project):null;},
    listActivities(limit=20){refresh();const count=Number.isFinite(limit)?Math.max(0,Math.min(ACTIVITY_LIMIT,Math.floor(limit))):20;return clone(activities.slice(0,count));},
    storageStatus(){refresh();return {persistent,warning};},
    recordAnalysis(args){
      if(!args||typeof args!=='object') throw new Error('请提供成功的分析结果。');
      refresh();
      const current=args.projectId?projects.find(p=>p.id===args.projectId):null;
      const kind=args.kind??(current?'settings':'import');
      if(!KINDS.has(kind)) throw new Error('未知的项目活动。');
      const p=args.p??args.result?.p,delta=has(args,'delta')?args.delta:(args.data?.delta??null);
      const data=cleanDataset(args.data,p,delta),resultSummary=summarize(args.result,data);
      if(p!==args.result.p||delta!==null&&delta!==args.result.delta) throw new Error('保存选项与成功分析结果不一致。');
      const preferences={p,delta,deltaMode:delta===null?'auto':'explicit'};
      const payload={data,preferences,source:clone(data.source??null),resultSummary};
      const changed=!current||JSON.stringify(payload)!==JSON.stringify({data:current.data,preferences:current.preferences,source:current.source,resultSummary:current.resultSummary});
      if(!changed&&kind!=='reopen') return {project:clone(current),persisted:dirtyProjects.size||dirtyActivities.size||removedProjects.size?persist():persistent,changed:false};
      const at=timestamp(),id=current?.id??args.projectId??idFactory();
      if(!validId(id)) throw new Error('项目标识无效。');
      const project={id,createdAt:current?.createdAt??at,updatedAt:changed?at:current.updatedAt,...payload};
      if(current) projects[projects.indexOf(current)]=project;else projects.push(project);
      dirtyProjects.add(project.id);removedProjects.delete(project.id);
      addActivity(project,kind,at);
      const persisted=persist();
      return {project:clone(project),persisted,changed};
    },
    removeProject(id){
      refresh();
      if(!projects.some(p=>p.id===id)) return {removed:false,persisted:persistent};
      projects=projects.filter(p=>p.id!==id);activities=activities.filter(a=>a.projectId!==id);
      dirtyProjects.delete(id);removedProjects.add(id);
      return {removed:true,persisted:persist()};
    },
  };
}

export const projectStore=createProjectStore();
