import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {createApiHandler} from '../server/api.mjs';
import {createAccountsApi} from '../server/accounts.mjs';
import {analyze} from '../dist/engine.mjs';
import {createProjectStore} from '../dist/projects.mjs';
import {PAPER_DATA} from './fixtures/benchmark.mjs';

const migrations=new URL('../drizzle/',import.meta.url);
const journal=JSON.parse(await readFile(new URL('meta/_journal.json',migrations),'utf8'));
const schema=(await Promise.all(journal.entries.map(({tag})=>
  readFile(new URL(`${tag}.sql`,migrations),'utf8')
))).join('\n');
function testDatabase(sqlite){
  const prepare=sql=>({sql,bindings:[],bind(...bindings){this.bindings=bindings;return this;},first(){return sqlite.prepare(sql).get(...this.bindings)??null;},all(){return {results:sqlite.prepare(sql).all(...this.bindings)};},run(){const result=sqlite.prepare(sql).run(...this.bindings);return {success:true,meta:{changes:Number(result.changes)}};}});
  return {prepare,batch(statements){sqlite.exec('BEGIN');try{const results=statements.map(statement=>statement.run());sqlite.exec('COMMIT');return results;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
}
function testActor(request){
  const id=request.headers.get('x-test-user-id');
  const email=request.headers.get('x-test-user-email');
  return id&&email?{id,email,name:`${id}用户`}:null;
}
function fixture(){
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');sqlite.exec(schema);
  let index=0,tick=Date.parse('2026-11-21T10:00:00Z');const errors=[];
  const handler=createApiHandler({resolveIdentity:testActor,idFactory:()=>`operation-${++index}`,now:()=>new Date(tick++).toISOString(),onError:error=>errors.push(error)}),env={DB:testDatabase(sqlite)};
  const request=async(user,path,method='GET',input,headers={})=>{
    const identity=user?{'x-test-user-id':user,'x-test-user-email':`${user}@example.com`}:{};
    const response=await handler(new Request(`https://adapt.example/api${path}`,{method,headers:{...identity,...(input!==undefined?{'content-type':'application/json'}:{}),...headers},...(input!==undefined?{body:JSON.stringify(input)}:{})}),env);
    const value=await response.json();if(response.status===500)assert.fail(`Unexpected 500: ${errors.at(-1)?.stack}`);
    return {status:response.status,...value};
  };
  return {sqlite,handler,env,request,errors};
}
function payload(title='测试项目'){
  const data={...structuredClone(PAPER_DATA),title,sampleCount:200,source:{filename:'测试.xlsx'}},result=analyze(data).result;
  const {project}=createProjectStore({storage:null}).recordAnalysis({data,result});
  return {data:project.data,resultSummary:project.resultSummary,preferences:project.preferences,kind:'import'};
}

function decisionPayload(title='年度机加工采购',rationale='样件精度达标，交期满足要求。'){
  const input=payload(title);
  const [recommended,alternative]=input.data.suppliers;
  input.data.procurement={decision:{recommendedId:recommended.id,alternativeId:alternative.id,rationale,followUps:'确认首批交付计划。'}};
  return input;
}

test('the initial account signs in directly and approved applicants need a project grant',async()=>{
  const {env}=fixture();
  const adminPassword='test-fixture-admin-password';
  const accounts=createAccountsApi({
    DB:env.DB,bootstrapOwnerEmail:'admin@example.invalid',bootstrapPassword:adminPassword,
    passwordPepper:'test-fixture-pepper-at-least-32-bytes',
  });
  await accounts.initialize();
  const projectApi=createApiHandler({resolveIdentity:incoming=>accounts.identity(incoming)});
  const origin='https://adapt.example';
  async function call(path,{method='GET',input,cookie='',headers={}}={}){
    const incoming=new Request(origin+path,{
      method,headers:{cookie,origin,...(input===undefined?{}:{'content-type':'application/json'}),...headers},
      body:input===undefined?undefined:JSON.stringify(input),
    });
    const response=path.startsWith('/api/auth/')?await accounts.handle(incoming):await projectApi(incoming,env);
    return {status:response.status,cookie:response.headers.get('set-cookie')?.split(';')[0],data:await response.json()};
  }

  assert.equal((await call('/api/projects',{headers:{'x-test-user-id':'admin'}})).status,401);
  assert.equal((await call('/api/auth/login',{method:'POST',input:{username:'admin',password:'incorrect'}})).status,401);
  const admin=await call('/api/auth/login',{method:'POST',input:{username:'admin',password:adminPassword}});
  assert.equal(admin.status,200);
  assert.equal(admin.data.user.mustChangePassword,false);
  assert.deepEqual((await call('/api/projects',{cookie:admin.cookie})).data.projects,[]);
  const saved=await call('/api/projects',{method:'POST',cookie:admin.cookie,input:payload()});
  assert.equal(saved.status,201);
  const base=`/api/projects/${saved.data.project.id}`;

  const credentials={username:'reviewer',password:'test-fixture-reviewer-password'};
  const email='reviewer@example.invalid';
  assert.equal((await call('/api/auth/register',{method:'POST',input:{...credentials,name:'测试评估员',email}})).status,202);
  assert.equal((await call('/api/auth/login',{method:'POST',input:credentials})).data.error.code,'ACCOUNT_PENDING');
  const pending=await call('/api/auth/registrations',{cookie:admin.cookie});
  const id=pending.data.registrations[0].id;
  assert.equal((await call(`/api/auth/registrations/${id}/approve`,{method:'POST',cookie:admin.cookie})).status,200);
  const member=await call('/api/auth/login',{method:'POST',input:credentials});
  assert.equal(member.status,200);
  assert.equal((await call('/api/auth/registrations',{cookie:member.cookie})).status,403);
  assert.equal((await call(base,{cookie:member.cookie})).status,404);
  assert.equal((await call(`${base}/members`,{method:'POST',cookie:admin.cookie,input:{email,role:'evaluator',canExport:false}})).status,201);
  assert.equal((await call(base,{cookie:member.cookie})).data.project.role,'evaluator');
  assert.equal((await call('/api/auth/logout',{method:'POST',cookie:member.cookie})).status,200);
  assert.equal((await call('/api/projects',{cookie:member.cookie})).status,401);
});

test('a reviewer confirms the immutable submitted version and its archive remains exportable after later edits',async()=>{
  const {request,sqlite}=fixture();
  const input=decisionPayload();
  const {project}=await request('owner','/projects','POST',input),base=`/projects/${project.id}`,reviews=`${base}/reviews`;
  for(const [user,role] of [['editor','evaluator'],['viewer','viewer']]){
    await request(user,'/session');
    assert.equal((await request('owner',`${base}/members`,'POST',{email:`${user}@example.com`,role,canExport:false})).status,201);
  }
  assert.equal((await request('outside',reviews)).status,404);
  assert.equal((await request('viewer',reviews,'POST',{version:1})).status,403);
  const submitted=await request('editor',reviews,'POST',{version:1});
  assert.equal(submitted.status,201);
  const selected=`${reviews}/${submitted.review.id}`;
  assert.equal((await request('editor',reviews,'POST',{version:1})).review.id,submitted.review.id);
  assert.equal((await request('editor',`${selected}/decision`,'POST',{action:'confirm'})).status,403);
  assert.equal((await request('owner',`${selected}/export`,'POST',{format:'html'})).error.code,'REVIEW_NOT_CONFIRMED');
  const changed=await request('editor',base,'PUT',{...decisionPayload('第二轮新草稿','第二轮报价更新了。'),version:1});
  assert.equal(changed.project.version,2);
  assert.equal((await request('editor',reviews,'POST',{version:2})).error.code,'REVIEW_PENDING');
  const confirmed=await request('owner',`${selected}/decision`,'POST',{action:'confirm',comment:'同意按此版定标。'});
  assert.equal(confirmed.review.status,'confirmed');
  assert.equal(confirmed.review.version,1);
  assert.equal(confirmed.review.title,input.data.title);
  assert.equal(confirmed.review.submittedBy,'editor用户');
  assert.equal(confirmed.review.reviewedBy,'owner用户');
  assert.equal(confirmed.review.content.rationale,input.data.procurement.decision.rationale);
  assert.equal(confirmed.review.content.suppliers.length,input.data.suppliers.length);
  assert.deepEqual(confirmed.review.content,submitted.review.content);
  assert.equal((await request('viewer',selected)).review.status,'confirmed');
  assert.equal((await request('viewer',`${selected}/export`,'POST',{format:'html'})).status,403);
  assert.deepEqual((await request('owner',`${selected}/decision`,'POST',{action:'confirm',comment:'覆盖之前意见'})).review,confirmed.review);
  assert.equal((await request('owner',`${selected}/decision`,'POST',{action:'return'})).status,409);
  assert.equal((await request('owner',base)).project.version,2);
  assert.deepEqual((await request('owner',`${selected}/export`,'POST',{format:'html'})).review,confirmed.review);
  const log=(await request('owner',`${base}/audit`)).events.filter(event=>event.kind.startsWith('review.'));
  assert.deepEqual(log.map(event=>[event.kind,event.version]),[['review.exported',1],['review.confirmed',1],['review.submitted',1]]);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM project_versions WHERE project_id=?').get(project.id).n,2);
});

test('review submission validates decisions and supports returning a version for resubmission',async()=>{
  const {request}=fixture();
  const {project}=await request('owner','/projects','POST',payload()),base=`/projects/${project.id}`,reviews=`${base}/reviews`;
  assert.equal((await request('owner',reviews,'POST',{version:1})).error.code,'REVIEW_DECISION_REQUIRED');
  assert.equal((await request('owner',base,'PUT',{...decisionPayload(),kind:'decision',version:1})).status,200);
  assert.equal((await request('owner',reviews,'POST',{version:1})).error.code,'VERSION_CONFLICT');
  const first=await request('owner',reviews,'POST',{version:2});
  const returned=await request('owner',`${reviews}/${first.review.id}/decision`,'POST',{action:'return',comment:'请核对交期。'});
  assert.equal(returned.review.status,'returned');
  assert.equal(returned.review.comment,'请核对交期。');
  const second=await request('owner',reviews,'POST',{version:2});
  assert.equal(second.status,201);
  assert.notEqual(second.review.id,first.review.id);
  assert.equal((await request('owner',`${reviews}/${second.review.id}/decision`,'POST',{action:'confirm'})).review.status,'confirmed');
  assert.deepEqual((await request('owner',reviews)).reviews.map(item=>item.status),['confirmed','returned']);
});

test('PDF review export uses the approved immutable snapshot and independent export permission',async()=>{
  const {request,sqlite}=fixture(),input=decisionPayload();
  const {project}=await request('owner','/projects','POST',input),base=`/projects/${project.id}`,reviews=`${base}/reviews`;
  await request('viewer','/session');
  assert.equal((await request('owner',`${base}/members`,'POST',{email:'viewer@example.com',role:'viewer',canExport:false})).status,201);
  const pending=await request('owner',reviews,'POST',{version:1}),pendingPath=`${reviews}/${pending.review.id}`;
  assert.equal((await request('owner',`${pendingPath}/export`,'POST',{format:'pdf'})).error.code,'REVIEW_NOT_CONFIRMED');
  assert.equal((await request('owner',`${pendingPath}/decision`,'POST',{action:'return'})).review.status,'returned');
  assert.equal((await request('owner',`${pendingPath}/export`,'POST',{format:'pdf'})).error.code,'REVIEW_NOT_CONFIRMED');
  const submitted=await request('owner',reviews,'POST',{version:1}),reviewPath=`${reviews}/${submitted.review.id}`;
  const confirmed=(await request('owner',`${reviewPath}/decision`,'POST',{action:'confirm',comment:'本版本可归档。'})).review;
  assert.equal((await request(null,`${reviewPath}/export`,'POST',{format:'pdf'})).status,401);
  assert.equal((await request('outside',`${reviewPath}/export`,'POST',{format:'pdf'})).status,404);
  assert.equal((await request('viewer',`${reviewPath}/export`,'POST',{format:'pdf'})).status,403);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE kind='review.exported'").get().n,0);
  assert.equal((await request('owner',base,'PUT',{...decisionPayload('后续新版本','新资料不得覆盖旧报告。'),version:1})).project.version,2);
  const exported=await request('owner',`${reviewPath}/export`,'POST',{format:'pdf'});
  assert.equal(exported.status,200);assert.deepEqual(exported.review,confirmed);
  assert.equal(exported.review.version,1);assert.equal(exported.review.title,input.data.title);
  assert.equal((await request('owner',`${base}/members/viewer`,'PATCH',{role:'viewer',canExport:true})).status,200);
  assert.deepEqual((await request('viewer',`${reviewPath}/export`,'POST',{format:'pdf'})).review,confirmed);
  assert.equal((await request('viewer',base)).project.role,'viewer');
  assert.equal((await request('owner',`${reviewPath}/export`,'POST',{format:'docx'})).status,400);
  assert.equal((await request('owner',`${base}/export`,'POST',{format:'pdf',expectedVersion:2})).status,400);
  for(const format of ['html','print'])assert.deepEqual((await request('owner',`${reviewPath}/export`,'POST',{format})).review,confirmed);
  const audit=(await request('owner',`${base}/audit`)).events.filter(event=>event.kind==='review.exported');
  assert.equal(audit.length,4);
  const pdf=audit.filter(event=>event.metadata.format==='pdf');assert.equal(pdf.length,2);
  for(const event of pdf){assert.equal(event.label,'采购评审报告 PDF');assert.equal(event.detail,'采购评审报告 PDF');assert.equal(event.version,1);assert.deepEqual(event.metadata,{reviewId:confirmed.id,version:1,format:'pdf'});}
  assert.equal(audit.find(event=>event.metadata.format==='html').detail,'采购评审报告 HTML');
  assert.equal(audit.find(event=>event.metadata.format==='print').detail,'打印采购评审报告');
});

test('review evidence uses full-cohort cost and benefit normalization and reconciles with the baseline gap',async()=>{
  const {request}=fixture(),input=decisionPayload();
  const {project}=await request('owner','/projects','POST',input);
  const submitted=await request('owner',`/projects/${project.id}/reviews`,'POST',{version:1});
  assert.equal(submitted.status,201);
  const {content}=submitted.review,{comparison}=content;
  assert.equal(content.formatVersion,1);
  assert.equal(comparison.recommendedScore,content.suppliers.find(row=>row.selection==='推荐').score);
  assert.equal(comparison.alternativeScore,content.suppliers.find(row=>row.selection==='备选').score);
  assert.equal(comparison.scoreDifference,comparison.recommendedScore-comparison.alternativeScore);
  assert.equal(comparison.contributions.length,input.data.criteria.length);
  const sum=comparison.contributions.reduce((total,row)=>total+row.contribution,0);
  assert.ok(Math.abs(sum-comparison.scoreDifference)<1e-12);
  for(let i=1;i<comparison.contributions.length;i++)assert.ok(Math.abs(comparison.contributions[i-1].contribution)>=Math.abs(comparison.contributions[i].contribution));
  const cost=comparison.contributions.find(row=>row.criterion===input.data.criteria[0].name);
  assert.equal(cost.type,'cost');assert.equal(cost.recommendedValue,.75);assert.equal(cost.alternativeValue,11/12);
  assert.equal(cost.recommendedNormalized,.5/.75);assert.equal(cost.alternativeNormalized,.5/(11/12));
  assert.ok(cost.contribution>0);
  const quality=comparison.contributions.find(row=>row.criterion===input.data.criteria[1].name);
  assert.equal(quality.type,'benefit');assert.equal(quality.recommendedNormalized,.5/(11/12));assert.equal(quality.alternativeNormalized,.75/(11/12));
  assert.ok(quality.contribution<0);
  for(const row of comparison.contributions){
    assert.equal(row.weight,content.criteria.find(criterion=>criterion.name===row.criterion).weight);
    assert.equal(row.contribution,row.weight*(row.recommendedNormalized-row.alternativeNormalized));
  }
});

test('review evidence preserves zero total gaps, offsetting drivers and stable criterion order',async()=>{
  const {request}=fixture();
  const create=async(values,title)=>{
    const data={title,sampleCount:20,criteria:[{id:'C1',name:'质量',type:'benefit',lower:1,modal:1,upper:1},{id:'C2',name:'交付',type:'benefit',lower:1,modal:1,upper:1}],suppliers:values.map((value,index)=>({id:`S${index+1}`,name:`供应商${index+1}`,values:value})),procurement:{decision:{recommendedId:'S1',alternativeId:'S2',rationale:'两个指标的取舍相互抵消。'}}};
    const result=analyze(data).result,{project:local}=createProjectStore({storage:null}).recordAnalysis({data,result});
    const {project}=await request('owner','/projects','POST',{data:local.data,resultSummary:local.resultSummary,preferences:local.preferences});
    return (await request('owner',`/projects/${project.id}/reviews`,'POST',{version:1})).review.content.comparison;
  };
  const offset=await create([[10,20],[20,10],[20,20]],'同分但取舍不同');
  assert.equal(offset.recommendedScore,.75);assert.equal(offset.alternativeScore,.75);assert.equal(offset.scoreDifference,0);
  assert.deepEqual(offset.contributions.map(row=>[row.criterion,row.contribution]),[['质量',-.25],['交付',.25]]);
  const identical=await create([[20,20],[20,20]],'相同表现');
  assert.equal(identical.recommendedScore,1);assert.equal(identical.alternativeScore,1);assert.equal(identical.scoreDifference,0);
  assert.deepEqual(identical.contributions.map(row=>[row.criterion,row.contribution]),[['质量',0],['交付',0]]);
});

test('review evidence is optional without a backup and legacy stored reports remain unchanged',async()=>{
  const {request,sqlite}=fixture(),input=decisionPayload();input.data.procurement.decision.alternativeId='';
  const {project}=await request('owner','/projects','POST',input),base=`/projects/${project.id}`;
  const submitted=await request('owner',`${base}/reviews`,'POST',{version:1});
  assert.equal(submitted.status,201);assert.equal(submitted.review.content.alternative,null);assert.equal(submitted.review.content.comparison,null);
  // Existing JSON snapshots have no comparison field. Loading, confirming and
  // exporting them must not recalculate or backfill historical evidence.
  const legacy=structuredClone(submitted.review.content);delete legacy.comparison;
  sqlite.prepare('UPDATE project_reviews SET content_json=? WHERE id=?').run(JSON.stringify(legacy),submitted.review.id);
  const reviewUrl=`${base}/reviews/${submitted.review.id}`;
  assert.deepEqual((await request('owner',reviewUrl)).review.content,legacy);
  assert.deepEqual((await request('owner',`${reviewUrl}/decision`,'POST',{action:'confirm'})).review.content,legacy);
  const archive=await request('owner',`${reviewUrl}/export`,'POST',{format:'html'});
  assert.equal(archive.status,200);assert.deepEqual(archive.review.content,legacy);
});

test('an authenticated session is required and caller-provided body identity never grants access',async()=>{
  const {request,handler}=fixture();
  assert.equal((await request(null,'/projects')).status,401);
  const unavailable=await handler(new Request('https://adapt.example/api/session',{headers:{'x-test-user-id':'owner','x-test-user-email':'owner@example.com'}}),{});assert.equal(unavailable.status,503);
  const session=await request('owner','/session');assert.equal(session.user.id,'owner');assert.equal(session.user.name,'owner用户');
  const saved=await request('owner','/projects','POST',payload());assert.equal(saved.status,201);assert.equal(saved.project.role,'administrator');assert.equal(saved.project.canExport,true);
  const outsider=await request('stranger',`/projects/${saved.project.id}`);assert.equal(outsider.status,404);
  const forged=await request('stranger',`/projects/${saved.project.id}`,'PUT',{...payload(),version:1,userId:'owner',role:'administrator'});assert.equal(forged.status,404);
  assert.deepEqual((await request('stranger','/projects')).projects,[]);
});

test('create mutationId is user-scoped and retry never duplicates or overwrites a success',async()=>{
  const {request,sqlite}=fixture();
  const input={...payload('首次内容'),mutationId:'analysis-uuid'};
  const first=await request('owner','/projects','POST',input),retry=await request('owner','/projects','POST',{...input,data:{...input.data,title:'重试不得覆盖'}});
  assert.equal(first.project.id,retry.project.id);assert.equal(retry.alreadyCreated,true);assert.equal(retry.project.title,'首次内容');
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM projects').get().n,1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE kind='import'").get().n,1);
  const other=await request('other','/projects','POST',input);assert.notEqual(other.project.id,first.project.id);
});

test('registered-only membership, role authorization, independent export flags and final-admin protection',async()=>{
  const {request}=fixture();
  const {project}=await request('owner','/projects','POST',payload()),base=`/projects/${project.id}`;
  assert.equal((await request('owner',`${base}/members`,'POST',{email:'new@example.com',role:'viewer',canExport:false})).error.code,'USER_NOT_FOUND');
  await request('viewer','/session');await request('editor','/session');
  assert.equal((await request('owner',`${base}/members`,'POST',{email:'viewer@example.com',role:'viewer',canExport:false})).status,201);
  assert.equal((await request('owner',`${base}/members`,'POST',{email:'editor@example.com',role:'evaluator',canExport:false})).status,201);
  assert.equal((await request('viewer',base)).project.role,'viewer');
  assert.equal((await request('viewer',base,'PUT',{...payload(),version:1})).status,403);
  assert.equal((await request('viewer',`${base}/members`)).status,403);assert.equal((await request('viewer',`${base}/audit`)).status,403);
  assert.equal((await request('editor',`${base}/export`,'POST',{format:'csv',expectedVersion:1})).status,403);
  assert.equal((await request('owner',`${base}/members/viewer`,'PATCH',{role:'viewer',canExport:true})).status,200);
  const exported=await request('viewer',`${base}/export`,'POST',{format:'scenarios_csv',expectedVersion:1});assert.equal(exported.status,200);assert.equal(exported.format,'scenarios_csv');
  assert.equal((await request('owner',`${base}/members/owner`,'PATCH',{role:'evaluator',canExport:true})).error.code,'LAST_ADMINISTRATOR');
  assert.equal((await request('owner',`${base}/members/owner`,'DELETE')).error.code,'LAST_ADMINISTRATOR');
  assert.equal((await request('owner',`${base}/members/viewer`,'DELETE')).removed,true);assert.equal((await request('viewer',base)).status,404);
});

test('optimistic write conflicts preserve the saved input and produce no false success audit',async()=>{
  const {request,sqlite}=fixture();const input=payload(),{project}=await request('owner','/projects','POST',input),base=`/projects/${project.id}`;
  const updated=await request('owner',base,'PUT',{...input,data:{...input.data,title:'已更新'},expectedVersion:1,kind:'settings'});assert.equal(updated.project.version,2);
  const before=sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n;
  const stale=await request('owner',base,'PUT',{...input,data:{...input.data,title:'过期覆盖'},version:1,kind:'settings'});
  assert.equal(stale.status,409);assert.equal(stale.error.code,'VERSION_CONFLICT');assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM audit_events').get().n,before);
  const exportConflict=await request('owner',`${base}/export`,'POST',{format:'adapt',expectedVersion:1});assert.equal(exportConflict.status,409);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE kind='project.exported'").get().n,0);
  assert.equal((await request('owner',base)).project.title,'已更新');
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM project_versions').get().n,2);
});

test('legacy browser activities preserve original identity/time semantics and migrate idempotently',async()=>{
  const {request,sqlite}=fixture();const input=payload();
  const item={...input,localId:'browser-123',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-02-01T00:00:00Z',activities:[{id:'old-event-1',kind:'decision',label:'保存采购决策',detail:'旧记录说明',projectTitle:'原始项目名',timestamp:'2026-02-01T10:20:30+08:00',actor:{id:'not-trusted'}}]};
  const first=await request('owner','/projects/migrate','POST',{projects:[item]}),retry=await request('owner','/projects/migrate','POST',{projects:[item]});
  assert.equal(first.importedCount,1);assert.equal(first.legacyImportedCount,1);assert.equal(retry.importedCount,0);assert.equal(retry.skippedCount,1);assert.equal(retry.legacyImportedCount,0);
  const id=first.mappings[0].projectId;assert.equal(id,retry.mappings[0].projectId);
  assert.equal(first.projects[0].migrationLocalId,'browser-123');assert.equal(first.projects[0].createdAt,item.createdAt);assert.equal(first.projects[0].updatedAt,item.updatedAt);
  assert.equal(first.historyImportedCount,1);assert.equal(retry.historyImportedCount,0);
  const audit=await request('owner',`/projects/${id}/audit`),legacy=audit.events.find(event=>event.source==='legacy'),migration=audit.events.find(event=>event.kind==='project.migrated');
  assert.equal(legacy.actor,null);assert.equal(legacy.actorLabel,'旧版浏览器记录');assert.equal(legacy.timestamp,item.activities[0].timestamp);assert.equal(legacy.legacyId,'old-event-1');assert.equal(legacy.projectTitle,'原始项目名');assert.equal(legacy.metadata.originalId,'old-event-1');
  assert.equal(migration.actor.id,'owner');assert.equal(migration.source,'server');
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM local_migrations').get().n,1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE kind='project.migrated'").get().n,1);
  const other=await request('other','/projects/migrate','POST',{projects:[item]});assert.notEqual(other.mappings[0].projectId,id);
});

test('recent activity does not expose other actors or administrative metadata to non-administrators',async()=>{
  const {request}=fixture();const {project}=await request('owner','/projects','POST',payload()),base=`/projects/${project.id}`;
  await request('viewer','/session');await request('owner',`${base}/members`,'POST',{email:'viewer@example.com',role:'viewer',canExport:false});
  await request('viewer',base);
  const viewer=await request('viewer','/activities'),owner=await request('owner','/activities');
  assert.ok(viewer.activities.length>0);assert.ok(viewer.activities.every(event=>event.actor.id==='viewer'&&event.projectId===project.id));
  assert.ok(!viewer.activities.some(event=>event.kind==='member.added'||event.kind==='import'));
  assert.ok(owner.activities.some(event=>event.kind==='member.added'&&event.actor.id==='owner'));
  assert.ok(owner.activities.some(event=>event.kind==='project.viewed'&&event.actor.id==='viewer'));
  assert.ok(!owner.activities.some(event=>!event.projectId));
});

test('audit keyset pagination preserves every event without generating noisy audit-read records',async()=>{
  const {request,sqlite}=fixture();const input=payload(),{project}=await request('owner','/projects','POST',input),base=`/projects/${project.id}`;
  for(let i=0;i<8;i++)await request('owner',base);
  const expected=sqlite.prepare('SELECT COUNT(*) n FROM audit_events WHERE project_id=?').get(project.id).n;
  const ids=[];let cursor=null;
  do{const page=await request('owner',`${base}/audit?limit=3${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`);assert.equal(page.status,200);ids.push(...page.events.map(event=>event.id));cursor=page.nextCursor;}while(cursor);
  assert.equal(ids.length,expected);assert.equal(new Set(ids).size,expected);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE kind='audit.viewed'").get().n,0);
  assert.equal((await request('owner',`${base}/audit?cursor=malformed`)).status,400);
});

test('repeated session bootstrap is throttled while remaining a real verified-user event',async()=>{
  const {request,sqlite}=fixture();for(let i=0;i<4;i++)await request('owner','/session');
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE kind='workspace.opened'").get().n,1);
});

test('migration validates the complete batch before writes and will not pretend malformed logs are real',async()=>{
  const {request,sqlite}=fixture();const item={...payload(),localId:'valid'};
  const invalid={...payload(),localId:'invalid',activities:[{id:'event',kind:'settings',label:'旧日志',timestamp:'bad-time'}]};
  assert.equal((await request('owner','/projects/migrate','POST',{projects:[item,invalid]})).status,400);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM projects').get().n,0);
});

test('idempotent retries do not regrant revoked access or let demoted importers append legacy events',async()=>{
  const {request,sqlite}=fixture(),input=payload();
  const created=await request('owner','/projects','POST',{...input,mutationId:'revocation-retry'}),base=`/projects/${created.project.id}`;
  await request('manager','/session');await request('owner',`${base}/members`,'POST',{email:'manager@example.com',role:'administrator',canExport:true});
  await request('manager',`${base}/members/owner`,'DELETE');
  assert.equal((await request('owner','/projects','POST',{...input,mutationId:'revocation-retry'})).status,404);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM project_members WHERE project_id=? AND user_id=?').get(created.project.id,'owner').n,0);
  const migration={...input,localId:'demoted-migration',activities:[]};
  const saved=await request('owner','/projects/migrate','POST',{projects:[migration]}),migratedBase=`/projects/${saved.mappings[0].projectId}`;
  await request('owner',`${migratedBase}/members`,'POST',{email:'manager@example.com',role:'administrator',canExport:true});
  await request('manager',`${migratedBase}/members/owner`,'PATCH',{role:'viewer',canExport:false});
  const retry=await request('owner','/projects/migrate','POST',{projects:[{...migration,activities:[{id:'new-old-record',kind:'decision',label:'旧决策',timestamp:'2026-01-01T00:00:00Z'}]}]});
  assert.equal(retry.status,403);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE legacy_id='new-old-record'").get().n,0);
});

test('partial legacy migration remains visible for retry after reload and fills only missing records',async()=>{
  const {request,handler,env,sqlite}=fixture();
  const item={...payload(),localId:'interrupted',activities:Array.from({length:100},(_,i)=>({id:`old-${i}`,kind:'settings',label:'旧设置记录',detail:`第 ${i} 条`,timestamp:'2026-01-01T00:00:00Z'}))};
  const batch=env.DB.batch.bind(env.DB);let legacyBatches=0;
  env.DB.batch=statements=>{if(statements[0]?.bindings[10]==='legacy'&&++legacyBatches===2)throw new Error('Simulated database interruption');return batch(statements);};
  const failed=await handler(new Request('https://adapt.example/api/projects/migrate',{method:'POST',headers:{'content-type':'application/json','x-test-user-id':'owner','x-test-user-email':'owner@example.com'},body:JSON.stringify({projects:[item]})}),env);
  assert.equal(failed.status,500);assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE source='legacy'").get().n,80);
  assert.equal(sqlite.prepare('SELECT completed_at FROM local_migrations').get().completed_at,null);
  const reloaded=await request('owner','/projects');assert.equal(reloaded.projects.length,1);assert.equal(reloaded.projects[0].migrationLocalId,null);
  env.DB.batch=batch;
  const retry=await request('owner','/projects/migrate','POST',{projects:[item]});
  assert.equal(retry.status,200);assert.equal(retry.importedCount,0);assert.equal(retry.skippedCount,1);assert.equal(retry.historyImportedCount,20);
  assert.equal(retry.projects[0].migrationLocalId,'interrupted');assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE source='legacy'").get().n,100);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE kind='project.migrated'").get().n,1);
});

test('cross-origin mutations are rejected and all SQL-bound project content remains plain data',async()=>{
  const {request,sqlite}=fixture();
  assert.equal((await request('owner','/projects','POST',payload(),{origin:'https://evil.example'})).status,403);
  const input=payload("项目'); DROP TABLE users;--"),saved=await request('owner','/projects','POST',input);
  assert.equal(saved.status,201);assert.equal(saved.project.title,input.data.title);assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM users').get().n,1);
  assert.equal((await request('owner','/projects','POST',{...input,resultSummary:{...input.resultSummary,supplierCount:999}})).status,400);
});

test('soft deletion is administrator-only, version-checked, hides the project and preserves its audit',async()=>{
  const {request,sqlite}=fixture();const {project}=await request('owner','/projects','POST',payload()),base=`/projects/${project.id}`;
  assert.equal((await request('owner',base,'DELETE',{version:2})).status,409);
  assert.equal((await request('owner',base,'DELETE',{version:1})).removed,true);
  assert.deepEqual((await request('owner','/projects')).projects,[]);assert.equal((await request('owner',base)).status,404);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE kind='project.deleted'").get().n,1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM projects').get().n,1);
});

const lifecycleInput=(project,action)=>({action,expectedVersion:project.version,expectedLifecycleVersion:project.lifecycleVersion});

test('project lifecycle is administrator-only, version-checked and independent of assessment versions',async()=>{
  const {request,sqlite}=fixture(),input=decisionPayload();
  let {project}=await request('owner','/projects','POST',input);
  const savedData=project.data;
  const base=`/projects/${project.id}`,route=`${base}/lifecycle`;
  assert.equal(project.lifecycle,'active');assert.equal(project.lifecycleVersion,0);assert.equal(project.reviewState,'unsubmitted');
  assert.equal(project.inactiveAt,null);assert.equal(project.deletedAt,null);assert.deepEqual(project.lifecycleActions,['delete']);
  for(const [user,role]of [['editor','evaluator'],['viewer','viewer']]){
    await request(user,'/session');
    await request('owner',`${base}/members`,'POST',{email:`${user}@example.com`,role,canExport:true});
    for(const action of ['delete','restore','deactivate','activate'])assert.equal((await request(user,route,'POST',lifecycleInput(project,action))).status,403);
    assert.equal((await request(user,base,'DELETE',{version:1})).status,403);
    assert.deepEqual((await request(user,base)).project.lifecycleActions,[]);
  }
  assert.equal((await request(null,route,'POST',lifecycleInput(project,'deactivate'))).status,401);
  assert.equal((await request('outside',route,'POST',lifecycleInput(project,'deactivate'))).status,404);
  assert.equal((await request('owner',route,'POST',{action:'deactivate',expectedVersion:1})).status,400);
  assert.equal((await request('owner',route,'POST',{...lifecycleInput(project,'deactivate'),expectedLifecycleVersion:1})).error.code,'LIFECYCLE_CONFLICT');
  assert.equal((await request('owner',route,'POST',{...lifecycleInput(project,'deactivate'),expectedVersion:2})).error.code,'VERSION_CONFLICT');
  assert.equal((await request('owner',route,'POST',lifecycleInput(project,'deactivate'))).error.code,'PROJECT_NOT_ARCHIVED');
  const submitted=await request('owner',`${base}/reviews`,'POST',{version:1});
  await request('owner',`${base}/reviews/${submitted.review.id}/decision`,'POST',{action:'confirm'});
  project=(await request('owner',base)).project;
  assert.deepEqual(project.lifecycleActions,['deactivate']);
  const deactivated=await request('owner',route,'POST',lifecycleInput(project,'deactivate'));
  assert.equal(deactivated.changed,true);project=deactivated.project;
  assert.equal(project.lifecycle,'inactive');assert.equal(project.lifecycleVersion,1);assert.equal(project.version,1);
  assert.ok(project.inactiveAt);assert.equal(project.permissions.canWrite,false);assert.deepEqual(project.lifecycleActions,['activate']);
  assert.equal((await request('owner',route,'POST',lifecycleInput(project,'delete'))).error.code,'PROJECT_ARCHIVED');
  assert.deepEqual((await request('owner',route,'POST',lifecycleInput(project,'deactivate'))),{status:200,project,changed:false});
  assert.equal((await request('owner',route,'POST',{action:'activate',expectedVersion:1,expectedLifecycleVersion:0})).error.code,'LIFECYCLE_CONFLICT');
  assert.deepEqual((await request('owner','/projects')).projects,[]);
  assert.equal((await request('editor','/projects?lifecycle=inactive')).projects[0].id,project.id);
  assert.equal((await request('viewer','/projects?lifecycle=all')).projects[0].lifecycle,'inactive');
  assert.equal((await request('owner','/projects?lifecycle=invalid')).status,400);
  assert.equal((await request('editor',base)).project.permissions.canWrite,false);
  assert.equal((await request('editor',base,'PUT',{...input,version:1})).error.code,'PROJECT_INACTIVE');
  assert.equal((await request('owner',`${base}/reviews`,'POST',{version:1})).error.code,'PROJECT_INACTIVE');
  assert.equal((await request('editor',`${base}/export`,'POST',{format:'csv',version:1})).status,200);
  assert.equal((await request('owner',`${base}/reviews`)).lifecycle,'inactive');
  assert.equal((await request('owner',`${base}/audit`)).status,200);
  const activated=await request('owner',route,'POST',lifecycleInput(project,'activate'));
  assert.equal(activated.changed,true);project=activated.project;
  assert.equal(project.lifecycle,'active');assert.equal(project.lifecycleVersion,2);assert.equal(project.version,1);assert.equal(project.inactiveAt,null);
  assert.equal((await request('owner',route,'POST',lifecycleInput(project,'activate'))).changed,false);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM project_versions').get().n,1);
  assert.deepEqual((await request('owner',base)).project.data,savedData);
  const events=(await request('owner',`${base}/audit`)).events.filter(event=>['project.deactivated','project.activated'].includes(event.kind));
  assert.deepEqual(events.map(event=>[event.kind,event.version]),[['project.activated',1],['project.deactivated',1]]);
  assert.deepEqual(events[0].metadata,{fromLifecycle:'inactive',toLifecycle:'active',fromLifecycleVersion:1,toLifecycleVersion:2,version:1});
});

test('pending review prevents deletion and inactivation, while returned projects recover under the same identity',async()=>{
  const {request,sqlite}=fixture();let {project}=await request('owner','/projects','POST',decisionPayload());
  const base=`/projects/${project.id}`,route=`${base}/lifecycle`,reviews=`${base}/reviews`;
  await request('viewer','/session');await request('owner',`${base}/members`,'POST',{email:'viewer@example.com',role:'viewer',canExport:false});
  const submitted=await request('owner',reviews,'POST',{version:1});
  project=(await request('owner',base)).project;
  assert.equal(project.reviewState,'pending');assert.deepEqual(project.lifecycleActions,[]);
  for(const action of ['delete','deactivate'])assert.equal((await request('owner',route,'POST',lifecycleInput(project,action))).error.code,'REVIEW_PENDING');
  assert.equal((await request('owner',base,'DELETE',{version:1})).error.code,'REVIEW_PENDING');
  assert.equal((await request('owner',`${reviews}/${submitted.review.id}/decision`,'POST',{action:'return'})).status,200);
  project=(await request('owner',base)).project;
  assert.equal(project.reviewState,'returned');assert.deepEqual(project.lifecycleActions,['delete']);
  assert.equal((await request('owner',route,'POST',lifecycleInput(project,'deactivate'))).error.code,'PROJECT_NOT_ARCHIVED');
  const deleted=await request('owner',route,'POST',lifecycleInput(project,'delete'));project=deleted.project;
  assert.equal(deleted.changed,true);assert.equal(project.lifecycle,'deleted');assert.equal(project.version,1);assert.equal(project.lifecycleVersion,1);
  assert.deepEqual(project.lifecycleActions,['restore']);assert.ok(project.deletedAt);
  assert.equal((await request('owner',base)).status,404);assert.equal((await request('viewer',base)).status,404);
  assert.equal((await request('owner',reviews)).status,404);
  assert.equal((await request('owner','/projects?lifecycle=deleted')).projects[0].id,project.id);
  assert.deepEqual((await request('viewer','/projects?lifecycle=all')).projects,[]);
  assert.deepEqual((await request('viewer','/projects?lifecycle=deleted')).projects,[]);
  assert.equal((await request('owner',route,'POST',lifecycleInput(project,'delete'))).changed,false);
  assert.equal((await request('owner',route,'POST',lifecycleInput(project,'activate'))).error.code,'PROJECT_STATE_CONFLICT');
  const restored=await request('owner',route,'POST',lifecycleInput(project,'restore'));project=restored.project;
  assert.equal(restored.changed,true);assert.equal(project.lifecycle,'active');assert.equal(project.lifecycleVersion,2);assert.equal(project.version,1);assert.equal(project.deletedAt,null);
  assert.equal((await request('owner',route,'POST',lifecycleInput(project,'restore'))).changed,false);
  assert.equal((await request('viewer',base)).status,200);
  assert.equal((await request('owner',reviews)).reviews[0].status,'returned');
  assert.equal((await request('owner',reviews,'POST',{version:1})).status,201);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM projects').get().n,1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM project_versions').get().n,1);
  const events=(await request('owner',`${base}/audit`)).events.filter(event=>['project.deleted','project.restored'].includes(event.kind));
  assert.deepEqual(events.map(event=>event.kind),['project.restored','project.deleted']);
});

test('any historical archive protects later drafts and returns, and stays exportable while inactive',async()=>{
  const {request,sqlite}=fixture(),input=decisionPayload();let {project}=await request('owner','/projects','POST',input);
  const base=`/projects/${project.id}`,route=`${base}/lifecycle`,reviews=`${base}/reviews`;
  const first=await request('owner',reviews,'POST',{version:1}),report=`${reviews}/${first.review.id}`;
  const confirmed=(await request('owner',`${report}/decision`,'POST',{action:'confirm'})).review;
  project=(await request('owner',base,'PUT',{...decisionPayload('更新后的草稿'),version:1})).project;
  assert.equal(project.reviewState,'archived');assert.deepEqual(project.lifecycleActions,['deactivate']);
  assert.equal((await request('owner',base,'DELETE',{version:2})).error.code,'PROJECT_ARCHIVED');
  const second=await request('owner',reviews,'POST',{version:2});
  assert.equal((await request('owner',base)).project.reviewState,'pending');
  await request('owner',`${reviews}/${second.review.id}/decision`,'POST',{action:'return'});
  project=(await request('owner',base)).project;
  assert.equal(project.reviewState,'archived');
  assert.equal((await request('owner',route,'POST',lifecycleInput(project,'delete'))).error.code,'PROJECT_ARCHIVED');
  project=(await request('owner',route,'POST',lifecycleInput(project,'deactivate'))).project;
  assert.equal(project.lifecycle,'inactive');assert.equal(project.version,2);assert.deepEqual(project.lifecycleActions,['activate']);
  assert.deepEqual((await request('owner',`${report}/export`,'POST',{format:'pdf'})).review,confirmed);
  assert.deepEqual((await request('owner',report)).review,confirmed);
  assert.equal((await request('owner',`${base}/audit`)).status,200);
  assert.equal((await request('owner',reviews,'POST',{version:2})).error.code,'PROJECT_INACTIVE');
  project=(await request('owner',route,'POST',lifecycleInput(project,'activate'))).project;
  assert.equal(project.version,2);assert.equal(project.reviewState,'archived');
  assert.deepEqual((await request('owner',report)).review,confirmed);
  assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM project_versions').get().n,2);
});

test('legacy deleted rows restore missing snapshots without overwriting archives or duplicating projects',async()=>{
  for(const archived of [false,true]){
    const {request,sqlite}=fixture(),input=decisionPayload();let {project}=await request('owner','/projects','POST',input);
    const savedData=project.data;
    const base=`/projects/${project.id}`,route=`${base}/lifecycle`,reviews=`${base}/reviews`;
    let confirmed;
    if(archived){const submitted=await request('owner',reviews,'POST',{version:1});confirmed=(await request('owner',`${reviews}/${submitted.review.id}/decision`,'POST',{action:'confirm'})).review;}
    sqlite.prepare('UPDATE projects SET version=2,deleted_at=? WHERE id=?').run('2026-11-20T09:00:00Z',project.id);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM project_versions WHERE version=2').get().n,0);
    project=(await request('owner','/projects?lifecycle=deleted')).projects[0];
    assert.equal(project.lifecycleVersion,0);assert.equal(project.reviewState,archived?'archived':'unsubmitted');
    const restored=await request('owner',route,'POST',lifecycleInput(project,'restore'));project=restored.project;
    assert.equal(restored.changed,true);assert.equal(project.version,2);assert.equal(project.lifecycle,archived?'inactive':'active');
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM projects').get().n,1);
    const snapshot=sqlite.prepare('SELECT * FROM project_versions WHERE project_id=? AND version=2').get(project.id);
    assert.deepEqual(JSON.parse(snapshot.data_json),savedData);assert.equal(snapshot.kind,'project.restored');
    assert.equal((await request('owner',route,'POST',lifecycleInput(project,'restore'))).changed,false);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM project_versions').get().n,2);
    if(archived){
      assert.deepEqual((await request('owner',`${reviews}/${confirmed.id}/export`,'POST',{format:'pdf'})).review,confirmed);
      assert.equal((await request('owner',base,'DELETE',{version:2})).error.code,'PROJECT_ARCHIVED');
    }else assert.equal((await request('owner',reviews,'POST',{version:2})).status,201);
    assert.deepEqual(sqlite.prepare('PRAGMA foreign_key_check').all(),[]);
  }
});

function beforeNextBatch(env,predicate,operation){
  const original=env.DB.batch;let called=false;
  env.DB.batch=statements=>{
    if(!called&&predicate(statements)){called=true;operation();}
    return original(statements);
  };
  return ()=>assert.equal(called,true,'race injection ran at the mutation boundary');
}
function insertReview(sqlite,project,status){
  sqlite.prepare(`INSERT INTO project_reviews (id,project_id,project_version,project_title,status,content_json,submitted_by,submitted_name,submitted_at,reviewed_by,reviewed_name,reviewed_at)
    VALUES (?,?,?,?,?,'{}','owner','owner用户','2026-11-21T11:00:00Z',?,?,?)`).run('racing-review',project.id,project.version,project.title,status,...(status==='pending'?[null,null,null]:['owner','owner用户','2026-11-21T11:01:00Z']));
}

test('lifecycle SQL rejects review, version and membership races without false audit events',async()=>{
  const cases=[
    {action:'delete',code:'REVIEW_PENDING',mutate:(db,p)=>insertReview(db,p,'pending')},
    {action:'deactivate',code:'REVIEW_PENDING',mutate:(db,p)=>insertReview(db,p,'pending')},
    {action:'delete',code:'PROJECT_ARCHIVED',mutate:(db,p)=>insertReview(db,p,'confirmed')},
    {action:'deactivate',code:'PROJECT_NOT_ARCHIVED',mutate:(db,p)=>db.prepare("DELETE FROM project_reviews WHERE project_id=? AND status='confirmed'").run(p.id)},
    {action:'deactivate',code:'VERSION_CONFLICT',mutate:(db,p)=>db.prepare('UPDATE projects SET version=version+1 WHERE id=?').run(p.id)},
    {action:'deactivate',code:'LIFECYCLE_CONFLICT',mutate:(db,p)=>db.prepare('UPDATE projects SET lifecycle_version=lifecycle_version+1 WHERE id=?').run(p.id)},
    {action:'deactivate',code:'FORBIDDEN',mutate:(db,p)=>db.prepare("UPDATE project_members SET role='viewer' WHERE project_id=? AND user_id='owner'").run(p.id)},
  ];
  for(const item of cases){
    const {request,sqlite,env}=fixture(),{project}=await request('owner','/projects','POST',decisionPayload());
    if(item.action==='deactivate'){
      const submitted=await request('owner',`/projects/${project.id}/reviews`,'POST',{version:1});
      await request('owner',`/projects/${project.id}/reviews/${submitted.review.id}/decision`,'POST',{action:'confirm'});
    }
    const injected=beforeNextBatch(env,statements=>statements[0].sql.startsWith('UPDATE projects SET inactive_at='),()=>item.mutate(sqlite,project));
    const result=await request('owner',`/projects/${project.id}/lifecycle`,'POST',lifecycleInput(project,item.action));
    injected();assert.equal(result.status,item.code==='FORBIDDEN'?403:409);assert.equal(result.error.code,item.code);
    assert.equal(sqlite.prepare('SELECT deleted_at FROM projects WHERE id=?').get(project.id).deleted_at,null);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE kind IN ('project.deleted','project.deactivated')").get().n,0);
  }
});

test('save and review submission cannot race a lifecycle change or reactivate a stale request',async()=>{
  for(const action of ['save-inactive','save-deleted','save-reactivated','review-inactive','review-reactivated']){
    const {request,sqlite,env}=fixture(),input=decisionPayload(),{project}=await request('owner','/projects','POST',input),base=`/projects/${project.id}`;
    const review=action.startsWith('review');
    const injected=beforeNextBatch(env,statements=>review?statements[0].sql.includes('INSERT OR IGNORE INTO project_reviews'):statements[0].sql.startsWith('UPDATE projects SET title='),()=>{
      const column=action.endsWith('deleted')?'deleted_at':action.endsWith('reactivated')?null:'inactive_at';
      if(column)sqlite.prepare(`UPDATE projects SET ${column}=?,lifecycle_version=lifecycle_version+1 WHERE id=?`).run('2026-11-21T11:00:00Z',project.id);
      else sqlite.prepare('UPDATE projects SET lifecycle_version=lifecycle_version+2 WHERE id=?').run(project.id);
    });
    const response=review?await request('owner',`${base}/reviews`,'POST',{version:1}):await request('owner',base,'PUT',{...input,version:1});
    injected();
    assert.equal(response.error.code,action.endsWith('deleted')?'NOT_FOUND':action.endsWith('reactivated')?'LIFECYCLE_CONFLICT':'PROJECT_INACTIVE');
    assert.equal(sqlite.prepare('SELECT version FROM projects WHERE id=?').get(project.id).version,1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM project_versions').get().n,1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM project_reviews').get().n,0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE kind IN ('review.submitted','settings')").get().n,0);
  }
});
