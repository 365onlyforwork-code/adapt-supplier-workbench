/**
 * ADAPT project API. The transport supplies a database and resolves an authenticated session.
 */
import {validateInput} from '../dist/engine.mjs';
import {normalizeEligibility} from '../dist/eligibility.mjs';
import {normalizeScenarios} from '../dist/scenarios.mjs';
import {normalizeDecision} from '../dist/decision-ui.mjs';
import {prepareReview} from './review-report.mjs';

const ROLES=new Set(['administrator','evaluator','viewer']);
const FORMATS=new Set(['adapt','csv','print','scenarios_csv']);
const REVIEW_EXPORT_LABELS=new Map([['html','采购评审报告 HTML'],['print','打印采购评审报告'],['pdf','采购评审报告 PDF']]);
const CHANGE_KINDS=new Set(['import','reopen','settings','comparison','resume','eligibility','scenarios','decision']);
const LABELS={import:'导入新项目',reopen:'打开评估文件',settings:'更新指标设置',comparison:'调整比较选项',resume:'继续评估',eligibility:'保存准入条件',scenarios:'更新评估方案',decision:'保存采购决策','project.viewed':'查看项目','project.exported':'导出项目','project.deleted':'删除项目','member.added':'添加项目成员','member.updated':'更新成员权限','member.removed':'移除项目成员','project.migrated':'迁移浏览器项目','workspace.opened':'访问工作台','audit.viewed':'查看操作日志'};
Object.assign(LABELS,{'review.submitted':'提交采购复核','review.confirmed':'确认定标并生成报告','review.returned':'退回采购复核','review.exported':'导出采购评审报告'});
Object.assign(LABELS,{'project.deactivated':'移出活跃列表','project.activated':'恢复到活跃列表','project.restored':'恢复项目'});
const MAX_BYTES=6*1024*1024,MAX_MIGRATION_PROJECTS=50,MAX_LEGACY_EVENTS=500;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const clone=value=>JSON.parse(JSON.stringify(value));
const uuid=()=>crypto.randomUUID();
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);

class ApiError extends Error{constructor(status,code,message,details){super(message);this.status=status;this.code=code;this.details=details;}}
const fail=(status,code,message,details)=>{throw new ApiError(status,code,message,details);};
function text(value,name,max=200,{optional=false}={}){
  if(optional&&(value===undefined||value===null))return null;
  if(typeof value!=='string'||!value.trim()||value.length>max)fail(400,'INVALID_INPUT',`${name}无效。`);
  return value.trim();
}
const prepared=(db,sql,bindings=[])=>db.prepare(sql).bind(...bindings);
const first=(db,sql,bindings=[])=>prepared(db,sql,bindings).first();
async function all(db,sql,bindings=[]){const result=await prepared(db,sql,bindings).all();return result.results??[];}
const changed=result=>Number(result?.meta?.changes??result?.changes??0);
function json(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'}});}
async function body(request){
  if(!request.headers.get('content-type')?.toLowerCase().includes('application/json'))fail(415,'UNSUPPORTED_MEDIA_TYPE','请使用 JSON 请求。');
  const length=Number(request.headers.get('content-length')??0);if(length>MAX_BYTES)fail(413,'PAYLOAD_TOO_LARGE','请求数据过大，请分批处理。');
  const bytes=await request.arrayBuffer();if(bytes.byteLength>MAX_BYTES)fail(413,'PAYLOAD_TOO_LARGE','请求数据过大，请分批处理。');
  try{const value=JSON.parse(new TextDecoder().decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}
  catch{fail(400,'INVALID_INPUT','请求内容不是有效的 JSON 对象。');}
}
function expectedVersion(input){
  const version=input.expectedVersion??input.version;
  if(!Number.isInteger(version)||version<1)fail(400,'INVALID_INPUT','请提供当前项目版本。');
  return version;
}
function assertVersion(row,version){if(row.version!==version)fail(409,'VERSION_CONFLICT','项目已由其他成员更新，请重新载入后再保存。',{expectedVersion:version,currentVersion:row.version});}
function lifecycleVersion(input){
  const value=input.expectedLifecycleVersion;
  if(!Number.isInteger(value)||value<0)fail(400,'INVALID_INPUT','请提供当前项目状态版本。');
  return value;
}
function assertLifecycleVersion(row,version){if(row.lifecycle_version!==version)fail(409,'LIFECYCLE_CONFLICT','项目状态已改变，请重新载入后再操作。',{expectedLifecycleVersion:version,currentLifecycleVersion:row.lifecycle_version});}
function boundedLimit(url,defaultValue=20){const raw=url.searchParams.get('limit');if(raw===null)return defaultValue;const value=Number(raw);if(!Number.isInteger(value)||value<1||value>100)fail(400,'INVALID_INPUT','日志数量应为 1–100。');return value;}
function readCursor(url){
  const raw=url.searchParams.get('cursor');if(!raw)return null;
  try{
    if(raw.length>1200)throw new Error();
    const value=JSON.parse(atob(raw.replace(/-/g,'+').replace(/_/g,'/')));
    if(typeof value.t!=='string'||!Number.isFinite(Date.parse(value.t))||typeof value.id!=='string'||!value.id||value.id.length>200)throw new Error();
    return value;
  }catch{fail(400,'INVALID_INPUT','日志分页标识无效。');}
}
const encodeCursor=row=>btoa(JSON.stringify({t:row.occurred_at,id:row.id})).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

async function stableId(prefix,value){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));return `${prefix}_${Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('').slice(0,40)}`;}

function canonicalPayload(input){
  try{
    const raw=input.data;if(!raw||typeof raw!=='object')throw new Error('缺少项目数据');
    const p=input.preferences?.p??raw.p??.9,delta=own(input.preferences??{},'delta')?input.preferences.delta:(raw.delta??null);
    const data={...clone(raw),...validateInput({...raw,p,delta}),p,delta};
    data.title=text(raw.title??'未命名评估项目','项目名称',200);
    if(data.suppliers.some(s=>s.id.length>200||s.name.length>200)||data.criteria.some(c=>c.id.length>200||c.name.length>200))throw new Error('供应商或指标名称过长');
    if(raw.procurement!==undefined){
      if(!raw.procurement||typeof raw.procurement!=='object')throw new Error('采购设置无效');
      data.procurement={eligibility:normalizeEligibility(data,raw.procurement.eligibility),scenarios:normalizeScenarios(data,raw.procurement.scenarios??[]),decision:normalizeDecision(raw.procurement.decision,data.suppliers)};
    }
    const summary=input.resultSummary,n=data.suppliers.length,count=n*(n-1)/2;
    if(!summary||summary.supplierCount!==n||summary.criterionCount!==data.criteria.length||summary.comparisonCount!==count)throw new Error('项目摘要与原始数据不一致');
    for(const key of ['unresolvedCount','equivalentCount','separableCount'])if(!Number.isInteger(summary[key])||summary[key]<0||summary[key]>count)throw new Error('项目比较计数无效');
    if(summary.unresolvedCount+summary.equivalentCount+summary.separableCount!==count)throw new Error('项目比较计数不完整');
    if(!Array.isArray(summary.leaderIds)||!summary.leaderIds.length||new Set(summary.leaderIds).size!==summary.leaderIds.length||summary.leaderIds.some(id=>!data.suppliers.some(s=>s.id===id)))throw new Error('项目首位供应商无效');
    if(!finite(summary.bestScore)||summary.bestScore<0||summary.bestScore>1+1e-12||!finite(summary.delta)||summary.delta<0||summary.p!==p||summary.sampleCount!==data.sampleCount||delta!==null&&summary.delta!==delta)throw new Error('项目结果参数无效');
    const resultSummary={supplierCount:n,criterionCount:data.criteria.length,comparisonCount:count,unresolvedCount:summary.unresolvedCount,equivalentCount:summary.equivalentCount,separableCount:summary.separableCount,leaderIds:[...summary.leaderIds],leaderNames:summary.leaderIds.map(id=>data.suppliers.find(s=>s.id===id).name),bestScore:summary.bestScore,sampleCount:data.sampleCount,p,delta:summary.delta};
    const preferences={p,delta,deltaMode:delta===null?'auto':'explicit'},source=clone(data.source??null);
    return {data,resultSummary,preferences,source,title:data.title};
  }catch(error){if(error instanceof ApiError)throw error;fail(400,'INVALID_INPUT',error.message||'项目数据无效。');}
}

const MIGRATION_LOCAL_ID=`(SELECT lm.local_id FROM local_migrations lm WHERE lm.project_id=p.id AND lm.user_id=m.user_id AND lm.completed_at IS NOT NULL LIMIT 1) AS migration_local_id`;
const REVIEW_STATE_SQL=`EXISTS (SELECT 1 FROM project_reviews r WHERE r.project_id=p.id AND r.status='pending') AS has_pending_review,
  EXISTS (SELECT 1 FROM project_reviews r WHERE r.project_id=p.id AND r.status='confirmed') AS has_confirmed_review,
  EXISTS (SELECT 1 FROM project_reviews r WHERE r.project_id=p.id AND r.status='returned') AS has_returned_review`;
const PROJECT_FIELDS=`p.*,m.role,m.can_export,${MIGRATION_LOCAL_ID},${REVIEW_STATE_SQL}`;
const ACCESS_SQL=`SELECT ${PROJECT_FIELDS} FROM projects p JOIN project_members m ON m.project_id=p.id WHERE p.id=? AND m.user_id=?`;
const projectLifecycle=row=>row.deleted_at?'deleted':row.inactive_at?'inactive':'active';
async function access(db,id,user,action='read',{includeDeleted=false}={}){
  const row=await first(db,ACCESS_SQL,[id,user.id]);
  if(!row||row.deleted_at&&!includeDeleted)fail(404,'NOT_FOUND','项目不存在或你没有访问权限。');
  if(action==='write'&&row.role==='viewer'||action==='admin'&&row.role!=='administrator'||action==='export'&&!row.can_export)fail(403,'FORBIDDEN','你没有执行此操作的项目权限。');
  if(action==='write'&&projectLifecycle(row)!=='active')fail(409,'PROJECT_INACTIVE','项目已移出活跃列表，请先恢复再修改。');
  return row;
}
function projectDTO(row,full=true){
  const data=JSON.parse(row.data_json),summary=JSON.parse(row.summary_json),preferences=JSON.parse(row.preferences_json),source=JSON.parse(row.source_json);
  const lifecycle=projectLifecycle(row),reviewState=row.has_pending_review?'pending':row.has_confirmed_review?'archived':row.has_returned_review?'returned':'unsubmitted';
  const lifecycleActions=[];
  if(row.role==='administrator'){
    if(lifecycle==='deleted')lifecycleActions.push('restore');
    else if(lifecycle==='inactive')lifecycleActions.push('activate');
    else if(!row.has_pending_review)lifecycleActions.push(row.has_confirmed_review?'deactivate':'delete');
  }
  const project={id:row.id,title:row.title,createdAt:row.created_at,updatedAt:row.updated_at,version:row.version,role:row.role,canExport:!!row.can_export,migrationLocalId:row.migration_local_id??null,lifecycle,inactiveAt:row.inactive_at??null,deletedAt:row.deleted_at??null,lifecycleVersion:row.lifecycle_version,reviewState,lifecycleActions,permissions:{canWrite:row.role!=='viewer'&&lifecycle==='active',canManage:row.role==='administrator',canViewAudit:row.role==='administrator'&&lifecycle!=='deleted',canExport:!!row.can_export&&lifecycle!=='deleted'},supplierCount:summary.supplierCount,criterionCount:summary.criterionCount,unresolvedCount:summary.unresolvedCount,status:summary.unresolvedCount?'needs-review':'complete',statusLabel:summary.unresolvedCount?'待明确':'评估完成',resultSummary:summary,preferences,source};
  if(full)project.data=data;return project;
}
function eventDTO(row){return {id:row.id,projectId:row.project_id,projectTitle:row.project_title,kind:row.kind,label:row.label,detail:row.detail,timestamp:row.occurred_at,source:row.source,version:row.version,legacyId:row.legacy_id,actor:row.source==='legacy'?null:{id:row.actor_id,email:row.actor_email,name:row.actor_name},actorLabel:row.source==='legacy'?'旧版浏览器记录':row.actor_name??row.actor_email??'系统',metadata:JSON.parse(row.metadata_json)};}
function eventValues({id,project,user,kind,timestamp,detail='',metadata={},source='server',legacyId=null,label,projectTitle}){
  return [id,project?.id??null,projectTitle??project?.title??'',source==='legacy'?null:user?.id??null,source==='legacy'?null:user?.email??null,source==='legacy'?null:user?.name??null,kind,label??LABELS[kind]??kind,detail,timestamp,source,project?.version??null,JSON.stringify(metadata),legacyId];
}
const EVENT_COLUMNS='id,project_id,project_title,actor_id,actor_email,actor_name,kind,label,detail,occurred_at,source,version,metadata_json,legacy_id';
function eventStatement(db,event,condition='',bindings=[]){
  const values=eventValues(event),marks=values.map(()=>'?').join(',');
  return prepared(db,`INSERT OR IGNORE INTO audit_events (${EVENT_COLUMNS}) SELECT ${marks}${condition?` WHERE ${condition}`:''}`,[...values,...bindings]);
}
const versionStatement=(db,id,operation,user,kind,timestamp)=>prepared(db,`INSERT OR IGNORE INTO project_versions (project_id,version,data_json,summary_json,preferences_json,changed_by,changed_at,kind) SELECT id,version,data_json,summary_json,preferences_json,?,?,? FROM projects WHERE id=? AND last_operation_id=?`,[user.id,timestamp,kind,id,operation]);

function membershipInput(input){
  if(!ROLES.has(input.role)||typeof input.canExport!=='boolean')fail(400,'INVALID_INPUT','请明确选择项目角色和导出权限。');
  return {role:input.role,canExport:input.canExport};
}
const MEMBER_SQL=`SELECT m.user_id,m.role,m.can_export,m.joined_at,u.email,u.name FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=?`;
const memberDTO=row=>({userId:row.user_id,email:row.email,name:row.name,role:row.role,canExport:!!row.can_export,joinedAt:row.joined_at});

const REVIEW_COLUMNS='id,project_id,project_version,project_title,status,submitted_name,submitted_at,reviewed_name,reviewed_at,review_comment';
function reviewDTO(row,full=false){
  const review={
    id:row.id,projectId:row.project_id,version:row.project_version,title:row.project_title,status:row.status,
    submittedBy:row.submitted_name,submittedAt:row.submitted_at,
    reviewedBy:row.reviewed_name,reviewedAt:row.reviewed_at,comment:row.review_comment,
  };
  if(full)review.content=JSON.parse(row.content_json);
  return review;
}
async function loadReview(db,projectId,id){
  const review=await first(db,'SELECT * FROM project_reviews WHERE project_id=? AND id=?',[projectId,id]);
  if(!review)fail(404,'NOT_FOUND','复核记录不存在。');
  return review;
}

/** Identity is injected by the Worker. The handler fails closed without a resolver. */
export function createApiHandler({resolveIdentity=()=>null,authentication='adapt-account',now=()=>new Date().toISOString(),idFactory=uuid,onError=()=>{}}={}){
  async function audit(db,{project,user,kind,label,detail='',metadata={},timestamp=now(),id=idFactory()}){await eventStatement(db,{id,project,user,kind,label,detail,metadata,timestamp}).run();}

  async function changeLifecycle(db,id,user,input,{legacyDelete=false}={}){
    const current=await access(db,id,user,'admin',{includeDeleted:true});
    const action=legacyDelete?'delete':input.action;
    if(!['delete','restore','deactivate','activate'].includes(action))fail(400,'INVALID_INPUT','请选择有效的项目操作。');
    const version=legacyDelete&&input.version===undefined&&input.expectedVersion===undefined?current.version:expectedVersion(input);
    const stateVersion=legacyDelete&&input.expectedLifecycleVersion===undefined?current.lifecycle_version:lifecycleVersion(input);
    assertVersion(current,version);assertLifecycleVersion(current,stateVersion);
    const fromLifecycle=projectLifecycle(current);
    function checkReviewProtection(row){
      if((action==='delete'||action==='deactivate')&&row.has_pending_review)fail(409,'REVIEW_PENDING','项目有待复核版本，请先完成复核。');
      if(action==='delete'&&row.has_confirmed_review)fail(409,'PROJECT_ARCHIVED','项目已有归档报告，请使用停用功能。');
      if(action==='deactivate'&&!row.has_confirmed_review)fail(409,'PROJECT_NOT_ARCHIVED','未归档项目请使用删除功能。');
    }
    checkReviewProtection(current);
    if(action==='delete'&&fromLifecycle==='inactive')fail(409,'PROJECT_STATE_CONFLICT','请先恢复项目，再执行其他操作。');
    const unchanged=action==='delete'&&fromLifecycle==='deleted'||action==='restore'&&fromLifecycle!=='deleted'||action==='deactivate'&&fromLifecycle==='inactive'||action==='activate'&&fromLifecycle==='active';
    if(unchanged)return json(legacyDelete?{removed:true}:{project:projectDTO(current,false),changed:false});
    if(fromLifecycle==='deleted'&&action!=='restore')fail(409,'PROJECT_STATE_CONFLICT','请先从回收站恢复项目。');
    const operation=idFactory(),at=now();
    const toLifecycle=action==='delete'?'deleted':action==='deactivate'?'inactive':action==='restore'&&(current.inactive_at||current.has_confirmed_review)?'inactive':'active';
    const inactiveAt=toLifecycle==='active'?null:toLifecycle==='inactive'?(current.inactive_at??at):current.inactive_at;
    const deletedAt=toLifecycle==='deleted'?at:null;
    const stateGuard=action==='restore'?'deleted_at IS NOT NULL':action==='activate'?'deleted_at IS NULL AND inactive_at IS NOT NULL':'deleted_at IS NULL AND inactive_at IS NULL';
    const reviewGuard=(action==='delete'||action==='deactivate')?` AND NOT EXISTS (SELECT 1 FROM project_reviews r WHERE r.project_id=projects.id AND r.status='pending') AND ${action==='delete'?'NOT ':''}EXISTS (SELECT 1 FROM project_reviews r WHERE r.project_id=projects.id AND r.status='confirmed')`:'';
    const kind={delete:'project.deleted',restore:'project.restored',deactivate:'project.deactivated',activate:'project.activated'}[action];
    const statements=[prepared(db,`UPDATE projects SET inactive_at=?,deleted_at=?,lifecycle_version=lifecycle_version+1,updated_at=?,last_operation_id=?
      WHERE id=? AND version=? AND lifecycle_version=? AND ${stateGuard}${reviewGuard}
      AND EXISTS (SELECT 1 FROM project_members WHERE project_id=? AND user_id=? AND role='administrator')`,
      [inactiveAt,deletedAt,at,operation,id,version,stateVersion,id,user.id])];
    // Old soft deletion advanced the assessment version without writing its
    // snapshot. Repair that one missing version on restore, never overwrite it.
    if(action==='restore')statements.push(versionStatement(db,id,operation,user,kind,at));
    statements.push(eventStatement(db,{id:operation,project:current,user,kind,timestamp:at,metadata:{fromLifecycle,toLifecycle,fromLifecycleVersion:stateVersion,toLifecycleVersion:stateVersion+1,version}},'EXISTS (SELECT 1 FROM projects WHERE id=? AND last_operation_id=?)',[id,operation]));
    const results=await db.batch(statements);
    if(!changed(results[0])){
      const latest=await access(db,id,user,'admin',{includeDeleted:true});
      assertVersion(latest,version);assertLifecycleVersion(latest,stateVersion);checkReviewProtection(latest);
      fail(409,'PROJECT_STATE_CONFLICT','项目状态已改变，请重新载入后再操作。');
    }
    return json(legacyDelete?{removed:true}:{project:projectDTO(await access(db,id,user,'admin',{includeDeleted:true}),false),changed:true});
  }

  async function submitReview(db,id,user,request){
    const project=await access(db,id,user,'write');
    const version=expectedVersion(await body(request));
    async function existingReview(){
      return first(db,`SELECT * FROM project_reviews
        WHERE project_id=? AND (status='pending' OR (project_version=? AND status='confirmed'))
        ORDER BY (project_version=?) DESC LIMIT 1`,[id,version,version]);
    }
    const existing=await existingReview();
    if(existing?.project_version===version)return json({review:reviewDTO(existing,true)});
    if(existing)fail(409,'REVIEW_PENDING','已有一版评估待复核，请先完成该版本。');
    assertVersion(project,version);
    const stored=await first(db,'SELECT data_json,summary_json,changed_at FROM project_versions WHERE project_id=? AND version=?',[id,version]);
    if(!stored)fail(409,'REVIEW_VERSION_MISSING','当前评估还没有可复核的保存版本。');
    const {content,error}=prepareReview(stored);
    if(error)fail(400,'REVIEW_DECISION_REQUIRED',error);

    const reviewId=idFactory(),timestamp=now();
    const results=await db.batch([
      prepared(db,`INSERT OR IGNORE INTO project_reviews
        (id,project_id,project_version,project_title,status,content_json,submitted_by,submitted_name,submitted_at)
        SELECT ?,p.id,p.version,p.title,'pending',?,?,?,? FROM projects p JOIN project_members m ON m.project_id=p.id
        WHERE p.id=? AND p.version=? AND p.lifecycle_version=? AND p.deleted_at IS NULL AND p.inactive_at IS NULL AND m.user_id=? AND m.role IN ('administrator','evaluator')
        AND NOT EXISTS (SELECT 1 FROM project_reviews r WHERE r.project_id=p.id AND r.project_version=p.version AND r.status='confirmed')`,
        [reviewId,JSON.stringify(content),user.id,user.name,timestamp,id,version,project.lifecycle_version,user.id]),
      eventStatement(db,{id:idFactory(),project:{...project,version},user,kind:'review.submitted',detail:`评估 V${version}`,timestamp,metadata:{reviewId,version}},
        'EXISTS (SELECT 1 FROM project_reviews WHERE id=?)',[reviewId]),
    ]);
    if(!changed(results[0])){
      const latest=await access(db,id,user,'write');
      assertLifecycleVersion(latest,project.lifecycle_version);
      const other=await existingReview();
      if(other?.project_version===version)return json({review:reviewDTO(other,true)});
      if(other)fail(409,'REVIEW_PENDING','已有一版评估待复核，请先完成该版本。');
      assertVersion(latest,version);
      fail(409,'REVIEW_CONFLICT','复核状态有变化，请刷新后重试。');
    }
    return json({review:reviewDTO(await loadReview(db,id,reviewId),true)},201);
  }

  async function decideReview(db,projectId,reviewId,user,request){
    const project=await access(db,projectId,user,'admin');
    const input=await body(request);
    const status={confirm:'confirmed',return:'returned'}[input.action];
    if(status!=='confirmed'&&status!=='returned')fail(400,'INVALID_INPUT','请选择确认或退回。');
    if(input.comment!==undefined&&(typeof input.comment!=='string'||input.comment.length>1200))fail(400,'INVALID_INPUT','复核意见不超过 1200 字。');
    const review=await loadReview(db,projectId,reviewId);
    if(review.status===status)return json({review:reviewDTO(review,true)});
    if(review.status!=='pending')fail(409,'REVIEW_ALREADY_DECIDED','此版本的复核已经完成。');
    if(project.inactive_at)fail(409,'PROJECT_INACTIVE','项目已移出活跃列表，请先恢复再修改。');
    const operation=idFactory(),timestamp=now();
    const results=await db.batch([
      prepared(db,`UPDATE project_reviews
        SET status=?,reviewed_by=?,reviewed_name=?,reviewed_at=?,review_comment=?,decision_operation_id=?
        WHERE id=? AND project_id=? AND status='pending'
        AND EXISTS (SELECT 1 FROM project_members m JOIN projects p ON p.id=m.project_id
          WHERE p.id=? AND p.lifecycle_version=? AND p.deleted_at IS NULL AND p.inactive_at IS NULL AND m.user_id=? AND m.role='administrator')`,
        [status,user.id,user.name,timestamp,input.comment?.trim()??'',operation,reviewId,projectId,projectId,project.lifecycle_version,user.id]),
      eventStatement(db,{
        id:operation,project:{id:projectId,title:review.project_title,version:review.project_version},user,
        kind:status==='confirmed'?'review.confirmed':'review.returned',detail:`评估 V${review.project_version}`,
        timestamp,metadata:{reviewId,version:review.project_version},
      },'EXISTS (SELECT 1 FROM project_reviews WHERE id=? AND decision_operation_id=?)',[reviewId,operation]),
    ]);
    if(!changed(results[0])){
      const current=await access(db,projectId,user,'admin');
      if(current.inactive_at)fail(409,'PROJECT_INACTIVE','项目已移出活跃列表，请先恢复再修改。');
      assertLifecycleVersion(current,project.lifecycle_version);
      const latest=await loadReview(db,projectId,reviewId);
      if(latest.status===status)return json({review:reviewDTO(latest,true)});
      fail(409,'REVIEW_ALREADY_DECIDED','此版本的复核已经完成。');
    }
    return json({review:reviewDTO(await loadReview(db,projectId,reviewId),true)});
  }

  async function createProject(db,user,payload,{kind='import',mutationId=null,migration=null}={}){
    const operation=idFactory(),timestamp=now();
    const id=migration?await stableId('migrated',`${user.id}\0${migration.localId}`):mutationId?await stableId('project',`${user.id}\0${mutationId}`):`project_${idFactory()}`;
    const existing=await first(db,'SELECT id FROM projects WHERE id=?',[id]);
    if(existing)return {row:await access(db,id,user),created:false};
    let createdAt=migration?.createdAt??timestamp,updatedAt=migration?.updatedAt??timestamp;
    if(Date.parse(updatedAt)<Date.parse(createdAt)){createdAt=timestamp;updatedAt=timestamp;}
    const bindings=[id,payload.title,JSON.stringify(payload.data),JSON.stringify(payload.resultSummary),JSON.stringify(payload.preferences),JSON.stringify(payload.source),user.id,createdAt,updatedAt,operation,operation,mutationId];
    const row={id,title:payload.title,version:1};
    const statements=[prepared(db,`INSERT OR IGNORE INTO projects (id,title,data_json,summary_json,preferences_json,source_json,created_by,created_at,updated_at,creation_token,last_operation_id,mutation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,bindings),
      prepared(db,`INSERT OR IGNORE INTO project_members (project_id,user_id,role,can_export,joined_at,last_operation_id) SELECT id,?,'administrator',1,?,? FROM projects WHERE id=? AND creation_token=?`,[user.id,timestamp,operation,id,operation]),
      versionStatement(db,id,operation,user,migration?'project.migrated':kind,timestamp),
      eventStatement(db,{id:operation,project:row,user,kind:migration?'project.migrated':kind,timestamp,detail:`${payload.resultSummary.supplierCount} 家供应商 · ${payload.resultSummary.criterionCount} 项指标`,metadata:migration?{localId:migration.localId,legacyRecords:migration.activities.length,originalCreatedAt:migration.createdAt,originalUpdatedAt:migration.updatedAt}:{mutationId}},'EXISTS (SELECT 1 FROM projects WHERE id=? AND creation_token=?)',[id,operation])];
    if(migration)statements.push(prepared(db,`INSERT OR IGNORE INTO local_migrations (user_id,local_id,project_id,local_created_at,local_updated_at,migrated_at) SELECT ?,?,id,?,?,? FROM projects WHERE id=? AND created_by=?`,[user.id,migration.localId,migration.createdAt,migration.updatedAt,timestamp,id,user.id]));
    const results=await db.batch(statements);
    return {row:await access(db,id,user),created:changed(results[0])>0};
  }

  return async function handleApi(request,env){
    const url=new URL(request.url),method=request.method.toUpperCase();
    try{
      if(!url.pathname.startsWith('/api/')&&url.pathname!=='/api')return json({error:{code:'NOT_FOUND',message:'接口不存在。'}},404);
      if(!['GET','POST','PUT','PATCH','DELETE'].includes(method))fail(405,'METHOD_NOT_ALLOWED','此接口不支持该请求方式。');
      if(method!=='GET'){
        const origin=request.headers.get('origin');
        if(origin&&origin!==url.origin)fail(403,'FORBIDDEN','不允许跨站修改项目。');
        if(request.headers.get('sec-fetch-site')==='cross-site')fail(403,'FORBIDDEN','不允许跨站修改项目。');
      }
      const db=env?.DB;
      if(!db||typeof db.prepare!=='function'||typeof db.batch!=='function')fail(503,'BACKEND_NOT_CONFIGURED','企业项目数据库尚未配置完成。');
      const user=await resolveIdentity(request,env);
      if(!user)fail(401,'UNAUTHENTICATED','请先登录后再使用企业项目。');
      const timestamp=now();
      await prepared(db,`INSERT INTO users (id,email,email_key,name,created_at,last_seen_at) VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,email_key=excluded.email_key,name=excluded.name,last_seen_at=excluded.last_seen_at`,[user.id,user.email,user.email.toLowerCase(),user.name,timestamp,timestamp]).run();
      const segments=url.pathname.replace(/^\/api\/?/,'').split('/').filter(Boolean).map(segment=>{try{return decodeURIComponent(segment);}catch{fail(400,'INVALID_INPUT','接口路径无效。');}});

      if(segments[0]==='session'&&segments.length===1&&method==='GET'){
        const cutoff=new Date(Date.parse(timestamp)-15*60*1000).toISOString();
        if(!await first(db,`SELECT id FROM audit_events WHERE actor_id=? AND kind='workspace.opened' AND occurred_at>=? LIMIT 1`,[user.id,cutoff]))await audit(db,{user,kind:'workspace.opened',timestamp});
        return json({user,authentication,storage:'sqlite'});
      }
      if(segments[0]==='activities'&&segments.length===1&&method==='GET'){
        const limit=boundedLimit(url),projectId=url.searchParams.get('projectId');
        if(projectId)await access(db,projectId,user);
        // Only project administrators see other actors' details or legacy logs.
        // Personal workspace visits are not clickable project activity records.
        const rows=await all(db,`SELECT a.* FROM audit_events a WHERE a.project_id IS NOT NULL AND ${projectId?'a.project_id=? AND ':''}EXISTS (SELECT 1 FROM project_members m WHERE m.project_id=a.project_id AND m.user_id=? AND (m.role='administrator' OR a.actor_id=?)) ORDER BY julianday(a.occurred_at) DESC,a.id DESC LIMIT ?`,[...(projectId?[projectId]:[]),user.id,user.id,limit]);
        return json({activities:rows.map(eventDTO)});
      }
      if(segments[0]!=='projects')fail(404,'NOT_FOUND','接口不存在。');

      if(segments.length===1&&method==='GET'){
        const selection=url.searchParams.get('lifecycle')??'active';
        const states=selection==='all'?['active','inactive','deleted']:selection.split(',');
        if(!states.length||states.some(state=>!['active','inactive','deleted'].includes(state)))fail(400,'INVALID_INPUT','项目状态筛选无效。');
        const filters={active:'p.deleted_at IS NULL AND p.inactive_at IS NULL',inactive:'p.deleted_at IS NULL AND p.inactive_at IS NOT NULL',deleted:"p.deleted_at IS NOT NULL AND m.role='administrator'"};
        const rows=await all(db,`SELECT ${PROJECT_FIELDS} FROM projects p JOIN project_members m ON m.project_id=p.id WHERE m.user_id=? AND (${states.map(state=>`(${filters[state]})`).join(' OR ')}) ORDER BY julianday(p.updated_at) DESC,p.id`,[user.id]);
        return json({projects:rows.map(row=>projectDTO(row,false))});
      }
      if(segments.length===1&&method==='POST'){
        const input=await body(request),payload=canonicalPayload(input),kind=CHANGE_KINDS.has(input.kind)?input.kind:'import';
        const mutationId=text(input.mutationId,'保存请求标识',160,{optional:true});
        const created=await createProject(db,user,payload,{kind,mutationId});
        return json({project:projectDTO(created.row),alreadyCreated:!created.created},created.created?201:200);
      }
      if(segments[1]==='migrate'&&segments.length===2&&method==='POST'){
        const input=await body(request);
        if(!Array.isArray(input.projects)||!input.projects.length||input.projects.length>MAX_MIGRATION_PROJECTS)fail(400,'INVALID_INPUT','每次迁移应包含 1–50 个项目。');
        const seen=new Set(),items=input.projects.map(item=>{
          const localId=text(item.localId??item.id,'浏览器项目标识',200);if(seen.has(localId))fail(400,'INVALID_INPUT','同批迁移的项目标识重复。');seen.add(localId);
          const activities=item.activities??[];if(!Array.isArray(activities)||activities.length>MAX_LEGACY_EVENTS)fail(400,'INVALID_INPUT','每个项目最多迁移 500 条浏览器活动。');
          const eventIds=new Set();
          const cleanEvents=activities.map(event=>{
            const id=text(event.id,'旧活动标识',200);if(eventIds.has(id))fail(400,'INVALID_INPUT','旧活动标识重复。');eventIds.add(id);
            const originalTime=text(event.timestamp,'旧活动时间',64);if(!Number.isFinite(Date.parse(originalTime)))fail(400,'INVALID_INPUT','旧活动时间无效。');
            return {id,kind:text(event.kind,'旧活动类型',100),timestamp:originalTime,label:text(event.label,'旧活动说明',200),detail:event.detail==null?'':String(event.detail).slice(0,2000),projectTitle:event.projectTitle==null?null:String(event.projectTitle).slice(0,200)};
          });
          const optionalDate=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;
          return {payload:canonicalPayload(item),migration:{localId,activities:cleanEvents,createdAt:optionalDate(item.createdAt),updatedAt:optionalDate(item.updatedAt)}};
        });
        const projects=[],mappings=[];let importedCount=0,skippedCount=0,legacyImportedCount=0;
        for(const item of items){
          const prior=await first(db,'SELECT project_id FROM local_migrations WHERE user_id=? AND local_id=?',[user.id,item.migration.localId]);
          const creation=prior?{row:await access(db,prior.project_id,user),created:false}:await createProject(db,user,item.payload,{kind:'import',migration:item.migration});
          // A retry may fill missing legacy entries, so it is still a write.
          // Never let a subsequently demoted/revoked importer append history.
          creation.row=await access(db,creation.row.id,user,'write');
          if(creation.created)importedCount++;else skippedCount++;
          const statements=[];
          for(const event of item.migration.activities){
            const id=await stableId('legacy',`${user.id}\0${item.migration.localId}\0${event.id}`);
            statements.push(eventStatement(db,{id,project:creation.row,user:null,kind:event.kind,label:event.label,projectTitle:event.projectTitle??creation.row.title,detail:event.detail,timestamp:event.timestamp,source:'legacy',legacyId:event.id,metadata:{originalId:event.id,originalProjectId:item.migration.localId,originalTimestamp:event.timestamp}},`EXISTS (SELECT 1 FROM project_members m JOIN projects p ON p.id=m.project_id WHERE m.project_id=? AND m.user_id=? AND m.role IN ('administrator','evaluator') AND p.deleted_at IS NULL AND p.inactive_at IS NULL)`,[creation.row.id,user.id]));
          }
          for(let start=0;start<statements.length;start+=80){await access(db,creation.row.id,user,'write');const results=await db.batch(statements.slice(start,start+80));legacyImportedCount+=results.reduce((sum,result)=>sum+changed(result),0);}
          // A refresh must not hide a partially migrated local project before
          // every legacy batch is durable. Failed retries may safely fill gaps.
          await access(db,creation.row.id,user,'write');
          await prepared(db,`UPDATE local_migrations SET completed_at=COALESCE(completed_at,?) WHERE user_id=? AND local_id=? AND project_id=? AND EXISTS (SELECT 1 FROM project_members m JOIN projects p ON p.id=m.project_id WHERE m.project_id=? AND m.user_id=? AND m.role IN ('administrator','evaluator') AND p.deleted_at IS NULL AND p.inactive_at IS NULL)`,[now(),user.id,item.migration.localId,creation.row.id,creation.row.id,user.id]).run();
          creation.row=await access(db,creation.row.id,user,'write');
          projects.push(projectDTO(creation.row,false));mappings.push({localId:item.migration.localId,projectId:creation.row.id,alreadyImported:!creation.created});
        }
        return json({projects,importedCount,skippedCount,legacyImportedCount,historyImportedCount:legacyImportedCount,historyCount:legacyImportedCount,mappings});
      }

      const id=text(segments[1],'项目标识',200);
      if(segments.length===2&&method==='GET'){
        const row=await access(db,id,user);await audit(db,{project:row,user,kind:'project.viewed'});
        return json({project:projectDTO(row)});
      }
      if(segments.length===2&&method==='PUT'){
        const current=await access(db,id,user,'write'),input=await body(request),version=expectedVersion(input);assertVersion(current,version);
        const payload=canonicalPayload(input),kind=CHANGE_KINDS.has(input.kind)?input.kind:'settings',operation=idFactory(),at=now();
        const statements=[prepared(db,`UPDATE projects SET title=?,data_json=?,summary_json=?,preferences_json=?,source_json=?,updated_at=?,version=version+1,last_operation_id=? WHERE id=? AND version=? AND lifecycle_version=? AND deleted_at IS NULL AND inactive_at IS NULL AND EXISTS (SELECT 1 FROM project_members WHERE project_id=? AND user_id=? AND role IN ('administrator','evaluator'))`,[payload.title,JSON.stringify(payload.data),JSON.stringify(payload.resultSummary),JSON.stringify(payload.preferences),JSON.stringify(payload.source),at,operation,id,version,current.lifecycle_version,id,user.id]),
          versionStatement(db,id,operation,user,kind,at),eventStatement(db,{id:operation,project:{id,title:payload.title,version:version+1},user,kind,timestamp:at,detail:kind==='comparison'?`覆盖 ${Number((payload.preferences.p*100).toFixed(2))}% · ${payload.preferences.delta===null?'自动容差':`容差 ${payload.preferences.delta}`}`:`${payload.resultSummary.supplierCount} 家供应商 · ${payload.resultSummary.criterionCount} 项指标`,metadata:{fromVersion:version,toVersion:version+1}},'EXISTS (SELECT 1 FROM projects WHERE id=? AND last_operation_id=?)',[id,operation])];
        const results=await db.batch(statements);
        if(!changed(results[0])){const latest=await access(db,id,user,'write');assertVersion(latest,version);assertLifecycleVersion(latest,current.lifecycle_version);fail(409,'VERSION_CONFLICT','项目保存发生冲突，请重新载入。');}
        return json({project:projectDTO(await access(db,id,user))});
      }
      if(segments.length===2&&method==='DELETE'){
        return await changeLifecycle(db,id,user,request.body?await body(request):{},{legacyDelete:true});
      }
      if(segments.length===3&&segments[2]==='lifecycle'&&method==='POST'){
        return await changeLifecycle(db,id,user,await body(request));
      }
      if(segments.length===3&&segments[2]==='export'&&method==='POST'){
        const row=await access(db,id,user,'export'),input=await body(request);
        if(!FORMATS.has(input.format))fail(400,'INVALID_INPUT','导出格式无效。');
        if(input.expectedVersion!==undefined||input.version!==undefined)assertVersion(row,expectedVersion(input));
        await audit(db,{project:row,user,kind:'project.exported',detail:input.format,metadata:{format:input.format,version:row.version}});
        return json({project:projectDTO(row),format:input.format});
      }
      if(segments.length===3&&segments[2]==='audit'&&method==='GET'){
        await access(db,id,user,'admin');
        const limit=boundedLimit(url,50),cursor=readCursor(url);
        const filter=cursor?' AND (julianday(occurred_at)<julianday(?) OR (julianday(occurred_at)=julianday(?) AND id<?))':'';
        const rows=await all(db,`SELECT * FROM audit_events WHERE project_id=?${filter} ORDER BY julianday(occurred_at) DESC,id DESC LIMIT ?`,[id,...(cursor?[cursor.t,cursor.t,cursor.id]:[]),limit+1]);
        const page=rows.slice(0,limit);
        return json({events:page.map(eventDTO),nextCursor:rows.length>limit?encodeCursor(page.at(-1)):null});
      }
      if(segments[2]==='reviews'){
        if(segments.length===3&&method==='GET'){
          const project=await access(db,id,user);
          const rows=await all(db,`SELECT ${REVIEW_COLUMNS} FROM project_reviews WHERE project_id=? ORDER BY submitted_at DESC,id DESC`,[id]);
          return json({projectVersion:project.version,lifecycle:projectLifecycle(project),lifecycleVersion:project.lifecycle_version,role:project.role,canExport:!!project.can_export,reviews:rows.map(row=>reviewDTO(row))});
        }
        if(segments.length===3&&method==='POST')return await submitReview(db,id,user,request);
        const reviewId=text(segments[3],'复核标识',200);
        if(segments.length===4&&method==='GET'){
          await access(db,id,user);
          return json({review:reviewDTO(await loadReview(db,id,reviewId),true)});
        }
        if(segments.length===5&&segments[4]==='decision'&&method==='POST')return await decideReview(db,id,reviewId,user,request);
        if(segments.length===5&&segments[4]==='export'&&method==='POST'){
          await access(db,id,user,'export');
          const {format}=await body(request);
          if(!REVIEW_EXPORT_LABELS.has(format))fail(400,'INVALID_INPUT','报告导出格式无效。');
          const review=await loadReview(db,id,reviewId);
          if(review.status!=='confirmed')fail(409,'REVIEW_NOT_CONFIRMED','负责人确认后即可导出归档报告。');
          await audit(db,{
            project:{id,title:review.project_title,version:review.project_version},user,kind:'review.exported',
            ...(format==='pdf'?{label:'采购评审报告 PDF'}:{}),
            detail:REVIEW_EXPORT_LABELS.get(format),metadata:{reviewId,version:review.project_version,format},
          });
          return json({review:reviewDTO(review,true)});
        }
      }
      if(segments[2]==='members'&&segments.length>=3&&segments.length<=4){
        const project=await access(db,id,user,'admin');
        if(segments.length===3&&method==='GET')return json({members:(await all(db,`${MEMBER_SQL} ORDER BY m.joined_at,m.user_id`,[id])).map(memberDTO)});
        if(segments.length===3&&method==='POST'){
          const input=await body(request),settings=membershipInput(input),email=text(input.email,'成员邮箱',320).toLowerCase();
          const target=await first(db,'SELECT * FROM users WHERE email_key=?',[email]);if(!target)fail(404,'USER_NOT_FOUND','该用户尚未登录此工作台，请先完成登录后再添加。');
          if(await first(db,'SELECT user_id FROM project_members WHERE project_id=? AND user_id=?',[id,target.id]))fail(409,'MEMBER_EXISTS','该用户已是项目成员。');
          const operation=idFactory(),at=now();
          const results=await db.batch([prepared(db,`INSERT OR IGNORE INTO project_members (project_id,user_id,role,can_export,joined_at,last_operation_id) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM project_members m JOIN projects p ON p.id=m.project_id WHERE m.project_id=? AND m.user_id=? AND m.role='administrator' AND p.deleted_at IS NULL)`,[id,target.id,settings.role,Number(settings.canExport),at,operation,id,user.id]),
            eventStatement(db,{id:operation,project,user,kind:'member.added',timestamp:at,detail:target.email,metadata:{targetUserId:target.id,...settings}},'EXISTS (SELECT 1 FROM project_members WHERE project_id=? AND user_id=? AND last_operation_id=?)',[id,target.id,operation])]);
          if(!changed(results[0])){await access(db,id,user,'admin');fail(409,'MEMBER_EXISTS','该用户已是项目成员。');}
          return json({member:memberDTO(await first(db,`${MEMBER_SQL} AND m.user_id=?`,[id,target.id]))},201);
        }
        const targetId=text(segments[3],'成员标识',256),target=await first(db,`${MEMBER_SQL} AND m.user_id=?`,[id,targetId]);
        if(!target)fail(404,'NOT_FOUND','项目成员不存在。');
        const guard=`project_id=? AND user_id=? AND EXISTS (SELECT 1 FROM project_members actor JOIN projects p ON p.id=actor.project_id WHERE actor.project_id=? AND actor.user_id=? AND actor.role='administrator' AND p.deleted_at IS NULL) AND (role<>'administrator' OR (SELECT COUNT(*) FROM project_members admins WHERE admins.project_id=? AND admins.role='administrator')>1)`;
        if((method==='PATCH'||method==='PUT')&&segments.length===4){
          const settings=membershipInput(await body(request)),operation=idFactory(),at=now();
          const updateGuard=settings.role==='administrator'?`project_id=? AND user_id=? AND EXISTS (SELECT 1 FROM project_members actor JOIN projects p ON p.id=actor.project_id WHERE actor.project_id=? AND actor.user_id=? AND actor.role='administrator' AND p.deleted_at IS NULL)`:guard;
          const updateBindings=settings.role==='administrator'?[id,targetId,id,user.id]:[id,targetId,id,user.id,id];
          const results=await db.batch([prepared(db,`UPDATE project_members SET role=?,can_export=?,last_operation_id=? WHERE ${updateGuard}`,[settings.role,Number(settings.canExport),operation,...updateBindings]),
            eventStatement(db,{id:operation,project,user,kind:'member.updated',timestamp:at,detail:target.email,metadata:{targetUserId:targetId,before:{role:target.role,canExport:!!target.can_export},after:settings}},'EXISTS (SELECT 1 FROM project_members WHERE project_id=? AND user_id=? AND last_operation_id=?)',[id,targetId,operation])]);
          if(!changed(results[0])){await access(db,id,user,'admin');fail(409,'LAST_ADMINISTRATOR','项目必须保留至少一名管理员。');}
          return json({member:memberDTO(await first(db,`${MEMBER_SQL} AND m.user_id=?`,[id,targetId]))});
        }
        if(method==='DELETE'&&segments.length===4){
          const operation=idFactory(),at=now(),bindings=[id,targetId,id,user.id,id];
          const results=await db.batch([eventStatement(db,{id:operation,project,user,kind:'member.removed',timestamp:at,detail:target.email,metadata:{targetUserId:targetId,role:target.role}},`EXISTS (SELECT 1 FROM project_members WHERE ${guard})`,bindings),prepared(db,`DELETE FROM project_members WHERE ${guard}`,bindings)]);
          if(!changed(results[1])){await access(db,id,user,'admin');fail(409,'LAST_ADMINISTRATOR','不能移除最后一名项目管理员。');}
          return json({removed:true});
        }
      }
      fail(404,'NOT_FOUND','接口不存在。');
    }catch(error){
      if(error instanceof ApiError)return json({error:{code:error.code,message:error.message,...(error.details?{details:error.details}:{})}},error.status);
      // Keep database errors and request data out of responses.
      onError(error);
      return json({error:{code:'INTERNAL_ERROR',message:'服务器暂时无法完成操作，请稍后重试。'}},500);
    }
  };
}
