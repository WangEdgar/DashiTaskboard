import { randomUUID } from "node:crypto";
import path from "node:path";
import { ApiError } from "../shared/api-fields.mjs";
import { taskFieldChanges } from "../shared/task-records.mjs";

const fail = (status, code, message) => { throw new ApiError(status, code, message); };
const required = (value, field) => {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) fail(400, "INVALID_COORDINATION", field + " is required");
  return value.trim();
};
const stamp = () => new Date().toISOString();
const executionStates = new Set(["queued", "running", "waiting_user", "blocked", "interrupted", "awaiting_review", "idle"]);
const reportStates = new Set(["waiting_user", "blocked", "interrupted", "awaiting_review"]);
const samePath = (a, b) => (process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

export class ProjectCoordination {
  constructor(taskboard, events) {
    this.tasks = taskboard;
    this.sql = taskboard.database;
    this.events = events;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS project_coordination (
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
      document TEXT NOT NULL
    )`);
  }

  get(projectId) {
    const project = this.tasks.getProject(projectId);
    if (!project) fail(404, "PROJECT_NOT_FOUND", "Project does not exist");
    const row = this.sql.prepare("SELECT document FROM project_coordination WHERE project_id = ?").get(projectId);
    return row ? JSON.parse(row.document) : {
      config: { version: 0, enabled: false, projectIdentity: null,
        generalManager: { name: project.name + "｜总经理｜项目总控", threadId: null },
        businessManagers: [] },
      assignments: [], runtime: {},
    };
  }

  list() {
    return { projects: this.sql.prepare("SELECT project_id, document FROM project_coordination").all()
      .map(row => ({ projectId: row.project_id, ...JSON.parse(row.document) })) };
  }

  save(projectId, document) {
    this.sql.prepare("INSERT INTO project_coordination(project_id, document) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET document=excluded.document")
      .run(projectId, JSON.stringify(document));
  }

  configure(projectId, input) {
    const doc = this.get(projectId);
    if (input.version !== doc.config.version) fail(409, "VERSION_CONFLICT", "Manager configuration changed; reload before saving");
    const project = this.tasks.getProject(projectId);
    const identity = input.projectIdentity;
    if (!identity || typeof identity !== "object") fail(400, "INVALID_COORDINATION", "Full project identity is required");
    const cleanIdentity = Object.fromEntries(["codexProjectId", "codexProjectKind", "codexHostId", "workspacePath"].map(key => [key, required(identity[key], key)]));
    if (!["local", "remote"].includes(cleanIdentity.codexProjectKind)) fail(400, "INVALID_COORDINATION", "Only local or remote Codex projects are supported");
    if (project.workspacePath && !samePath(project.workspacePath, cleanIdentity.workspacePath)) fail(409, "PROJECT_BINDING_MISMATCH", "Manager workspace must match this Taskboard project");
    const general = input.generalManager;
    if (!general || required(general.name, "generalManager.name") !== project.name + "｜总经理｜项目总控") fail(400, "INVALID_MANAGER_NAME", "Use 项目名｜总经理｜项目总控");
    if (!Array.isArray(input.businessManagers)) fail(400, "INVALID_COORDINATION", "businessManagers must be an array");
    const manager = (item, isGeneral = false) => {
      const scope = isGeneral ? null : required(item.scope, "scope");
      const name = required(item.name, "name");
      if (!isGeneral && name !== project.name + "｜业务经理｜" + scope) fail(400, "INVALID_MANAGER_NAME", "Use 项目名｜业务经理｜业务范围");
      const threadId = item.threadId == null || item.threadId === "" ? null : required(item.threadId, "threadId");
      return { ...(isGeneral ? {} : { id: required(item.id, "manager.id"), scope }), name, threadId, createRequested: !threadId && item.createRequested === true };
    };
    const generalManager = manager(general, true);
    if (input.enabled === true && !generalManager.threadId && !generalManager.createRequested) fail(400, "GENERAL_MANAGER_REQUIRED", "启用联动前，请绑定总经理会话或明确选择创建总经理会话");
    const businessManagers = input.businessManagers.map(item => manager(item));
    const ids = businessManagers.map(item => item.id);
    if (ids.includes("general") || new Set(ids).size !== ids.length) fail(400, "INVALID_COORDINATION", "Manager ids must be unique and cannot be general");
    const bound = [generalManager, ...businessManagers].map(item => item.threadId).filter(Boolean);
    if (new Set(bound).size !== bound.length) fail(400, "INVALID_COORDINATION", "Each manager needs a distinct conversation");
    for (const assignment of doc.assignments) {
      if (assignment.managerId && !businessManagers.some(item => item.id === assignment.managerId)) fail(409, "MANAGER_ASSIGNED", "Retain managers with assignment history");
    }
    doc.config = { version: doc.config.version + 1, enabled: input.enabled === true, projectIdentity: cleanIdentity, generalManager, businessManagers };
    this.save(projectId, doc);
    this.events?.emit("coordination.updated", { projectId });
    return doc;
  }

  requireGeneral(doc, input) {
    if (!doc.config.enabled) fail(409, "COORDINATION_DISABLED", "Enable manager coordination first");
    if (!doc.config.generalManager.threadId || input.threadId !== doc.config.generalManager.threadId) fail(403, "GENERAL_MANAGER_REQUIRED", "Only the bound general manager may claim or dispatch");
  }

  requireTasks(projectId, input) {
    if (!Array.isArray(input.taskIds) || !input.taskIds.length || new Set(input.taskIds).size !== input.taskIds.length) fail(400, "INVALID_COORDINATION", "Supply unique taskIds");
    return input.taskIds.map(id => {
      const task = this.tasks.getTask(required(id, "taskId"));
      if (!task || task.projectId !== projectId) fail(404, "TASK_NOT_FOUND", "Task is not in this project");
      if (task.source === "jira") fail(409, "COORDINATION_LOCAL_ONLY", "Jira tasks must be managed through Jira");
      if (task.archivedAt !== null) fail(409, "TASK_ARCHIVED", "Archived tasks cannot be dispatched");
      if (input.versions?.[id] !== task.version) fail(409, "VERSION_CONFLICT", "Task " + task.identifier + " changed; read its latest description, comments and attachments");
      return task;
    });
  }

  eligible(task) {
    if (task.relations.blockedBy.some(item => item.status !== "done")) fail(409, "DEPENDENCIES_BLOCKED", task.identifier + " has unfinished dependencies");
    const comments = this.tasks.listComments(task.id);
    const last = comments.at(-1)?.body ?? "";
    if (/(?:请|暂时|暂不|先|需要).{0,8}(?:暂停|等待|不要执行|不要开发)|等待(?:确认|确定|验收|通知)|on hold|do not (?:start|implement)/i.test(task.description + "\n" + last)) {
      fail(409, "TASK_WAITING", task.identifier + " explicitly asks to wait");
    }
  }

  bindTasks(tasks, doc, threadId, status, name) {
    const identity = doc.config.projectIdentity;
    const update = this.sql.prepare(`UPDATE tasks SET status = ?, thread_id = ?, thread_codex_project_id = ?,
      thread_codex_project_kind = ?, thread_codex_host_id = ?, thread_workspace_path = ?,
      assignee_type = 'agent', assignee_id = 'codex-agent', assignee_name = ?, assignee_avatar_url = NULL,
      version = version + 1, updated_at = ? WHERE id = ? AND version = ?`);
    for (const task of tasks) {
      const result = update.run(status ?? task.status, threadId, identity.codexProjectId, identity.codexProjectKind,
        identity.codexHostId, identity.workspacePath, name, stamp(), task.id, task.version);
      if (result.changes !== 1) fail(409, "VERSION_CONFLICT", "Task changed during assignment");
      const changes = taskFieldChanges(task, { status: status ?? task.status, assignee: { type: "agent", id: "codex-agent", name, avatarUrl: null } });
      if (changes.length) this.sql.prepare("INSERT INTO task_activities(id, task_id, actor_type, actor_id, actor_name, actor_avatar_url, changes, created_at) VALUES (?, ?, 'agent', 'codex-agent', ?, NULL, ?, ?)")
        .run(randomUUID(), task.id, name, JSON.stringify(changes), stamp());
    }
  }

  transaction(projectId, doc, apply) {
    this.sql.exec("BEGIN IMMEDIATE");
    try { apply(); this.save(projectId, doc); this.sql.exec("COMMIT"); }
    catch (error) { this.sql.exec("ROLLBACK"); throw error; }
    this.events?.emit("coordination.updated", { projectId });
    for (const id of new Set(doc.assignments.flatMap(a => a.taskIds))) {
      const task = this.tasks.getTask(id);
      if (task) this.events?.emit("task.updated", { task });
    }
    return doc;
  }

  claim(projectId, input) {
    const doc = this.get(projectId);
    this.requireGeneral(doc, input);
    const tasks = this.requireTasks(projectId, input);
    for (const task of tasks) {
      if (task.status !== "todo") fail(409, "TASK_NOT_CLAIMABLE", "Only waiting-to-claim tasks can be claimed");
      this.eligible(task);
      const bindingThread = task.threadBinding?.threadId ?? task.threadId;
      if (bindingThread && bindingThread !== input.threadId) fail(409, "TASK_ALREADY_BOUND", "Task belongs to another conversation; explicitly correct its binding before claiming");
      if (doc.assignments.some(a => a.taskIds.includes(task.id))) fail(409, "ALREADY_CLAIMED", "Task already has a manager claim; use its existing assignment");
    }
    const assignment = { id: randomUUID(), taskIds: input.taskIds, managerId: null, claimantThreadId: input.threadId,
      executorThreadId: null, state: "claimed", message: "已由总经理认领，等待业务分派", updatedAt: stamp(),
      claimedVersions: Object.fromEntries(tasks.map(t => [t.id, t.version])) };
    doc.assignments.push(assignment);
    return this.transaction(projectId, doc, () => this.bindTasks(tasks, doc, input.threadId, "in_progress", doc.config.generalManager.name));
  }

  dispatch(projectId, input) {
    const doc = this.get(projectId);
    this.requireGeneral(doc, input);
    const tasks = this.requireTasks(projectId, input);
    const manager = doc.config.businessManagers.find(item => item.id === input.managerId);
    if (!manager || (!manager.threadId && !manager.createRequested)) fail(409, "MANAGER_NOT_BOUND", "Bind or request the business manager conversation first");
    const assignments = new Set();
    for (const task of tasks) {
      if (task.status !== "in_progress" && task.status !== "todo") fail(409, "TASK_NOT_DISPATCHABLE", "Task must be active or returned for rework");
      this.eligible(task);
      const assignment = doc.assignments.find(item => item.taskIds.includes(task.id));
      if (!assignment || assignment.claimantThreadId !== input.threadId) fail(403, "GENERAL_CLAIM_REQUIRED", "General manager must claim before business dispatch");
      const boundThread = task.threadBinding?.threadId ?? task.threadId;
      if (boundThread && ![assignment.claimantThreadId, assignment.executorThreadId].includes(boundThread)) fail(409, "TASK_BINDING_CHANGED", "Developer changed the execution conversation; coordinate this before dispatch");
      if (assignment.state === "running" || assignment.state === "queued") fail(409, "ALREADY_DISPATCHED", "Work is already queued or running");
      if (assignment.managerId && assignment.managerId !== manager.id) fail(409, "REWORK_MANAGER_MISMATCH", "Rework must return to the original business manager");
      assignments.add(assignment);
    }
    for (const assignment of assignments) {
      assignment.taskIds = assignment.taskIds.filter(id => !input.taskIds.includes(id));
    }
    doc.assignments = doc.assignments.filter(a => a.taskIds.length);
    doc.assignments.push({ id: randomUUID(), taskIds: input.taskIds, managerId: manager.id, claimantThreadId: input.threadId,
      executorThreadId: manager.threadId, state: "queued", message: "已分派，等待业务经理执行", updatedAt: stamp(),
      claimedVersions: Object.assign({}, ...[...assignments].map(a => a.claimedVersions)),
      dispatchedVersions: Object.fromEntries(tasks.map(t => [t.id, t.version + 1])) });
    return this.transaction(projectId, doc, () => this.bindTasks(tasks, doc, manager.threadId ?? input.threadId, "in_progress", manager.name));
  }

  report(projectId, input) {
    const doc = this.get(projectId);
    const tasks = this.requireTasks(projectId, input);
    if (!reportStates.has(input.state)) fail(400, "INVALID_EXECUTION_STATE", "Report waiting_user, blocked, interrupted or awaiting_review");
    const message = required(input.message, "Implementation, verification and remaining-work message");
    const matching = [];
    for (const task of tasks) {
      const assignment = doc.assignments.find(a => a.taskIds.includes(task.id));
      if (!assignment?.executorThreadId || assignment.executorThreadId !== input.threadId) fail(403, "EXECUTOR_REQUIRED", "Only the assigned business manager may report");
      if (!assignment.taskIds.every(id => input.taskIds.includes(id))) fail(400, "PARTIAL_GROUP_REPORT", "Report all tasks in the execution group");
      matching.push(assignment);
      if (task.status !== "in_progress" && task.status !== "in_review") fail(409, "TASK_STATE_CHANGED", "Developer changed the task state; ask the general manager to coordinate");
    }
    for (const assignment of new Set(matching)) Object.assign(assignment, { state: input.state, message, updatedAt: stamp() });
    const manager = doc.config.businessManagers.find(m => m.threadId === input.threadId);
    if (!manager) fail(403, "EXECUTOR_REQUIRED", "Execution manager binding changed");
    const commentIds = [];
    const result = this.transaction(projectId, doc, () => {
      this.bindTasks(tasks, doc, input.threadId, input.state === "awaiting_review" ? "in_review" : null, manager.name);
      const identity = doc.config.projectIdentity;
      for (const task of tasks) {
        const id = randomUUID(), time = stamp();
        const revision = this.sql.prepare("UPDATE comment_attachment_revision SET value=value+1 WHERE id=1 RETURNING value").get().value;
        this.sql.prepare(`INSERT INTO comments (id, task_id, body, thread_id, thread_codex_project_id,
          thread_codex_project_kind, thread_codex_host_id, thread_workspace_path,
          author_type, author_id, author_name, author_avatar_url, version, created_at, updated_at, change_revision)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'agent', 'codex-agent', ?, NULL, 1, ?, ?, ?)`)
          .run(id, task.id, message, input.threadId, identity.codexProjectId, identity.codexProjectKind,
            identity.codexHostId, identity.workspacePath, manager.name, time, time, revision);
        commentIds.push(id);
      }
    });
    for (const id of commentIds) {
      const comment = this.tasks.getComment(id);
      this.events?.emit("comment.created", { comment, task: this.tasks.getTask(comment.taskId) });
    }
    return result;
  }

  runtime(projectId, input) {
    const doc = this.get(projectId);
    const manager = input.managerId === "general" ? doc.config.generalManager : doc.config.businessManagers.find(m => m.id === input.managerId);
    if (!manager) fail(404, "MANAGER_NOT_FOUND", "Manager is not configured");
    if (input.state !== undefined && !executionStates.has(input.state)) fail(400, "INVALID_EXECUTION_STATE", "Unsupported execution state");
    if (input.threadId !== undefined) {
      const threadId = required(input.threadId, "threadId");
      if (manager.threadId && manager.threadId !== threadId) fail(409, "MANAGER_ALREADY_BOUND", "Existing manager conversation must be changed through configuration");
      if (!manager.threadId && !manager.createRequested) fail(409, "CREATE_NOT_REQUESTED", "Conversation creation was not requested");
      if ([doc.config.generalManager, ...doc.config.businessManagers].some(m => m !== manager && m.threadId === threadId)) fail(409, "MANAGER_ALREADY_BOUND", "Conversation already belongs to another manager");
      if (manager.threadId !== threadId) { manager.threadId = threadId; manager.createRequested = false; doc.config.version++; }
    }
    for (const key of ["message", "turnId", "fingerprint", "lastActivityAt"]) {
      if (input[key] !== undefined && input[key] !== null && typeof input[key] !== "string") fail(400, "INVALID_COORDINATION", key + " must be a string or null");
    }
    const next = { ...(doc.runtime[input.managerId] ?? {}) };
    for (const key of ["state", "message", "turnId", "fingerprint", "lastActivityAt"]) if (input[key] !== undefined) next[key] = input[key];
    next.updatedAt = stamp();
    next.threadId = manager.threadId;
    doc.runtime[input.managerId] = next;
    const assignment = input.assignmentId ? doc.assignments.find(a => a.id === input.assignmentId) : null;
    if (input.assignmentId && (!assignment || assignment.managerId !== input.managerId)) fail(404, "ASSIGNMENT_NOT_FOUND", "Assignment is not owned by this manager");
    if (assignment && input.state) {
      if (input.state === "awaiting_review") fail(400, "REPORT_REQUIRED", "Only an execution report can submit work for acceptance");
      Object.assign(assignment, { state: input.state, updatedAt: stamp(), executorThreadId: manager.threadId });
      if (input.message !== undefined) assignment.message = input.message;
    }
    return this.transaction(projectId, doc, () => {
      for (const a of doc.assignments.filter(a => a.managerId === input.managerId && !a.executorThreadId)) {
        if (!manager.threadId) continue;
        a.executorThreadId = manager.threadId;
        const tasks = a.taskIds.map(id => this.tasks.getTask(id)).filter(t => t && t.projectId === projectId && t.archivedAt === null && t.status === "in_progress");
        this.bindTasks(tasks, doc, manager.threadId, null, manager.name);
        a.dispatchedVersions = Object.fromEntries(tasks.map(t => [t.id, t.version + 1]));
      }
    });
  }
}
