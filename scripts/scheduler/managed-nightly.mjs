import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
if(!process.env.MIVO_NIGHTLY_TASK_ROOT || !path.isAbsolute(process.env.MIVO_NIGHTLY_TASK_ROOT))throw Error('MIVO_NIGHTLY_TASK_ROOT must be an explicit absolute runtime directory');
export const TASK=fs.realpathSync(process.env.MIVO_NIGHTLY_TASK_ROOT);
export const SCHEDULE_ID='e6eb4be5-9aff-4c93-aa81-f05af3b86438';
export const sha=b=>createHash('sha256').update(b).digest('hex');
const json=p=>JSON.parse(fs.readFileSync(p,'utf8'));
function save(p,value){const tmp=p+'.tmp-'+process.pid;fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});fs.renameSync(tmp,p);}
export function fixedEnv(){return {...process.env,PATH:'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',TZ:'Asia/Shanghai',GIT_OPTIONAL_LOCKS:'0',npm_config_cache:path.join(TASK,'npm-cache'),TMPDIR:path.join(TASK,'install-tmp')};}
function execute(command,args,options){const r=spawnSync(command,args,{encoding:'utf8',maxBuffer:64*1024*1024,...options});return {status:r.status,stdout:r.stdout||'',stderr:r.stderr||'',error:r.error?.message||null};}
export function verifyBusiness({exit,result,receipt,health,manifest}) {
  const exits={completed:0,partial:5,blocked:6,failed:2};
  if(!Object.hasOwn(exits,result.status)||exits[result.status]!==exit)throw Error('runner exit/status mismatch');
  if(!receipt.finishedAt||receipt.runId!==result.runId||receipt.status!==result.status||receipt.scanDate!==result.scanDate)throw Error('unfinished or mismatched business receipt');
  if(health.lastRunId!==result.runId||health.status!==result.status)throw Error('health does not belong to this run');
  if(exit===0||exit===5){
    if(!manifest||!manifest.valid||manifest.status!==result.status||manifest.runId!==result.runId||manifest.commit!==receipt.commit||manifest.repo!==receipt.repo)throw Error('manifest identity mismatch');
    for(const name of ['findings','report'])if(!receipt.artifacts?.[name]?.sha256||receipt.artifacts[name].sha256!==manifest.artifacts?.[name]?.sha256)throw Error('receipt artifact hash missing or mismatched: '+name);
    for(const step of ['g1','g2-dry-run'])if(!receipt.steps.some(s=>s.name.startsWith(step)&&s.exitCode===0))throw Error('missing successful G1/G2');
    if(exit===0&&(!manifest.dimensions.length||manifest.dimensions.some(d=>d.bucket!=='ok')))throw Error('completed with incomplete dimensions');
  }
  return result.status;
}

// The config is pinned per accepted release; no dirty source copying at runtime.
export async function managedNightly(context,{run=execute,configPath=process.env.MIVO_NIGHTLY_CONFIG,dependencyStatePath=process.env.MIVO_NIGHTLY_DEPENDENCY_STATE}={}) {
  if(!configPath||!dependencyStatePath||!path.isAbsolute(configPath)||!path.isAbsolute(dependencyStatePath))throw Error('explicit absolute config and dependency state paths required');
  const config=json(configPath);
  if(config.accepted!==true)throw Error('release not independently accepted');
  const release=config.release,source=path.join(release,'source'),target=config.target;
  if(!release.startsWith(TASK+'/releases/')||target!==path.join(TASK,'plugin-runtime'))throw Error('unapproved runtime path');
  const env=fixedEnv(),state=path.join(release,'state'),out=path.join(release,'reports');
  const lock=path.join(TASK,'.managed-nightly.lock');
  const id=new Date().toISOString().replaceAll(':','-')+'-'+randomUUID();
  const evidence=path.join(release,'managed-runs',id);fs.mkdirSync(evidence,{recursive:true});
  const record={schemaVersion:1,id,hostRunId:context.runId,startedAt:new Date().toISOString(),finishedAt:null,status:'failed',exit:2,stage:'initializing',candidateRevision:config.revision,steps:[]};
  const persist=()=>save(path.join(evidence,'receipt.json'),record);persist();let locked=false;
  function command(stage,cmd,args,cwd,timeout=120000){record.stage=stage;persist();const r=run(cmd,args,{cwd,env,timeout});const prefix=String(record.steps.length+1)+'-'+stage;fs.writeFileSync(path.join(evidence,prefix+'.stdout.txt'),r.stdout);fs.writeFileSync(path.join(evidence,prefix+'.stderr.txt'),r.stderr);record.steps.push({stage,exit:r.status,error:r.error});persist();return r;}
  function checked(stage,cmd,args,cwd,timeout){const r=command(stage,cmd,args,cwd,timeout);if(r.status!==0)throw Error(stage+' failed, exit='+r.status);return r.stdout.trim();}
  const git=(stage,args,cwd)=>checked(stage,'git',args,cwd);
  const assert=(condition,message)=>{if(!condition)throw Error(message);};
  try{
    try{fs.mkdirSync(lock);locked=true;}catch{record.status='blocked';record.exit=6;throw Error('managed run active or stale lock; inspect before retry');}
    assert(!fs.existsSync(path.join(state,'.nightly-runner.lock')),'runner lock present before maintenance');
    const inventory=json(path.join(release,'release-manifest.json'));
    assert(inventory.contentSha256===config.contentSha256&&sha(JSON.stringify(inventory.files))===config.contentSha256,'release inventory hash mismatch');
    for(const f of inventory.files){assert(!path.isAbsolute(f.path)&&!f.path.split('/').includes('..'),'release path escapes');assert(sha(fs.readFileSync(path.join(source,f.path)))===f.sha256,'release changed: '+f.path);}
    assert(git('release-root',['rev-parse','--show-toplevel'],source)===fs.realpathSync(source),'release root mismatch');
    assert(git('release-head',['rev-parse','HEAD'],source)===config.revision,'candidate revision changed');
    assert(git('release-clean',['status','--porcelain'],source)==='','release dirty');
    assert(git('release-origin',['remote','get-url','origin'],source)===path.join(release,'frozen-origin.git'),'release origin mismatch');
    assert(git('target-root',['rev-parse','--show-toplevel'],target)===fs.realpathSync(target),'target root mismatch');
    assert(git('target-origin',['remote','get-url','origin'],target)==='https://github.com/xindong/mivo-canvas-plugin.git','target origin mismatch');
    assert(git('target-branch',['branch','--show-current'],target)==='main','target not main');
    assert(git('target-clean',['status','--porcelain'],target)==='','target dirty');
    const lockBefore=sha(fs.readFileSync(path.join(target,'package-lock.json')));
    git('fetch-main',['fetch','origin','main'],target);
    const remote=git('fetched-head',['rev-parse','FETCH_HEAD'],target);
    git('fast-forward',['merge','--ff-only',remote],target);
    assert(git('target-head',['rev-parse','HEAD'],target)===remote,'target differs from fetched main');
    record.targetSha=remote;record.syncedAt=new Date().toISOString();
    const lockAfter=sha(fs.readFileSync(path.join(target,'package-lock.json')));record.lockBefore=lockBefore;record.lockAfter=lockAfter;
    const dependencyReceipt=dependencyStatePath;
    const prior=fs.existsSync(dependencyReceipt)?json(dependencyReceipt):null;
    if(!prior)throw Error('missing approved dependency baseline; prepare before scheduling');
    if(lockBefore!==lockAfter||prior.target!==target||prior.lockSha256!==lockAfter){
      fs.mkdirSync(env.npm_config_cache,{recursive:true});fs.mkdirSync(env.TMPDIR,{recursive:true});
      checked('locked-dependencies','npm',['ci','--ignore-scripts','--no-audit','--no-fund'],target,600000);
      assert(sha(fs.readFileSync(path.join(target,'package-lock.json')))===lockAfter,'npm changed lockfile');
      save(dependencyReceipt,{target,lockSha256:lockAfter,installedAt:new Date().toISOString(),ignoreScripts:true});
    }
    checked('dependency-load',process.execPath,['-e',"for(const p of ['sharp','typescript','hono'])require(p)"],target);
    const snapshot=()=>({head:git('audit-head',['rev-parse','HEAD'],target),status:git('audit-clean',['status','--porcelain'],target),trackedHash:sha(git('audit-files',['ls-files','-z'],target).split(String.fromCharCode(0)).filter(Boolean).sort().map(p=>p+':'+sha(fs.readFileSync(path.join(target,p)))).join('\n'))});
    const before=snapshot();assert(before.status==='','target dirty before audit');record.auditBefore=before;persist();
    const r=command('nightly-runner','/bin/sh',[path.join(source,'scripts/audit/nightly-runner.sh'),'--repo',target,'--issue-repo','xindong/mivo-canvas-plugin','--state-dir',state,'--out-dir',out],release,2400000);
    const after=snapshot();record.auditAfter=after;assert(JSON.stringify(before)===JSON.stringify(after),'target changed during audit');
    const result=JSON.parse(r.stdout.trim().split('\n').filter(Boolean).at(-1)||'null');
    assert(result&&/^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-f0-9-]+$/.test(result.runId),'missing runner identity');
    const receiptPath=path.join(state,'nightly-runs',result.runId,'receipt.json');assert(result.receiptPath===receiptPath,'runner receipt path mismatch');
    const receipt=json(receiptPath),health=json(path.join(state,'nightly-health.json'));let manifest=null;
    if(r.status===0||r.status===5){const {validateManifest}=await import(pathToFileURL(path.join(source,'scripts/audit/run-contract.mjs')));manifest=validateManifest(path.join(state,'manifest-'+result.scanDate+'.json'),{scanDate:result.scanDate,runId:result.runId,repo:target,commit:remote,outputRoots:[state,out]});}
    const status=verifyBusiness({exit:r.status,result,receipt,health,manifest});
    assert(git('release-final',['rev-parse','HEAD'],source)===config.revision,'release changed during self-sync');
    record.status=status;record.exit=r.status;record.businessRunId=result.runId;record.businessReceipt=receiptPath;record.reason=result.reason;
  }catch(error){if(record.status!=='blocked'){record.status='failed';record.exit=2;}record.reason=error.message;}
  finally{record.finishedAt=new Date().toISOString();persist();if(locked)fs.rmdirSync(lock);}
  return {...record,evidence};
}
