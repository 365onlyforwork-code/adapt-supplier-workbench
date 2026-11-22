import {isWeightFeasible,scenarioScores,validateInput} from './engine.mjs?v=workspace-2';
import {parseFile,datasetFromTable,downloadTemplate,exportResults} from './import.mjs?v=i18n-1';
import {PROJECT_STORAGE_KEY} from './projects.mjs?v=procurement-1';
import {createCloudProjectStore} from './cloud-projects.mjs?v=initialize-1';
import {mountProjectLifecycle,projectMenuActions} from './project-lifecycle-ui.mjs?v=i18n-1';
import {mountWorkspace,WORKSPACE_ROLES} from './workspace-ui.mjs?v=initialize-1';
import {evaluateEligibility,normalizeEligibility} from './eligibility.mjs?v=procurement-1';
import {mountEligibility} from './eligibility-ui.mjs?v=i18n-1';
import {mountScenario,normalizeScenarios,scenarioDataSignature} from './scenarios.mjs?v=i18n-1';
import {decisionRows,mountDecision,normalizeDecision} from './decision-ui.mjs?v=i18n-1';
import {mountReviewPanel} from './review-ui.mjs?v=i18n-1';
import {getLocale,saveLocale,t,translateSystemText} from './i18n.mjs';
import {applyEnglishShell} from './english-shell.mjs?v=visuals-1';
import {renderScorePlot,renderRankMap} from './overview-viz.mjs?v=visuals-1';
import {renderPairHistogram,renderSensitivityChart} from './comparison-viz.mjs?v=visuals-1';
import {mountAccountUI} from './account-ui.mjs?v=login-tagline-1';

const $=s=>document.querySelector(s);
const $$=s=>[...document.querySelectorAll(s)];
const clone=x=>structuredClone(x);
const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=(x,d=4)=>Number(x)!==0&&Math.abs(Number(x))<10**(-d)?Number(x).toExponential(2):Number(x).toFixed(d);
const pct=(x,d=1)=>`${(x*100).toFixed(d)}%`;
const icon=name=>`<i data-lucide="${name}"></i>`;
const score=x=>num(x*100,2);
const signedScore=x=>`${x>0?'+':''}${score(x)}`;
const language=getLocale(),languageTransitionKey='adapt.language-transition';
const assessmentProgress=t('正在生成评估结果','Calculating assessment results');
const supplierCount=count=>t(`${count} 家供应商`,`${count} ${count===1?'supplier':'suppliers'}`);
const criterionCount=count=>t(`${count} 项指标`,`${count} ${count===1?'criterion':'criteria'}`);
const pairCount=count=>t(`${count} 组对比`,`${count} ${count===1?'comparison':'comparisons'}`);
const projectCount=count=>t(`${count} 项`,`${count} ${count===1?'project':'projects'}`);
const eligibilityLabel=row=>({
  eligible:t('合格','Eligible'),ineligible:t('不合格','Ineligible'),
  pending:t('待核验','Verification pending'),unconfigured:t('未配置','Not configured'),
})[row.code]??translateSystemText(row.status);
const directionLabel=key=>key==='cost'?t('越低越好','Lower is better'):t('越高越好','Higher is better');
const directionAria=name=>t(`${name}评价方向`,`${name}: scoring direction`);
const columnLabel=index=>t(`第 ${index+1} 列`,`Column ${index+1}`);
const transition=consumeLanguageTransition();
const state={data:{suppliers:[],criteria:[],title:'',source:{}},result:null,view:'overview',method:'wsm',pairA:null,pairB:null,busy:false,request:0,table:null,defaultDelta:null};
const projectStore=createCloudProjectStore();
let accountUI,worker,toastTimer,toleranceTimer,pendingRun,fileReadId=0;
state.projectId=null;
state.workspace={mode:'initializing',session:null};
state.projectAccess=null;
state.assessmentMode=false;
state.sensitivityTab='weights';
let eligibilityEditor,scenarioEditor,decisionEditor,renderedProcurementProject;
let workspaceEditor,workspaceRequest=0,workspaceRefreshing=false;
let reviewEditor,projectList=['active','inactive','deleted'].includes(transition?.projectList)?transition.projectList:'active';

function icons(){window.lucide?.createIcons();}
function toast(message){$('#toast').textContent=translateSystemText(message);$('#toast').classList.remove('hidden');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.add('hidden'),4000);}
const projectDate=new Intl.DateTimeFormat(language,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Shanghai'});
const formatDate=iso=>projectDate.format(new Date(iso));
const signedIn=()=>state.workspace.mode==='cloud'||state.workspace.mode==='local';
const canEdit=()=>signedIn()&&state.projectAccess?.lifecycle!=='inactive'&&['administrator','evaluator'].includes(state.projectAccess?.role);
const canExport=()=>signedIn()&&!!state.projectAccess?.canExport;
const projectVersion=()=>state.projectAccess?.version;
const listLifecycle=project=>project.lifecycle??'active';
const projectReviewStates={
  unsubmitted:[t('未提交复核','Not submitted'),'neutral'],pending:[t('待复核','Pending review'),'amber'],
  returned:[t('已退回','Returned'),'amber'],archived:[t('已归档','Archived'),'green'],
};
const projectLifecycleUI=mountProjectLifecycle({
  findProject:id=>projectStore.listProjects({lifecycle:'all'}).find(project=>project.id===id),
  changeProject:changeListProject,openReview:id=>void resumeProject(id,{review:true}),
  focusList:focusProjectList,
  refresh:refreshWorkspace,icons,notify:toast,
});

function focusProjectList(){
  const tab=$('[data-project-list][aria-pressed="true"]');
  const target=tab?.getClientRects().length?tab:$('#new-assessment');
  target.focus({preventScroll:true});
}

function consumeLanguageTransition(){
  try{
    const raw=sessionStorage.getItem(languageTransitionKey);
    sessionStorage.removeItem(languageTransitionKey);
    const requested=raw&&JSON.parse(raw);
    return requested?.language===language?requested:null;
  }catch{return null;}
}

function switchLanguage(){
  if(state.busy||state.procurementSaving){
    toast(t('请等待当前评估操作完成。','Wait for the current assessment operation to finish.'));
    return;
  }
  if(hasPendingEdits())return;
  if(scenarioEditor?.isDirty()){
    toast(t('请先保存或取消方案修改。','Save or cancel your scenario changes first.'));
    return;
  }
  const next=language==='en'?'zh-CN':'en';
  try{
    sessionStorage.setItem(languageTransitionKey,JSON.stringify({
      language:next,projectId:state.projectId,view:state.view,assessment:state.assessmentMode,
      sensitivityTab:state.sensitivityTab,pair:[state.pairA,state.pairB],projectList,
    }));
  }catch{/* The language choice works even when storage is restricted. */}
  saveLocale(next);
  const url=new URL(location.href);
  url.searchParams.set('lang',next);
  location.replace(url.href);
}

function syncAccessControls(){
  const readonly=!canEdit(),locked=state.busy||state.procurementSaving||!!state.failedRun;
  const assessment=state.assessmentMode||state.view!=='overview';
  for(const control of $$('#new-assessment,#import-button,#data-import-button')){
    control.disabled=locked||!signedIn()||(assessment&&state.result&&readonly);
  }
  for(const control of $$('#apply-weights,#apply-data-settings,#reset-weights,#p-slider,#delta-slider,#reset-tolerance,[data-weight],[data-weight-slider],[data-criterion]')){
    control.disabled=locked||readonly;
  }
  $('#confirm-import').disabled=locked||!signedIn()||!state.importData;
  $('#export-button').disabled=locked||!state.result||!canExport()||state.dirty;
  $('#export-wrap').classList.toggle('hidden',!state.result||!canExport()||!assessment);
  const projectRole=$('#project-role');
  projectRole.textContent=readonly&&state.result?(state.projectAccess?.lifecycle==='inactive'?t('已移出','Inactive'):WORKSPACE_ROLES[state.projectAccess?.role]||''):'';
  projectRole.classList.toggle('hidden',!projectRole.textContent);
  const accountName=state.workspace.session?.user?t('账户与工作区','Account & Workspace'):t('工作区','Workspace');
  $('#workspace-button-label').textContent=accountName;
  $('#workspace-button').setAttribute('aria-label',accountName);
}

function renderProjects(){
  projectLifecycleUI.closeMenu();
  const allProjects=projectStore.listProjects({lifecycle:'all'});
  const hasAdministrator=state.workspace.mode==='cloud'&&allProjects.some(project=>project.role==='administrator');
  const showInactive=hasAdministrator||allProjects.some(project=>listLifecycle(project)==='inactive');
  if(signedIn()&&((projectList==='deleted'&&!hasAdministrator)||(projectList==='inactive'&&!showInactive)))projectList='active';
  $('#project-list-tabs').classList.toggle('hidden',!signedIn()||!showInactive);
  $('[data-project-list="deleted"]').classList.toggle('hidden',!hasAdministrator);
  for(const tab of $$('[data-project-list]'))tab.setAttribute('aria-pressed',String(tab.dataset.projectList===projectList));
  const projects=allProjects.filter(project=>listLifecycle(project)===projectList);
  const query=$('#project-search').value.trim().toLocaleLowerCase();
  const filter=$('#project-filter').value;
  const matching=projects.filter(project=>{
    const matchesStatus=filter==='all'||filter===(project.reviewState??'unsubmitted')||
      (filter==='unresolved'&&project.unresolvedCount>0)||(filter==='resolved'&&!project.unresolvedCount);
    return matchesStatus&&[project.title,project.source?.filename].some(value=>String(value??'').toLocaleLowerCase().includes(query));
  });
  const filtered=!!query||filter!=='all';
  const showActions=matching.some(project=>projectMenuActions(project).length);
  $('#project-action-column').classList.toggle('hidden',!showActions);
  $('#project-count').textContent=filtered?`${matching.length} / ${projectCount(projects.length)}`:projectCount(projects.length);
  $('#project-filters').classList.toggle('hidden',!projects.length);
  $('#project-table').classList.toggle('hidden',!allProjects.length);
  $('#empty-workspace').classList.toggle('hidden',!!allProjects.length||!signedIn());
  const mode=state.workspace.mode;
  $('#project-connection').classList.toggle('hidden',signedIn());
  $('#project-connection-message').textContent=mode==='initializing'?t('正在加载评估项目…','Loading assessment projects…'):mode==='anonymous'?t('登录后查看评估项目。','Sign in to view assessment projects.'):state.workspace.warning||t('暂时无法加载评估项目。','Assessment projects are temporarily unavailable.');
  $('#retry-workspace').classList.toggle('hidden',mode!=='unavailable');
  $('#workspace-sign-in').classList.toggle('hidden',mode!=='anonymous');
  $('#project-rows').innerHTML=matching.map(project=>{
    const id=esc(project.id),title=esc(project.title),pending=project.unresolvedCount;
    const isDeleted=listLifecycle(project)==='deleted';
    const [label,tone]=projectReviewStates[project.reviewState]??projectReviewStates.unsubmitted;
    const updated=`<time datetime="${esc(project.updatedAt)}">${formatDate(project.updatedAt)}</time>`;
    const name=isDeleted?`<strong class="project-deleted-name">${title}</strong>`:`<button class="project-link" type="button" data-project="${id}">${title}</button>`;
    const actionsLabel=t(`项目操作 ${title}`,`Project actions: ${title}`);
    const menu=projectMenuActions(project).length?`<button class="icon-button project-row-menu-trigger" type="button" data-project-menu="${id}" aria-label="${actionsLabel}" aria-haspopup="menu" aria-controls="project-row-menu" aria-expanded="false">${icon('ellipsis')}</button>`:'';
    return `<tr data-project-id="${id}"${isDeleted?'':` data-project-row="${id}"`}><td class="project-name-cell">${name}<span class="project-source" title="${esc(project.source?.filename)}">${esc(project.source?.filename)}</span><span class="project-mobile-date">${updated}</span></td><td><span class="badge ${tone}">${label}</span></td><td class="numeric">${t(`${project.supplierCount} 家`,project.supplierCount)}</td><td class="numeric">${t(`${pending} 组`,pending)}</td><td class="project-updated">${updated}</td>${showActions?`<td class="project-row-actions">${menu}</td>`:''}</tr>`;
  }).join('')||`<tr><td colspan="${showActions?6:5}" class="empty-state"><div class="project-no-matches">${projects.length?t('没有匹配的项目','No matching projects'):{active:t('暂无活跃项目','No active projects'),inactive:t('暂无已移出的项目','No inactive projects'),deleted:t('暂无最近删除的项目','No recently deleted projects')}[projectList]}${projects.length&&filtered?`<button class="text-button" id="clear-project-filters" type="button">${t('清除筛选','Clear Filters')}</button>`:''}</div></td></tr>`;
  const listed=new Set(projects.map(project=>project.id));
  const activities=projectStore.listActivities(20).filter(event=>event.projectId&&listed.has(event.projectId)).slice(0,8);
  $('#recent-activity').classList.toggle('hidden',!activities.length);
  $('#activity-list').innerHTML=activities.map(event=>`<li>${icon(event.kind==='import'||event.kind==='reopen'?'file-check':'sliders-horizontal')}<div><strong>${esc(event.source==='legacy'?event.label:translateSystemText(event.label))}</strong>${projectList==='deleted'?`<span>${esc(event.projectTitle)}</span>`:`<button class="text-button" data-project="${esc(event.projectId)}">${esc(event.projectTitle)}</button>`}<time datetime="${esc(event.timestamp)}">${formatDate(event.timestamp)}</time></div></li>`).join('');
  const migration=state.migrationPreview;
  $('#migration-banner').classList.toggle('hidden',!migration?.canMigrate);
  $('#migration-banner-label').textContent=migration?.count?t(`此浏览器有 ${migration.count} 个旧项目 · ${migration.historyCount} 条活动记录`,`Local projects: ${migration.count} · Activity records: ${migration.historyCount}`):'';
  icons();
}

async function changeListProject(project,action){
  if(state.workspace.mode!=='cloud')throw new Error(t('工作区暂不可用，请重新登录或刷新。','Workspace unavailable. Refresh the page or sign in again.'));
  if(state.busy||state.procurementSaving)throw new Error(t('请等待当前评估操作完成。','Wait for the current assessment operation to finish.'));
  if(project.id===state.projectId&&(hasPendingEdits()||scenarioEditor?.isDirty()))throw new Error(t('请先保存或取消当前评估的修改。','Save or cancel the current assessment changes first.'));
  const {project:updated}=await projectStore.changeProjectLifecycle(project.id,action,{
    expectedVersion:project.version,expectedLifecycleVersion:project.lifecycleVersion,
  });
  if(updated.id===state.projectId){
    if(listLifecycle(updated)==='deleted')clearCurrentProject();
    else{
      state.projectAccess={...state.projectAccess,lifecycle:listLifecycle(updated)};
      mountProcurement();
    }
  }
  if(state.view==='overview'&&!state.assessmentMode)renderProjects();
  syncAccessControls();
  return updated;
}

function toggleNavigation(open){
  $('#sidebar').classList.toggle('open',open);
  $('#menu-button').setAttribute('aria-expanded',String(open));
  $('#nav-backdrop').classList.toggle('hidden',!open);
}

function showView(view,{push=false,assessment=state.assessmentMode}={}){
  if(!['overview','compare','sensitivity','data'].includes(view))view='overview';
  state.view=view;
  state.assessmentMode=assessment;
  const showProjects=view==='overview'&&!assessment;
  $('#projects-view').classList.toggle('hidden',!showProjects);
  $('#workspace-name').classList.toggle('hidden',!showProjects);
  $('#workspace-home').classList.toggle('hidden',showProjects);
  $$('.view').forEach(el=>el.classList.toggle('hidden',el.id!==`view-${view}`||showProjects));
  $$('.result-only').forEach(el=>el.classList.toggle('hidden',!state.result));
  $$('.no-result-only,#assessment-empty').forEach(el=>el.classList.toggle('hidden',!!state.result));
  $('#analysis-toolbar').classList.toggle('hidden',showProjects||!state.result);
  $('#export-wrap').classList.toggle('hidden',showProjects||!state.result);
  $('#new-assessment').classList.toggle('hidden',!showProjects);
  $('#import-button').classList.toggle('hidden',view==='data'||showProjects);
  const active=view==='overview'&&assessment?$('#active-assessment'):$(`.nav-item[data-view="${view}"]`);
  $$('.nav-item[data-view],#active-assessment').forEach(el=>{
    el.classList.toggle('active',el===active);
    if(el===active)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');
  });
  const headings={overview:assessment?t('评估结果','Assessment Results'):t('评估项目','Assessment Projects'),compare:t('供应商对比','Supplier Comparison'),sensitivity:t('决策偏好','Decision Preferences'),data:t('数据管理','Data Management')};
  $('#page-title').textContent=headings[view];
  toggleNavigation(false);
  const hash=`#${view}`;
  if(location.hash!==hash||Boolean(history.state?.assessment)!==assessment)history[push?'pushState':'replaceState']({assessment},'',hash);
  if(push)window.scrollTo(0,0);
  if(showProjects)renderProjects();
  else projectLifecycleUI.closeMenu();
  if(state.result){if(view==='overview'&&assessment)renderPerformance();if(view==='compare')renderCompare();if(view==='sensitivity')showSensitivityTab(state.sensitivityTab);}
  else showSensitivityTab('weights');
  syncAccessControls();
  icons();
}

function showRunError(message){
  $('#run-error').textContent=translateSystemText(message);
  $('#run-error').classList.toggle('hidden',!message);
}

function setSaveRecovery(failed){
  state.failedRun=failed;
  $('#save-recovery').classList.toggle('hidden',!failed);
  $('#retry-save').classList.toggle('hidden',!!failed?.conflict);
  $('#discard-save').textContent=failed?.conflict?t('打开最新版本','Open Latest Version'):t('放弃本次修改','Discard Changes');
}

function acceptProject(project){
  state.projectId=project.id;
  state.projectUpdatedAt=project.updatedAt;
  state.projectAccess={role:project.role,canExport:project.canExport===true,version:project.version,lifecycle:listLifecycle(project)};
}

async function commitRun(run,result){
  const data={...(run.data??state.data),p:result.p,delta:run.delta};
  setSaveRecovery(null);
  let project=run.project;
  if(!project){
    setBusy(true,t('正在保存到工作区','Saving to the workspace'));
    try{
      ({project}=await projectStore.recordAnalysis({
        projectId:run.projectId,data,result,kind:run.kind,delta:run.delta,
        expectedVersion:run.version,mutationId:run.mutationId,
      }));
    }catch(error){
      const conflict=error.status===409||error.status===403;
      setSaveRecovery({run,result,conflict});
      showRunError(error.message||t('评估已完成，暂时无法保存。','Assessment finished. It could not be saved yet.'));
      if(state.result)syncTolerance();
      setBusy(false);
      return;
    }
  }
  state.data=project.data??data;
  state.result=result;
  if(run.kind==='import'||run.kind==='reopen'||run.kind==='resume'){
    state.pairA=result.sorted[0];
    state.pairB=result.sorted[1];
    const [first,second]=run.after?.pair??[];
    if(first!==second&&result.sorted.includes(first)&&result.sorted.includes(second)){
      state.pairA=first;
      state.pairB=second;
    }
    if(run.after?.sensitivityTab==='scenarios')state.sensitivityTab='scenarios';
    if(run.projectId!==state.projectId||run.kind!=='resume')$('#eligibility-panel').open=false;
  }
  state.defaultDelta=result.defaultDelta;
  acceptProject(project);
  if(run.data)prepareProcurement(run.kind!=='settings');
  setBusy(false);
  if(run.data)markDirty(false,'all');
  renderAll(!!run.data);
  if(run.after){
    showView(run.after.view,{assessment:run.after.assessment,push:run.after.push??true});
    $('#page-title').focus({preventScroll:true});
    if(run.after.review)openReview();
  }
}

function startWorker(){
  worker=new Worker(new URL('./worker.js?v=workspace-2',import.meta.url),{type:'module'});
  worker.onmessage=({data:message})=>{
    if(message.id!==state.request||!pendingRun)return;
    if(message.type==='progress'){
      const progress=Math.round(message.progress*100);
      $('#progress-fill').value=progress;
      $('#progress-value').textContent=`${progress}%`;
      return;
    }
    const run=pendingRun;
    pendingRun=null;
    if(message.type==='error'){
      setBusy(false);showRunError(message.error||t('无法完成评估，请检查设置后重试。','Assessment could not finish. Check the settings and try again.'));
      if(state.result)syncTolerance();
      return;
    }
    if(message.type!=='result')return;
    void commitRun(run,message.result);
  };
  worker.onerror=()=>{
    pendingRun=null;setBusy(false);showRunError(t('无法加载评估组件，请刷新页面后重试。','The assessment engine did not load. Refresh and try again.'));
  };
}

function setBusy(busy,label=assessmentProgress){
  state.busy=busy;
  $('#run-progress').classList.toggle('hidden',!busy);
  $('#progress-label').textContent=label;
  $('#progress-fill').classList.toggle('hidden',label!==assessmentProgress);
  $('#progress-value').classList.toggle('hidden',label!==assessmentProgress);
  if(busy){$('#progress-fill').value=0;$('#progress-value').textContent='0%';}
  syncAccessControls();
}

function analyze(data,{kind='settings',projectId=state.projectId,project,after}={}){
  if(state.busy||state.procurementSaving||!signedIn()||(kind==='settings'&&(!canEdit()||state.failedRun)))return;
  clearTimeout(toleranceTimer);
  const input={...clone(data),p:data.p??.9,delta:data.delta??null};
  if(kind==='settings'&&state.procurement?.scenarios.length){
    // Directions can be edited in place. The saved schemes keep their own weights.
    try{
      const datasetSignature=scenarioDataSignature(input);
      input.procurement={...state.procurement,scenarios:state.procurement.scenarios.map(scenario=>({...scenario,datasetSignature}))};
    }catch(error){showRunError(error.message);return;}
  }
  pendingRun={kind,projectId,project,after,data:input,delta:input.delta,version:projectVersion(),mutationId:crypto.randomUUID()};
  showRunError('');setBusy(true);
  worker.postMessage({type:'analyze',id:++state.request,data:input});
}

function reclassify(p,delta){
  if(!state.result||state.busy||state.failedRun||!canEdit())return;
  clearTimeout(toleranceTimer);
  toleranceTimer=setTimeout(()=>{
    if(state.busy||!canEdit())return;
    pendingRun={kind:'comparison',projectId:state.projectId,delta,version:projectVersion()};
    showRunError('');setBusy(true);
    worker.postMessage({type:'reclassify',id:++state.request,p,delta});
  },150);
}

async function resumeProject(id,{discard=false,review=false,returnTo=null}={}){
  if(state.busy||state.procurementSaving||!signedIn()||(!discard&&hasPendingEdits()))return;
  const after=returnTo?{...returnTo,review:false,push:false}:{view:'overview',assessment:true,review};
  clearTimeout(toleranceTimer);
  showRunError('');
  setBusy(true,t('正在打开评估','Opening assessment'));
  let project;
  try{
    project=await projectStore.loadProject(id);
    if(!project)throw new Error(t('此项目已不可用。','This project is no longer available.'));
  }catch(error){
    if(id===state.projectId&&(error.status===403||error.status===404))clearCurrentProject();
    setBusy(false);
    showRunError(error.message);
    return;
  }
  setBusy(false);
  if(!discard&&id===state.projectId&&state.result&&project.version===projectVersion()&&project.role===state.projectAccess?.role&&project.canExport===state.projectAccess?.canExport&&listLifecycle(project)===state.projectAccess?.lifecycle){
    showView(after.view,{assessment:after.assessment,push:true});
    $('#page-title').focus({preventScroll:true});
    if(review)openReview();
    return;
  }
  if(discard)resetProcurementMount();
  setSaveRecovery(null);
  analyze(project.data,{kind:'resume',projectId:id,project,after});
}

function hasPendingEdits(){
  if(state.failedRun){toast(t('请先处理上次保存。','Resolve the previous save before continuing.'));return true;}
  if(state.dirty){toast(t('请先应用当前评估的设置，或在决策偏好中恢复已应用的设置。','Apply your changes or restore the applied settings in Decision Preferences.'));return true;}
  if(eligibilityEditor?.isDirty?.()){toast(t('请先保存准入条件，或取消未保存的修改。','Save or cancel your eligibility changes first.'));return true;}
  if(decisionEditor?.isDirty()){toast(t('请先保存当前的采购决策。','Save the current procurement decision first.'));return true;}
  return false;
}

function projectProcurement(data,source=data.procurement){
  return {
    eligibility:normalizeEligibility(data,source?.eligibility),
    scenarios:normalizeScenarios(data,source?.scenarios),
    decision:normalizeDecision(source?.decision,data.suppliers),
  };
}

function prepareProcurement(reset){
  const data=state.data,source=data.procurement;
  const errors=[];
  const restore=(read,fallback)=>{
    try{return read();}catch(error){errors.push(error.message);return fallback;}
  };
  state.procurement={
    eligibility:restore(()=>normalizeEligibility(data,source?.eligibility),normalizeEligibility(data)),
    scenarios:restore(()=>normalizeScenarios(data,source?.scenarios),[]),
    decision:normalizeDecision(source?.decision,data.suppliers),
  };
  if(source)data.procurement=state.procurement;
  if(errors.length)showRunError(`${t('部分采购设置无法读取。','Some procurement settings could not be read. ')}${errors.map(translateSystemText).join(' ')}`);
  state.eligibility=evaluateEligibility(state.data,state.procurement.eligibility);
  if(reset){
    state.sensitivityTab='weights';
    $('#supplier-search').value='';
    $('#eligibility-filter').value=state.eligibility.configured?'eligible':'all';
  }
}

function decisionEligibility(){
  return Object.fromEntries(state.eligibility.rows.map(row=>[row.id,{
    status:row.code==='ineligible'?'excluded':row.code,
    label:row.status,
    reasons:row.reasons,
  }]));
}

function runScenario(data){
  const weights=data.criteria.map(({lower,modal,upper})=>lower/3+modal/3+upper/3);
  const {sorted,suppliers}=scenarioScores(data,weights);
  return {sorted,suppliers:suppliers.map(({id,name,score,rank})=>({id,name,baseline:score,wsmRank:rank}))};
}

function scenarioInputs(){
  return {
    contextId:state.projectId,data:state.data,
    result:{sorted:state.result.sorted,suppliers:state.result.suppliers.map(({id,baseline,wsmRank})=>({id,baseline,wsmRank}))},
    scenarios:state.procurement.scenarios,
    eligibleIds:state.eligibility.configured?state.eligibility.eligibleIds:undefined,
    readOnly:!canEdit(),
    canExport:canExport(),
  };
}

function resetProcurementMount(){
  eligibilityEditor?.destroy();scenarioEditor?.destroy();decisionEditor?.destroy();
  eligibilityEditor=null;scenarioEditor=null;decisionEditor=null;
  renderedProcurementProject=null;
}

function clearCurrentProject(){
  resetProcurementMount();
  clearTimeout(toleranceTimer);
  setSaveRecovery(null);
  state.projectId=null;
  state.projectAccess=null;
  state.projectUpdatedAt=null;
  state.result=null;
  state.data={suppliers:[],criteria:[],title:'',source:{}};
  state.draftCriteria=null;
  state.assessmentMode=false;
  state.dirty=false;
  state.procurement=null;
  state.eligibility=null;
  $('#sidebar-project').textContent=t('尚未打开项目','No project open');
  $('#sidebar-project').removeAttribute('title');
  $('#eligibility-panel').open=false;
  $('#unresolved-nav').classList.add('hidden');
  for(const selector of ['#results-body','#performance-chart','#rank-chart','#pair-a','#pair-b','#pair-matrix','#criteria-body','#data-table','#weight-controls','#decision-panel','#decision-print','#stats-grid','#overview-insight','#pair-chart','#pair-metrics','#pair-conclusion','#pair-drivers','#scan-chart','#scan-summary']){
    const element=$(selector);
    if(element)element.replaceChildren();
  }
  showView('overview',{assessment:false});
}

function mountProcurement(){
  const mountKey=`${state.projectId}:${canEdit()}:${canExport()}`;
  if(renderedProcurementProject===mountKey&&eligibilityEditor){
    eligibilityEditor.update({data:state.data,settings:state.procurement.eligibility,readOnly:!canEdit()});
    scenarioEditor.update(scenarioInputs());
    return;
  }
  resetProcurementMount();
  renderedProcurementProject=mountKey;
  eligibilityEditor=mountEligibility($('#eligibility-editor'),{
    data:state.data,settings:state.procurement.eligibility,readOnly:!canEdit(),
    onSave:settings=>saveProcurement('eligibility',settings),
  });
  scenarioEditor=mountScenario($('#scenario-panel'),{
    ...scenarioInputs(),onSave:scenarios=>saveProcurement('scenarios',scenarios),workerRun:async data=>runScenario(data),
    onExport:()=>authorizeExport('scenarios_csv'),
  });
  decisionEditor=mountDecision($('#decision-panel'),{
    suppliers:state.data.suppliers,decision:state.procurement.decision,eligibility:decisionEligibility(),
    readOnly:!canEdit(),
    onSave:decision=>saveProcurement('decision',decision),
  });
}

async function saveProcurement(kind,value){
  if(!canEdit())throw new Error(t('此项目为只读。','This project is read-only.'));
  if(!state.result||state.busy||state.procurementSaving||state.failedRun)throw new Error(t('请先处理当前评估。','Finish the current assessment operation first.'));
  const procurement=projectProcurement(state.data,{...state.procurement,[kind]:value});
  const data={...state.data,procurement};
  state.procurementSaving=true;
  syncAccessControls();
  let saved;
  try{
    saved=await projectStore.recordAnalysis({projectId:state.projectId,data,result:state.result,kind,expectedVersion:projectVersion()});
  }catch(error){
    if(error.status===409||error.status===403){
      setSaveRecovery({run:{projectId:state.projectId},conflict:true});
      showRunError(error.message);
    }
    throw error;
  }finally{
    state.procurementSaving=false;
    syncAccessControls();
  }
  const {project,persisted}=saved;
  state.data=data;
  state.procurement=procurement;
  acceptProject(project);
  $('#last-updated').textContent=t(`更新于 ${formatDate(project.updatedAt)}`,`Updated ${formatDate(project.updatedAt)}`);
  if(kind==='eligibility'){
    state.eligibility=evaluateEligibility(data,procurement.eligibility);
    $('#eligibility-filter').value=state.eligibility.configured?'eligible':'all';
    decisionEditor?.updateEligibility?.(decisionEligibility());
    scenarioEditor?.update(scenarioInputs());
    renderStats();renderTable();renderInsight();renderCompare();
  }
  renderDecisionPrint();
  return kind==='eligibility'?{settings:procurement.eligibility,persisted}:procurement[kind];
}

function showSensitivityTab(tab){
  state.sensitivityTab=tab;
  const scenarios=tab==='scenarios';
  $('#weights-tab').setAttribute('aria-pressed',String(!scenarios));
  $('#scenarios-tab').setAttribute('aria-pressed',String(scenarios));
  $('#weights-tab').classList.toggle('active',!scenarios);
  $('#scenarios-tab').classList.toggle('active',scenarios);
  $('#weight-view').classList.toggle('hidden',!state.result||scenarios);
  $('#scenario-panel').classList.toggle('hidden',!state.result||!scenarios);
  if(!scenarios&&state.result)renderScan();
}

function openProcurementSection(section){
  if(!state.result)return;
  if(section==='review'){
    openReview();
    return;
  }
  if(section==='scenarios'){
    state.sensitivityTab='scenarios';
    showView('sensitivity',{push:true,assessment:true});
    $('#scenarios-tab').focus();
    return;
  }
  const isEligibility=section==='eligibility';
  showView(isEligibility?'data':'overview',{push:true,assessment:true});
  const target=$(isEligibility?'#eligibility-panel > summary':'#decision-panel');
  if(isEligibility)target.parentElement.open=true;
  target.focus({preventScroll:true});
  target.scrollIntoView({block:'start'});
}

function sortedSuppliers(){const map=new Map(state.result.suppliers.map(x=>[x.id,x]));return state.result.sorted.map(id=>map.get(id));}
function supplier(id){return state.result.suppliers.find(s=>s.id===id);}
function orientedPair(a=state.pairA,b=state.pairB){
  const p=state.result.pairs.find(p=>p.a===a&&p.b===b||p.a===b&&p.b===a);if(!p)return null;
  if(p.a===a)return p;
  return {...p,a,b,prob:p.probReverse??1-p.prob-(p.probTie||0),probReverse:p.prob,lo:-p.hi,hi:-p.lo,min:-p.max,max:-p.min,histogram:p.histogram?.map(x=>({left:-x.right,right:-x.left,probability:x.probability})).reverse()};
}
function statusBadge(status){return `<span class="badge ${status==='未解决'?'amber':status==='等效'?'neutral':'green'}">${status==='可分'?t('优势明确','Clear advantage'):status==='等效'?t('差异可接受','Difference acceptable'):t('需确认偏好','Clarify preferences')}</span>`;}
function renderAll(changed){
  const {data,result:r}=state;
  $('#dataset-title').textContent=data.title;$('#sidebar-project').textContent=data.title;
  $('#sidebar-project').title=data.title;
  $('#last-updated').textContent=state.projectUpdatedAt?t(`更新于 ${formatDate(state.projectUpdatedAt)}`,`Updated ${formatDate(state.projectUpdatedAt)}`):'';
  const unresolved=r.pairs.filter(x=>x.status==='未解决').length;$('#unresolved-nav').textContent=unresolved;$('#unresolved-nav').classList.toggle('hidden',!unresolved);
  renderStats();renderPerformance();renderRank();renderTable();renderInsight();renderDecisionPrint();
  const options=data.suppliers.map(s=>`<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');$('#pair-a').innerHTML=options;$('#pair-b').innerHTML=options;$('#pair-a').value=state.pairA;$('#pair-b').value=state.pairB;
  if(changed){state.draftCriteria=clone(state.data.criteria);renderWeightControls();renderData();$('#scan-criterion').innerHTML=data.criteria.map((c,j)=>`<option value="${j}">${esc(c.name)}</option>`).join('');$('#scan-criterion').value=String(Math.min(1,data.criteria.length-1));mountProcurement();}
  syncTolerance();showView(state.view);icons();
}
function renderStats(){
  const r=state.result,ss=sortedSuppliers(),winner=ss[0];
  const leaders=ss.filter(supplier=>supplier.wsmRank===1);
  const pending=r.pairs.filter(pair=>pair.status==='未解决').length;
  const openPairs=[t('待确认组合','Open pairs'),t(`${pending} 组`,String(pending)),pairCount(r.pairs.length)];
  const summary=state.eligibility.configured?[
    [t('符合准入条件','Eligible'),supplierCount(state.eligibility.eligibleIds.length),t(`共 ${ss.length} 家参评`,`of ${supplierCount(ss.length)}`)],
    [t('待核验','Verification pending'),supplierCount(state.eligibility.pendingIds.length)],
    [t('未满足准入条件','Ineligible'),supplierCount(state.eligibility.excludedIds.length)],
    openPairs,
  ]:[
    [leaders.length>1?t('并列第一','Tied for first'):t('综合评分第一','Top overall score'),leaders.length>1?t(`${leaders.length} 家并列`,`${leaders.length} tied`):winner.name,t(`${score(winner.baseline)} 分`,`${score(winner.baseline)} pts`)],
    [leaders.length>1?t(`${winner.name} 保持第一`,`${winner.name} keeps first`):t('保持第一的比例','Stays in first place'),pct(winner.rankProb[0]),t('评价重点变化时','As weights vary')],
    [t('参评规模','Assessment size'),supplierCount(ss.length),criterionCount(state.data.criteria.length)],
    openPairs,
  ];
  $('#stats-grid').innerHTML=summary.map(([label,value,detail])=>`<div class="summary-cell"><span>${esc(label)}</span><strong>${esc(value)}</strong>${detail?`<small>${esc(detail)}</small>`:''}</div>`).join('');
}
function renderPerformance(){
  renderScorePlot($('#performance-chart'),state.result.suppliers,state.method);
}
function probabilityColors(probability){
  const level=Math.sqrt(probability);
  const shades=[[239,245,255],[34,78,184]];
  const channels=shades[0].map((start,i)=>Math.round(start+level*(shades[1][i]-start)));
  const linear=channels.map(channel=>{
    const value=channel/255;
    return value<=.04045?value/12.92:((value+.055)/1.055)**2.4;
  });
  const luminance=.2126*linear[0]+.7152*linear[1]+.0722*linear[2];
  return `background:rgb(${channels.join(',')});color:${luminance<.18?'#fff':luminance<.25?'#000':'#193363'}`;
}

function renderRank(){
  renderRankMap($('#rank-chart'),sortedSuppliers());
}
function renderTable(){
  if(!state.result)return;
  const query=$('#supplier-search').value.trim().toLocaleLowerCase();
  const {configured,rows}=state.eligibility;
  const selection=configured?$('#eligibility-filter').value:'all';
  const qualifications=new Map(rows.map(row=>[row.id,row]));
  const suppliers=sortedSuppliers().filter(row=>row.name.toLocaleLowerCase().includes(query)&&(selection==='all'||qualifications.get(row.id)?.code===selection));
  $('#supplier-count').textContent=supplierCount(suppliers.length);
  $('#eligibility-filter').classList.toggle('hidden',!configured);
  $('#eligibility-column').classList.toggle('hidden',!configured);
  $('#supplier-rank-heading').textContent=configured?t('综合原排名','Overall rank'):t('排名','Rank');
  $('#eligibility-summary').classList.toggle('hidden',!configured);
  $('#eligibility-summary').textContent=configured?t('准入筛选保留全体参评供应商的综合分与原排名。','Scores and ranks still reflect all assessed suppliers.'):'';
  $('#results-body').innerHTML=suppliers.length?suppliers.map(s=>{
    const qualification=configured?`<td>${eligibilityBadge(qualifications.get(s.id))}</td>`:'';
    return `<tr><td><span class="rank-number ${s.wsmRank===1?'first':''}">${String(s.wsmRank).padStart(2,'0')}</span></td><td>${esc(s.name)}</td>${qualification}<td class="score-number numeric">${score(s.baseline)}<span class="score-unit">${t('分','pts')}</span></td><td class="numeric" title="${t('评价重点变化时保持当前名次的比例','Share of weight scenarios where the supplier keeps its rank')}"><span class="stable-bar"><span style="width:${s.rsi*100}%"></span></span>${pct(s.rsi,1)}</td><td><button class="compare-table-button" data-compare="${esc(s.id)}">${t('查看对比','Compare')}${icon('git-compare-arrows')}</button></td></tr>`;
  }).join(''):`<tr><td colspan="${configured?6:5}"><div class="empty-state">${!query&&selection==='eligible'?t('暂无符合准入条件的供应商','No eligible suppliers yet'):t('没有匹配的供应商','No matching suppliers')}</div></td></tr>`;
  icons();
}

function eligibilityBadge(row){
  if(!row)return '';
  const tone=row.code==='eligible'?'green':row.code==='pending'?'amber':row.code==='ineligible'?'red':'neutral';
  return `<span class="badge ${tone}" title="${esc(row.reasons?.map(translateSystemText).join(t('；','; ')))}">${esc(eligibilityLabel(row))}</span>`;
}

function renderInsight(){
  const {configured,candidateIds}=state.eligibility;
  const candidates=new Set(candidateIds);
  const ss=sortedSuppliers().filter(row=>candidates.has(row.id));
  const winner=ss[0];
  const pair=state.result.pairs.find(p=>p.status==='未解决'&&candidates.has(p.a)&&candidates.has(p.b));
  let text;
  if(pair){const a=esc(supplier(pair.a).name),b=esc(supplier(pair.b).name);text=`<strong>${t(`${a} 与 ${b} 待确认`,`${a} vs. ${b} needs review`)}</strong>`;}
  else if(winner)text=`<strong>${esc(winner.name)} ${configured?t('在合格供应商中评分最高','has the highest eligible score'):t(`当前位列第 ${winner.wsmRank} 名`,`currently ranks #${winner.wsmRank}`)}</strong>`;
  else text=`<strong>${t('暂无符合准入条件的供应商','No eligible suppliers yet')}</strong>`;
  const action=ss.length>=2?`<button class="text-button" data-insight="${esc(pair?.a??ss[0].id)}" data-b="${esc(pair?.b??ss[1].id)}">${t('查看对比','Compare')}${icon('scan-search')}</button>`:`<button class="text-button" data-extension="${winner?'decision':'eligibility'}">${winner?t('记录采购决策','Record Decision'):t('查看准入条件','View Eligibility Rules')}</button>`;
  $('#overview-insight').innerHTML=`<span class="insight-icon">${icon('lightbulb')}</span><span class="insight-text">${text}</span>${action}`;
}
function syncTolerance(){const r=state.result;state.uiDelta=r.delta;state.uiDeltaSetting=state.data.delta;$('#delta-slider').min='0';$('#delta-slider').step='any';$('#delta-slider').max=String(Math.max(.1,r.delta*2));$('#delta-slider').value=r.delta;$('#delta-display').textContent=score(r.delta);$('#p-slider').value=r.p;$('#p-display').textContent=pct(r.p,0);}
function renderCompare(){
  if(!state.result)return;const p=orientedPair();if(!p)return;const a=supplier(p.a),b=supplier(p.b),r=state.result;
  for(const [selector,supplierId] of [['#pair-eligibility-a',p.a],['#pair-eligibility-b',p.b]]){
    const label=$(selector);
    label.classList.toggle('hidden',!state.eligibility.configured);
    label.innerHTML=state.eligibility.configured?eligibilityBadge(state.eligibility.rows.find(row=>row.id===supplierId)):'';
  }
  $('#pair-status').outerHTML=statusBadge(p.status).replace('class="','id="pair-status" class="');
  $('#pair-metrics').innerHTML=`<div class="pair-metric"><span>${t(`${esc(a.name)} 得分更高`,`${esc(a.name)} scores higher`)}</span><strong>${pct(p.prob,2)}</strong><small>${t('评价重点变化情景','Across weighting scenarios')}</small></div><div class="pair-metric"><span>${t('综合评分差','Overall score gap')}</span><strong>${signedScore(a.baseline-b.baseline)}</strong><small>${esc(a.name)} − ${esc(b.name)}</small></div><div class="pair-metric"><span>${t('差异可接受的情景','Scenarios within tolerance')}</span><strong>${pct(p.within??0,1)}</strong><small>±${score(r.delta)} ${t('分','pts')}</small></div>`;
  renderPairHistogram($('#pair-chart'),{
    pair:p,aName:a.name,bName:b.name,delta:r.delta,coverage:r.p,currentGap:a.baseline-b.baseline,
  });
  const better=esc(p.lo>0?a.name:b.name);
  const action=p.status==='等效'
    ?t(' <strong>评分差异可接受。</strong> 可结合商务条款、服务承诺等条件选择。','<strong>The score difference is acceptable.</strong> Consider commercial terms and service commitments.')
    :p.status==='可分'
      ?t(`<strong>${better} 表现更优。</strong> 当前评价标准支持优先比较这家供应商。`,`<strong>${better} scores higher.</strong> Current criteria support giving this supplier priority.`)
      :t('<strong>需进一步确认评价重点。</strong> 明确关键指标的优先级后，重新比较。','<strong>Clarify your priorities.</strong> Refine key criteria weights, then compare again.');
  $('#pair-conclusion').innerHTML=action;
  renderPairDrivers(a,b);renderMatrix();icons();
}
function renderPairDrivers(a,b){
  const first=state.data.suppliers.findIndex(row=>row.id===a.id);
  const second=state.data.suppliers.findIndex(row=>row.id===b.id);
  const {normalized,weights}=state.result;
  const rows=state.data.criteria.map((criterion,i)=>({
    criterion,weight:weights[i],a:state.data.suppliers[first].values[i],b:state.data.suppliers[second].values[i],
    difference:weights[i]*(normalized[first][i]-normalized[second][i]),
  })).sort((left,right)=>Math.abs(right.difference)-Math.abs(left.difference));
  const formatValue=value=>Number(value.toPrecision(8)).toString();
  const originalValue=name=>t(`${esc(name)} 原值`,`${esc(name)} raw value`);
  $('#pair-drivers').innerHTML=`<table><thead><tr><th scope="col">${t('指标','Criterion')}</th><th scope="col">${t('评价方向','Direction')}</th><th scope="col" class="numeric">${t('评分权重','Weight')}</th><th scope="col" class="numeric">${originalValue(a.name)}</th><th scope="col" class="numeric">${originalValue(b.name)}</th><th scope="col" class="numeric">${t('评分差贡献（分）','Contribution (pts)')}</th></tr></thead><tbody>${rows.map(row=>`<tr><th scope="row">${esc(row.criterion.name)}</th><td>${directionLabel(row.criterion.type)}</td><td class="numeric">${pct(row.weight)}</td><td class="numeric">${formatValue(row.a)}</td><td class="numeric">${formatValue(row.b)}</td><td class="numeric ${row.difference>0?'contribution-positive':row.difference<0?'contribution-negative':''}">${signedScore(row.difference)}</td></tr>`).join('')}</tbody><tfoot><tr><th colspan="5">${t('综合评分差','Overall score gap')}</th><td class="numeric score-number">${signedScore(a.baseline-b.baseline)}</td></tr></tfoot></table>`;
}
function renderMatrix(){
  const suppliers=sortedSuppliers();
  const supplierHeader=s=>`<span title="${esc(s.name)}">${esc(s.name)}</span>`;
  const columns=suppliers.map(s=>`<th scope="col">${supplierHeader(s)}</th>`).join('');
  const rows=suppliers.map(a=>{
    const cells=suppliers.map(b=>{
      if(a.id===b.id)return '<td class="matrix-self">—</td>';
      const {prob}=orientedPair(a.id,b.id);
      const label=`${a.name} ${t('高于','outscores')} ${b.name} · ${pct(prob,5)}`;
      const value=prob>0&&prob<.001?'<0.1%':prob>.999&&prob<1?'>99.9%':pct(prob,1);
      const selected=a.id===state.pairA&&b.id===state.pairB;
      return `<td><button type="button" class="matrix-cell" data-pair-a="${esc(a.id)}" data-pair-b="${esc(b.id)}" style="${probabilityColors(prob)}" aria-label="${esc(label)}" aria-pressed="${selected}" title="${esc(label)}">${esc(value)}</button></td>`;
    }).join('');
    return `<tr><th scope="row">${supplierHeader(a)}</th>${cells}</tr>`;
  }).join('');
  $('#pair-matrix').innerHTML=`<table class="matrix-table" aria-label="${t('全部供应商对照','All supplier comparisons')}"><thead><tr><th scope="col">${t('供应商','Supplier')}</th>${columns}</tr></thead><tbody>${rows}</tbody></table>`;
}
function renderWeightControls(){
  const cs=state.draftCriteria||state.data.criteria;
  const weights=[['lower',t('最低','Minimum')],['modal',t('常用','Typical')],['upper',t('最高','Maximum')]];
  $('#weight-controls').innerHTML=cs.map((c,j)=>`<div class="weight-control" data-j="${j}"><div class="weight-control-top"><span>${esc(c.name)}</span><strong id="weight-percentage-${j}">${pct(state.result.weights[j],1)}</strong></div><input type="range" aria-label="${esc(c.name)}${t('中心权重',': typical weight')}" data-weight-slider="${j}" min="0.001" max="${Math.max(1,c.upper*1.8)}" step="0.001" value="${c.modal}"><details class="weight-details"><summary>${t('浮动范围','Weight range')}</summary><div class="weight-inputs">${weights.map(([key,label])=>`<label>${label}<input type="number" aria-label="${esc(c.name)}${t('',': ')}${label}" data-weight="${j}" data-key="${key}" min="0.000001" step="0.001" value="${c[key]}"></label>`).join('')}</div></details></div>`).join('');
}
function readWeights(){const cs=clone(state.draftCriteria||state.data.criteria);$$('[data-weight]').forEach(el=>{cs[+el.dataset.weight][el.dataset.key]=Number(el.value);});return cs;}
function updatePercentages(){const cs=readWeights(),means=cs.map(c=>(c.lower+c.modal+c.upper)/3),sum=means.reduce((a,b)=>a+b,0);means.forEach((m,j)=>$(`#weight-percentage-${j}`).textContent=pct(m/sum,1));}
function renderScan(){
  if(!state.result)return;const pair=orientedPair();if(!pair)return;const r=state.result,j=+$('#scan-criterion').value||0,cs=state.data.criteria,names=state.data.suppliers.map(s=>s.id),ai=names.indexOf(pair.a),bi=names.indexOf(pair.b),gap=r.normalized[ai].map((v,k)=>v-r.normalized[bi][k]),base=r.weights,otherSum=1-base[j];
  const intercept=gap.reduce((sum,g,k)=>sum+(k===j?0:g*base[k]/otherSum),0),slope=gap[j]-intercept,cross=Math.abs(slope)>1e-14?-intercept/slope:null;
  const weightsAt=t=>base.map((v,k)=>k===j?t:v/otherSum*(1-t));
  const feasible=t=>isWeightFeasible(weightsAt(t),cs);
  let lo=base[j],hi=base[j];let l=0,u=base[j];for(let i=0;i<50;i++){const m=(l+u)/2;if(feasible(m))u=m;else l=m;}lo=u;l=base[j];u=1;for(let i=0;i<50;i++){const m=(l+u)/2;if(feasible(m))l=m;else u=m;}hi=l;
  const inPath=cross!=null&&cross>=0&&cross<=1,inDomain=inPath&&feasible(cross);
  $('#scan-pair-label').textContent=`${supplier(pair.a).name} ${t('与','vs.')} ${supplier(pair.b).name}`;
  const criterion=esc(cs[j].name);
  $('#scan-summary').innerHTML=`<div><strong>${inPath?pct(cross,2):'—'}</strong><span>${t(`${criterion}优先顺序变化点`,`${criterion} crossover weight`)}</span></div><div><strong>${pct(base[j],1)}</strong><span>${t('当前重要程度','Current weight')}</span></div>`;
  const a=supplier(pair.a).name,b=supplier(pair.b).name;
  renderSensitivityChart($('#scan-chart'),{
    aName:a,bName:b,criterionName:cs[j].name,currentWeight:base[j],
    feasibleLow:lo,feasibleHigh:hi,intercept,slope,crossover:cross,inPath,inDomain,
  });
  $('#scan-action').textContent=inDomain
    ?t(`${cs[j].name}的评分权重达到 ${pct(cross,2)} 时，两家评分相同。更高的权重有利于 ${slope>0?a:b}。`,`The scores tie when ${cs[j].name} has a weight of ${pct(cross,2)}. A higher weight favors ${slope>0?a:b}.`)
    :t(`沿此指标的允许调整路径，顺序保持不变。权重范围为 ${pct(lo,1)}–${pct(hi,1)}。`,`The ordering stays the same over the feasible weight range of ${pct(lo,1)}–${pct(hi,1)}.`);
}
function renderData(){
  const d=state.data;
  $('#data-count').textContent=`${supplierCount(d.suppliers.length)} · ${criterionCount(d.criteria.length)}`;
  $('#data-source-label').textContent=d.source?.filename||t('已导入数据','Imported data');
  $('#data-table').innerHTML=`<table class="data-values-table"><thead><tr><th scope="col">${t('供应商','Supplier')}</th>${d.criteria.map(c=>`<th scope="col">${esc(c.name)}</th>`).join('')}</tr></thead><tbody>${d.suppliers.map(s=>`<tr><td>${esc(s.name)}</td>${s.values.map(v=>`<td>${v}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const weightLabels={
    lower:t('下限权重',': minimum weight'),modal:t('中心权重',': typical weight'),upper:t('上限权重',': maximum weight'),
  };
  $('#criteria-body').innerHTML=d.criteria.map((c,j)=>`<tr><td>${esc(c.name)}</td><td><select aria-label="${esc(directionAria(c.name))}" data-criterion="${j}" data-key="type"><option value="benefit" ${c.type==='benefit'?'selected':''}>${directionLabel('benefit')}</option><option value="cost" ${c.type==='cost'?'selected':''}>${directionLabel('cost')}</option></select></td>${['lower','modal','upper'].map(key=>`<td><input type="number" aria-label="${esc(c.name)}${weightLabels[key]}" data-criterion="${j}" data-key="${key}" value="${c[key]}" min="0.000001" step="0.001"></td>`).join('')}</tr>`).join('');$('#criteria-error').textContent='';
}
function setImportStage(preview){
  $('#upload-stage').classList.toggle('hidden',preview);
  $('#preview-stage').classList.toggle('hidden',!preview);
  $('#confirm-import').classList.toggle('hidden',!preview);
  for(const [selector,active] of [['#upload-step',!preview],['#preview-step',preview]]){
    const step=$(selector);
    step.classList.toggle('active',active);
    if(active)step.setAttribute('aria-current','step');
    else step.removeAttribute('aria-current');
  }
}
function openImport(isNew=false){
  if(state.busy||state.procurementSaving||!signedIn()||(!isNew&&state.result&&!canEdit()))return;
  if(hasPendingEdits())return;
  state.importReturnView=isNew?'overview':state.view;
  state.table=null;
  state.importData=null;
  state.importDraft={};
  $('#assessment-name').value='';
  $('#import-criteria').replaceChildren();
  $('#file-input').value='';
  setImportStage(false);
  $('#import-validation').classList.add('hidden');
  $('#confirm-import').disabled=true;
  $('#import-error').textContent='';
  $('#import-dialog').showModal();
}

async function handleFile(file){
  if(!file)return;
  const readId=++fileReadId;
  const current=()=>readId===fileReadId&&$('#import-dialog').open;
  $('#import-error').textContent='';
  $('#confirm-import').disabled=true;
  state.importData=null;
  try{
    if(file.name.toLowerCase().endsWith('.json')){
      const data=await readAssessment(file);
      if(current())startImportedAssessment(data,'reopen');
      return;
    }
    const table=await parseFile(file);
    if(!current())return;
    state.table=table;
    state.importDraft={};
    if(!$('#assessment-name').value.trim())$('#assessment-name').value=file.name.replace(/\.[^.]+$/,'');
    $('#import-filename').textContent=file.name;
    $('#import-size').textContent=t(`${table.rows.length} 行数据 · ${table.headers.length} 列`,`${table.rows.length} rows · ${table.headers.length} columns`);
    $('#name-column').innerHTML=table.headers.map((heading,j)=>`<option value="${j}">${esc(heading||columnLabel(j))}</option>`).join('');
    $('#name-column').value='0';
    setImportStage(true);
    renderImportPreview();
    $('#import-filename').focus({preventScroll:true});
  }catch(error){
    if(!current())return;
    state.table=null;
    setImportStage(false);
    $('#import-error').textContent=translateSystemText(error.message);
  }
  icons();
}
function renderImportPreview(){
  const table=state.table;if(!table)return;const name=+$('#name-column').value;
  $('#column-picks').innerHTML=table.headers.map((h,j)=>j===name?'':`<label class="column-pick"><input type="checkbox" value="${j}" checked>${esc(h||columnLabel(j))}</label>`).join('');
  renderImportCriteria();
  $('#import-preview-count').textContent=table.rows.length>8?t(`前 8 / ${table.rows.length} 行`,`First 8 of ${table.rows.length} rows`):'';
  $('#import-preview').innerHTML=`<table><thead><tr>${table.headers.map(h=>`<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${table.rows.slice(0,8).map((row,i)=>`<tr>${table.headers.map((_,j)=>`<td data-import-row="${i+2}" data-import-col="${j}">${esc(row[j]??'')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  validateImportPreview();
}
function renderImportCriteria(){
  if(!state.table)return;
  $('#import-criteria').innerHTML=$$('#column-picks input:checked').map(el=>{
    const j=+el.value,name=state.table.headers[j],draft=state.importDraft[j]||{type:/成本|单价|价格|cost|price/i.test(name)?'cost':'benefit',modal:1};
    state.importDraft[j]=draft;
    return `<tr><td>${esc(name)}</td><td><select data-import-criterion="${j}" data-key="type" aria-label="${esc(directionAria(name))}"><option value="benefit" ${draft.type==='benefit'?'selected':''}>${directionLabel('benefit')}</option><option value="cost" ${draft.type==='cost'?'selected':''}>${directionLabel('cost')}</option></select></td><td><input type="number" data-import-criterion="${j}" data-key="modal" aria-label="${esc(name)}${t('重要程度',': weight')}" min="0.000001" step="0.1" value="${draft.modal}"></td></tr>`;
  }).join('');
}
function validateImportPreview(){
  if(!state.table)return;
  const selected=$$('#column-picks input:checked').map(input=>Number(input.value));
  const criteria=selected.map(column=>{
    const {type,modal}=state.importDraft[column];
    return {type,lower:modal*.7,modal,upper:modal*1.3};
  });
  const status=$('#import-validation'),title=$('#import-validation-title'),detail=$('#import-validation-detail');
  status.classList.remove('hidden','invalid');
  $$('.invalid-cell').forEach(cell=>cell.classList.remove('invalid-cell'));
  try{
    state.importData=datasetFromTable(state.table,{nameColumn:Number($('#name-column').value),valueColumns:selected,criteria});
    title.textContent=t('数据校验通过','Data validation passed');
    detail.textContent=`${supplierCount(state.importData.suppliers.length)} · ${criterionCount(selected.length)}`;
  }catch(error){
    state.importData=null;
    status.classList.add('invalid');
    title.textContent=t('请检查数据与指标','Check the data and criteria');
    detail.textContent=translateSystemText(error.message);
    if(Number.isInteger(error.row)&&Number.isInteger(error.column))$(`[data-import-row="${error.row}"][data-import-col="${error.column}"]`)?.classList.add('invalid-cell');
  }
  syncAccessControls();
}

function startImportedAssessment(data,kind){
  if(!signedIn()||state.busy)return;
  $('#import-dialog').close();
  analyze(data,{kind,projectId:null,after:{view:state.importReturnView||'overview',assessment:true}});
}

function applyImport(){
  if(!state.importData||state.busy||!signedIn()||state.failedRun)return;
  const title=$('#assessment-name').value.trim();
  if(!title){$('#import-error').textContent=t('请填写评估名称。','Enter an assessment name.');$('#assessment-name').focus();return;}
  startImportedAssessment({...state.importData,title,sampleCount:200000,p:.9,delta:null,seed:20261101},'import');
}
function downloadAssessment(){
  if(!state.result)return;
  const data={...clone(state.data),p:state.result.p,delta:state.result.delta};
  const snapshot={format:'adapt-assessment',version:1,savedAt:new Date().toISOString(),assessment:data};
  const blob=new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${data.title.replace(/[\\/:*?"<>|]/g,'_')}.adapt.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  toggleExport(false);toast(t('评估文件已保存','Assessment file saved'));
}

function procurementReportRows(){
  const {configured,rows,settings}=state.eligibility;
  const decision=state.procurement.decision;
  const report=[];
  if(configured){
    const criteria=new Map(state.data.criteria.map(item=>[item.id,item.name]));
    report.push([t('准入设置','Eligibility settings')],[t('评价指标','Criterion'),t('条件','Condition'),t('门槛','Threshold')]);
    for(const rule of settings.rules)report.push([criteria.get(rule.criterionId),rule.operator==='>='?t('至少','At least'):t('至多','At most'),rule.threshold]);
    if(settings.requireQualification)report.push([t('人工资质核验','Manual qualification check'),t('需核验通过','Verification required')]);
    report.push([],[t('供应商准入结果','Supplier eligibility results')],[t('供应商','Supplier'),t('准入状态','Eligibility'),t('说明','Notes')]);
    for(const row of rows)report.push([row.name,eligibilityLabel(row),row.reasons.map(translateSystemText).join(t('；','; '))]);
  }
  if(Object.values(decision).some(Boolean))report.push([],[t('采购决策记录','Procurement decision record')],...procurementDecisionRows());
  return report;
}

function procurementDecisionRows(){
  const decision=state.procurement.decision;
  const report=decisionRows(decision,state.data.suppliers);
  if(!state.eligibility.configured)return report;
  for(const [label,id] of [[t('推荐供应商当前准入','Recommended supplier eligibility'),decision.recommendedId],[t('备选供应商当前准入','Alternate supplier eligibility'),decision.alternativeId]]){
    const outcome=state.eligibility.rows.find(row=>row.id===id);
    if(outcome)report.push([label,eligibilityLabel(outcome)]);
  }
  return report;
}

function renderDecisionPrint(){
  const panel=$('#decision-print');
  const decision=state.procurement.decision;
  const hasDecision=Object.values(decision).some(Boolean);
  const {configured,eligibleIds,pendingIds,excludedIds}=state.eligibility;
  panel.classList.toggle('has-procurement-report',configured||hasDecision);
  const decisionFields=hasDecision?procurementDecisionRows().map(([label,value])=>`<dt>${esc(label)}</dt><dd>${esc(value)}</dd>`).join(''):'';
  const counts=t(`准入结果　合格 ${eligibleIds.length} 家 · 待核验 ${pendingIds.length} 家 · 不合格 ${excludedIds.length} 家`,`Eligibility: ${eligibleIds.length} eligible · ${pendingIds.length} pending · ${excludedIds.length} ineligible`);
  panel.innerHTML=`<div class="panel-heading"><h2>${t('准入与采购决策','Eligibility and Procurement Decision')}</h2></div><div class="extension-content">${configured?`<p>${counts}</p>`:''}${hasDecision?`<dl class="decision-report-fields">${decisionFields}</dl>`:''}</div>`;
}

async function readAssessment(file){
  if(file.size>5*1024*1024)throw new Error(t('评估文件不能超过 5 MB。','The assessment file must be 5 MB or smaller.'));
  let snapshot;try{snapshot=JSON.parse(await file.text());}catch{throw new Error(t('无法读取评估文件。','Could not read the assessment file.'));}
  if(snapshot?.format!=='adapt-assessment'||snapshot.version!==1||!snapshot.assessment)throw new Error(t('请选择有效的 ADAPT 评估文件。','Choose a valid ADAPT assessment file.'));
  const validated=validateInput(snapshot.assessment);const title=String(snapshot.assessment.title||t('供应商评估','Supplier Assessment')).slice(0,80);
  const source={filename:String(snapshot.assessment.source?.filename||file.name).slice(0,200)};
  const data={...validated,title,source};
  if(snapshot.assessment.procurement!==undefined)data.procurement=projectProcurement(data,snapshot.assessment.procurement);
  return data;
}
function markDirty(dirty,scope){
  state.dirty=scope==='all'&&!dirty?false:JSON.stringify(state.draftCriteria||state.data.criteria)!==JSON.stringify(state.data.criteria);
  $('#settings-dirty').classList.toggle('hidden',!state.dirty);
  $('#dataset-tag').classList.toggle('hidden',!state.dirty);
  syncAccessControls();
}
function syncDraft(criteria,from){
  if(!canEdit())return;
  state.draftCriteria=clone(criteria);
  if(from!=='data')$$('[data-criterion]').forEach(el=>el.value=criteria[+el.dataset.criterion][el.dataset.key]);
  if(from!=='weights'){
    $$('[data-weight]').forEach(el=>el.value=criteria[+el.dataset.weight][el.dataset.key]);
    $$('[data-weight-slider]').forEach(el=>{const c=criteria[+el.dataset.weightSlider];el.max=Math.max(1,c.upper*1.8);el.value=c.modal;});
  }
  updatePercentages();markDirty(true);
}

function currentProject(){
  return state.projectId?{id:state.projectId,title:state.data.title,...state.projectAccess}:null;
}

function openReview(){
  const project=currentProject();
  if(!project||!signedIn())return;
  const dialog=$('#review-dialog');
  const decision=state.procurement.decision;
  reviewEditor=mountReviewPanel($('#review-content'),{
    store:projectStore,project,decisionComplete:!!(decision.recommendedId&&decision.rationale),
    beforeSubmit(){
      if(state.busy||state.procurementSaving||state.projectId!==project.id||projectVersion()!==project.version)throw new Error(t('当前评估已变化，请重新打开复核。','The assessment changed. Reopen Review & Archive.'));
      if(hasPendingEdits()||scenarioEditor?.isDirty())throw new Error(t('请先保存或取消当前评估的修改。','Save or cancel the current assessment changes first.'));
    },
    onEditDecision(){
      dialog.close();
      openProcurementSection('decision');
    },
  });
  dialog.showModal();
}

function workspaceProps(){
  return {
    mode:state.workspace.mode,
    session:state.workspace.session,
    project:currentProject(),
    migration:state.migrationPreview,
    legacyMigrationAvailable:state.workspace.session?.legacyMigrationAvailable!==false,
    workspaceName:t('ADAPT 采购工作区','ADAPT Procurement Workspace'),
    onSignOut:()=>accountUI.signOut(),
  };
}

function readMigrationPreview(){
  state.migrationPreview=state.workspace.mode==='cloud'?projectStore.previewLocalMigration():null;
  return state.migrationPreview;
}

async function refreshWorkspace({initial=false}={}){
  if(workspaceRefreshing||state.busy||state.procurementSaving)return;
  workspaceRefreshing=true;
  const previous=state.workspace.session?.user?.id;
  try{
    state.workspace=await (initial?projectStore.bootstrap():projectStore.refresh());
    const user=state.workspace.session?.user?.id;
    if(state.workspace.mode==='anonymous'&&accountUI?.getState().ready){
      document.body.classList.add('account-pending');
      location.reload();
      return;
    }
    if(previous&&user&&previous!==user){
      location.reload();
      return;
    }
    readMigrationPreview();
    if(state.result){
      const project=projectStore.listProjects().find(project=>project.id===state.projectId);
      if(state.workspace.mode==='anonymous'||(signedIn()&&!project))clearCurrentProject();
      else if(project&&(project.role!==state.projectAccess?.role||project.canExport!==state.projectAccess?.canExport||listLifecycle(project)!==state.projectAccess?.lifecycle)){
        state.projectAccess={...state.projectAccess,role:project.role,canExport:project.canExport===true,lifecycle:listLifecycle(project)};
        mountProcurement();
      }
    }
  }catch(error){
    state.workspace={mode:'unavailable',session:state.workspace.session,warning:translateSystemText(error.message)||t('工作区暂不可用。','The workspace is temporarily unavailable.')};
    state.migrationPreview=null;
  }finally{
    workspaceRefreshing=false;
    if(state.view==='overview'&&!state.assessmentMode)renderProjects();
    syncAccessControls();
    icons();
  }
}

async function workspaceAdminDetails(project){
  if(!project||project.role!=='administrator')return {members:null,audit:null};
  const reads=await Promise.allSettled([projectStore.listMembers(project.id),projectStore.readAudit(project.id)]);
  return {
    members:reads[0].status==='fulfilled'?reads[0].value.members:null,
    audit:reads[1].status==='fulfilled'?reads[1].value:null,
  };
}

function openWorkspace(section){
  const dialog=$('#workspace-dialog'),project=currentProject(),request=++workspaceRequest;
  workspaceEditor?.destroy();
  const reloadAfterMemberChange=async action=>{
    await action();
    await refreshWorkspace();
    const patch=workspaceProps();
    return {...patch,...await workspaceAdminDetails(patch.project)};
  };
  workspaceEditor=mountWorkspace($('#workspace-content'),{
    ...workspaceProps(),
    onRefresh:async()=>{
      await refreshWorkspace();
      const patch=workspaceProps();
      return {...patch,...await workspaceAdminDetails(patch.project)};
    },
    onLoadMembers:id=>projectStore.listMembers(id),
    onLoadAudit:(id,cursor)=>projectStore.readAudit(id,cursor?{cursor}:undefined),
    onPreviewMigration:readMigrationPreview,
    onSaveMember:member=>reloadAfterMemberChange(()=>projectStore.saveMember(project.id,member)),
    onRemoveMember:({userId})=>reloadAfterMemberChange(()=>projectStore.removeMember(project.id,userId)),
    onMigrate:async options=>{
      try{return await projectStore.migrateLocalProjects(options);}
      finally{
        if(state.view==='overview'&&!state.assessmentMode)renderProjects();
        icons();
      }
    },
  });
  dialog.showModal();
  dialog.scrollTop=0;
  if(section)$('#workspace-content').querySelector(`[data-workspace-section="${section}"]`)?.scrollIntoView({block:'start'});
  void workspaceAdminDetails(project).then(details=>{
    if(dialog.open&&request===workspaceRequest)workspaceEditor.update(details);
  });
}

async function authorizeExport(format){
  if(!state.result||!canExport()||state.dirty||state.busy||state.failedRun)throw new Error(t('暂时无法导出此项目。','This project cannot be exported right now.'));
  const id=state.projectId,version=projectVersion();
  try{await projectStore.recordExport(id,format,version);}
  catch(error){
    if(error.status===403||error.status===404)void refreshWorkspace();
    throw error;
  }
  if(state.projectId!==id||projectVersion()!==version)throw new Error(t('项目已变化，请重新导出。','The project changed. Export it again.'));
  return true;
}

function exportWithPermission(format,exporter){
  return async ()=>{
    toggleExport(false);
    try{await authorizeExport(format);exporter();}
    catch(error){toast(error.message);}
  };
}


$$('[data-view],[data-go]').forEach(el=>el.addEventListener('click',()=>{
  const view=el.dataset.view||el.dataset.go;
  showView(view,{push:true,assessment:view==='overview'?false:state.assessmentMode});
  $('#page-title').focus({preventScroll:true});
}));
const navigateHistory=()=>showView(location.hash.slice(1),{assessment:!!history.state?.assessment});
window.addEventListener('hashchange',()=>{if(location.hash!=='#main')navigateHistory();});
window.addEventListener('popstate',navigateHistory);
$('#brand-home').onclick=event=>{event.preventDefault();showView('overview',{assessment:false,push:true});};
$('#active-assessment').onclick=()=>showView('overview',{assessment:true,push:true});
$('#workspace-button').onclick=()=>openWorkspace();
$('#workspace-sign-in').onclick=()=>void accountUI.start();
$('#account-approvals-button').onclick=()=>{
  $('#workspace-dialog').close();
  void accountUI.openApprovals();
};
$('#project-settings').onclick=()=>openWorkspace('members');
$('#open-migration').onclick=()=>openWorkspace('migration');
$('#close-workspace').onclick=()=>$('#workspace-dialog').close();
$('#close-review').onclick=()=>$('#review-dialog').close();
$('#review-dialog').addEventListener('close',()=>{reviewEditor?.destroy();reviewEditor=null;});
$('#workspace-dialog').addEventListener('close',()=>{
  workspaceRequest++;
  workspaceEditor?.destroy();workspaceEditor=null;
  readMigrationPreview();
  if(state.view==='overview'&&!state.assessmentMode){renderProjects();icons();}
});
$('#retry-workspace').onclick=()=>void refreshWorkspace();
$('#retry-save').onclick=()=>{
  const failed=state.failedRun;
  if(!failed||failed.conflict||state.busy)return;
  showRunError('');
  void commitRun(failed.run,failed.result);
};
$('#discard-save').onclick=()=>{
  const failed=state.failedRun;
  if(!failed||state.busy)return;
  const id=failed.run.projectId??state.projectId;
  setSaveRecovery(null);
  showRunError('');
  if(id)void resumeProject(id,{discard:true});
  else setBusy(false);
};
$('#project-search').addEventListener('input',renderProjects);
$('#project-filter').addEventListener('change',renderProjects);
for(const tab of $$('[data-project-list]'))tab.addEventListener('click',()=>{
  projectList=tab.dataset.projectList;
  $('#project-search').value='';
  $('#project-filter').value='all';
  projectLifecycleUI.clearError();
  renderProjects();
});
$('#eligibility-filter').addEventListener('change',renderTable);
$('#weights-tab').onclick=()=>showSensitivityTab('weights');
$('#scenarios-tab').onclick=()=>showSensitivityTab('scenarios');
window.addEventListener('storage',event=>{
  if((event.key===PROJECT_STORAGE_KEY||event.key===null)&&state.view==='overview'&&!state.assessmentMode){
    if(!$('#workspace-dialog').open)readMigrationPreview();
    renderProjects();
    icons();
  }
});
$('#menu-button').onclick=()=>toggleNavigation(!$('#sidebar').classList.contains('open'));
$('#nav-backdrop').onclick=()=>{toggleNavigation(false);$('#menu-button').focus();};
$('#import-dialog').addEventListener('close',()=>{fileReadId++;});
$('#import-button').onclick=()=>openImport();$('#data-import-button').onclick=()=>openImport();
$('#close-import').onclick=()=>$('#import-dialog').close();$('#cancel-import').onclick=()=>$('#import-dialog').close();
$('#file-input').addEventListener('change',e=>handleFile(e.target.files[0]));
$('#drop-zone').addEventListener('dragover',e=>{e.preventDefault();$('#drop-zone').classList.add('dragover');});$('#drop-zone').addEventListener('dragleave',()=>$('#drop-zone').classList.remove('dragover'));$('#drop-zone').addEventListener('drop',e=>{e.preventDefault();$('#drop-zone').classList.remove('dragover');handleFile(e.dataTransfer.files[0]);});
$('#choose-another').onclick=()=>{$('#file-input').value='';$('#file-input').click();};$('#name-column').onchange=renderImportPreview;$('#confirm-import').onclick=applyImport;
['#template-xlsx','#dialog-template','#empty-template'].forEach(sel=>$(sel).onclick=()=>{try{downloadTemplate('xlsx');}catch(e){toast(e.message);}});
$('#help-button').onclick=()=>{
  toggleNavigation(false);
  $('#help-dialog').showModal();
};
$('#close-help').onclick=()=>$('#help-dialog').close();
$('#about-button').onclick=()=>{
  toggleNavigation(false);
  $('#about-dialog').showModal();
};
$('#close-about').onclick=()=>$('#about-dialog').close();
for(const [dialog,trigger] of [['#about-dialog','#about-button'],['#help-dialog','#help-button']]){
  $(dialog).addEventListener('close',()=>{
    const menu=$('#menu-button');
    (menu.getClientRects().length?menu:$(trigger)).focus();
  });
}
$$('dialog').forEach(d=>d.addEventListener('click',e=>{if(e.target===d){const box=d.getBoundingClientRect();if(e.clientX<box.left||e.clientX>box.right||e.clientY<box.top||e.clientY>box.bottom)d.close();}}));
$('#new-assessment').onclick=()=>openImport(true);
$('#supplier-search').addEventListener('input',renderTable);
$('#method-toggle').addEventListener('click',e=>{const b=e.target.closest('[data-method]');if(!b)return;state.method=b.dataset.method;$$('[data-method]').forEach(el=>{el.classList.toggle('active',el===b);el.setAttribute('aria-pressed',String(el===b));});if(state.result)renderPerformance();});
function setPair(a,b){if(a===b)return;state.pairA=a;state.pairB=b;$('#pair-a').value=a;$('#pair-b').value=b;renderCompare();renderScan();}
$('#pair-a').onchange=()=>{const a=$('#pair-a').value;setPair(a,a===state.pairB?state.data.suppliers.find(s=>s.id!==a).id:state.pairB);};
$('#pair-b').onchange=()=>{const b=$('#pair-b').value;setPair(b===state.pairA?state.data.suppliers.find(s=>s.id!==b).id:state.pairA,b);};
$('#swap-pair').onclick=()=>setPair(state.pairB,state.pairA);
document.addEventListener('click',e=>{
  if(e.target.closest('[data-project-menu],#project-row-menu'))return;
  if(e.target.closest('#clear-project-filters')){
    $('#project-search').value='';
    $('#project-filter').value='all';
    renderProjects();
    $('#project-search').focus();
    return;
  }
  const project=e.target.closest('[data-project]');
  if(project){resumeProject(project.dataset.project);return;}
  const row=e.target.closest('[data-project-row]');
  if(row&&window.getSelection()?.isCollapsed){resumeProject(row.dataset.projectRow);return;}
  const extension=e.target.closest('[data-extension]');
  if(extension){openProcurementSection(extension.dataset.extension);return;}
  const compare=e.target.closest('[data-compare]');if(compare){
    const a=compare.dataset.compare;
    const match=state.eligibility.candidateIds.includes(a)?state.result.sorted.find(id=>id!==a&&state.eligibility.candidateIds.includes(id)):null;
    setPair(a,match??state.result.sorted.find(id=>id!==a));showView('compare',{assessment:true,push:true});
  }
  const matrix=e.target.closest('[data-pair-a]');
  if(matrix){
    setPair(matrix.dataset.pairA,matrix.dataset.pairB);
    $('#pair-a').focus({preventScroll:true});
    const behavior=window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth';
    window.scrollTo({top:0,behavior});
  }
  const insight=e.target.closest('[data-insight]');if(insight){setPair(insight.dataset.insight,insight.dataset.b);showView('compare',{assessment:true,push:true});}
  if(!e.target.closest('.export-wrap'))toggleExport(false);
});
$('#delta-slider').addEventListener('input',()=>{state.uiDelta=+$('#delta-slider').value;state.uiDeltaSetting=state.uiDelta;$('#delta-display').textContent=score(state.uiDelta);reclassify(+$('#p-slider').value,state.uiDeltaSetting);});
$('#p-slider').addEventListener('input',()=>{$('#p-display').textContent=pct(+$('#p-slider').value,0);reclassify(+$('#p-slider').value,state.uiDeltaSetting);});
$('#reset-tolerance').onclick=()=>{clearTimeout(toleranceTimer);$('#p-slider').value=.9;$('#delta-slider').value=state.defaultDelta;state.uiDelta=state.defaultDelta;state.uiDeltaSetting=null;$('#p-display').textContent='90%';$('#delta-display').textContent=score(state.defaultDelta);reclassify(.9,null);};
$('#scan-criterion').onchange=renderScan;
$('#reset-weights').onclick=()=>{state.draftCriteria=clone(state.data.criteria);renderWeightControls();renderData();markDirty(false,'all');toast(t('已恢复已应用设置','Applied settings restored'));};
$('#weight-controls').addEventListener('input',e=>{
  const slider=e.target.closest('[data-weight-slider]');if(slider){const j=+slider.dataset.weightSlider,old=readWeights()[j],base=old.modal>0?old:state.data.criteria[j],ratio=+slider.value/base.modal;$$(`[data-weight="${j}"]`).forEach(el=>el.value=Number((base[el.dataset.key]*ratio).toFixed(6)));}
  if(e.target.matches('[data-weight][data-key="modal"]')){$(`[data-weight-slider="${e.target.dataset.weight}"]`).value=e.target.value;}
  syncDraft(readWeights(),'weights');
});
$('#apply-weights').onclick=()=>{if(state.busy||!state.result)return;analyze({...clone(state.data),criteria:clone(state.draftCriteria||state.data.criteria),p:state.result.p,delta:null});};
$('#apply-data-settings').onclick=()=>{if(state.busy||!state.result)return;const cs=clone(state.data.criteria);$$('[data-criterion]').forEach(el=>cs[+el.dataset.criterion][el.dataset.key]=el.dataset.key==='type'?el.value:Number(el.value));if(cs.some(c=>!(0<c.lower&&c.lower<=c.modal&&c.modal<=c.upper))){$('#criteria-error').textContent=t('请检查重要程度：最低值应大于零，且不高于设定值和最高值。','Use weights in this order: 0 < minimum ≤ typical ≤ maximum.');return;}$('#criteria-error').textContent='';analyze({...clone(state.data),criteria:cs,p:state.result.p,delta:null});};
function toggleExport(open){$('#export-menu').classList.toggle('hidden',!open);$('#export-button').setAttribute('aria-expanded',String(open));}
$('#export-button').onclick=()=>toggleExport($('#export-menu').classList.contains('hidden'));
document.addEventListener('keydown',event=>{if(event.key==='Escape'){toggleExport(false);if($('#sidebar').classList.contains('open')){$('#menu-button').focus();toggleNavigation(false);}}});
$('#save-assessment').onclick=exportWithPermission('adapt',downloadAssessment);
$('#export-csv').onclick=exportWithPermission('csv',()=>exportResults(state.result,state.data,procurementReportRows()));
$('#print-report').onclick=exportWithPermission('print',()=>{
  document.body.classList.add('allow-project-print');
  window.print();
});
window.addEventListener('afterprint',()=>document.body.classList.remove('allow-project-print'));

document.documentElement.lang=language;
saveLocale(language);
if(language==='en')applyEnglishShell(document);
$('#language-switch-label').textContent=t('English','简体中文');
$('#language-switch-label').lang=t('en','zh-CN');
$('#language-switch').setAttribute('aria-label',t('切换为英文','Switch to Chinese'));
$('#language-switch').onclick=switchLanguage;
showView(transition?.view??(location.hash.slice(1)||'overview'));icons();setBusy(false);

async function enterWorkspace(user){
  $('#account-approvals-button').classList.toggle('hidden',user.role!=='admin');
  $('#account-approvals-button').textContent=t('注册审批','Registration approvals');
  document.body.classList.remove('account-pending');
  if(!worker)startWorker();
  await refreshWorkspace({initial:true});
  if(signedIn()&&typeof transition?.projectId==='string'){
    const project=projectStore.listProjects().find(item=>item.id===transition.projectId);
    if(project)void resumeProject(project.id,{returnTo:transition});
  }
}
accountUI=mountAccountUI({
  root:$('#account-root'),
  onSignedIn:user=>void enterWorkspace(user),
  onSignedOut:()=>{
    projectStore.clearSession();
    document.body.classList.add('account-pending');
    const url=new URL(location.href);
    url.hash='overview';
    history.replaceState({assessment:false},'',url);
    location.reload();
  },
  onToggleLanguage:switchLanguage,
});
void accountUI.start().then(session=>{
  if(session.ready)void enterWorkspace(session.user);
});
window.addEventListener('focus',()=>{
  if(state.workspace.mode==='cloud'&&!state.busy&&!state.procurementSaving&&!$('#workspace-dialog').open&&!$('#review-dialog').open)void refreshWorkspace();
});


$('#column-picks').addEventListener('change',()=>{renderImportCriteria();validateImportPreview();});
$('#import-criteria').addEventListener('input',e=>{const el=e.target.closest('[data-import-criterion]');if(!el)return;state.importDraft[el.dataset.importCriterion][el.dataset.key]=el.dataset.key==='type'?el.value:Number(el.value);validateImportPreview();});
$('#show-advanced').onchange=()=>$('#config-table').classList.toggle('expanded', $('#show-advanced').checked);
$('#criteria-body').addEventListener('input',e=>{
  const el=e.target.closest('[data-criterion]');if(!el)return;
  if(el.dataset.key==='modal'){
    const j=+el.dataset.criterion,original=(state.draftCriteria||state.data.criteria)[j],v=Number(el.value);
    if(v>0){const applied=original.modal>0?original:state.data.criteria[j];$(`[data-criterion="${j}"][data-key="lower"]`).value=v*applied.lower/applied.modal;$(`[data-criterion="${j}"][data-key="upper"]`).value=v*applied.upper/applied.modal;}
  }
  const cs=clone(state.draftCriteria||state.data.criteria);
  $$('[data-criterion]').forEach(field=>cs[+field.dataset.criterion][field.dataset.key]=field.dataset.key==='type'?field.value:Number(field.value));
  syncDraft(cs,'data');
});
