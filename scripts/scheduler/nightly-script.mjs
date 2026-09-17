import {createInterface} from 'node:readline';
import {pathToFileURL} from 'node:url';
import {managedNightly,TASK,SCHEDULE_ID} from './managed-nightly.mjs';
export async function runProtocol({input=process.stdin,output=process.stdout,error=process.stderr,env=process.env,run=managedNightly,workingDir=TASK}={}){
  if(env.CINDY_SCRIPT_PROTOCOL!=='1'&&env.XDT_MAKER_SCRIPT_PROTOCOL!=='1'){error.write('failed: Cindy script host required; no work executed\n');return 2;}
  const reader=createInterface({input});
  try{
    const first=await Promise.race([(async()=>{for await(const line of reader){if(line.trim())return JSON.parse(line);}throw Error('host closed before start');})(),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('host start timeout')),5000);timer.unref();})]);
    if(!['cindy-script/1','xdt-maker-script/1'].includes(first.protocol)||first.type!=='start'||first.context?.scheduleId!==SCHEDULE_ID||typeof first.context.runId!=='string'||!first.context.runId||first.context.workingDir!==workingDir)throw Error('invalid host/schedule/working-directory identity');
    const r=await run(first.context);
    if(!['completed','partial','blocked','failed'].includes(r.status)||({completed:0,partial:5,blocked:6,failed:2})[r.status]!==r.exit)throw Error('invalid managed result');
    const text=r.status==='completed'?'夜巡审计已完成，G2 仅预览，未发送。':r.status==='partial'?'夜巡部分完成，有检查缺项。':r.status==='blocked'?'夜巡被阻挡，尚未完成。':'夜巡失败，尚未完成。';
    output.write(JSON.stringify({protocol:env.CINDY_SCRIPT_PROTOCOL==='1'?'cindy-script/1':first.protocol,type:'complete',resultText:text+' 状态：'+r.status+'；'+(r.reason||'')+'；证据：'+r.evidence,primarySessionId:null})+'\n');
    if(r.exit!==0)error.write(r.status+': '+(r.reason||'')+'; evidence='+r.evidence+'\n');
    return r.exit;
  }catch(e){error.write('failed: '+e.message+'\n');return 2;}finally{reader.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)process.exitCode=await runProtocol();
