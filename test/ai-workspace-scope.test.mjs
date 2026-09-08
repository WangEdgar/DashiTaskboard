import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {resolveMappedAiWorkspace} from '../server/ai-chat-catalog.mjs';
test('AI workspace excludes other saved projects', async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'taskboard-workspace-test-'));
 try {
  const current=path.join(root,'[current]'), other=path.join(root,'other');
  await mkdir(current); await mkdir(other);
  const result=await resolveMappedAiWorkspace('current',{id:'current'},{current,other});
  assert.equal(result.workspacePath,current);
  assert.deepEqual(result.addDirectories,[]);
 } finally {await rm(root,{recursive:true,force:true});}
});
