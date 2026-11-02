import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const db=new DatabaseSync(path.join(root,'.data','workspace.sqlite'),{readOnly:true});
try{
 for(const table of ['work_tasks','task_runs','execution_traces']){
  if(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE status IN ('running','queued','starting','cancelling')`).get().count)throw new Error(`There is active work in ${table}. Retry after it finishes.`);
 }
 console.log('No active business task, scheduled run or model execution.');
}finally{db.close()}
