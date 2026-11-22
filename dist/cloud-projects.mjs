/**
 * Enterprise project-store bridge. Hosted identity and permissions are always
 * enforced by /api; this cache is a rendering convenience, never authorization.
 * The legacy local store is left untouched during cloud use and migration.
 */
import {createProjectStore,projectStore as legacyProjectStore} from './projects.mjs';
import {t,translateSystemText} from './i18n.mjs';

const clone=value=>value===undefined?undefined:JSON.parse(JSON.stringify(value));
const has=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);
const ROLES=new Set(['administrator','evaluator','viewer']);
const FORMATS=new Set(['adapt','csv','print','scenarios_csv']);
const REVIEW_FORMATS=new Set(['html','print','pdf']);
const LIFECYCLES=new Set(['active','inactive','deleted']);
const LIFECYCLE_ACTIONS=new Set(['delete','restore','deactivate','activate']);
const REVIEW_STATES=new Set(['unsubmitted','pending','returned','archived']);
const DEFAULT_LIMIT=20;
export const MIGRATION_MAX_PROJECTS=50;
export const MIGRATION_MAX_BYTES=6_000_000;

export class CloudStoreError extends Error {
  constructor(message,{status=0,code='CLIENT_ERROR',details,mutationId}={}){
    super(translateSystemText(message));this.name='CloudStoreError';this.status=status;this.code=code;
    // Keep composition of system notices independent of the current language.
    this.rawMessage=message;
    if(details!==undefined)this.details=details;
    if(mutationId!==undefined)this.mutationId=mutationId;
    this.isConflict=status===409;
  }
}

function id(value,label='项目编号'){
  if(typeof value!=='string'||!value.trim()||value.length>200)throw new CloudStoreError(`${label}无效。`);
  return value;
}
function version(value){
  if(!Number.isInteger(value)||value<1)throw new CloudStoreError('请重新载入项目，获取有效版本后再保存。',{code:'VERSION_REQUIRED'});
  return value;
}
function lifecycleVersion(value){
  if(!Number.isInteger(value)||value<0)throw new CloudStoreError('请刷新项目状态后重试。',{code:'LIFECYCLE_VERSION_REQUIRED'});
  return value;
}
function limit(value,fallback=DEFAULT_LIMIT){return Number.isFinite(value)?Math.max(0,Math.min(100,Math.floor(value))):fallback;}
function makeId(){return globalThis.crypto?.randomUUID?.()??`adapt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;}
function validDate(value){return typeof value==='string'&&Number.isFinite(Date.parse(value));}
function contextUser(session){
  if(!session?.user||typeof session.user.id!=='string'||!session.user.id||session.user.id.length>200)throw new CloudStoreError('登录状态响应无效，请重新登录。',{code:'INVALID_RESPONSE'});
  return {
    user:{id:session.user.id,email:String(session.user.email??'').slice(0,320),name:String(session.user.name??'').slice(0,200)},
    ...(session.legacyMigrationAvailable===false?{legacyMigrationAvailable:false}:{}),
  };
}

function remoteListRecord(value){
  if(!value||typeof value!=='object')throw new CloudStoreError('项目列表响应无效。',{code:'INVALID_RESPONSE'});
  id(value.id);version(value.version);
  if(!ROLES.has(value.role)||typeof value.canExport!=='boolean'||!validDate(value.createdAt)||!validDate(value.updatedAt))throw new CloudStoreError('项目权限或版本响应无效。',{code:'INVALID_RESPONSE'});
  const summary=value.resultSummary;
  const supplierCount=value.supplierCount??summary?.supplierCount;
  const criterionCount=value.criterionCount??summary?.criterionCount;
  const unresolvedCount=value.unresolvedCount??summary?.unresolvedCount;
  if(!Number.isInteger(supplierCount)||supplierCount<2||supplierCount>30||!Number.isInteger(criterionCount)||criterionCount<2||criterionCount>10||!Number.isInteger(unresolvedCount)||unresolvedCount<0)throw new CloudStoreError('项目摘要响应无效。',{code:'INVALID_RESPONSE'});
  const lifecycle=value.lifecycle??'active',lifeVersion=value.lifecycleVersion??0,reviewState=value.reviewState??'unsubmitted';
  if(!LIFECYCLES.has(lifecycle)||!Number.isInteger(lifeVersion)||lifeVersion<0||!REVIEW_STATES.has(reviewState))throw new CloudStoreError('项目状态响应无效。',{code:'INVALID_RESPONSE'});
  for(const key of ['inactiveAt','deletedAt'])if(value[key]!=null&&!validDate(value[key]))throw new CloudStoreError('项目状态时间响应无效。',{code:'INVALID_RESPONSE'});
  if(value.lifecycleActions!==undefined&&(!Array.isArray(value.lifecycleActions)||value.lifecycleActions.some(action=>!LIFECYCLE_ACTIONS.has(action))||new Set(value.lifecycleActions).size!==value.lifecycleActions.length))throw new CloudStoreError('项目状态操作响应无效。',{code:'INVALID_RESPONSE'});
  return {
    id:value.id,title:String(value.title??value.data?.title??'未命名评估项目'),
    status:value.status??(unresolvedCount?'needs-review':'complete'),statusLabel:value.statusLabel??(unresolvedCount?'待明确':'评估完成'),
    createdAt:value.createdAt,updatedAt:value.updatedAt,version:value.version,role:value.role,canExport:value.canExport,
    supplierCount,criterionCount,unresolvedCount,source:clone(value.source??value.data?.source??null),
    resultSummary:clone(summary),preferences:clone(value.preferences),
    lifecycle,lifecycleVersion:lifeVersion,inactiveAt:value.inactiveAt??null,deletedAt:value.deletedAt??null,reviewState,
    lifecycleActions:value.role==='administrator'?[...(value.lifecycleActions??[])]:[],
    ...(typeof value.migrationLocalId==='string'?{migrationLocalId:value.migrationLocalId}:{}),
  };
}

function remoteProject(value){
  const summary=remoteListRecord(value);
  // Reuse the existing local store's input, preferences and summary validation.
  // This dependency only reads an in-memory envelope; it never writes backups.
  const raw=JSON.stringify({version:1,projects:[value],activities:[]});
  const validator=createProjectStore({storage:{getItem:()=>raw,setItem:()=>{throw new Error('read only');}},key:'validate-cloud-project'});
  const canonical=validator.getProject(value.id);
  if(!canonical)throw new CloudStoreError('服务器返回的项目数据或分析摘要无效。',{code:'INVALID_RESPONSE'});
  return {...canonical,...summary,data:canonical.data,resultSummary:canonical.resultSummary,preferences:canonical.preferences};
}

function summarizeAnalysis(args){
  const utility=createProjectStore({storage:null,idFactory:()=>args.projectId??'pending-cloud-project'});
  const {project}=utility.recordAnalysis(args);
  return {data:project.data,resultSummary:project.resultSummary,preferences:project.preferences,source:project.source};
}

function unchanged(current,payload){
  return !!current&&JSON.stringify({data:current.data,resultSummary:current.resultSummary,preferences:current.preferences,source:current.source})===JSON.stringify(payload);
}

/**
 * Sync reads use hydrated, account-bound memory. Writes and full project loads
 * are async. A 409 has error.status===409, error.isConflict===true and the server
 * code; it is never retried with a newer version behind the user's back.
 */
export function createCloudProjectStore(options={}){
  const fetcher=options.fetch??globalThis.fetch?.bind(globalThis);
  if(typeof fetcher!=='function')throw new CloudStoreError('当前环境不支持服务器访问。');
  const local=options.localStore??legacyProjectStore;
  const base=options.baseUrl??'/api';
  if(typeof base!=='string'||!base.startsWith('/')||base.startsWith('//')||/[?#]/.test(base))throw new CloudStoreError('服务器接口必须使用本站路径。');
  const prefix=base.replace(/\/$/,'');
  let mode='initializing',session=null,warning='',lists=[],activities=[],full=new Map(),namespace=null,authRevision=0,bootstrapRevision=0,preview=null,listRevision=0,listRead=0,activityRead=0,projectRefreshWarning='';
  const pendingCreates=new Map(),migratedLocalIds=new Set();
  const projectRevisions=new Map(),projectReads=new Map();

  function snapshot(){return {mode,session:clone(session),warning:translateSystemText(warning),projects:listProjects(),activities:listActivities(100)};}
  function notify(){try{options.onChange?.(snapshot());}catch{/* Host rendering errors must not corrupt storage state. */}}
  function clearCache(){lists=[];activities=[];full=new Map();preview=null;pendingCreates.clear();migratedLocalIds.clear();projectRevisions.clear();projectReads.clear();listRevision++;listRead++;activityRead++;projectRefreshWarning='';}
  function deactivate(nextMode,message=''){
    authRevision++;mode=nextMode;session=null;namespace=null;warning=message;clearCache();notify();
  }
  function cloudRequired(){
    if(mode!=='cloud'||!session)throw new CloudStoreError(mode==='anonymous'?'请先登录后访问企业项目。':'服务器项目尚未就绪，请稍后重试。',{status:mode==='anonymous'?401:503,code:mode==='anonymous'?'AUTH_REQUIRED':'CLOUD_UNAVAILABLE'});
  }
  function stale(token){if(token!==authRevision)throw new CloudStoreError('账户或工作空间已变化，本次结果已丢弃。',{code:'STALE_CONTEXT'});}
  const projectRevision=projectId=>projectRevisions.get(projectId)??0;
  function invalidateProject(projectId){projectRevisions.set(projectId,projectRevision(projectId)+1);listRevision++;}
  function staleProject(){return new CloudStoreError('项目状态已更新，本次过期结果已丢弃。',{code:'STALE_PROJECT'});}
  function knownProject(projectId){return lists.find(project=>project.id===projectId)??full.get(projectId);}
  function assertCurrentSummary(record){
    const current=knownProject(record.id);
    if(current&&(record.version<current.version||record.lifecycleVersion<current.lifecycleVersion))throw staleProject();
  }

  async function request(path,{method='GET',body,unscoped=false}={}){
    const token=authRevision;
    let response;
    try{
      response=await fetcher(`${prefix}${path}`,{method,credentials:'same-origin',mode:'same-origin',cache:'no-store',headers:body===undefined?{Accept:'application/json'}:{Accept:'application/json','Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    }catch(error){
      if(!unscoped)stale(token);
      throw new CloudStoreError('无法连接服务器，请检查网络后重试。',{code:'NETWORK_ERROR',details:String(error?.message??'')});
    }
    if(!unscoped)stale(token);
    let payload=null;
    try{if(response.status!==204)payload=await response.json();}
    catch{throw new CloudStoreError('服务器响应格式不正确，请稍后重试。',{status:response.status,code:'INVALID_RESPONSE'});}
    if(!unscoped)stale(token);
    if(!response.ok){
      const error=new CloudStoreError(payload?.error?.message||`服务器请求失败（${response.status}）。`,{status:response.status,code:payload?.error?.code??`HTTP_${response.status}`,details:payload?.error?.details});
      if(response.status===401&&!unscoped&&token===authRevision)deactivate('anonymous',error.message);
      throw error;
    }
    return payload;
  }

  function replaceLists(rows){
    if(!Array.isArray(rows))throw new CloudStoreError('项目列表响应无效。',{code:'INVALID_RESPONSE'});
    const seen=new Set();
    const next=rows.map(row=>{const record=remoteListRecord(row);if(seen.has(record.id))throw new CloudStoreError('项目列表含有重复记录。',{code:'INVALID_RESPONSE'});seen.add(record.id);return record;}).sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
    const previous=new Map(lists.map(project=>[project.id,project]));
    for(const record of next){const old=previous.get(record.id);if(!old||JSON.stringify(old)!==JSON.stringify(record))invalidateProject(record.id);previous.delete(record.id);}
    for(const projectId of previous.keys())invalidateProject(projectId);
    lists=next;
    for(const record of lists)if(record.migrationLocalId)migratedLocalIds.add(record.migrationLocalId);
    for(const [key,project]of full){const latest=lists.find(row=>row.id===key);if(!latest||latest.lifecycle==='deleted'||latest.version!==project.version)full.delete(key);else full.set(key,{...project,...clone(latest),data:project.data});}
  }
  function cacheSummary(record){
    assertCurrentSummary(record);
    const index=lists.findIndex(row=>row.id===record.id),previous=index<0?null:lists[index];
    if(!previous||JSON.stringify(previous)!==JSON.stringify(record))invalidateProject(record.id);
    if(index===-1)lists.push(clone(record));else lists[index]=clone(record);
    lists.sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
    const loaded=full.get(record.id);
    if(record.lifecycle==='deleted'||loaded&&loaded.version!==record.version)full.delete(record.id);
    else if(loaded)full.set(record.id,{...loaded,...clone(record),data:loaded.data});
  }
  function cacheProject(project){
    cacheSummary(remoteListRecord(project));
    if(project.lifecycle!=='deleted')full.set(project.id,clone(project));
    return clone(project);
  }
  function listProjects(options={}){
    const lifecycle=typeof options==='string'?options:options?.lifecycle;
    if(lifecycle!==undefined&&lifecycle!=='all'&&!LIFECYCLES.has(lifecycle))throw new CloudStoreError('项目状态筛选无效。');
    const rows=mode==='local'?local.listProjects():mode==='cloud'?lists:[];
    return clone(rows.filter(project=>{
      if(lifecycle==='all')return true;
      const state=project.lifecycle??'active';
      return lifecycle===undefined?state!=='deleted':state===lifecycle;
    }));
  }
  function getProject(projectId){return mode==='local'?local.getProject(projectId):mode==='cloud'&&full.has(projectId)&&full.get(projectId).lifecycle!=='deleted'?clone(full.get(projectId)):null;}
  async function refreshProjects(options={}){
    if(mode==='local')return listProjects(options);
    cloudRequired();
    const revision=listRevision,read=++listRead;
    const response=await request('/projects?lifecycle=all');
    if(read===listRead&&revision===listRevision){replaceLists(response?.projects);if(projectRefreshWarning){if(warning===projectRefreshWarning)warning='';projectRefreshWarning='';}}
    notify();return listProjects(options);
  }
  function listActivities(count=DEFAULT_LIMIT){return mode==='local'?local.listActivities(count):mode==='cloud'?clone(activities.filter(event=>knownProject(event.projectId)?.lifecycle!=='deleted').slice(0,limit(count))):[];}
  async function refreshActivities(){
    const revision=listRevision,read=++activityRead;
    const response=await request('/activities?limit=100');
    if(!Array.isArray(response?.activities))throw new CloudStoreError('操作记录响应无效。',{code:'INVALID_RESPONSE'});
    if(revision===listRevision&&read===activityRead)activities=clone(response.activities).slice(0,100);
  }
  function storageStatus(){
    if(mode==='local'){const status=local.storageStatus();return {...status,warning:translateSystemText(status.warning),mode,remote:false};}
    return {persistent:mode==='cloud'&&!warning,warning:translateSystemText(warning),mode,remote:mode==='cloud',accountId:session?.user.id??null};
  }

  async function bootstrap(){
    const operation=++bootstrapRevision,previousNamespace=namespace;
    authRevision++;mode='initializing';warning='';preview=null;notify();
    try{
      const response=await request('/session',{unscoped:true});
      if(operation!==bootstrapRevision)return snapshot();
      const nextSession=contextUser(response),nextNamespace=nextSession.user.id;
      if(nextNamespace!==previousNamespace)clearCache();
      session=nextSession;namespace=nextNamespace;
      const token=authRevision;
      const [projectsResponse,activityResponse]=await Promise.all([request('/projects?lifecycle=all'),request('/activities?limit=100')]);
      stale(token);
      if(operation!==bootstrapRevision)return snapshot();
      replaceLists(projectsResponse?.projects);
      if(!Array.isArray(activityResponse?.activities))throw new CloudStoreError('操作记录响应无效。',{code:'INVALID_RESPONSE'});
      activities=clone(activityResponse.activities).slice(0,100);mode='cloud';warning='';notify();return snapshot();
    }catch(error){
      if(operation!==bootstrapRevision||error.code==='STALE_CONTEXT')return snapshot();
      if(options.allowLocalFallback===true&&[404,501].includes(error.status)){
        authRevision++;session=null;namespace=null;clearCache();mode='local';warning='';notify();return snapshot();
      }
      deactivate(error.status===401?'anonymous':'unavailable',error.rawMessage??error.message);return snapshot();
    }
  }

  async function loadProject(projectId){
    id(projectId);
    if(mode==='local')return local.getProject(projectId);
    cloudRequired();
    const context=authRevision,revision=projectRevision(projectId),read=(projectReads.get(projectId)??0)+1;projectReads.set(projectId,read);
    const assertFresh=()=>{if(revision!==projectRevision(projectId)||read!==projectReads.get(projectId))throw staleProject();};
    try{
      const response=await request(`/projects/${encodeURIComponent(projectId)}`);
      assertFresh();
      const project=remoteProject(response?.project);
      if(project.id!==projectId)throw new CloudStoreError('服务器返回了不匹配的项目。',{code:'INVALID_RESPONSE'});
      const cached=cacheProject(project);warning='';notify();return cached;
    }catch(error){
      if(context===authRevision&&error.code!=='STALE_CONTEXT')assertFresh();
      if([403,404].includes(error.status)){full.delete(projectId);if(knownProject(projectId)?.lifecycle!=='deleted'){lists=lists.filter(row=>row.id!==projectId);invalidateProject(projectId);}activities=activities.filter(row=>row.projectId!==projectId);notify();}
      throw error;
    }
  }

  async function recordAnalysis(args){
    if(mode==='local')return local.recordAnalysis(args);
    cloudRequired();
    if(!args||typeof args!=='object')throw new CloudStoreError('请提供成功的分析结果。');
    const payload=summarizeAnalysis(args),kind=args.kind??(args.projectId?'settings':'import');
    let current=args.projectId?full.get(args.projectId):null,expectedVersion;
    if(args.projectId){
      id(args.projectId);
      if(has(args,'expectedVersion'))expectedVersion=version(args.expectedVersion);
      else {if(!current)current=await loadProject(args.projectId);expectedVersion=version(current.version);}
      if(current&&expectedVersion===current.version&&unchanged(current,payload)&&kind!=='reopen'){
        const latest=await loadProject(args.projectId);
        if(latest.version!==expectedVersion)throw new CloudStoreError('项目已被其他成员更新，请重新载入后再保存。',{status:409,code:'VERSION_CONFLICT',details:{currentVersion:latest.version}});
        if(unchanged(latest,payload))return {project:clone(latest),persisted:true,changed:false};
      }
    }
    const createKey=!args.projectId?JSON.stringify(payload):null;
    let mutationId=args.mutationId;
    if(!args.projectId){
      mutationId=mutationId??pendingCreates.get(createKey)??makeId();id(mutationId,'保存请求编号');
      pendingCreates.set(createKey,mutationId);
      if(pendingCreates.size>50)pendingCreates.delete(pendingCreates.keys().next().value);
    }
    try{
      if(args.projectId)invalidateProject(args.projectId);else listRevision++;
      const response=await request(args.projectId?`/projects/${encodeURIComponent(args.projectId)}`:'/projects',{
        method:args.projectId?'PUT':'POST',body:{data:payload.data,resultSummary:payload.resultSummary,preferences:payload.preferences,kind,...(args.projectId?{version:expectedVersion}:{mutationId})},
      });
      const project=remoteProject(response?.project);
      if(args.projectId&&project.id!==args.projectId)throw new CloudStoreError('服务器返回了不匹配的项目。',{code:'INVALID_RESPONSE'});
      cacheProject(project);if(createKey)pendingCreates.delete(createKey);warning='';
      try{await refreshActivities();}catch(error){if(error.code==='STALE_CONTEXT'||error.status===401)throw error;warning='项目已保存，操作记录暂未刷新。';}
      notify();return {project:clone(project),persisted:true,changed:!current||!unchanged(current,payload),...(mutationId?{mutationId}:{})};
    }catch(error){
      if(mutationId)error.mutationId=mutationId;
      if(error.code!=='STALE_CONTEXT'&&mode==='cloud'){warning=error.isConflict?'项目已被其他成员更新，请重新载入后再保存。当前分析尚未覆盖服务器内容。':`项目未确认保存：${error.rawMessage??error.message}`;notify();}
      throw error;
    }
  }

  async function removeProject(projectId,expectedVersion){
    id(projectId);if(mode==='local')return local.removeProject(projectId);cloudRequired();
    const known=full.get(projectId)??lists.find(row=>row.id===projectId);
    if(known?.lifecycleActions.includes('delete')){
      const result=await changeProjectLifecycle(projectId,'delete',{expectedVersion:expectedVersion??known.version,expectedLifecycleVersion:known.lifecycleVersion});
      return {removed:result.project.lifecycle==='deleted',persisted:true};
    }
    const requiredVersion=expectedVersion??known?.version??(await loadProject(projectId)).version;
    const body={version:version(requiredVersion)};
    invalidateProject(projectId);
    const response=await request(`/projects/${encodeURIComponent(projectId)}`,{method:'DELETE',body});
    invalidateProject(projectId);full.delete(projectId);lists=lists.filter(row=>row.id!==projectId);activities=activities.filter(row=>row.projectId!==projectId);warning='';
    try{await refreshProjects({lifecycle:'all'});}catch(error){if(error.status===401||error.code==='STALE_CONTEXT')throw error;warning='项目已删除，项目列表暂未刷新。';projectRefreshWarning=warning;}
    notify();
    return {removed:response?.removed!==false,persisted:true};
  }

  async function changeProjectLifecycle(projectId,action,options={}){
    id(projectId);cloudRequired();
    if(!LIFECYCLE_ACTIONS.has(action))throw new CloudStoreError('项目状态操作无效。');
    let known=knownProject(projectId);
    if((options.expectedVersion===undefined||options.expectedLifecycleVersion===undefined)&&!known){await refreshProjects({lifecycle:'all'});known=knownProject(projectId);}
    const expectedVersion=version(options.expectedVersion??known?.version);
    const expectedLifecycleVersion=lifecycleVersion(options.expectedLifecycleVersion??known?.lifecycleVersion);
    invalidateProject(projectId);
    const revision=projectRevision(projectId);
    const response=await request(`/projects/${encodeURIComponent(projectId)}/lifecycle`,{method:'POST',body:{action,expectedVersion,expectedLifecycleVersion}});
    let project=remoteListRecord(response?.project);
    if(project.id!==projectId||typeof response.changed!=='boolean')throw new CloudStoreError('项目状态响应无效，请刷新后核对。',{code:'INVALID_RESPONSE'});
    if(revision!==projectRevision(projectId)){
      const latest=knownProject(projectId);
      if(latest&&latest.version===project.version&&latest.lifecycleVersion===project.lifecycleVersion)project=clone(latest);
    }
    cacheSummary(project);invalidateProject(projectId);
    if(project.lifecycle==='deleted')activities=activities.filter(event=>event.projectId!==projectId);
    warning='';
    try{await refreshActivities();}catch(error){if(error.status===401||error.code==='STALE_CONTEXT')throw error;warning='项目状态已保存，操作记录暂未刷新。';}
    notify();return {project:clone(project),changed:response.changed,persisted:true};
  }

  async function recordExport(projectId,format,expectedVersion){
    id(projectId);if(!FORMATS.has(format))throw new CloudStoreError('不支持的导出格式。');
    if(mode==='local')return {project:local.getProject(projectId),format};
    cloudRequired();
    const known=full.get(projectId)??lists.find(row=>row.id===projectId);
    const requiredVersion=expectedVersion===undefined?known?.version:expectedVersion;
    const response=await request(`/projects/${encodeURIComponent(projectId)}/export`,{method:'POST',body:{format,expectedVersion:version(requiredVersion)}});
    if(response?.project)cacheProject(remoteProject(response.project));
    try{await refreshActivities();}catch(error){if(error.status===401||error.code==='STALE_CONTEXT')throw error;}
    notify();return clone(response);
  }

  async function listMembers(projectId){id(projectId);cloudRequired();const response=await request(`/projects/${encodeURIComponent(projectId)}/members`);if(!Array.isArray(response?.members))throw new CloudStoreError('成员列表响应无效。',{code:'INVALID_RESPONSE'});return clone(response);}
  async function saveMember(projectId,member){
    id(projectId);cloudRequired();
    if(!member||!ROLES.has(member.role)||typeof member.canExport!=='boolean')throw new CloudStoreError('请确认成员角色和导出权限。');
    const existing=member.userId!==undefined;
    if(existing)id(member.userId,'成员编号');
    else if(typeof member.email!=='string'||!member.email.trim()||member.email.length>320)throw new CloudStoreError('请填写成员邮箱。');
    const response=await request(`/projects/${encodeURIComponent(projectId)}/members${existing?`/${encodeURIComponent(member.userId)}`:''}`,{method:existing?'PATCH':'POST',body:{...(existing?{}:{email:member.email.trim()}),role:member.role,canExport:member.canExport}});
    return clone(response);
  }
  async function removeMember(projectId,member){
    id(projectId);cloudRequired();const userId=typeof member==='string'?member:member?.userId;id(userId,'成员编号');
    const response=await request(`/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,{method:'DELETE'});
    if(userId===session?.user.id){full.delete(projectId);lists=lists.filter(row=>row.id!==projectId);activities=activities.filter(row=>row.projectId!==projectId);notify();}
    return clone(response);
  }
  async function readAudit(projectId,options={}){
    if(projectId&&typeof projectId==='object'){options=projectId;projectId=options.projectId;}
    id(projectId);cloudRequired();
    const params=new URLSearchParams();
    if(options.limit!==undefined)params.set('limit',String(limit(options.limit,100)));
    if(options.cursor!==undefined&&options.cursor!==null){
      if(typeof options.cursor!=='string'||options.cursor.length>2000)throw new CloudStoreError('审计记录分页标识无效。');
      params.set('cursor',options.cursor);
    }
    const suffix=params.size?`?${params.toString()}`:'';
    const response=await request(`/projects/${encodeURIComponent(projectId)}/audit${suffix}`);
    if(!Array.isArray(response?.events))throw new CloudStoreError('审计记录响应无效。',{code:'INVALID_RESPONSE'});
    return clone(response);
  }

  function reviewPath(projectId,reviewId){
    id(projectId);
    if(reviewId!==undefined)id(reviewId,'复核编号');
    const base=`/projects/${encodeURIComponent(projectId)}/reviews`;
    return reviewId===undefined?base:`${base}/${encodeURIComponent(reviewId)}`;
  }

  async function listReviews(projectId){
    cloudRequired();
    const response=await request(reviewPath(projectId));
    if(!Array.isArray(response?.reviews))throw new CloudStoreError('复核列表响应无效。',{code:'INVALID_RESPONSE'});
    return response;
  }

  async function readReview(path,body){
    cloudRequired();
    const response=await request(path,body===undefined?{}:{method:'POST',body});
    if(!response?.review?.id||!response.review.content)throw new CloudStoreError('复核详情响应无效。',{code:'INVALID_RESPONSE'});
    if(body!==undefined){
      try{await refreshActivities();}catch(error){if(error.status===401||error.code==='STALE_CONTEXT')throw error;}
      notify();
    }
    return response.review;
  }

  async function mutateReview(projectId,path,body){
    cloudRequired();invalidateProject(projectId);
    const review=await readReview(path,body);
    invalidateProject(projectId);
    try{await refreshProjects({lifecycle:'all'});}
    catch(error){if(error.status===401||error.code==='STALE_CONTEXT')throw error;warning='复核已保存，项目状态暂未刷新。';projectRefreshWarning=warning;notify();}
    return review;
  }

  async function exportReview(projectId,reviewId,format){
    if(!REVIEW_FORMATS.has(format))throw new CloudStoreError('不支持的报告导出格式。');
    return readReview(`${reviewPath(projectId,reviewId)}/export`,{format});
  }

  function localMigrationProjects(){
    const history=local.listActivities(100),records=local.listProjects();
    return records.map(record=>{
      const project=local.getProject(record.id);
      if(!project)throw new CloudStoreError(`本地项目「${record.title}」无法读取，请先检查备份。`);
      return {localId:project.id,data:clone(project.data),resultSummary:clone(project.resultSummary),createdAt:project.createdAt,updatedAt:project.updatedAt,activities:history.filter(event=>event.projectId===project.id).map(event=>({id:event.id,kind:event.kind,timestamp:event.timestamp,label:event.label,detail:event.detail,projectTitle:event.projectTitle}))};
    });
  }
  function previewLocalMigration(){
    if(mode!=='cloud'||!session)return {previewId:null,count:0,historyCount:0,recordCount:0,projects:[],canMigrate:false,reason:t('请先登录并连接企业项目服务。','Sign in and connect to the workspace project service first.')};
    if(session.legacyMigrationAvailable===false)return null;
    const all=localMigrationProjects(),payload=all.filter(project=>!migratedLocalIds.has(project.localId)),previewId=makeId();
    preview={id:previewId,namespace,authRevision,payload,fingerprint:JSON.stringify(all),completed:new Map(),batches:[]};
    const projects=payload.map(project=>({id:project.localId,localId:project.localId,title:String(project.data.title||'未命名评估项目'),supplierCount:project.resultSummary.supplierCount,criterionCount:project.resultSummary.criterionCount,updatedAt:project.updatedAt,historyCount:project.activities.length,recordCount:project.activities.length}));
    const historyCount=projects.reduce((sum,project)=>sum+project.historyCount,0);
    return {previewId,count:projects.length,historyCount,recordCount:historyCount,projects,canMigrate:projects.length>0,reason:projects.length?'':all.length?t('此浏览器中的旧项目已迁移到当前账户。','The legacy projects in this browser have been migrated to the current account.'):t('此浏览器中没有可迁移的旧项目。','This browser has no legacy projects to migrate.')};
  }

  function migrationBatches(projects){
    const encoder=new TextEncoder(),overhead=encoder.encode(JSON.stringify({projects:[]})).byteLength,batches=[];
    let current=[],bytes=overhead;
    for(const project of projects){
      const size=encoder.encode(JSON.stringify(project)).byteLength;
      if(size+overhead>MIGRATION_MAX_BYTES)throw new CloudStoreError(`本地项目「${project.data.title||project.localId}」超过单次迁移的 6 MB 限制，请先导出备份并整理该项目。`,{status:413,code:'MIGRATION_PROJECT_TOO_LARGE'});
      const separator=current.length?1:0;
      if(current.length>=MIGRATION_MAX_PROJECTS||bytes+separator+size>MIGRATION_MAX_BYTES){batches.push(current);current=[];bytes=overhead;}
      bytes+=(current.length?1:0)+size;current.push(project);
    }
    if(current.length)batches.push(current);
    return batches;
  }

  function migrationProgress(plan,selected){
    const records=selected.map(localId=>plan.completed.get(localId)).filter(Boolean);
    const mappings=records.map(record=>clone(record.mapping));
    const projects=records.map(record=>clone(record.project));
    const associatedHistoryCount=records.reduce((sum,record)=>sum+record.historyCount,0);
    const selectedSet=new Set(selected),completeBatches=plan.batches.filter(batch=>batch.ids.every(localId=>selectedSet.has(localId)));
    const countedIds=new Set(completeBatches.flatMap(batch=>batch.ids));
    const importedHistoryKnown=records.every(record=>countedIds.has(record.localId))&&completeBatches.every(batch=>Number.isInteger(batch.historyImportedCount));
    const historyImportedCount=importedHistoryKnown?completeBatches.reduce((sum,batch)=>sum+batch.historyImportedCount,0):undefined;
    return {
      previewId:plan.id,totalCount:selected.length,completedCount:records.length,
      importedCount:records.filter(record=>!record.mapping.alreadyImported).length,
      skippedCount:records.filter(record=>record.mapping.alreadyImported).length,
      associatedHistoryCount,projects,mappings,
      remainingIds:selected.filter(localId=>!plan.completed.has(localId)),
      ...(importedHistoryKnown?{historyImportedCount,importedHistoryCount:historyImportedCount,historyCount:historyImportedCount,recordCount:historyImportedCount}:{}),
    };
  }

  async function migrateLocalProjects(args={}){
    cloudRequired();
    if(args.confirmed!==true)throw new CloudStoreError('请先预览本地项目，再明确确认迁移。',{code:'MIGRATION_CONFIRMATION_REQUIRED'});
    if(!preview||preview.namespace!==namespace||preview.authRevision!==authRevision||(args.previewId!==undefined&&args.previewId!==preview.id))throw new CloudStoreError('迁移预览已失效，请重新预览后确认。',{code:'MIGRATION_PREVIEW_REQUIRED'});
    const latest=localMigrationProjects();
    if(JSON.stringify(latest)!==preview.fingerprint)throw new CloudStoreError('本地项目或旧操作记录已变化，请重新预览后确认。',{code:'MIGRATION_PREVIEW_CHANGED'});
    const selected=args.ids===undefined?preview.payload.map(project=>project.localId):args.ids;
    if(!Array.isArray(selected)||!selected.length||new Set(selected).size!==selected.length||selected.some(value=>!preview.payload.some(project=>project.localId===value)))throw new CloudStoreError('请选择预览中的本地项目。');
    const plan=preview,token=authRevision;
    const remaining=plan.payload.filter(project=>selected.includes(project.localId)&&!plan.completed.has(project.localId));
    // Construct all batches first so an oversized item cannot cause a partial upload.
    const batches=migrationBatches(remaining);
    try{
      for(let index=0;index<batches.length;index++){
        stale(token);cloudRequired();
        const batch=batches[index];
        try{args.onProgress?.({...migrationProgress(plan,selected),batchIndex:index+1,batchCount:batches.length});}catch{/* Progress display must not interrupt a confirmed transfer. */}
        stale(token);
        const response=await request('/projects/migrate',{method:'POST',body:{projects:batch}});
        if(!Array.isArray(response?.projects)||!Number.isInteger(response.importedCount)||!Number.isInteger(response.skippedCount)||response.importedCount<0||response.skippedCount<0||response.importedCount+response.skippedCount!==batch.length||!Array.isArray(response.mappings)||response.mappings.length!==batch.length)throw new CloudStoreError('迁移结果响应无效，请重试并核对项目列表。',{code:'INVALID_RESPONSE'});
        const projectMap=new Map(response.projects.map(value=>{const record=remoteListRecord(value);return [record.id,record];})),seen=new Set();
        const confirmed=response.mappings.map(mapping=>{
          const source=batch.find(project=>project.localId===mapping.localId);
          if(!source||seen.has(mapping.localId)||typeof mapping.alreadyImported!=='boolean'||!projectMap.has(mapping.projectId))throw new CloudStoreError('迁移映射响应无效，请重试并核对项目列表。',{code:'INVALID_RESPONSE'});
          seen.add(mapping.localId);
          return {localId:source.localId,mapping:clone(mapping),project:projectMap.get(mapping.projectId),historyCount:source.activities.length};
        });
        if(confirmed.filter(item=>item.mapping.alreadyImported).length!==response.skippedCount)throw new CloudStoreError('迁移计数响应不一致，请重试并核对项目列表。',{code:'INVALID_RESPONSE'});
        for(const record of confirmed){
          plan.completed.set(record.localId,record);migratedLocalIds.add(record.localId);
          cacheSummary(record.project);
        }
        const historyImportedCount=response.historyImportedCount??response.importedHistoryCount??response.legacyImportedCount??response.historyCount;
        plan.batches.push({ids:batch.map(project=>project.localId),...(Number.isInteger(historyImportedCount)&&historyImportedCount>=0?{historyImportedCount}:{})});
        lists.sort((a,b)=>Date.parse(b.updatedAt)-Date.parse(a.updatedAt));
        warning='';notify();
      }
    }catch(error){
      if(error.code!=='STALE_CONTEXT'&&token===authRevision&&mode==='cloud'){
        const partial=migrationProgress(plan,selected);
        error.partial={...partial,canRetry:partial.remainingIds.length>0};
        const message=`已完成 ${partial.completedCount}/${selected.length} 个项目。${partial.remainingIds.length?'其余项目可使用相同确认重试。 ':''}${error.rawMessage??error.message}`;
        error.rawMessage=message;error.message=translateSystemText(message);
        warning=message;notify();
      }
      throw error;
    }
    stale(token);
    let refreshWarning='';
    try{
      await refreshProjects({lifecycle:'all'});
      await refreshActivities();
    }catch(error){
      if(error.status===401||error.code==='STALE_CONTEXT')throw error;
      refreshWarning='项目迁移已完成，项目列表或操作记录暂未刷新。';
    }
    const outcome=migrationProgress(plan,selected);
    warning=refreshWarning;
    try{args.onProgress?.({...outcome,batchIndex:batches.length,batchCount:batches.length});}catch{}
    notify();return {...clone(outcome),...(refreshWarning?{warning:translateSystemText(refreshWarning)}:{})};
  }

  function permissions(projectId){
    const project=getProject(projectId)??(mode==='cloud'?lists.find(row=>row.id===projectId):null);
    if(!project)return {role:null,canRead:false,canEdit:false,canManageMembers:false,canDelete:false,canExport:false};
    if(mode==='local')return {role:'administrator',canRead:true,canEdit:true,canManageMembers:false,canDelete:true,canExport:true};
    const readable=project.lifecycle!=='deleted',active=project.lifecycle==='active',administrator=project.role==='administrator';
    return {role:project.role,lifecycle:project.lifecycle,canRead:readable,canEdit:active&&(administrator||project.role==='evaluator'),canManageMembers:readable&&administrator,canDelete:administrator&&project.lifecycleActions.includes('delete'),canExport:readable&&project.canExport,canRestore:administrator&&project.lifecycleActions.includes('restore'),canDeactivate:administrator&&project.lifecycleActions.includes('deactivate'),canActivate:administrator&&project.lifecycleActions.includes('activate')};
  }

  return {
    bootstrap,refresh:bootstrap,snapshot,getSession:()=>clone(session),isCloud:()=>mode==='cloud',
    listProjects,getProject,listActivities,storageStatus,loadProject,refreshProjects,loadProjects:refreshProjects,recordAnalysis,removeProject,changeProjectLifecycle,
    restoreProject:(projectId,options)=>changeProjectLifecycle(projectId,'restore',options),
    deactivateProject:(projectId,options)=>changeProjectLifecycle(projectId,'deactivate',options),
    activateProject:(projectId,options)=>changeProjectLifecycle(projectId,'activate',options),
    recordExport,requestExport:recordExport,listMembers,saveMember,removeMember,readAudit,
    listReviews,loadReview:(projectId,reviewId)=>readReview(reviewPath(projectId,reviewId)),
    submitReview:(projectId,expectedVersion)=>mutateReview(projectId,reviewPath(projectId),{version:version(expectedVersion)}),
    decideReview:(projectId,reviewId,action,comment)=>mutateReview(projectId,`${reviewPath(projectId,reviewId)}/decision`,{action,comment}),
    exportReview,
    previewLocalMigration,migrateLocalProjects,permissions,
    clearSession(){bootstrapRevision++;deactivate('anonymous','已退出当前账户。');},
  };
}
