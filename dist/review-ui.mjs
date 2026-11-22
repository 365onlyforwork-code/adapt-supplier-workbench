import {t,translateSystemText} from './i18n.mjs';
import {archiveDocument,escapeHtml as escape,formatReviewDate as dateText,reportDocumentTitle,reportMarkup,reportPrintStyle,reportStyle,reviewStatuses as statuses} from './review-document.mjs?v=pdf-1';

export {archiveDocument};

const reportLogo=new URL('./brand/bentham-symbol.jpg',import.meta.url).href;
const badge=status=>`<span class="badge ${status==='confirmed'?'green':status==='pending'?'amber':'neutral'}">${statuses[status]}</span>`;

async function embeddedReportLogo(){
  const response=await fetch(reportLogo);
  if(!response.ok)throw new Error(t('报告标志载入失败，请重试。','The report logo could not be loaded. Please try again.'));
  const image=await response.blob();
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result);
    reader.onerror=()=>reject(reader.error);
    reader.readAsDataURL(image);
  });
}

function downloadReport(review,blob,extension){
  const filename=review.title.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').replace(/[. ]+$/,'').slice(0,80);
  const url=URL.createObjectURL(blob);
  const anchor=document.createElement('a');
  anchor.href=url;
  anchor.download=`${filename||'ADAPT'}-V${review.version}-${t('采购评审报告','Procurement Review Report')}.${extension}`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),10000);
}

async function printArchive(review,logo){
  const outlet=document.querySelector('#review-print-output');
  outlet.innerHTML=`<style>${reportPrintStyle(review)}</style>${reportMarkup(review,logo)}`;
  await outlet.querySelector('img').decode();
  const previousTitle=document.title;
  document.title=reportDocumentTitle(review);
  document.body.classList.add('review-printing');
  const finish=()=>{
    document.title=previousTitle;
    document.body.classList.remove('review-printing');
    outlet.replaceChildren();
  };
  window.addEventListener('afterprint',finish,{once:true});
  try{window.print();}
  catch(error){
    window.removeEventListener('afterprint',finish);
    finish();
    throw error;
  }
}

export function mountReviewPanel(container,{store,project,decisionComplete,beforeSubmit,onEditDecision}){
  if(!document.querySelector('#procurement-report-style')){
    const style=document.createElement('style');
    style.id='procurement-report-style';
    style.textContent=reportStyle;
    document.head.append(style);
  }

  let records=[],selected=null,current=null,busy='',feedback='',error='',comment='',closed=false;
  const button=(action,label,primary=false,id='',{active=false,ariaLabel=''}={})=>`<button type="button" class="button ${primary?'primary':'secondary'}"
    data-review-action="${action}"${id?` data-review-id="${escape(id)}"`:''}${ariaLabel?` aria-label="${escape(ariaLabel)}"`:''}${active?' aria-current="true"':''}${busy||active?' disabled':''}>${label}</button>`;

  function render(){
    if(closed)return;
    const pending=records.find(record=>record.status==='pending');
    const currentConfirmed=records.some(record=>record.version===project.version&&record.status==='confirmed');
    const currentDisplayed=current?.projectVersion===project.version;
    const maySubmit=current&&current.lifecycle!=='inactive'&&['administrator','evaluator'].includes(current.role)&&currentDisplayed&&!pending&&!currentConfirmed;
    const mayDecide=selected?.status==='pending'&&current?.role==='administrator';
    const readyToExport=selected?.status==='confirmed'&&current?.canExport;
    const title=t(`当前评估 V${project.version}${current&&!currentDisplayed?` · 项目最新版 V${current.projectVersion}`:''}`,`Assessment V${project.version}${current&&!currentDisplayed?` · Latest project V${current.projectVersion}`:''}`);
    container.innerHTML=`
      <div class="review-toolbar">
        <div><strong>${escape(project.title)}</strong><span>${title}</span></div>
        <div class="review-actions">
          ${button('refresh',t('刷新','Refresh'))}
          ${maySubmit?(decisionComplete?button('submit',t('提交复核','Submit for review'),true,'',{ariaLabel:t(`提交评估 V${project.version} 复核`,`Submit assessment V${project.version} for review`)}):button('edit',t('填写采购决策','Record procurement decision'),true)):''}
        </div>
      </div>
      ${error?`<p class="inline-error" role="alert">${escape(error)}</p>`:''}
      ${busy||feedback?`<p class="review-feedback" role="status">${escape(busy||feedback)}</p>`:''}
      ${records.length?`<div class="table-scroll review-history"><table aria-label="${t('复核与归档记录','Review and archive history')}">
        <thead><tr><th scope="col">${t('评估版本','Version')}</th><th scope="col">${t('状态','Status')}</th><th scope="col">${t('提交人','Submitted by')}</th><th scope="col">${t('提交时间','Submitted at')}</th><th scope="col">${t('操作','Action')}</th></tr></thead>
        <tbody>${records.map(record=>`<tr class="${selected?.id===record.id?'review-selected':''}">
          <th scope="row">V${record.version}</th><td>${badge(record.status)}</td><td>${escape(record.submittedBy)}</td><td>${dateText(record.submittedAt)}</td>
          <td>${button('select',selected?.id===record.id?t('已展开','Expanded'):record.status==='confirmed'?t('查看报告','View report'):t('查看复核','View review'),false,record.id,{active:selected?.id===record.id,ariaLabel:t(`${selected?.id===record.id?'当前查看':'查看'}评估 V${record.version}${record.status==='confirmed'?'归档报告':'复核材料'}`,`${selected?.id===record.id?'Viewing':'View'} assessment V${record.version} ${record.status==='confirmed'?'archived report':'review material'}`)})}</td>
        </tr>`).join('')}</tbody>
      </table></div>`:current&&!busy?`<p class="review-empty">${t('暂无复核记录。','No reviews yet.')}</p>`:''}
      ${selected?`<section class="review-detail" aria-label="${t('所选复核版本','Selected review version')}" tabindex="-1">
        ${mayDecide?`<div class="review-decision-bar">
          <label>${t('复核意见（选填）','Review comment (optional)')}<textarea data-review-comment maxlength="1200" rows="2"${busy?' disabled':''}>${escape(comment)}</textarea></label>
          <div class="review-actions">${button('return',t('退回修改','Return for changes'))}${button('confirm',t('确认并归档','Approve and archive'),true,'',{ariaLabel:t(`确认评估 V${selected.version} 并生成归档报告`,`Approve assessment V${selected.version} and create the archived report`)})}</div>
        </div>`:''}
        ${readyToExport?`<div class="review-actions review-export">${button('print',t('打印报告','Print report'))}${button('download',t('下载 HTML','Download HTML'),false,'',{ariaLabel:t('下载归档报告 HTML','Download archived report HTML')})}${button('pdf',t('下载 PDF','Download PDF'),true)}</div>`:''}
        ${reportMarkup(selected,reportLogo)}
      </section>`:''}`;
  }

  async function run(message,task){
    if(busy||closed)return;
    busy=message;
    error='';
    feedback='';
    render();
    try{await task();}
    catch(exception){error=translateSystemText(exception.message)||t('操作未完成，请重试。','The action could not be completed. Please try again.');}
    finally{busy='';render();}
  }

  function choose(review){
    selected=review;
    comment='';
  }

  function saveReview(review){
    records=[review,...records.filter(record=>record.id!==review.id)].sort((a,b)=>b.submittedAt.localeCompare(a.submittedAt)||b.id.localeCompare(a.id));
    choose(review);
  }

  async function refresh(){
    current=await store.listReviews(project.id);
    records=current.reviews;
    const target=records.find(record=>record.id===selected?.id)??records.find(record=>record.status==='pending')??records[0];
    if(target)choose(await store.loadReview(project.id,target.id));
    else choose(null);
  }

  function handleClick(event){
    const target=event.target.closest('[data-review-action]');
    if(!target||busy)return;
    switch(target.dataset.reviewAction){
      case 'edit':
        onEditDecision();
        break;
      case 'refresh':
        void run(t('正在读取复核记录…','Loading reviews…'),refresh);
        break;
      case 'select':
        void run(t('正在打开复核版本…','Opening review…'),async()=>choose(await store.loadReview(project.id,target.dataset.reviewId))).then(()=>{
          if(event.detail===0&&!closed&&!error)(container.querySelector('[data-review-comment]')??container.querySelector('.review-detail'))?.focus({preventScroll:true});
        });
        break;
      case 'submit':
        void run(t('正在提交复核…','Submitting for review…'),async()=>{
          beforeSubmit();
          saveReview(await store.submitReview(project.id,project.version));
          feedback=t('已提交复核。','Submitted for review.');
        });
        break;
      case 'confirm':
      case 'return': {
        const action=target.dataset.reviewAction;
        void run(t('正在保存复核结果…','Saving review decision…'),async()=>{
          saveReview(await store.decideReview(project.id,selected.id,action,comment));
          feedback=action==='confirm'?t('已确认并归档。','Approved and archived.'):t('已退回。','Returned for changes.');
        });
        break;
      }
      case 'download':
      case 'pdf':
      case 'print': {
        const action=target.dataset.reviewAction,format=action==='download'?'html':action;
        void run(format==='pdf'?t('正在生成 PDF…','Generating PDF…'):t('正在准备归档报告…','Preparing archived report…'),async()=>{
          const archive=await store.exportReview(project.id,selected.id,format);
          if(closed)return;
          const logo=await embeddedReportLogo();
          if(closed)return;
          if(format==='pdf'){
            const {createReviewPdf}=await import('./review-pdf.mjs?v=pdf-1');
            const pdf=await createReviewPdf(archive,logo);
            if(!closed)downloadReport(archive,pdf,'pdf');
          }else if(format==='print')await printArchive(archive,logo);
          else downloadReport(archive,new Blob([archiveDocument(archive,logo)],{type:'text/html;charset=utf-8'}),'html');
        });
        break;
      }
    }
  }
  function handleInput(event){
    if(event.target.matches('[data-review-comment]'))comment=event.target.value;
  }
  container.addEventListener('click',handleClick);
  container.addEventListener('input',handleInput);
  void run(t('正在读取复核记录…','Loading reviews…'),refresh);
  return {destroy(){
    closed=true;
    container.removeEventListener('click',handleClick);
    container.removeEventListener('input',handleInput);
    container.replaceChildren();
  }};
}
