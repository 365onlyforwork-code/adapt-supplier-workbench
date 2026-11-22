/** Standalone eligibility editor. Only touches the supplied container. */
import {t,translateSystemText} from './i18n.mjs';
import {normalizeEligibility,evaluateEligibility} from './eligibility.mjs';

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const copy=value=>structuredClone(value);
let mountId=0;

/**
 * mountEligibility(container,{data,settings,onSave})
 * onSave(canonicalSettings,evaluation) may return a Promise. No local storage,
 * outside DOM hooks, scoring mutation, or fabricated records are performed here.
 * onSave may return canonical settings or {settings,persisted}; a separate
 * metadata.persisted annotation is also accepted without becoming rule data.
 * Returns {update({data?,settings?}),getSettings(),isDirty(),destroy()}.
 */
export function mountEligibility(container,{data,settings={},onSave,readOnly=false}={}){
  if(!container||typeof container.addEventListener!=='function') throw new Error(t("准入规则需要有效的显示容器。", "Eligibility rules require a valid container."));
  if(typeof onSave!=='function') throw new Error(t("请提供准入规则保存处理函数。", "Provide a save handler for eligibility rules."));
  let currentData=data,draft=normalizeEligibility(data,settings),saved=JSON.stringify(draft),saving=false,destroyed=false;
  const prefix=`eligibility-${++mountId}`,find=selector=>container.querySelector(selector);

  function isDirty(){
    try{return JSON.stringify(normalizeEligibility(currentData,draft))!==saved;}
    catch{return true;}
  }

  function setMessage(message,error=false){
    const area=find('[data-eligibility-message]');if(!area)return;
    area.textContent=message;area.className=error?'form-error':'small-label';
    area.setAttribute('role',error?'alert':'status');
  }

  function lockWhileSaving(){
    if(saving||readOnly)container.querySelectorAll('input,select,button').forEach(control=>control.disabled=true);
  }

  function preview(){
    try{
      const evaluation=evaluateEligibility(currentData,draft),dirty=isDirty();
      const {counts}=evaluation;
      find('[data-eligibility-summary]').textContent=evaluation.configured?t(`${counts.eligible} 家合格 · ${counts.ineligible} 家不合格 · ${counts.pending} 家待核验`, `${counts.eligible} eligible · ${counts.ineligible} ineligible · ${counts.pending} pending verification`):draft.enabled?t("尚无准入条件", "No eligibility conditions"):t("未启用准入检查", "Eligibility checks disabled");
      find('[data-eligibility-table]').classList.toggle('hidden',!evaluation.configured);
      find('[data-eligibility-results]').innerHTML=evaluation.configured?evaluation.rows.map(row=>`<tr><td>${esc(row.name)}</td><td><span class="badge ${row.code==='eligible'?'green':row.code==='ineligible'?'red':row.code==='pending'?'amber':'neutral'}">${esc(({eligible:t('合格','Eligible'),ineligible:t('不合格','Ineligible'),pending:t('待核验','Pending verification'),unconfigured:t('未配置','Not configured')})[row.code]??translateSystemText(row.status))}</span></td><td class="extension-reasons">${esc(row.reasons.map(reason=>translateSystemText(reason)).join(' ')||t("符合条件", "Requirements met"))}</td></tr>`).join(''):'';
      const button=find('[data-eligibility-save]');button.disabled=saving;button.textContent=saving?t("正在保存…", "Saving…"):t("保存准入规则", "Save eligibility rules");
      find('[data-eligibility-cancel]').disabled=saving||!dirty;
      setMessage(dirty?t("修改未保存", "Unsaved changes"):'');
      return evaluation;
    }catch(error){
      find('[data-eligibility-summary]').textContent='';
      find('[data-eligibility-results]').innerHTML='';
      find('[data-eligibility-table]').classList.add('hidden');
      find('[data-eligibility-save]').disabled=true;
      find('[data-eligibility-cancel]').disabled=saving||!isDirty();
      setMessage(translateSystemText(error.message)||t("准入规则无效。", "Invalid eligibility rules."),true);
      return null;
    }
  }

  function render(){
    const selected=new Set(draft.rules.map(rule=>rule.criterionId));
    container.innerHTML=`<section class="extension-section eligibility-editor" aria-label="${t('准入规则','Eligibility rules')}">
      <div class="extension-form"><label class="extension-toggle"><input type="checkbox" data-eligibility-enabled ${draft.enabled?'checked':''}> ${t('启用准入检查','Enable eligibility checks')}</label>
      <div class="extension-rule-list">${draft.rules.length?draft.rules.map((rule,index)=>`<div class="extension-rule-row" data-eligibility-rule="${index}">
        <label for="${prefix}-criterion-${index}">${t("指标", "Criterion")}<select id="${prefix}-criterion-${index}" data-rule-field="criterionId">${currentData.criteria.map(criterion=>`<option value="${esc(criterion.id)}" ${criterion.id===rule.criterionId?'selected':''} ${selected.has(criterion.id)&&criterion.id!==rule.criterionId?'disabled':''}>${esc(criterion.name??criterion.id)}</option>`).join('')}</select></label>
        <label for="${prefix}-operator-${index}">${t("要求", "Requirement")}<select id="${prefix}-operator-${index}" data-rule-field="operator"><option value=">=" ${rule.operator==='>='?'selected':''}>${t("不低于 ≥", "At least ≥")}</option><option value="&lt;=" ${rule.operator==='<='?'selected':''}>${t("不高于 ≤", "At most ≤")}</option></select></label>
        <label for="${prefix}-threshold-${index}">${t("原始单位阈值", "Threshold (original unit)")}<input id="${prefix}-threshold-${index}" type="number" inputmode="decimal" min="0" step="any" value="${Number.isFinite(rule.threshold)?rule.threshold:''}" data-rule-field="threshold"></label>
        <button type="button" class="text-button" data-remove-rule="${index}" aria-label="${t(`删除第 ${index+1} 条准入规则`, `Delete eligibility rule ${index+1}`)}">${t("删除", "Delete")}</button></div>`).join(''):`<p class="small-label">${t("尚无数值条件", "No numeric conditions")}</p>`}</div>
      <button type="button" class="button secondary" data-add-rule ${draft.rules.length>=currentData.criteria.length?'disabled':''}>${t("添加数值条件", "Add numeric condition")}</button>
      <label class="extension-toggle"><input type="checkbox" data-qualification-required ${draft.requireQualification?'checked':''}> ${t('要求资质核验','Require qualification verification')}</label>
      ${draft.requireQualification?`<div class="table-scroll"><table class="extension-qualification-table"><thead><tr><th>${t("供应商", "Supplier")}</th><th>${t("资质证明核验", "Qualification verification")}</th></tr></thead><tbody>${currentData.suppliers.map(supplier=>{const status=Object.hasOwn(draft.qualifications,supplier.id)?draft.qualifications[supplier.id]:'pending';return `<tr><td>${esc(supplier.name??supplier.id)}</td><td><select data-qualification-id="${esc(supplier.id)}" aria-label="${esc(t(`${supplier.name??supplier.id}资质核验状态`, `${supplier.name??supplier.id}: qualification verification status`))}"><option value="pending" ${status==='pending'?'selected':''}>${t("待核验", "Pending verification")}</option><option value="verified" ${status==='verified'?'selected':''}>${t("已确认符合", "Verified: meets requirements")}</option><option value="failed" ${status==='failed'?'selected':''}>${t("已确认不符合", "Verified: does not meet requirements")}</option></select></td></tr>`;}).join('')}</tbody></table></div>`:''}
      <div class="extension-actions"><button type="button" class="button primary" data-eligibility-save>${t("保存准入规则", "Save eligibility rules")}</button><button type="button" class="button secondary" data-eligibility-cancel>${t("撤销修改", "Discard changes")}</button><span data-eligibility-message aria-live="polite"></span></div>
      </div><p class="extension-summary" data-eligibility-summary aria-live="polite"></p>
      <div class="table-scroll hidden" data-eligibility-table><table class="extension-results-table"><thead><tr><th>${t("供应商", "Supplier")}</th><th>${t("准入状态", "Eligibility")}</th><th>${t("核对说明", "Details")}</th></tr></thead><tbody data-eligibility-results></tbody></table></div>
      </section>`;
    preview();lockWhileSaving();
  }

  function onChange(event){
    if(readOnly||saving)return;
    const target=event.target;
    if(target.matches('[data-eligibility-enabled]'))draft.enabled=target.checked;
    else if(target.matches('[data-qualification-required]')){draft.requireQualification=target.checked;render();find('[data-qualification-required]')?.focus();return;}
    else if(target.matches('[data-rule-field]')){
      const index=Number(target.closest('[data-eligibility-rule]').dataset.eligibilityRule),key=target.dataset.ruleField;
      draft.rules[index][key]=key==='threshold'?(target.value.trim()===''?NaN:Number(target.value)):target.value;
      if(key==='criterionId'){render();find(`[data-eligibility-rule="${index}"] [data-rule-field="criterionId"]`)?.focus();return;}
    }else if(target.matches('[data-qualification-id]')){
      draft.qualifications=Object.fromEntries([...Object.entries(draft.qualifications).filter(([id])=>id!==target.dataset.qualificationId),[target.dataset.qualificationId,target.value]]);
    }else return;
    preview();
  }

  async function onClick(event){
    if(readOnly||saving)return;
    const add=event.target.closest('[data-add-rule]'),remove=event.target.closest('[data-remove-rule]'),save=event.target.closest('[data-eligibility-save]'),cancel=event.target.closest('[data-eligibility-cancel]');
    if(cancel&&!saving){draft=normalizeEligibility(currentData,JSON.parse(saved));render();setMessage(t("已撤销修改。", "Changes discarded."));find('[data-eligibility-enabled]')?.focus();return;}
    if(add){
      const used=new Set(draft.rules.map(rule=>rule.criterionId)),criterion=currentData.criteria.find(item=>!used.has(item.id));
      if(!criterion)return;
      draft.rules.push({id:`gate-${criterion.id}`,criterionId:criterion.id,operator:criterion.type==='cost'?'<=':'>=',threshold:NaN});render();
      find(`[data-eligibility-rule="${draft.rules.length-1}"] [data-rule-field="threshold"]`)?.focus();return;
    }
    if(remove){const index=Number(remove.dataset.removeRule);draft.rules.splice(index,1);render();(find(`[data-remove-rule="${Math.min(index,draft.rules.length-1)}"]`)||find('[data-add-rule]'))?.focus();return;}
    if(!save||saving)return;
    const evaluation=preview();if(!evaluation)return;
    saving=true;preview();lockWhileSaving();
    try{
      const response=await onSave(copy(evaluation.settings),evaluation);
      if(destroyed)return;
      const returnedSettings=response?.settings??(Array.isArray(response?.rules)?response:evaluation.settings);
      draft=normalizeEligibility(currentData,returnedSettings);saved=JSON.stringify(draft);saving=false;render();
      const persisted=response?.persisted??response?.metadata?.persisted;
      setMessage(persisted===false?t("规则已应用，本次会话中可继续使用；请导出评估文件保留。", "Rules applied for this session. Export the assessment file to keep them."):t("准入规则已保存。", "Eligibility rules saved."));
    }catch(error){if(destroyed)return;saving=false;render();setMessage(translateSystemText(error.message)||t("准入规则未保存，请重试。", "Eligibility rules were not saved. Try again."),true);}
  }

  container.addEventListener('input',onChange);container.addEventListener('change',onChange);container.addEventListener('click',onClick);render();
  return {
    update(next={}){
      if(destroyed)return;
      readOnly=next.readOnly??readOnly;
      const nextData=next.data??currentData;
      const canonical=normalizeEligibility(nextData,next.settings??JSON.parse(saved)),incoming=JSON.stringify(canonical);
      currentData=nextData;
      // Main analysis may rerender after weight changes. Identical saved rules
      // must not discard an unrelated unfinished gate or qualification edit.
      if(incoming!==saved){draft=canonical;saved=incoming;}
      render();
    },
    getSettings(){return normalizeEligibility(currentData,draft);},
    isDirty,
    destroy(){destroyed=true;container.removeEventListener('input',onChange);container.removeEventListener('change',onChange);container.removeEventListener('click',onClick);container.innerHTML='';},
  };
}
