/** Procurement decision UI. State and persistence belong to the caller. */

import {t,translateSystemText} from './i18n.mjs';

export const DECISION_LIMITS=Object.freeze({rationale:800,followUps:800});
const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clean=value=>typeof value==='string'?value.trim():'';
const bound=(value,limit)=>Array.from(clean(value)).slice(0,limit).join('');
const textLength=value=>Array.from(String(value??'')).length;
let instanceCount=0;

function supplierList(suppliers){
  const seen=new Set();
  return (Array.isArray(suppliers)?suppliers:[]).filter(s=>{
    if(!s||typeof s.id!=='string'||!s.id||seen.has(s.id))return false;
    seen.add(s.id);return true;
  }).map(s=>({id:s.id,name:String(s.name||s.id)}));
}

/** Canonical persisted shape. Removed suppliers and duplicate backups are cleared. */
export function normalizeDecision(decision,suppliers){
  const input=decision&&typeof decision==='object'?decision:{};
  const ids=new Set(supplierList(suppliers).map(s=>s.id));
  const requested=clean(input.recommendedId),backup=clean(input.alternativeId);
  const recommendedId=ids.has(requested)?requested:'';
  return {
    recommendedId,
    alternativeId:ids.has(backup)&&backup!==recommendedId?backup:'',
    rationale:bound(input.rationale,DECISION_LIMITS.rationale),
    followUps:bound(input.followUps,DECISION_LIMITS.followUps),
  };
}

/** Business label/value rows; call the shared CSV serializer when downloading. */
export function decisionRows(decision,suppliers){
  const value=normalizeDecision(decision,suppliers);
  const names=new Map(supplierList(suppliers).map(s=>[s.id,s.name]));
  return [
    [t("推荐供应商", "Recommended supplier"),names.get(value.recommendedId)||t("未指定", "Not specified")],
    [t("备选供应商", "Alternative supplier"),names.get(value.alternativeId)||t("未指定", "Not specified")],
    [t("选择依据", "Rationale"),value.rationale||t("未填写", "Not entered")],
    [t("后续事项", "Follow-up actions"),value.followUps||t("未填写", "Not entered")],
  ];
}

function eligibilityEntry(id,eligibility){
  if(!id||!eligibility)return null;
  const entry=eligibility instanceof Map?eligibility.get(id):eligibility[id];
  if(!entry||typeof entry!=='object')return null;
  const status=entry.status==='ineligible'?'excluded':entry.status;
  return {...entry,status};
}

/** Field-level errors for supplier selections. Existing records are not altered. */
export function decisionSelectionErrors(decision,suppliers,eligibility={}){
  const value=decision&&typeof decision==='object'?decision:{};
  const names=new Map(supplierList(suppliers).map(s=>[s.id,s.name])),errors={};
  for(const key of ['recommendedId','alternativeId']){
    const id=clean(value[key]);if(!id)continue;
    const field=key==='recommendedId'?t("推荐供应商", "Recommended supplier"):t("备选供应商", "Alternative supplier");
    if(!names.has(id)){errors[key]=t(`请重新选择当前评估中的${field}。`, `Choose the ${field.toLowerCase()} from the current assessment again.`);continue;}
    const entry=eligibilityEntry(id,eligibility);
    if(entry?.status==='excluded')errors[key]=t(`${field}“${names.get(id)}”未满足准入要求，请更换供应商或清空选择。`, `${field} “${names.get(id)}” does not meet eligibility requirements. Choose another supplier or clear the selection.`);
    if(entry?.status==='pending')errors[key]=t(`${field}“${names.get(id)}”的准入信息待核验，请完成核验、更换供应商或清空选择。`, `Eligibility for ${field.toLowerCase()} “${names.get(id)}” is pending verification. Complete verification, choose another supplier or clear the selection.`);
  }
  if(clean(value.recommendedId)&&clean(value.recommendedId)===clean(value.alternativeId))errors.alternativeId=t("推荐供应商与备选供应商不能相同。", "The recommended and alternative suppliers must be different.");
  return errors;
}

function eligibilityHTML(id,eligibility){
  const entry=eligibilityEntry(id,eligibility);if(!entry)return '';
  const {status}=entry;
  const labels={eligible:t("合格", "Eligible"),pending:t("待核验", "Pending verification"),excluded:t("不合格", "Ineligible")};
  if(!Object.hasOwn(labels,status))return '';
  const label=translateSystemText(bound(entry.label,60))||labels[status];
  const reasons=Array.isArray(entry.reasons)?entry.reasons.filter(s=>typeof s==='string'&&s.trim()).slice(0,3).map(s=>translateSystemText(bound(s,160))):[];
  return `<span class="badge ${status==='eligible'?'green':status==='excluded'?'red':'amber'}">${escapeHTML(label)}</span>${reasons.length?`<span class="decision-eligibility-detail">${escapeHTML(reasons.join(t('；', '; ')))}</span>`:''}`;
}

/**
 * mountDecision(container,{suppliers,decision,onSave,eligibility})
 * eligibility: supplier-id map (or Map), entries {status,label?,reasons?:string[]}.
 * Statuses: eligible / pending / excluded; ineligible is also accepted.
 * Pending/ineligible selections must be amended before saving. Eligibility updates
 * retain historical selections for review. Blank selections may still be saved.
 * onSave receives a new canonical decision; it may be async and throw on failure.
 * Returns {read,isDirty,updateEligibility,destroy}.
 * The caller may retain read() across rerenders or update eligibility in place.
 */
export function mountDecision(container,{suppliers=[],decision={},onSave,eligibility={},readOnly=false}={}){
  if(!container||typeof container.querySelector!=='function')throw new TypeError(t("采购决策需要有效的容器。", "Procurement decisions require a valid container."));
  if(typeof onSave!=='function')throw new TypeError(t("采购决策需要 onSave 回调。", "Procurement decisions require an onSave callback."));
  const list=supplierList(suppliers),prefix=`decision-${++instanceCount}`;
  let saved=normalizeDecision(decision,list),saving=false,destroyed=false;
  const options=selected=>`<option value="">${t("未指定", "Not specified")}</option>${list.map(s=>`<option value="${escapeHTML(s.id)}"${s.id===selected?' selected':''}>${escapeHTML(s.name)}</option>`).join('')}`;
  container.innerHTML=`
    <div class="panel-heading extension-toolbar">
      <div><h2>${t("采购决策", "Procurement decision")}</h2></div>
      <span class="badge neutral" data-decision-state></span>
    </div>
    <form class="extension-form decision-form" novalidate>
      <div class="decision-select-grid">
        <div class="decision-field">
          <label for="${prefix}-recommended">${t("推荐供应商", "Recommended supplier")}</label>
          <select id="${prefix}-recommended" name="recommendedId" aria-describedby="${prefix}-recommended-error">${options(saved.recommendedId)}</select>
          <div class="decision-eligibility" data-eligibility="recommendedId" aria-live="polite"></div>
          <div id="${prefix}-recommended-error" class="extension-error decision-field-error hidden" data-field-error="recommendedId" role="alert"></div>
        </div>
        <div class="decision-field">
          <label for="${prefix}-alternative">${t("备选供应商", "Alternative supplier")}</label>
          <select id="${prefix}-alternative" name="alternativeId" aria-describedby="${prefix}-alternative-error">${options(saved.alternativeId)}</select>
          <div class="decision-eligibility" data-eligibility="alternativeId" aria-live="polite"></div>
          <div id="${prefix}-alternative-error" class="extension-error decision-field-error hidden" data-field-error="alternativeId" role="alert"></div>
        </div>
      </div>
      <div class="decision-notes-grid">
        <div class="decision-field">
          <label for="${prefix}-rationale">${t("选择依据", "Rationale")}<span class="small-label" data-count="rationale"></span></label>
          <textarea id="${prefix}-rationale" name="rationale" rows="3" maxlength="${DECISION_LIMITS.rationale}">${escapeHTML(saved.rationale)}</textarea>
        </div>
        <div class="decision-field">
          <label for="${prefix}-followups">${t("后续事项", "Follow-up actions")}<span class="small-label" data-count="followUps"></span></label>
          <textarea id="${prefix}-followups" name="followUps" rows="3" maxlength="${DECISION_LIMITS.followUps}">${escapeHTML(saved.followUps)}</textarea>
        </div>
      </div>
      <div class="extension-error hidden" data-decision-error role="alert" tabindex="-1"></div>
      <div class="extension-toolbar decision-actions${readOnly?' hidden':''}">
        <button type="submit" class="button primary">${t("保存采购决策", "Save decision")}</button>
        <button type="button" class="button secondary" data-decision-reset>${t("撤销修改", "Discard changes")}</button>
        <span class="small-label" data-decision-feedback role="status" aria-live="polite"></span>
      </div>
    </form>`;
  const form=container.querySelector('form');
  const fields=Object.fromEntries(['recommendedId','alternativeId','rationale','followUps'].map(key=>[key,form.elements.namedItem(key)]));
  const errorBox=form.querySelector('[data-decision-error]'),stateBadge=container.querySelector('[data-decision-state]');
  const feedback=form.querySelector('[data-decision-feedback]');
  const raw=()=>Object.fromEntries(Object.keys(fields).map(key=>[key,clean(fields[key].value)]));
  const read=()=>normalizeDecision(raw(),list);
  const isDirty=()=>JSON.stringify(raw())!==JSON.stringify(saved);
  const hasRecord=value=>Object.values(value).some(Boolean);
  const showError=message=>{errorBox.textContent=message;errorBox.classList.toggle('hidden',!message);};
  const showFieldErrors=(errors={})=>{
    for(const key of ['recommendedId','alternativeId']){
      const box=form.querySelector(`[data-field-error="${key}"]`),message=errors[key]||'';
      box.textContent=message;box.classList.toggle('hidden',!message);
      if(message)fields[key].setAttribute('aria-invalid','true');else fields[key].removeAttribute('aria-invalid');
    }
  };
  const update=()=>{
    const dirty=isDirty();container.dataset.decisionDirty=String(dirty);
    stateBadge.textContent=dirty?t("修改未保存", "Unsaved changes"):hasRecord(saved)?t("已记录", "Recorded"):t("未记录", "Not recorded");
    stateBadge.className=`badge ${dirty?'amber':'neutral'}`;
    for(const key of ['rationale','followUps'])form.querySelector(`[data-count="${key}"]`).textContent=`${textLength(fields[key].value)} / ${DECISION_LIMITS[key]}`;
    for(const key of ['recommendedId','alternativeId'])form.querySelector(`[data-eligibility="${key}"]`).innerHTML=eligibilityHTML(fields[key].value,eligibility);
    fields.recommendedId.disabled=saving||readOnly;
    fields.alternativeId.disabled=saving||readOnly;
    fields.rationale.readOnly=saving||readOnly;
    fields.followUps.readOnly=saving||readOnly;
    form.querySelector('[data-decision-reset]').disabled=saving||readOnly||!dirty;
    form.querySelector('[type="submit"]').disabled=saving||readOnly||!list.length;
  };
  const onInput=()=>{showError('');showFieldErrors();feedback.textContent='';update();};
  const onReset=()=>{
    if(saving)return;
    for(const [key,value]of Object.entries(saved))fields[key].value=value;
    showError('');showFieldErrors();feedback.textContent='';update();
  };
  const onSubmit=async event=>{
    event.preventDefault();if(saving||destroyed||readOnly)return;
    const value=raw();showError('');showFieldErrors();feedback.textContent='';
    const selectionErrors=decisionSelectionErrors(value,list,eligibility);
    if(Object.keys(selectionErrors).length){showFieldErrors(selectionErrors);fields[Object.keys(selectionErrors)[0]].focus();return;}
    for(const key of ['rationale','followUps'])if(textLength(value[key])>DECISION_LIMITS[key]){
      showError(t(`${key==='rationale'?t("选择依据", "Rationale"):t("后续事项", "Follow-up actions")}最多填写 ${DECISION_LIMITS[key]} 个字符。`, `${key==='rationale'?t("选择依据", "Rationale"):t("后续事项", "Follow-up actions")} must not exceed ${DECISION_LIMITS[key]} characters.`));fields[key].focus();return;
    }
    const updated=normalizeDecision(value,list);saving=true;feedback.textContent=t("正在保存", "Saving");update();
    for(const field of Object.values(fields))field.disabled=true;
    try{
      const outcome=await onSave({...updated});
      if(outcome===false)throw new Error(t("采购决策未保存，请重试。", "The procurement decision was not saved. Try again."));
      saved=outcome&&typeof outcome==='object'&&Object.hasOwn(outcome,'recommendedId')?normalizeDecision(outcome,list):{...updated};
      for(const [key,value]of Object.entries(saved))fields[key].value=value;
      feedback.textContent=t("采购决策已更新", "Procurement decision updated");
    }catch(error){showError(error instanceof Error?translateSystemText(error.message):t("采购决策未保存，请重试。", "The procurement decision was not saved. Try again."));feedback.textContent='';}
    finally{
      saving=false;
      for(const field of Object.values(fields))field.disabled=false;
      if(!destroyed)update();
    }
  };
  form.addEventListener('input',onInput);form.addEventListener('change',onInput);form.addEventListener('submit',onSubmit);
  const reset=form.querySelector('[data-decision-reset]');reset.addEventListener('click',onReset);
  update();
  return {read,isDirty,updateEligibility(nextObject){eligibility=nextObject&&typeof nextObject==='object'?nextObject:{};if(!destroyed)update();},destroy(){destroyed=true;form.removeEventListener('input',onInput);form.removeEventListener('change',onInput);form.removeEventListener('submit',onSubmit);reset.removeEventListener('click',onReset);}};
}
