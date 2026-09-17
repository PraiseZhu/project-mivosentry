import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {Readable,Writable} from 'node:stream';
import {fileURLToPath} from 'node:url';
import {runProtocol} from '../../scripts/scheduler/nightly-script.mjs';
import {TASK,SCHEDULE_ID,verifyBusiness,managedNightly,sha,fixedEnv} from '../../scripts/scheduler/managed-nightly.mjs';
const require=createRequire(import.meta.url);
const ts=require(path.join(TASK,'plugin-runtime/node_modules/typescript'));
if(!process.env.CINDY_SOURCE_ROOT)throw Error('CINDY_SOURCE_ROOT required for actual host contract tests');
const hostRoot=path.join(process.env.CINDY_SOURCE_ROOT,'apps/desktop/src/main/scheduler-host');
// Real host implementation + real process management. Only unused DB/hook dependencies are stubs.
function loadHost(file){
  const source=fs.readFileSync(path.join(hostRoot,file),'utf8');
  const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{}};
  const customRequire=name=>{
    if(name.startsWith('node:'))return require(name);
    if(name==='./proc-util')return loadHost('proc-util.ts');
    if(name==='drizzle-orm')return {eq:()=>{throw Error('DB not allowed');}};
    if(name==='../localDb/schema')return {sessions:{}};
    if(name==='./pre-run-hook')return new Proxy({}, {get:()=>()=>{throw Error('hook not allowed');}});
    throw Error('unmocked dependency '+name);
  };
  vm.runInThisContext('(function(require,module,exports){'+code+'\n})',{filename:file})(customRequire,module,module.exports);
  return module.exports;
}
const {ScriptScheduleRunner}=loadHost('script-runner.ts');
const child=fileURLToPath(new URL('./protocol-child.mjs',import.meta.url));
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
// The host strips inherited custom env; production commands must pass these explicitly too.
const runtimeEnv='MIVO_NIGHTLY_TASK_ROOT='+quote(TASK)+' MIVO_NIGHTLY_CONFIG='+quote(process.env.MIVO_NIGHTLY_CONFIG)+' MIVO_NIGHTLY_DEPENDENCY_STATE='+quote(process.env.MIVO_NIGHTLY_DEPENDENCY_STATE)+' ';
for(const [status,exit]of Object.entries({completed:0,partial:5,blocked:6,failed:2})){
  test('real host terminal semantics '+status,async()=>{
    let calls=0;const notifications=[];
    const host=new ScriptScheduleRunner({broker:{call:async()=>{calls++;throw Error('capabilities forbidden');}},logger:{},notifier:{notify:async(_s,r)=>notifications.push(r)}});
    const schedule={id:SCHEDULE_ID,name:'MivoSentry 夜巡 02:30',executionMode:'script',workspaceKind:'project',workingDir:TASK,useWorktree:false,persistentSession:false,silentWhenIdle:true,scriptConfig:{command:runtimeEnv+quote(process.execPath)+' '+quote(child)+' '+status,capabilities:[],timeoutMs:10000}};
    const run=host.fire(schedule,{runId:'host-fixture-'+status,firedAt:Date.now(),signal:new AbortController().signal});
    if(exit===0){const result=await run;assert.match(result.resultText,/夜巡审计已完成/);assert.equal(notifications[0].status,'success');}
    else{await assert.rejects(run,new RegExp('code '+exit+': '+status));assert.equal(notifications[0].status,'failed');}
    assert.equal(calls,0);
  });
}
test('no host refuses without executing business',()=>{const env={...process.env};delete env.CINDY_SCRIPT_PROTOCOL;delete env.XDT_MAKER_SCRIPT_PROTOCOL;const r=spawnSync(process.execPath,[child,'completed'],{env,encoding:'utf8'});assert.equal(r.status,2);assert.equal(r.stdout,'');assert.match(r.stderr,/host required/);});
test('wrong task identity never executes business',async()=>{let ran=false;let error='';const result=await runProtocol({input:Readable.from([JSON.stringify({protocol:'cindy-script/1',type:'start',context:{scheduleId:'wrong',runId:'x',workingDir:TASK}})+'\n']),output:new Writable({write(_c,_e,cb){cb();}}),error:{write:s=>{error+=s;}},env:{CINDY_SCRIPT_PROTOCOL:'1'},run:async()=>{ran=true;}});assert.equal(result,2);assert.equal(ran,false);assert.match(error,/identity/);});
function business(status='completed'){
  const result={status,runId:'fixture',scanDate:'2026-09-17'};
  const artifacts={findings:{path:'a',sha256:'a'.repeat(64)},report:{path:'b',sha256:'b'.repeat(64)}};
  const receipt={...result,finishedAt:'2026-09-17T01:00:00Z',repo:'/fixture',commit:'c'.repeat(40),artifacts,steps:[{name:'g1',exitCode:0},{name:'g2-dry-run',exitCode:0}]};
  return {exit:{completed:0,partial:5,blocked:6,failed:2}[status],result,receipt,health:{lastRunId:'fixture',status},manifest:{...receipt,valid:true,dimensions:[{bucket:status==='partial'?'n_a':'ok'}]}};
}
for(const status of ['completed','partial','blocked','failed'])test('business status preserved '+status,()=>assert.equal(verifyBusiness(business(status)),status));
for(const kind of ['hash','unfinished','wrong-run','wrong-exit','missing-g2'])test('reject invalid business '+kind,()=>{const b=business();if(kind==='hash')b.receipt={...b.receipt,artifacts:{}};if(kind==='unfinished')b.receipt.finishedAt=null;if(kind==='wrong-run')b.health.lastRunId='old';if(kind==='wrong-exit')b.exit=5;if(kind==='missing-g2')b.receipt.steps.pop();assert.throws(()=>verifyBusiness(b));});
test('fixed PATH TZ and local cache/temp',()=>{const e=fixedEnv();assert.equal(e.TZ,'Asia/Shanghai');assert.equal(e.PATH,'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin');assert.ok(e.TMPDIR.startsWith(TASK+'/'));assert.ok(e.npm_config_cache.startsWith(TASK+'/'));});

for(const failure of ['wrong-root','wrong-origin','dirty','fetch','ff-only','dependency-load','install-failed','install-timeout','missing-dependency-baseline'])test('managed sync failure stops before audit: '+failure,async t=>{
  const release=fs.mkdtempSync(path.join(TASK,'releases/test-sync-'));t.after(()=>fs.rmSync(release,{recursive:true,force:true}));
  const source=path.join(release,'source');fs.mkdirSync(source);const target=path.join(TASK,'plugin-runtime');
  const config={accepted:true,release,target,revision:'a'.repeat(40),contentSha256:sha('[]')};
  const configPath=path.join(release,'config.json');fs.writeFileSync(configPath,JSON.stringify(config));fs.writeFileSync(path.join(release,'release-manifest.json'),JSON.stringify({contentSha256:sha('[]'),files:[]}));
  const dependencyStatePath=path.join(release,'dependency.json');
  if(failure!=='missing-dependency-baseline')fs.writeFileSync(dependencyStatePath,JSON.stringify({target,lockSha256:failure.startsWith('install-')?'old-lock':sha(fs.readFileSync(path.join(target,'package-lock.json')))}));
  const commands=[];
  const run=(cmd,args,opt)=>{commands.push([cmd,...args]);let stdout='';let status=0;
    if(cmd==='git'){
      const key=args.join(' ');
      if(key==='rev-parse --show-toplevel')stdout=failure==='wrong-root'&&opt.cwd===target?TASK:opt.cwd;
      else if(key==='rev-parse HEAD'||key==='rev-parse FETCH_HEAD')stdout='a'.repeat(40);
      else if(key==='remote get-url origin')stdout=opt.cwd===source?path.join(release,'frozen-origin.git'):(failure==='wrong-origin'?'bad':'https://github.com/xindong/mivo-canvas-plugin.git');
      else if(key==='branch --show-current')stdout='main';
      else if(key==='status --porcelain')stdout=failure==='dirty'&&opt.cwd===target?'?? unknown':'';
      else if(key==='fetch origin main'&&failure==='fetch')status=128;
      else if(args[0]==='merge'&&failure==='ff-only')status=128;
    }else if(cmd===process.execPath)status=failure==='dependency-load'?1:0;
    else if(cmd==='npm'){assert.deepEqual(args,['ci','--ignore-scripts','--no-audit','--no-fund']);status=failure==='install-timeout'?null:1;}
    else throw Error('unexpected child command: '+cmd);
    return {status,stdout,stderr:status?'fixture failure':'',error:null};
  };
  const result=await managedNightly({runId:'mock-sync'},{run,configPath,dependencyStatePath});assert.equal(result.exit,2);assert.equal(result.status,'failed');assert.equal(commands.some(c=>c[0]==='/bin/sh'),false);
  if(!failure.startsWith('install-'))assert.equal(commands.some(c=>c[0]==='npm'),false);
  if(failure.startsWith('install-'))assert.match(result.reason,/locked-dependencies/);
  if(failure==='fetch')assert.match(result.reason,/fetch-main/);if(failure==='ff-only')assert.match(result.reason,/fast-forward/);if(failure==='dependency-load')assert.match(result.reason,/dependency-load/);
});

test('existing managed lock blocks without executing child commands',async t=>{
  const lock=path.join(TASK,'.managed-nightly.lock');assert.equal(fs.existsSync(lock),false);fs.mkdirSync(lock);t.after(()=>fs.rmdirSync(lock));
  let calls=0;const result=await managedNightly({runId:'mock-lock'},{run:()=>{calls++;throw Error('must not execute');}});
  assert.equal(calls,0);assert.equal(result.exit,6);assert.equal(result.status,'blocked');assert.equal(fs.existsSync(lock),true);
});

test('actual scheduler rejects preserved silentWhenIdle in script mode',()=>{
  const source=fs.readFileSync(path.join(process.env.CINDY_SOURCE_ROOT,'packages/maker-scheduler/src/engine/scheduler.ts'),'utf8');
  const start=source.indexOf('function validateScheduleExecutionShape('),end=source.indexOf('export interface SchedulerOptions',start);
  assert.ok(start>=0&&end>start);
  const code=ts.transpileModule(source.slice(start,end)+'\n(globalThis as any).validateShape = validateScheduleExecutionShape;',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const context={};vm.runInNewContext(code,context);
  const value={executionMode:'script',scriptConfig:{command:'node adapter.mjs'},workspaceKind:'project',workingDir:TASK,useWorktree:false,persistentSession:false,silentWhenIdle:true};
  assert.throws(()=>context.validateShape(value),/script execution does not support silentWhenIdle/);
  assert.doesNotThrow(()=>context.validateShape({...value,silentWhenIdle:false}));
});
