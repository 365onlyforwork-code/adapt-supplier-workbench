import {once} from 'node:events';
import {mkdir, readFile, readdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {Readable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {createAccountsApi} from '../server/accounts.mjs';
import {createApiHandler} from '../server/api.mjs';

const HOST='127.0.0.1';
const MAX_BODY=6*1024*1024;
const WEB_ROOT=new URL('../dist/',import.meta.url);
const DATA_ROOT=new URL('../.data/',import.meta.url);
const MIGRATIONS_ROOT=new URL('../drizzle/',import.meta.url);
const WEB_TYPES=new Map([
  ['.css','text/css; charset=utf-8'],
  ['.html','text/html; charset=utf-8'],
  ['.jpg','image/jpeg'],
  ['.js','text/javascript; charset=utf-8'],
  ['.mjs','text/javascript; charset=utf-8'],
  ['.png','image/png'],
  ['.svg','image/svg+xml'],
]);

function inTransaction(sqlite,run){
  sqlite.exec('BEGIN IMMEDIATE');
  try{
    const result=run();
    sqlite.exec('COMMIT');
    return result;
  }catch(error){
    sqlite.exec('ROLLBACK');
    throw error;
  }
}

async function applyMigrations(sqlite){
  const journal=JSON.parse(await readFile(new URL('meta/_journal.json',MIGRATIONS_ROOT),'utf8'));
  sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations (tag TEXT PRIMARY KEY NOT NULL)');
  for(const {tag} of journal.entries){
    if(!/^\d{4}_[a-z0-9_]+$/.test(tag))throw new Error('Invalid SQL migration name.');
    const sql=await readFile(new URL(`${tag}.sql`,MIGRATIONS_ROOT),'utf8');
    inTransaction(sqlite,()=>{
      if(sqlite.prepare('SELECT tag FROM schema_migrations WHERE tag=?').get(tag))return;
      sqlite.exec(sql);
      sqlite.prepare('INSERT INTO schema_migrations (tag) VALUES (?)').run(tag);
    });
  }
}

function databaseAdapter(sqlite){
  return {
    prepare(sql){
      return {
        bind(...bindings){
          const statement=sqlite.prepare(sql);
          return {
            first:()=>statement.get(...bindings)??null,
            all:()=>({results:statement.all(...bindings)}),
            run:()=>({meta:{changes:statement.run(...bindings).changes}}),
          };
        },
      };
    },
    batch(statements){
      return inTransaction(sqlite,()=>statements.map(statement=>statement.run()));
    },
  };
}

async function webFiles(){
  const files=new Map();
  for(const directory of ['','brand/','vendor/']){
    const entries=await readdir(new URL(directory,WEB_ROOT),{withFileTypes:true});
    for(const entry of entries){
      if(!entry.isFile()||!/^[-\w.]+$/.test(entry.name)||entry.name.startsWith('.'))continue;
      const extension=entry.name.slice(entry.name.lastIndexOf('.'));
      const type=WEB_TYPES.get(extension);
      if(!type)continue;
      const relative=`${directory}${entry.name}`;
      files.set(`/${relative}`,{path:new URL(relative,WEB_ROOT),type});
    }
  }
  if(!files.has('/index.html'))throw new Error('The application HTML is missing.');
  return files;
}

async function readBody(message){
  if(Number(message.headers['content-length'])>MAX_BODY)return null;
  const chunks=[];
  let size=0;
  for await(const chunk of message.iterator({destroyOnReturn:false})){
    size+=chunk.length;
    if(size>MAX_BODY)return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks,size);
}

function send(response,result,headOnly=false){
  const headers=Object.fromEntries(result.headers);
  const cookies=result.headers.getSetCookie();
  if(cookies.length)headers['set-cookie']=cookies;
  response.writeHead(result.status,headers);
  if(headOnly||!result.body){
    response.end();
    return;
  }
  const body=Readable.fromWeb(result.body);
  body.on('error',()=>response.destroy());
  response.on('close',()=>body.destroy());
  body.pipe(response);
}

function errorResponse(status,message){
  return new Response(message,{status,headers:{
    'cache-control':'no-store','content-type':'text/plain; charset=utf-8',
    'x-content-type-options':'nosniff',
  }});
}

async function main(){
  const port=Number(process.env.PORT??3000);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Set PORT to an integer between 1 and 65535.');
  const hostHeader=port===80?HOST:`${HOST}:${port}`;
  const origin=`http://${hostHeader}`;
  const files=await webFiles();
  process.umask(0o077);
  await mkdir(DATA_ROOT,{recursive:true,mode:0o700});
  const sqlite=new DatabaseSync(fileURLToPath(new URL('adapt.sqlite',DATA_ROOT)),{enableForeignKeyConstraints:true});
  sqlite.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL');
  await applyMigrations(sqlite);
  const DB=databaseAdapter(sqlite);
  const accounts=createAccountsApi({
    DB,
    bootstrapOwnerEmail:process.env.ADAPT_BOOTSTRAP_OWNER_EMAIL,
    bootstrapPassword:process.env.ADAPT_BOOTSTRAP_PASSWORD,
    passwordPepper:process.env.ADAPT_PASSWORD_PEPPER,
  });
  await accounts.initialize();
  const api=createApiHandler({resolveIdentity:request=>accounts.identity(request)});

  async function handle(message){
    if(message.headers.host!==hostHeader||!message.url?.startsWith('/')||message.url.startsWith('//')){
      return errorResponse(400,'Invalid request destination.');
    }
    const url=new URL(origin+message.url);
    const method=message.method;
    if(url.pathname==='/api'||url.pathname.startsWith('/api/')){
      const options={method,headers:new Headers(message.headers)};
      if(method!=='GET'&&method!=='HEAD'){
        if(message.headers.origin!==origin||message.headers['sec-fetch-site']==='cross-site'){
          return errorResponse(403,'A same-origin request is required.');
        }
        options.body=await readBody(message);
        if(options.body===null){
          message.resume();
          return errorResponse(413,'Request too large.');
        }
      }
      const request=new Request(url,options);
      if(url.pathname==='/api/auth'||url.pathname.startsWith('/api/auth/'))return accounts.handle(request);
      return api(request,{DB});
    }
    if(method!=='GET'&&method!=='HEAD')return errorResponse(405,'Method not allowed.');
    const file=files.get(url.pathname==='/'?'/index.html':url.pathname);
    if(!file)return errorResponse(404,'Not found.');
    return new Response(method==='HEAD'?null:await readFile(file.path),{headers:{
      'content-type':file.type,
      'cache-control':file.type.startsWith('text/html')?'no-store':'no-cache',
      'referrer-policy':'same-origin',
      'x-content-type-options':'nosniff',
    }});
  }

  const server=createServer({requestTimeout:30000,headersTimeout:10000},async(message,response)=>{
    try{
      send(response,await handle(message),message.method==='HEAD');
    }catch{
      if(response.headersSent)response.destroy();
      else send(response,errorResponse(500,'Request could not be completed.'),message.method==='HEAD');
    }
  });
  server.listen(port,HOST);
  await once(server,'listening');
  console.log(`ADAPT is ready at ${origin}`);
}

try{
  await main();
}catch(error){
  const message=/^(Set |Could not initialize |The application HTML is missing)/.test(error.message)?error.message:
    error.code==='EADDRINUSE'?'This port is already in use. Set PORT to another local port.':'Could not open the local application or database.';
  console.error(message);
  process.exitCode=1;
}
