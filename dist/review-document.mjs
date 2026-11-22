import {t,getLocale,translateSystemText} from './i18n.mjs';

export const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const escape=escapeHtml;

const documentDate=new Intl.DateTimeFormat(getLocale(),{dateStyle:'medium',timeZone:'Asia/Shanghai'});
const recordDate=new Intl.DateTimeFormat(getLocale(),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Shanghai'});
const dateKey=new Intl.DateTimeFormat('sv-SE',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:'Asia/Shanghai'});
export const reviewStatuses={pending:t('待复核','Pending review'),confirmed:t('已确认','Approved'),returned:t('已退回','Returned')};
const score=value=>(value*100).toFixed(2);
const signedScore=value=>{
  const magnitude=score(Math.abs(value));
  return magnitude==='0.00'?magnitude:`${value<0?'−':'+'}${magnitude}`;
};
const rawValue=value=>Number.isFinite(value)?String(value):'—';
export const formatReviewDate=(value,format=recordDate)=>format.format(new Date(value));

export const reportBaseStyle=`
.procurement-report {
  --report-ink:#172438;--report-muted:#4c5666;--report-line:#d7dee7;--report-shade:#f0f3f7;
  color:var(--report-ink);font:14px/1.65 system-ui,"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif;
}
.procurement-report :is(h2,h3,p,dl) { margin:0; }
.report-letterhead {
  display:flex;align-items:center;justify-content:space-between;gap:10px 18px;flex-wrap:wrap;
  border-bottom:1px solid var(--report-line);padding-bottom:11px;
}
.report-affiliation { display:flex;align-items:center;gap:8px;font-size:15px;font-weight:680;color:#19202a; }
.report-mark { display:grid;place-content:center;width:39px;height:39px;overflow:hidden;flex:none; }
.report-mark img { display:block;width:56px;height:56px;max-width:none; }
.report-number { color:var(--report-muted);font-size:11px;letter-spacing:.018em;overflow-wrap:anywhere; }
.report-title { padding:19px 0 14px; }
.report-title h2 { font-size:30px;line-height:1.2;font-weight:730;letter-spacing:.025em; }
.report-title p { margin-top:7px;color:var(--report-muted);font-size:16px;font-weight:550;overflow-wrap:anywhere; }
.report-metadata,.report-review-facts {
  display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px 16px;
}
.report-metadata { padding:9px 0 10px;border-block:1px solid var(--report-line); }
.procurement-report dt { color:var(--report-muted);font-size:12px;font-weight:540; }
.procurement-report dd { margin:1px 0 0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums; }
.report-section { margin-top:20px; }
.report-section h3 {
  font-size:16px;line-height:1.4;font-weight:690;padding-bottom:5px;border-bottom:1px solid var(--report-line);
  margin-bottom:8px;
}
.report-selection {
  display:grid;grid-template-columns:repeat(2,minmax(0,1fr));border:1px solid var(--report-line);
  background:var(--report-shade);
}
.report-choice { padding:9px 11px 10px; }
.report-choice + .report-choice { border-left:1px solid var(--report-line); }
.report-choice dt { font-weight:650; }
.report-choice dd { font-size:17px;font-weight:690;line-height:1.4; }
.report-choice p { margin-top:2px;color:var(--report-muted);font-size:12px; }
.report-notes { margin-top:9px; }
.report-notes dd { margin-top:1px;white-space:pre-wrap; }
.report-review-facts .report-notes { grid-column:1/-1; }
.report-section .report-context { margin-bottom:7px;color:var(--report-muted);font-size:12px;overflow-wrap:anywhere; }
.report-context strong { color:var(--report-ink); }
.report-scroll { overflow-x:auto; }
.procurement-report table { width:100%;border-collapse:collapse;font-size:12px;line-height:1.5; }
.procurement-report :is(th,td) {
  padding:5px 7px;border-bottom:1px solid var(--report-line);text-align:left;vertical-align:top;overflow-wrap:anywhere;
}
.procurement-report thead th { background:var(--report-shade);font-weight:660;color:#28384f; }
.procurement-report tbody th { font-weight:570; }
.procurement-report tbody tr:last-child :is(th,td) { border-bottom:1px solid var(--report-line); }
.procurement-report .report-num { white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums; }
.report-value-header { min-width:78px; }
.report-recommended { background:#f5f7fa; }
.report-rank { width:46px; }
.report-status { width:72px; }
.report-score { width:58px; }
.report-assignment { width:56px;white-space:nowrap; }
.procurement-report[lang="en"] .report-ranking { table-layout:fixed; }
.procurement-report[lang="en"] .report-ranking thead th { width:auto;white-space:normal;overflow-wrap:normal; }
.procurement-report[lang="en"] .report-ranking td:last-child { white-space:nowrap; }
.procurement-report[lang="en"] .report-ranking td:nth-child(4) { overflow-wrap:normal; }
.procurement-report .report-review-facts { margin-top:5px; }
.report-rule-title { margin:9px 0 2px;font-size:inherit;break-after:avoid; }
.report-rules { margin:0;padding-inline-start:18px; }
.procurement-report .report-source { margin-bottom:7px; }
.report-source div { display:flex;gap:4px 8px;align-items:baseline;flex-wrap:wrap; }
`;

export const reportPaperStyle=`
  .procurement-report { font-size:10pt;line-height:1.5;orphans:3;widows:3; }
  .report-letterhead { padding-bottom:3mm; }
  .report-title { padding:5mm 0 3mm; }
  .report-title h2 { font-size:22pt; }
  .report-title p { font-size:12pt;margin-top:2mm; }
  .report-metadata { padding-block:2mm; }
  .report-section { margin-top:5mm; }
  .report-section h3 { font-size:12pt;break-after:avoid; }
  .report-scroll { overflow:visible; }
  .procurement-report table { font-size:9pt; }
  .procurement-report :is(th,td) { padding:1.15mm 1.7mm; }
  .procurement-report thead { display:table-header-group; }
  .procurement-report :is(tr,.report-cover,.report-selection,.report-short-section) { break-inside:avoid; }
  .procurement-report dt { break-after:avoid; }
`;

export const reportStyle=`${reportBaseStyle}
@media screen and (max-width:540px) {
  .procurement-report { font-size:13px; }
  .report-title { padding-block:15px 10px; }
  .report-title h2 { font-size:25px; }
  .report-metadata,.report-review-facts { gap:7px;grid-template-columns:repeat(2,minmax(0,1fr)); }
  .report-choice { padding-inline:8px; }
  .report-choice dd { font-size:15px; }
  .report-section { margin-top:16px; }
  .report-ranking { min-width:345px; }
}
@page procurement-review {
  size:A4;
  margin:15mm 16mm 17mm;
  @bottom-left { font:8.5pt system-ui,sans-serif;color:#4c5666; }
  @bottom-right { content:counter(page) " / " counter(pages);font:8.5pt system-ui,sans-serif;color:#4c5666; }
}
@media print {
  ${reportPaperStyle}
  .procurement-report { page:procurement-review; }
  .procurement-report * { print-color-adjust:exact; }
}
`;

export function reportNumber(review){
  const date=dateKey.format(new Date(review.submittedAt)).replaceAll('-','');
  const code=String(review.id).replace(/[^a-z0-9]/gi,'').slice(-12).toUpperCase();
  return `ADAPT-${date}-${code}-V${Number(review.version)}`;
}

export function reportPrintStyle(review){
  return `@media print { :root { background:#fff; } }
    @page procurement-review { @bottom-left { content:"${reportNumber(review)}"; } }`;
}

export const reportDocumentTitle=review=>`${review.title} · V${review.version} ${t('采购评审报告','Procurement Review Report')}`;

function fact(label,value,notes=false){
  return `<div${notes?' class="report-notes"':''}><dt>${label}</dt><dd>${escape(value)}</dd></div>`;
}

function choice(label,name,supplier){
  const summary=supplier?`<p>${t(`综合评分 ${score(supplier.score)} 分 · 原排名第 ${supplier.rank}`,`Score ${score(supplier.score)} / 100 · Baseline rank ${supplier.rank}`)}</p>`:'';
  return `<div class="report-choice"><dt>${label}</dt><dd>${escape(name||t('未指定','Not specified'))}${summary}</dd></div>`;
}

const selectionLabel=value=>value==='推荐'?t('推荐','Recommended'):value==='备选'?t('备选','Alternative'):value;
const qualificationLabel=value=>({合格:t('合格','Eligible'),不合格:t('不合格','Ineligible'),待核验:t('待核验','Pending verification'),未配置:t('未配置','Not configured')}[value]??value);
function qualificationReason(value){
  if(getLocale()==='zh-CN')return value;
  const failed=String(value).match(/^(.+)为 (.+)，未满足(不低于|不高于) (.+)。$/u);
  if(failed)return `${failed[1]}: ${failed[2]}; requires ${failed[3]==='不低于'?'at least':'at most'} ${failed[4]}.`;
  if(value==='人工核验确认资质不符合要求。')return 'Manual verification found the qualifications insufficient.';
  if(value==='资质证明尚待人工核验。')return 'Qualification documents await manual verification.';
  return translateSystemText(value);
}

export function reportMarkup(review,logo){
  const {content:c}=review;
  const confirmed=review.status==='confirmed';
  const selected=c.suppliers.find(supplier=>supplier.selection==='推荐');
  const alternative=c.suppliers.find(supplier=>supplier.selection==='备选');
  const reportTitle=confirmed?t('采购评审报告','Procurement Review Report'):t('采购复核材料','Procurement Review Material');
  const qualified=c.qualification.configured;
  const rankingColumns=getLocale()==='en'?`<colgroup>${(qualified?[10,25,9,16,24,16]:[10,60,14,16]).map(width=>`<col style="width:${width}%">`).join('')}</colgroup>`:'';
  const rules=c.qualification.rules.map(rule=>`<li>${escape(rule.criterion)} ${rule.operator==='>='?t('不低于','at least'):t('不高于','at most')} ${escape(rule.threshold)}</li>`).join('');
  const drivers=c.comparison?.contributions.filter(item=>score(Math.abs(item.contribution))!=='0.00').slice(0,3);
  return `<article class="procurement-report" lang="${getLocale()}">
    <header class="report-cover">
      <div class="report-letterhead">
        <div class="report-affiliation"><span class="report-mark"><img src="${escape(logo)}" width="56" height="56" alt=""></span><span>${t('贝翰战略咨询','Bentham Strategy Consulting')}</span></div>
        <span class="report-number">${reportNumber(review)}</span>
      </div>
      <div class="report-title"><h2>${reportTitle}</h2><p>${escape(review.title)}</p></div>
      <dl class="report-metadata">
        ${fact(t('评估版本','Assessment version'),`V${review.version}`)}
        ${fact(t('复核状态','Review status'),reviewStatuses[review.status])}
        ${review.reviewedAt?fact(confirmed?t('确认日期','Approval date'):t('复核日期','Review date'),formatReviewDate(review.reviewedAt,documentDate)):fact(t('提交日期','Submission date'),formatReviewDate(review.submittedAt,documentDate))}
      </dl>
    </header>
    <section class="report-section">
      <h3>${t('采购结论','Procurement decision')}</h3>
      <dl class="report-selection">${choice(t('推荐供应商','Recommended supplier'),c.recommendation,selected)}${choice(t('备选供应商','Alternative supplier'),c.alternative,alternative)}</dl>
      <dl>${fact(t('选择依据','Rationale'),c.rationale,true)}${c.followUps?fact(t('后续事项','Follow-up actions'),c.followUps,true):''}</dl>
    </section>
    <section class="report-section">
      <h3>${t('供应商评审结果','Supplier assessment')}</h3>
      <p class="report-context">${t(`${c.suppliers.length} 家参评 · 综合评分满分 100 分`,`${c.suppliers.length} suppliers · Scores out of 100`)}${c.openComparisons?t(` · ${c.openComparisons} 组比较待明确`,` · ${c.openComparisons} comparisons unresolved`):''}</p>
      <div class="report-scroll"><table class="report-ranking">
        ${rankingColumns}
        <thead><tr><th scope="col" class="report-rank report-num">${t('原排名','Baseline rank')}</th><th scope="col">${t('供应商','Supplier')}</th><th scope="col" class="report-score report-num">${t('综合分','Score')}</th>${qualified?`<th scope="col" class="report-status">${t('准入结果','Eligibility')}</th><th scope="col">${t('准入说明','Eligibility notes')}</th>`:''}<th scope="col" class="report-assignment">${t('采购意见','Decision')}</th></tr></thead>
        <tbody>${c.suppliers.map(row=>`<tr${row.selection==='推荐'?' class="report-recommended"':''}>
          <td class="report-num">${row.rank}</td><th scope="row">${escape(row.name)}</th><td class="report-num">${score(row.score)}</td>${qualified?`<td>${escape(qualificationLabel(row.qualification))}</td><td>${escape(row.reasons.map(qualificationReason).join(t('；','; '))||'—')}</td>`:''}<td>${escape(selectionLabel(row.selection)||'—')}</td>
        </tr>`).join('')}</tbody>
      </table></div>
    </section>
    ${c.comparison?`<section class="report-section report-short-section">
      <h3>${t('推荐与备选的评分差异','Recommended vs alternative: score difference')}</h3>
      <p class="report-context">${escape(c.recommendation)} − ${escape(c.alternative)}　<strong>${signedScore(c.comparison.scoreDifference)} ${t('分','pts')}</strong></p>
      ${drivers.length?`<div class="report-scroll"><table>
        <thead><tr><th scope="col">${t('主要指标','Key criterion')}</th><th scope="col" class="report-num report-value-header">${t('推荐方原值','Recommended value')}</th><th scope="col" class="report-num report-value-header">${t('备选方原值','Alternative value')}</th><th scope="col" class="report-num">${t('分差贡献（分）','Contribution (pts)')}</th></tr></thead>
        <tbody>${drivers.map(item=>`<tr><th scope="row">${escape(item.criterion)}</th><td class="report-num">${rawValue(item.recommendedValue)}</td><td class="report-num">${rawValue(item.alternativeValue)}</td><td class="report-num">${signedScore(item.contribution)}</td></tr>`).join('')}</tbody>
      </table></div>`:''}
    </section>`:''}
    ${c.plans.length?`<section class="report-section report-short-section">
      <h3>${t('采购方案对比','Procurement scenarios')}</h3>
      <div class="report-scroll"><table>
        <thead><tr><th scope="col">${t('方案','Scenario')}</th><th scope="col">${t('首位候选','Leading candidate')}</th><th scope="col" class="report-num">${t('推荐方原排名','Recommended rank')}</th><th scope="col" class="report-num">${t('推荐方综合分','Recommended score')}</th></tr></thead>
        <tbody>${c.plans.map(plan=>`<tr><th scope="row">${escape(plan.name)}</th><td>${escape(plan.leader||'—')}</td><td class="report-num">${plan.rank}</td><td class="report-num">${score(plan.score)}</td></tr>`).join('')}</tbody>
      </table></div>
    </section>`:''}
    <section class="report-section">
      <h3>${t('复核记录','Review record')}</h3>
      <dl class="report-review-facts">
        ${fact(t('提交人','Submitted by'),review.submittedBy)}${fact(t('提交时间','Submitted at'),formatReviewDate(review.submittedAt))}
        ${review.reviewedAt?fact(confirmed?t('确认人','Approved by'):t('复核人','Reviewed by'),review.reviewedBy)+fact(confirmed?t('确认时间','Approved at'):t('复核时间','Reviewed at'),formatReviewDate(review.reviewedAt)):''}
        ${review.comment?fact(t('复核意见','Review comment'),review.comment,true):''}
      </dl>
    </section>
    <section class="report-section">
      <h3>${t('附录 · 评价标准与数据来源','Appendix · Criteria and data source')}</h3>
      <dl class="report-source">
        ${c.dataSource?fact(t('数据来源','Data source'),c.dataSource):''}${fact(t('评估版本保存时间','Assessment saved at'),formatReviewDate(c.assessmentUpdatedAt))}
      </dl>
      <div class="report-scroll"><table>
        <thead><tr><th scope="col">${t('指标','Criterion')}</th><th scope="col">${t('评价方向','Direction')}</th><th scope="col" class="report-num">${t('评分权重','Score weight')}</th></tr></thead>
        <tbody>${c.criteria.map(item=>`<tr><th scope="row">${escape(item.name)}</th><td>${item.type==='cost'?t('越低越好','Lower is better'):t('越高越好','Higher is better')}</td><td class="report-num">${(item.weight*100).toFixed(1)}%</td></tr>`).join('')}</tbody>
      </table></div>
      ${qualified?`<h4 class="report-rule-title">${t('准入条件','Eligibility requirements')}</h4><ul class="report-rules">${rules}${c.qualification.requireQualification?`<li>${t('资质证明须通过人工核验','Qualification documents require manual verification')}</li>`:''}</ul>`:''}
    </section>
  </article>`;
}

export function archiveDocument(review,logo){
  if(review.status!=='confirmed')throw new Error(t('负责人确认后即可生成归档报告。','The report can be generated after approval.'));
  return `<!doctype html><html lang="${getLocale()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escape(reportDocumentTitle(review))}</title><style>
    ${reportStyle}${reportPrintStyle(review)}
    body{margin:0;background:#edf1f5}main{box-sizing:border-box;max-width:850px;margin:22px auto;background:#fff;padding:32px 36px}
    @media screen and (max-width:540px){main{margin:0;padding:16px 14px}}
    @media print{body{background:#fff}main{max-width:none;margin:0;padding:0}}
    </style></head><body><main>${reportMarkup(review,logo)}</main></body></html>`;
}
