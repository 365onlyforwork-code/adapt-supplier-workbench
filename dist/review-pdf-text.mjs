/**
 * Copy/search layer for a rasterized report page. The visible report is untouched.
 * Empty Type 3 glyph programs are generated here; no system font is redistributed.
 */
const BANK_SIZE=255;
const EPSILON=.4;
const HIDDEN_TAGS=new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE']);

function unicodeHex(text){
  let encoded='';
  for(let index=0;index<text.length;index++)encoded+=text.charCodeAt(index).toString(16).padStart(4,'0');
  return encoded.toUpperCase();
}

function* codePointSegments(text){
  let index=0;
  for(const segment of text){yield {segment,index};index+=segment.length;}
}

function intersect(clip,rect,x=true,y=true){
  return {
    left:x?Math.max(clip.left,rect.left):clip.left,
    right:x?Math.min(clip.right,rect.right):clip.right,
    top:y?Math.max(clip.top,rect.top):clip.top,
    bottom:y?Math.min(clip.bottom,rect.bottom):clip.bottom,
  };
}

function collectText(sheet,metrics){
  const doc=sheet.ownerDocument,view=doc.defaultView,box=sheet.getBoundingClientRect();
  if(!box.width||!box.height)throw new Error('报告页面尚未完成布局。');
  const page={left:box.left,right:box.right,top:box.top,bottom:box.bottom};
  const segmenter=typeof Intl.Segmenter==='function'?new Intl.Segmenter('zh',{granularity:'grapheme'}):null;
  const clips=new Map(),runs=[],walker=doc.createTreeWalker(sheet,4);
  const styleFor=element=>view.getComputedStyle(element);
  function clipping(element){
    if(clips.has(element))return clips.get(element);
    let clip={...page};
    for(let current=element;current;current=current.parentElement){
      if(HIDDEN_TAGS.has(current.tagName)){clip=null;break;}
      const style=styleFor(current);
      if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||Number(style.opacity)===0){clip=null;break;}
      const cropX=style.overflowX!=='visible',cropY=style.overflowY!=='visible';
      if(cropX||cropY){
        const rect=current.getBoundingClientRect();
        const scaleX=current.offsetWidth?rect.width/current.offsetWidth:1,scaleY=current.offsetHeight?rect.height/current.offsetHeight:1;
        const left=rect.left+current.clientLeft*scaleX,top=rect.top+current.clientTop*scaleY;
        clip=intersect(clip,{left,right:left+current.clientWidth*scaleX,top,bottom:top+current.clientHeight*scaleY},cropX,cropY);
      }
      // An offscreen staging page is valid: do not clip it to the browser viewport.
      if(current===sheet)break;
    }
    clips.set(element,clip);return clip;
  }
  while(walker.nextNode()){
    const node=walker.currentNode,text=node.textContent??'',parent=node.parentElement;
    if(!text||!parent)continue;
    const clip=clipping(parent);if(!clip||clip.right<=clip.left||clip.bottom<=clip.top)continue;
    const segments=segmenter?segmenter.segment(text):codePointSegments(text);
    for(const {segment,index}of segments){
      const range=doc.createRange();range.setStart(node,index);range.setEnd(node,index+segment.length);
      const rect=range.getClientRects()[0];
      // Never expose hidden or clipped content in the PDF's searchable text.
      if(!rect||rect.width<=.01||rect.height<=.01||rect.left<clip.left-EPSILON||rect.right>clip.right+EPSILON||rect.top<clip.top-EPSILON||rect.bottom>clip.bottom+EPSILON)continue;
      runs.push({
        text:segment,
        x:(rect.left-box.left)/box.width*metrics.width,
        y:(rect.top-box.top)/box.height*metrics.height,
        width:rect.width/box.width*metrics.width,
        height:rect.height/box.height*metrics.height,
      });
    }
  }
  return runs;
}

function cmap(entries){
  const lines=[
    '/CIDInit /ProcSet findresource begin','12 dict begin','begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /ReportSearchUnicode def','/CMapType 2 def',
    '1 begincodespacerange','<00> <FF>','endcodespacerange',
  ];
  for(let start=0;start<entries.length;start+=100){
    const chunk=entries.slice(start,start+100);
    lines.push(`${chunk.length} beginbfchar`,...chunk.map((text,index)=>`<${(start+index+1).toString(16).padStart(2,'0')}> <${unicodeHex(text)}>`),'endbfchar');
  }
  lines.push('endcmap','CMapName currentdict /CMap defineresource pop','end','end');
  return lines.join('\n');
}

/**
 * Adds invisible, correctly positioned Unicode to the same page image.
 * sheet must be the attached, already paginated DOM page (including its footer).
 * metrics are that page's CSS dimensions; PDF point dimensions come from pdfPage.
 * Returns {textRuns,glyphs,fonts}; the function does not print, save or download.
 */
export function addReportTextLayer(pdfLib,pdfDocument,pdfPage,sheet,metrics={width:794,height:1123}){
  if(!pdfLib?.PDFName||!pdfDocument?.context||!pdfPage?.node||!sheet?.ownerDocument?.defaultView||!sheet.isConnected)throw new Error('报告文字层需要已布局的页面与有效 PDF 文档。');
  if(!Number.isFinite(metrics.width)||!Number.isFinite(metrics.height)||metrics.width<=0||metrics.height<=0)throw new Error('报告页面尺寸无效。');
  const size=pdfPage.getSize();
  if(!Number.isFinite(size.width)||!Number.isFinite(size.height)||size.width<=0||size.height<=0)throw new Error('PDF 页面尺寸无效。');
  const runs=collectText(sheet,metrics);
  if(!runs.length)return {textRuns:0,glyphs:0,fonts:0};
  const {PDFName}=pdfLib,context=pdfDocument.context,unique=[...new Set(runs.map(run=>run.text))],mapping=new Map();
  const blank=context.register(context.flateStream('1000 0 d0\n'));
  let fonts=0;
  for(let start=0;start<unique.length;start+=BANK_SIZE){
    const entries=unique.slice(start,start+BANK_SIZE),programs={},differences=[1];
    entries.forEach((text,index)=>{const glyph=`g${index+1}`;programs[glyph]=blank;differences.push(PDFName.of(glyph));});
    const font=context.obj({
      Type:'Font',Subtype:'Type3',FontBBox:[0,0,1000,1000],FontMatrix:[.001,0,0,.001,0,0],
      CharProcs:programs,Encoding:{Type:'Encoding',Differences:differences},
      FirstChar:1,LastChar:entries.length,Widths:entries.map(()=>1000),Resources:{},
      ToUnicode:context.register(context.flateStream(cmap(entries))),
    });
    const key=pdfPage.node.newFontDictionary('ReportText',context.register(font));
    entries.forEach((text,index)=>mapping.set(text,{font:key.toString(),code:(index+1).toString(16).padStart(2,'0')}));
    fonts++;
  }
  const scaleX=size.width/metrics.width,scaleY=size.height/metrics.height,commands=['q','BT','3 Tr'];
  for(const run of runs){
    const glyph=mapping.get(run.text),fontSize=run.height*scaleY;
    const x=run.x*scaleX,y=size.height-(run.y+run.height)*scaleY;
    const horizontalScale=run.width*scaleX/fontSize*100;
    commands.push(`${glyph.font} ${fontSize.toFixed(5)} Tf ${horizontalScale.toFixed(5)} Tz 1 0 0 1 ${x.toFixed(5)} ${y.toFixed(5)} Tm <${glyph.code}> Tj`);
  }
  commands.push('ET','Q');
  pdfPage.node.addContentStream(context.register(context.flateStream(commands.join('\n'))));
  return {textRuns:runs.length,glyphs:unique.length,fonts};
}
