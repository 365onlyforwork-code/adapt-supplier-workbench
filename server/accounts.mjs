/** Application accounts, registration approval and server-side sessions. */
const ITERATIONS=100000,ALGORITHM='PBKDF2-SHA512-HMAC-SHA256-v1';
const SESSION_SECONDS=8*60*60,INITIAL_SESSION_SECONDS=15*60,MAX_BODY=8192;
const encoder=new TextEncoder();
const uuid=()=>crypto.randomUUID();
const prepared=(db,sql,bindings=[])=>db.prepare(sql).bind(...bindings);
const first=(db,sql,bindings=[])=>prepared(db,sql,bindings).first();
const changed=result=>Number(result?.meta?.changes??result?.changes??0);
const hex=bytes=>Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('');
const randomHex=length=>hex(crypto.getRandomValues(new Uint8Array(length)));
const digest=async value=>hex(await crypto.subtle.digest('SHA-256',encoder.encode(value)));
const accountId=()=>`acct_${uuid()}`;

class AccountError extends Error{
  constructor(status,code,message,headers={}){super(message);this.status=status;this.code=code;this.headers=headers;}
}
const fail=(status,code,message,headers)=>{throw new AccountError(status,code,message,headers);};
function json(value,status=200,extra={}){
  return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',...extra}});
}
const invalid=()=>fail(400,'INVALID_INPUT','Invalid account details.');
const username=value=>typeof value==='string'&&/^[A-Za-z0-9_.-]{3,40}$/.test(value.trim())?value.trim():null;
function name(value){
  if(typeof value!=='string'||!value.trim()||Array.from(value.trim()).length>100||/[\u0000-\u001f\u007f]/.test(value))invalid();
  return value.trim();
}
function email(value){
  if(typeof value!=='string'||value.trim().length>254||!/^[^\s@\u0000-\u001f\u007f]+@[^\s@\u0000-\u001f\u007f]+\.[^\s@\u0000-\u001f\u007f]+$/.test(value.trim()))invalid();
  return value.trim();
}
function newPassword(value){
  if(typeof value!=='string'||!value.trim()||Array.from(value).length<12||Array.from(value).length>128||value.includes('\u0000'))invalid();
  return value;
}
function safeLoginPassword(value){return typeof value==='string'&&value.length>0&&Array.from(value).length<=128&&!value.includes('\u0000');}
async function readBody(request){
  if(!request.headers.get('content-type')?.toLowerCase().includes('application/json'))fail(415,'INVALID_INPUT','Use a JSON request.');
  if(Number(request.headers.get('content-length')??0)>MAX_BODY)fail(413,'INVALID_INPUT','Account request is too large.');
  const bytes=await request.arrayBuffer();if(bytes.byteLength>MAX_BODY)fail(413,'INVALID_INPUT','Account request is too large.');
  try{const value=JSON.parse(new TextDecoder().decode(bytes));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error();return value;}
  catch{invalid();}
}
function sameOrigin(request){
  const url=new URL(request.url),origin=request.headers.get('origin');
  if(origin!==url.origin||request.headers.get('sec-fetch-site')==='cross-site')fail(403,'FORBIDDEN','A same-origin request is required.');
}
function secureTransport(request){
  const url=new URL(request.url);
  return url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]','::1'].includes(url.hostname);
}
function cookieName(request){return new URL(request.url).protocol==='https:'?'__Host-adapt_session':'adapt_session';}
function cookie(request,token,seconds){
  return `${cookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${new URL(request.url).protocol==='https:'?'; Secure':''}${seconds===0?'; Expires=Thu, 01 Jan 1970 00:00:00 GMT':''}`;
}
function sessionToken(request){
  const key=cookieName(request),matches=(request.headers.get('cookie')??'').split(';').map(part=>part.trim()).filter(part=>part.startsWith(`${key}=`));
  // Ambiguous duplicate cookies are rejected rather than accepting a shadow.
  if(matches.length!==1)return null;
  const value=matches[0].slice(key.length+1);return /^[A-Za-z0-9_-]{43}$/.test(value)?value:null;
}
function makeToken(){return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function constantEqual(left,right){
  if(typeof left!=='string'||typeof right!=='string'||left.length!==64||right.length!==64)return false;
  let difference=0;for(let index=0;index<64;index++)difference|=left.charCodeAt(index)^right.charCodeAt(index);return difference===0;
}
function saltBytes(salt){
  if(typeof salt!=='string'||!/^[0-9a-f]{32}$/.test(salt))throw new Error('Invalid password salt.');
  return Uint8Array.from(salt.match(/../g),value=>parseInt(value,16));
}
async function passwordHash(password,salt,pepperKey){
  const material=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  const derived=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-512',salt:saltBytes(salt),iterations:ITERATIONS},material,512);
  return hex(await crypto.subtle.sign('HMAC',pepperKey,derived));
}
function userDTO(row){return {id:row.user_id,username:row.username,name:row.name,email:row.email,role:row.role,mustChangePassword:!!row.must_change_password};}
function registrationDTO(row){return {id:row.id,username:row.username,name:row.name,email:row.email,createdAt:row.created_at,status:row.status,reviewedAt:row.reviewed_at??null};}

/** now may return milliseconds, a Date or an ISO timestamp. No request may set it. */
export function createAccountsApi({DB,now=()=>Date.now(),bootstrapOwnerEmail,bootstrapPassword,passwordPepper}={}){
  const db=DB;
  let pepperPromise=null;
  const dummySalt=randomHex(16);
  function clock(){const value=new Date(now()).getTime();if(!Number.isFinite(value))throw new Error('Invalid account clock.');return value;}
  function available(){
    if(!db||typeof db.prepare!=='function'||typeof db.batch!=='function'||typeof passwordPepper!=='string'||passwordPepper.length<32||passwordPepper.length>4096)fail(503,'AUTH_UNAVAILABLE','Account service is unavailable.');
  }
  function pepper(){available();return pepperPromise??=crypto.subtle.importKey('raw',encoder.encode(passwordPepper),{name:'HMAC',hash:'SHA-256'},false,['sign']);}
  async function hash(password,salt){return passwordHash(password,salt,await pepper());}
  async function verify(password,row){
    const supported=row?.password_algorithm===ALGORITHM&&row?.password_iterations===ITERATIONS;
    const calculated=await hash(password,supported?row.password_salt:dummySalt);
    return supported&&constantEqual(calculated,row.password_hash);
  }
  async function initialize(){
    if(typeof passwordPepper!=='string'||passwordPepper.length<32||passwordPepper.length>4096){
      throw new Error('Set ADAPT_PASSWORD_PEPPER to a secret between 32 and 4096 characters.');
    }
    available();
    if(await first(db,'SELECT id FROM auth_accounts WHERE is_bootstrap=1'))return;
    let address,password;
    try{
      address=email(bootstrapOwnerEmail);
      password=newPassword(bootstrapPassword);
    }catch{
      throw new Error('Set ADAPT_BOOTSTRAP_OWNER_EMAIL and a 12–128 character ADAPT_BOOTSTRAP_PASSWORD for initial setup.');
    }
    const emailKey=address.toLowerCase(),id=accountId(),displayName='Administrator';
    const salt=randomHex(16),hashed=await hash(password,salt),at=new Date(clock()).toISOString();
    await db.batch([
      prepared(db,`INSERT OR IGNORE INTO users (id,email,email_key,name,created_at,last_seen_at)
        SELECT ?,?,?,?,?,? WHERE NOT EXISTS (SELECT 1 FROM auth_accounts WHERE is_bootstrap=1)`,
      [id,address,emailKey,displayName,at,at]),
      prepared(db,`INSERT OR IGNORE INTO auth_accounts
        (id,user_id,username,username_key,name,email,email_key,password_hash,password_salt,password_algorithm,password_iterations,password_version,status,role,is_bootstrap,must_change_password,created_at,updated_at,reviewed_at,reviewed_by,last_operation_id)
        SELECT id,id,'admin','admin',name,email,email_key,?,?,?,?,1,'approved','admin',1,0,?,?,?,id,? FROM users WHERE id=?`,
      [hashed,salt,ALGORITHM,ITERATIONS,at,at,at,uuid(),id]),
    ]);
    if(!await first(db,'SELECT id FROM auth_accounts WHERE is_bootstrap=1')){
      throw new Error('Could not initialize the administrator account.');
    }
  }
  async function rateLimit(scope,subject=''){
    const at=clock();
    await prepared(db,'DELETE FROM auth_rate_limits WHERE expires_at<=?',[at]).run();
    const rules=scope==='login'?[['login-total','local',15*60,30],['login-name',subject,15*60,10]]:scope==='register'?[['register-total','local',60*60,8]]:[['password-session',subject,15*60,8]];
    for(const [prefix,key,seconds,limit]of rules){
      const start=Math.floor(at/(seconds*1000))*seconds*1000,expires=start+seconds*1000;
      const bucket=`${prefix}:${start}:${await digest(key)}`;
      const count=await first(db,`INSERT INTO auth_rate_limits (bucket_key,attempts,expires_at) VALUES (?,1,?)
        ON CONFLICT(bucket_key) DO UPDATE SET attempts=attempts+1 RETURNING attempts`,[bucket,expires]);
      if(count.attempts>limit)fail(429,'RATE_LIMITED','Too many attempts. Try again later.',{'retry-after':String(Math.max(1,Math.ceil((expires-at)/1000)))});
    }
  }
  async function session(request){
    const token=sessionToken(request);if(!token||!secureTransport(request))return null;
    const tokenHash=await digest(token),at=clock();
    const row=await first(db,`SELECT a.*,s.token_hash,s.password_version AS session_password_version,s.expires_at
      FROM auth_sessions s JOIN auth_accounts a ON a.id=s.account_id
      WHERE s.token_hash=? AND s.expires_at>? AND a.status='approved' AND a.user_id IS NOT NULL AND s.password_version=a.password_version`,[tokenHash,at]);
    return row?{...row,tokenHash}:null;
  }
  async function authenticated(request,{admin=false,allowPasswordChange=false}={}){
    const row=await session(request);if(!row)fail(401,'UNAUTHENTICATED','Sign in to continue.');
    if(row.must_change_password&&!allowPasswordChange)fail(403,'PASSWORD_CHANGE_REQUIRED','Change the initial password first.');
    if(admin&&row.role!=='admin')fail(403,'FORBIDDEN','Administrator access is required.');
    return row;
  }
  function sessionGuard(row,at){
    return {sql:`EXISTS (SELECT 1 FROM auth_sessions gate JOIN auth_accounts actor ON actor.id=gate.account_id
      WHERE gate.token_hash=? AND gate.expires_at>? AND gate.password_version=actor.password_version
      AND actor.id=? AND actor.status='approved' AND actor.must_change_password=0 AND actor.role='admin')`,bindings:[row.tokenHash,at,row.id]};
  }
  async function issue(request,row){
    const at=clock(),seconds=row.must_change_password?INITIAL_SESSION_SECONDS:SESSION_SECONDS,token=makeToken(),tokenHash=await digest(token);
    const results=await db.batch([
      prepared(db,'DELETE FROM auth_sessions WHERE expires_at<=?',[at]),
      prepared(db,`INSERT INTO auth_sessions (token_hash,account_id,password_version,created_at,expires_at)
        SELECT ?,id,password_version,?,? FROM auth_accounts WHERE id=? AND status='approved' AND password_version=? AND password_hash=?`,[tokenHash,at,at+seconds*1000,row.id,row.password_version,row.password_hash]),
      prepared(db,`DELETE FROM auth_sessions WHERE account_id=? AND id NOT IN
        (SELECT id FROM auth_sessions WHERE account_id=? ORDER BY id DESC LIMIT 8)`,[row.id,row.id]),
    ]);
    if(!changed(results[1]))fail(401,'INVALID_CREDENTIALS','Invalid username or password.');
    return json({user:userDTO(row)},200,{'set-cookie':cookie(request,token,seconds)});
  }

  async function route(request){
    const url=new URL(request.url),path=url.pathname;
    if(!path.startsWith('/api/auth/'))return null;
    available();if(!secureTransport(request))fail(503,'AUTH_UNAVAILABLE','HTTPS is required.');
    if(!['GET','POST'].includes(request.method))return json({error:{code:'NOT_FOUND',message:'Account endpoint not found.'}},405,{allow:'GET, POST'});
    if(request.method==='POST')sameOrigin(request);
    if(path==='/api/auth/session'&&request.method==='GET'){
      const current=await session(request);return json({user:current?userDTO(current):null});
    }
    if(path==='/api/auth/logout'&&request.method==='POST'){
      const token=sessionToken(request);
      if(token)await prepared(db,'DELETE FROM auth_sessions WHERE token_hash=?',[await digest(token)]).run();
      return json({signedOut:true},200,{'set-cookie':cookie(request,'',0)});
    }
    if(path==='/api/auth/login'&&request.method==='POST'){
      const input=await readBody(request),loginName=username(input.username),key=loginName?.toLowerCase()??'';
      await rateLimit('login',key);
      if(!loginName||!safeLoginPassword(input.password))fail(401,'INVALID_CREDENTIALS','Invalid username or password.');
      const row=await first(db,'SELECT * FROM auth_accounts WHERE username_key=?',[key]);
      if(!await verify(input.password,row))fail(401,'INVALID_CREDENTIALS','Invalid username or password.');
      if(row.status==='pending')fail(403,'ACCOUNT_PENDING','Registration is awaiting administrator approval.');
      if(row.status==='rejected')fail(403,'ACCOUNT_REJECTED','Registration was not approved.');
      if(row.status!=='approved'||!row.user_id)fail(401,'INVALID_CREDENTIALS','Invalid username or password.');
      return issue(request,row);
    }
    if(path==='/api/auth/register'&&request.method==='POST'){
      await rateLimit('register');
      const input=await readBody(request),loginName=username(input.username);if(!loginName)invalid();
      const profile={username:loginName,name:name(input.name),email:email(input.email)},key=loginName.toLowerCase(),emailKey=profile.email.toLowerCase();
      const password=newPassword(input.password);
      if(key==='admin'||await first(db,'SELECT id FROM auth_accounts WHERE username_key=? OR email_key=?',[key,emailKey])
        ||await first(db,'SELECT id FROM users WHERE email_key=?',[emailKey]))fail(409,'ACCOUNT_UNAVAILABLE','Account details are unavailable.');
      const id=accountId(),salt=randomHex(16),hashed=await hash(password,salt),at=new Date(clock()).toISOString();
      try{await prepared(db,`INSERT INTO auth_accounts
        (id,username,username_key,name,email,email_key,password_hash,password_salt,password_algorithm,password_iterations,password_version,status,role,is_bootstrap,must_change_password,created_at,updated_at,last_operation_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,1,'pending','user',0,0,?,?,?)`,[id,profile.username,key,profile.name,profile.email,emailKey,hashed,salt,ALGORITHM,ITERATIONS,at,at,uuid()]).run();}
      catch(error){if(/UNIQUE constraint|SQLITE_CONSTRAINT|constraint failed/i.test(String(error?.message)))fail(409,'ACCOUNT_UNAVAILABLE','Account details are unavailable.');throw error;}
      return json({registration:registrationDTO(await first(db,'SELECT * FROM auth_accounts WHERE id=?',[id]))},202);
    }
    if(path==='/api/auth/change-password'&&request.method==='POST'){
      const current=await authenticated(request,{allowPasswordChange:true});
      if(!current.must_change_password)fail(403,'FORBIDDEN','This session does not require an initial password change.');
      await rateLimit('password',current.id);
      const input=await readBody(request),password=newPassword(input.password);
      if(await verify(password,current))fail(400,'PASSWORD_REUSE','Choose a different password.');
      const salt=randomHex(16),hashed=await hash(password,salt),token=makeToken(),tokenHash=await digest(token),at=clock(),stamp=new Date(at).toISOString(),operation=uuid(),version=current.password_version+1;
      const results=await db.batch([
        prepared(db,`UPDATE auth_accounts SET password_hash=?,password_salt=?,password_algorithm=?,password_iterations=?,password_version=password_version+1,must_change_password=0,updated_at=?,last_operation_id=?
          WHERE id=? AND status='approved' AND password_version=? AND EXISTS
          (SELECT 1 FROM auth_sessions WHERE token_hash=? AND account_id=? AND expires_at>? AND password_version=?)`,
        [hashed,salt,ALGORITHM,ITERATIONS,stamp,operation,current.id,current.password_version,current.tokenHash,current.id,at,current.password_version]),
        prepared(db,`DELETE FROM auth_sessions WHERE account_id=? AND EXISTS
          (SELECT 1 FROM auth_accounts WHERE id=? AND last_operation_id=? AND password_version=?)`,[current.id,current.id,operation,version]),
        prepared(db,`INSERT INTO auth_sessions (token_hash,account_id,password_version,created_at,expires_at)
          SELECT ?,id,password_version,?,? FROM auth_accounts WHERE id=? AND last_operation_id=? AND password_version=?`,[tokenHash,at,at+SESSION_SECONDS*1000,current.id,operation,version]),
      ]);
      if(!changed(results[0])||!changed(results[2]))fail(401,'UNAUTHENTICATED','The session changed. Sign in again.');
      const updated=await first(db,'SELECT * FROM auth_accounts WHERE id=?',[current.id]);
      return json({user:userDTO(updated)},200,{'set-cookie':cookie(request,token,SESSION_SECONDS)});
    }
    if(path==='/api/auth/registrations'&&request.method==='GET'){
      await authenticated(request,{admin:true});
      const status=url.searchParams.get('status')??'all';if(!['all','pending','approved','rejected'].includes(status))invalid();
      const result=await prepared(db,`SELECT * FROM auth_accounts WHERE is_bootstrap=0${status==='all'?'':' AND status=?'} ORDER BY (status='pending') DESC,created_at DESC,id DESC LIMIT 100`,status==='all'?[]:[status]).all();
      return json({registrations:(result.results??[]).map(registrationDTO)});
    }
    const decision=path.match(/^\/api\/auth\/registrations\/([A-Za-z0-9_-]{1,100})\/(approve|reject)$/);
    if(decision&&request.method==='POST'){
      const admin=await authenticated(request,{admin:true}),id=decision[1],target=await first(db,'SELECT * FROM auth_accounts WHERE id=? AND is_bootstrap=0',[id]);
      if(!target)fail(404,'NOT_FOUND','Registration not found.');
      const status=decision[2]==='approve'?'approved':'rejected';
      if(target.status===status)return json({registration:registrationDTO(target)});
      if(target.status!=='pending')fail(409,'REGISTRATION_RESOLVED','Registration has already been reviewed.');
      const at=clock(),stamp=new Date(at).toISOString(),operation=uuid(),guard=sessionGuard(admin,at),statements=[];
      if(status==='approved')statements.push(prepared(db,`INSERT OR IGNORE INTO users (id,email,email_key,name,created_at,last_seen_at)
        SELECT id,email,email_key,name,?,? FROM auth_accounts WHERE id=? AND status='pending' AND legacy_user_id IS NULL AND ${guard.sql}`,[stamp,stamp,id,...guard.bindings]));
      statements.push(prepared(db,`UPDATE auth_accounts SET status=?,user_id=${status==='approved'?'COALESCE(legacy_user_id,id)':'NULL'},reviewed_at=?,reviewed_by=?,updated_at=?,last_operation_id=?
        WHERE id=? AND status='pending' AND ${guard.sql}${status==='approved'?' AND EXISTS (SELECT 1 FROM users WHERE users.id=COALESCE(auth_accounts.legacy_user_id,auth_accounts.id) AND users.email_key=auth_accounts.email_key)':''}`,[status,stamp,admin.user_id,stamp,operation,id,...guard.bindings]));
      await db.batch(statements);
      const latest=await first(db,'SELECT * FROM auth_accounts WHERE id=?',[id]);
      if(latest.status!==status){
        await authenticated(request,{admin:true});
        if(latest.status==='pending')fail(409,'ACCOUNT_UNAVAILABLE','Account details are unavailable.');
        fail(409,'REGISTRATION_RESOLVED','Registration has already been reviewed.');
      }
      return json({registration:registrationDTO(latest)});
    }
    return json({error:{code:'NOT_FOUND',message:'Account endpoint not found.'}},404);
  }

  return {
    initialize,
    async handle(request){
      try{return await route(request);}
      catch(error){
        if(error instanceof AccountError)return json({error:{code:error.code,message:error.message}},error.status,error.headers);
        return json({error:{code:'AUTH_UNAVAILABLE',message:'Account service is unavailable.'}},503);
      }
    },
    async identity(request){
      try{available();const row=await session(request);if(!row||row.must_change_password)return null;const user=userDTO(row);delete user.mustChangePassword;return user;}
      catch{return null;}
    },
  };
}
