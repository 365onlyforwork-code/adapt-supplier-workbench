import {FIXED_SEED} from '../../dist/engine.mjs';

export const PAPER_DATA = {
  suppliers: [
    {id:'S1',name:'S1',values:[.75,.5,11/12,.75,.75,.75]},
    {id:'S2',name:'S2',values:[11/12,.75,.75,.5,.75,.5]},
    {id:'S3',name:'S3',values:[.5,11/12,.75,11/12,.75,.75]},
    {id:'S4',name:'S4',values:[.75,.75,.5,.75,11/12,.5]},
    {id:'S5',name:'S5',values:[.5,.75,.75,.5,.5,11/12]},
  ],
  criteria: [
    {id:'C1',name:'成本',type:'cost',lower:.143,modal:.200,upper:.257},
    {id:'C2',name:'质量',type:'benefit',lower:.200,modal:.260,upper:.323},
    {id:'C3',name:'交付',type:'benefit',lower:.140,modal:.183,upper:.230},
    {id:'C4',name:'技术',type:'benefit',lower:.100,modal:.147,upper:.197},
    {id:'C5',name:'财务',type:'benefit',lower:.083,modal:.117,upper:.157},
    {id:'C6',name:'响应',type:'benefit',lower:.067,modal:.093,upper:.130},
  ],
  sampleCount:200000,seed:FIXED_SEED,p:.9,delta:null,
};
