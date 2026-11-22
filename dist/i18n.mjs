import {englishSystemText} from './system-text-en.mjs';

const languageKey='adapt.language';
const supported=value=>value==='en'||value==='zh-CN';
function preferredLanguage(){
  const requested=new URLSearchParams(globalThis.location?.search??'').get('lang');
  if(supported(requested))return requested;
  try{
    const saved=globalThis.localStorage?.getItem(languageKey);
    if(supported(saved))return saved;
  }catch{/* The URL still works if browser storage is disabled. */}
  return 'zh-CN';
}

const language=preferredLanguage();
export const getLocale=()=>language;
export const t=(zh,en)=>language==='en'?en:zh;
export const translateSystemText=text=>language==='en'&&typeof text==='string'?englishSystemText(text):text;

export function saveLocale(value){
  if(!supported(value))return;
  try{globalThis.localStorage?.setItem(languageKey,value);}
  catch{/* The explicit language in the URL remains available. */}
}
