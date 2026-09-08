import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectManagerCoordinator } from '../scripts/project-manager-coordinator.mjs';

test('general manager receives allocation changes only, including after scheduler restart', async () => {
  const doc = { config: { enabled: true, version: 1, projectIdentity: { workspacePath: '/fixture', codexHostId: 'local' }, generalManager: { name: 'GM', threadId: 'gm' }, businessManagers: [] }, runtime: {}, assignments: [] };
  const tasks = ['a', 'b'].map(id => ({ id, status: 'todo', title: id, version: 1, relations: { blockedBy: [] } }));
  const sent = [];
  const request = async (url, options) => {
    if (url === '/api/local/coordination') return { projects: [{ projectId: 'p', ...structuredClone(doc) }] };
    if (url.endsWith('/runtime')) { doc.runtime.general = { ...doc.runtime.general, ...options.body }; return {}; }
    if (url.endsWith('/coordination')) return structuredClone(doc);
    if (url.startsWith('/api/tasks?')) return { tasks: structuredClone(tasks) };
    if (url.endsWith('/comments')) return { comments: [] };
    if (url.endsWith('/attachments')) return { attachments: [] };
    throw Error(url);
  };
  const rpc = async (_host, method, params) => {
    if (method === 'turn/start') { sent.push(params); return { turn: { id: 'turn' } }; }
    return { thread: { id: 'gm', cwd: '/fixture', status: { type: 'idle' }, turns: [{ id: 'turn', status: 'completed' }] } };
  };
  const make = () => createProjectManagerCoordinator({ request, rpc, runtimeFile: '/fixture/runtime.json' });
  let coordinator = make();
  await coordinator.tick();
  assert.equal(sent.length, 1);
  tasks[0].status = 'in_progress'; tasks[0].threadBinding = { threadId: 'gm' };
  doc.assignments.push({ id: 'group', taskIds: ['a'], claimantThreadId: 'gm', state: 'claimed' });
  await coordinator.tick();
  assert.equal(sent.length, 1, 'claim is not a new request');
  doc.assignments[0].state = 'running'; doc.assignments[0].executorThreadId = 'worker'; tasks[0].threadBinding.threadId = 'worker';
  coordinator = make();
  await coordinator.tick();
  assert.equal(sent.length, 1, 'partial allocation and restart must not resend b');
  tasks[1].title = 'new allocation requirements';
  await coordinator.tick();
  assert.equal(sent.length, 2);
  tasks[1].status = 'done';
  for (const state of ['running', 'waiting_user', 'blocked', 'interrupted', 'awaiting_review']) {
    doc.assignments[0].state = state;
    await coordinator.tick();
  }
  assert.equal(sent.length, 2, 'execution and reports alone do not notify GM');
  tasks[0].status = 'todo';
  await coordinator.tick();
  assert.equal(sent.length, 3, 'explicit return to todo needs allocation');
  await coordinator.tick();
  assert.equal(sent.length, 3);
});
