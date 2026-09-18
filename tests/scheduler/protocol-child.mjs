import {runProtocol} from '../../scripts/scheduler/nightly-script.mjs';
const status=process.argv[2];
process.exitCode=await runProtocol({run:async()=>({status,exit:{completed:0,partial:5,blocked:6,failed:2}[status],reason:'fixture-'+status,evidence:'local-fixture'})});
