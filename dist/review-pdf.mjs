import {t} from './i18n.mjs';
import {reportBaseStyle,reportDocumentTitle,reportMarkup,reportNumber,reportPaperStyle} from './review-document.mjs?v=pdf-1';
import {addReportTextLayer} from './review-pdf-text.mjs?v=pdf-1';

const paperWidth=794,paperHeight=1123; // A4 rounded to 96 DPI for browser layout.
const pointWidth=210*72/25.4,pointHeight=297*72/25.4;
const renderScale=2.5;
const pageStyle=`
  ${reportBaseStyle}
  ${reportPaperStyle}
  .pdf-sheet {
    box-sizing:border-box;position:relative;width:${paperWidth}px;height:${paperHeight}px;
    padding:15mm 16mm 17mm;background:white;
  }
  .pdf-sheet *, .pdf-sheet *::before, .pdf-sheet *::after { box-sizing:border-box; }
  .pdf-sheet > article { display:flow-root;height:100%; }
  .pdf-sheet > article > :first-child { margin-top:0; }
  .pdf-footer {
    position:absolute;inset-inline:16mm;bottom:6mm;display:flex;justify-content:space-between;
    font:8.5pt/1.3 system-ui,sans-serif;color:#4c5666;font-variant-numeric:tabular-nums;
  }
`;

const makeElement=(name,className)=>{
  const element=document.createElement(name);
  if(className)element.className=className;
  return element;
};

function fits(article){
  const bottom=article.getBoundingClientRect().bottom;
  return !article.lastElementChild||article.lastElementChild.getBoundingClientRect().bottom<=bottom+0.1;
}

function rankTableColumns(table){
  if(table.querySelector(':scope > colgroup'))return;
  const header=[...table.tHead.rows[0].cells];
  const width=table.getBoundingClientRect().width;
  const columns=makeElement('colgroup');
  for(const cell of header){
    const column=makeElement('col');
    column.style.width=`${cell.getBoundingClientRect().width/width*100}%`;
    columns.append(column);
  }
  table.prepend(columns);
  table.style.tableLayout='fixed';
}

function paginate(root,source){
  const pages=[];
  let page;
  const newPage=()=>{
    page=makeElement('div','pdf-sheet');
    const article=source.cloneNode(false);
    page.append(article);
    root.append(page);
    pages.push(page);
    return article;
  };
  let article=newPage();

  function addTable(section,table){
    const scroll=table.parentElement,rows=[...table.tBodies[0].rows];
    rankTableColumns(table);
    table.tBodies[0].replaceChildren();
    let tbody=table.tBodies[0];
    for(const row of rows){
      tbody.append(row);
      if(fits(article))continue;
      row.remove();
      if(!tbody.rows.length){
        section.remove();
        article=article.children.length?newPage():article;
        article.append(section);
      }else{
        article=newPage();
        const continuation=section.cloneNode(false);
        const scroller=scroll.cloneNode(false);
        const repeatedTable=table.cloneNode(true);
        tbody=repeatedTable.tBodies[0];
        tbody.replaceChildren();
        scroller.append(repeatedTable);
        continuation.append(scroller);
        article.append(continuation);
      }
      tbody.append(row);
      if(!fits(article))throw new Error(t('有一行供应商资料超过 A4 页高。','A supplier row exceeds the A4 page height.'));
    }
  }

  function addLongNotes(section){
    const notes=[...section.querySelectorAll('.report-notes')].map(note=>({note,list:note.parentElement}));
    for(const {note} of notes)note.remove();
    if(!fits(article)){
      section.remove();
      if(article.children.length)article=newPage();
      article.append(section);
    }
    if(!fits(article))throw new Error(t('报告内容超出 A4 排版范围。','The report content exceeds the A4 page area.'));
    for(const {note,list} of notes){
      const title=note.querySelector('dt').textContent;
      let remaining=Array.from(note.querySelector('dd').textContent.replace(/\n{3,}/g,'\n\n'));
      let continued=false;
      while(remaining.length){
        const part=note.cloneNode(true),value=part.querySelector('dd');
        part.querySelector('dt').textContent=continued?t(`${title}（续）`,`${title} (continued)`):title;
        value.textContent=remaining.join('');
        let fragment;
        if(article.contains(list))list.append(part);
        else{
          fragment=makeElement('section','report-section');
          const continuation=makeElement('dl');
          continuation.append(part);fragment.append(continuation);article.append(fragment);
        }
        if(fits(article))break;
        let minimum=0,maximum=remaining.length;
        while(minimum<maximum){
          const count=Math.ceil((minimum+maximum)/2);
          value.textContent=remaining.slice(0,count).join('');
          if(fits(article))minimum=count;
          else maximum=count-1;
        }
        if(minimum>0){
          value.textContent=remaining.slice(0,minimum).join('');
          remaining=remaining.slice(minimum);
          continued=true;
        }else{
          (fragment??part).remove();
          if(!article.children.length)throw new Error(t('报告文本无法分页。','The report text could not be paginated.'));
        }
        article=newPage();
      }
    }
  }

  for(const section of [...source.children]){
    article.append(section);
    if(fits(article))continue;
    const table=section.querySelector('.report-ranking');
    if(table){addTable(section,table);continue;}
    if(section.querySelector('.report-notes')){addLongNotes(section);continue;}
    section.remove();
    if(article.children.length)article=newPage();
    article.append(section);
    if(!fits(article))throw new Error(t('报告内容超出 A4 排版范围。','The report content exceeds the A4 page area.'));
  }
  return pages;
}

async function capturePage(page){
  const markup=new XMLSerializer().serializeToString(page);
  const width=Math.round(paperWidth*renderScale),height=Math.round(paperHeight*renderScale);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${paperWidth} ${paperHeight}">
    <foreignObject width="${paperWidth}" height="${paperHeight}">
      <div xmlns="http://www.w3.org/1999/xhtml"><style><![CDATA[${pageStyle}]]></style>${markup}</div>
    </foreignObject>
  </svg>`;
  // An inline image keeps the page's HTML, stylesheet and logo self-contained
  // when the browser paints it into a canvas.
  const image=new Image();
  image.src=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const canvas=makeElement('canvas');
  canvas.width=width;canvas.height=height;
  try{
    const context=canvas.getContext('2d',{alpha:false});
    if(!context)throw new Error(t('当前浏览器无法生成报告图片。','This browser cannot render the report pages.'));
    context.fillStyle='#fff';context.fillRect(0,0,width,height);
    context.drawImage(image,0,0);
    const sample=makeElement('canvas');
    sample.width=48;sample.height=68;
    const sampleContext=sample.getContext('2d',{willReadFrequently:true});
    sampleContext.drawImage(canvas,0,0,sample.width,sample.height);
    const pixels=sampleContext.getImageData(0,0,sample.width,sample.height).data;
    if(!pixels.some((value,index)=>index%4!==3&&value<245))throw new Error(t('未能生成有效的报告页面，请重试。','A valid report page could not be generated. Please try again.'));
    const blob=await new Promise((resolve,reject)=>{
      canvas.toBlob(result=>result?resolve(result):reject(new Error(t('报告页面生成失败。','The report page could not be generated.'))),'image/jpeg',.95);
    });
    return new Uint8Array(await blob.arrayBuffer());
  }finally{
    canvas.width=0;canvas.height=0;
  }
}

export async function createReviewPdf(review,logo){
  if(review.status!=='confirmed')throw new Error(t('负责人确认后即可下载 PDF。','The PDF can be downloaded after approval.'));
  await import('./vendor/pdf-lib.min.js?v=1.17.1');
  const pdfLib=globalThis.PDFLib;
  const {PDFDocument}=pdfLib;
  const documentPdf=await PDFDocument.create();
  documentPdf.setTitle(reportDocumentTitle(review));
  documentPdf.setAuthor(t('贝翰战略咨询','Bentham Strategy Consulting'));
  documentPdf.setSubject(reportNumber(review));
  const confirmedAt=new Date(review.reviewedAt);
  documentPdf.setCreationDate(confirmedAt);
  documentPdf.setModificationDate(confirmedAt);

  const host=makeElement('div');
  host.setAttribute('aria-hidden','true');
  host.inert=true;
  host.style.cssText='position:fixed;left:-10000px;top:0;pointer-events:none;';
  const root=host.attachShadow({mode:'closed'});
  const style=makeElement('style'),template=makeElement('template');
  style.textContent=pageStyle;
  template.innerHTML=reportMarkup(review,logo);
  root.append(style);
  document.body.append(host);
  try{
    await document.fonts?.ready;
    const pages=paginate(root,template.content.firstElementChild);
    for(const [index,sheet] of pages.entries()){
      const footer=makeElement('div','pdf-footer');
      const identifier=makeElement('span'),counter=makeElement('span');
      identifier.textContent=reportNumber(review);
      counter.textContent=`${index+1} / ${pages.length}`;
      footer.append(identifier,counter);
      sheet.append(footer);
      const image=await documentPdf.embedJpg(await capturePage(sheet));
      const page=documentPdf.addPage([pointWidth,pointHeight]);
      page.drawImage(image,{x:0,y:0,width:pointWidth,height:pointHeight});
      addReportTextLayer(pdfLib,documentPdf,page,sheet,{width:paperWidth,height:paperHeight});
      sheet.remove();
    }
    return new Blob([await documentPdf.save()],{type:'application/pdf'});
  }finally{
    host.remove();
  }
}
