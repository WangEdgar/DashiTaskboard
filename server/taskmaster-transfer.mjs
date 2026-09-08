import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ApiError } from "../shared/api-fields.mjs";
import { projectPrefix } from "../shared/task-records.mjs";

const statuses = { pending: "todo", "in-progress": "in_progress", review: "in_review", done: "done", deferred: "backlog", blocked: "blocked", cancelled: "canceled", canceled: "canceled" };
const exportStatuses = { todo: "pending", in_progress: "in-progress", in_review: "review", done: "done", backlog: "deferred", blocked: "blocked", canceled: "cancelled" };
const bad = (message, code = "INVALID_TASKMASTER", status = 400) => { throw new ApiError(status, code, message); };
const object = value => value && typeof value === "object" && !Array.isArray(value);
const sourceId = value => {
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim() || String(value).length > 256 || (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0))) bad("Every TaskMaster task needs a nonempty string or integer id");
  return String(value).trim();
};
const inside = (root, target) => { const relative = path.relative(root, target); return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)); };
const time = () => new Date().toISOString();

function parseDocument(document, requestedTag) {
  if (!object(document)) bad("document must be a TaskMaster JSON object");
  const tags = Array.isArray(document.tasks) ? ["master"] : Object.keys(document).filter(key => object(document[key]) && Array.isArray(document[key].tasks));
  if (!tags.length) bad("Expected {tasks:[]} or tagged {master:{tasks:[]}}");
  const tag = requestedTag ?? (tags.includes("master") ? "master" : tags[0]);
  if (typeof tag !== "string" || !tags.includes(tag)) bad("Selected tag does not exist");
  const list = Array.isArray(document.tasks) ? document.tasks : document[tag].tasks;
  const tasks = [], seen = new Set();
  const walk = (items, parent = null, depth = 0) => {
    if (!Array.isArray(items) || depth > 20) bad("Invalid or excessively nested subtasks");
    for (const raw of items) {
      if (!object(raw)) bad("Each task must be an object");
      const localId = sourceId(raw.id);
      const id = parent ? (localId.startsWith(parent + ".") ? localId : parent + "." + localId) : localId;
      if (seen.has(id)) bad("Duplicate source id " + id);
      seen.add(id);
      if (typeof raw.title !== "string" || !raw.title.trim() || raw.title.length > 500) bad("Task " + id + " requires a title up to 500 characters");
      if (!Object.hasOwn(statuses, raw.status ?? "pending")) bad("Unknown TaskMaster status for " + id + ": " + raw.status);
      for (const field of ["description", "details", "testStrategy"]) if (raw[field] !== undefined && typeof raw[field] !== "string") bad(field + " must be text");
      if (raw.dependencies !== undefined && !Array.isArray(raw.dependencies)) bad("dependencies must be an array");
      const priority = raw.priority ?? "medium";
      if (!["none", "urgent", "high", "medium", "low"].includes(priority)) bad("Unknown priority " + priority);
      tasks.push({ sourceId: id, parentSourceId: parent, rawId: raw.id, title: raw.title.trim(),
        description: [raw.description ?? "", raw.details ? "## 实施细节\n" + raw.details : "", raw.testStrategy ? "## 验证策略\n" + raw.testStrategy : ""].filter(Boolean).join("\n\n"),
        status: statuses[raw.status ?? "pending"], priority, dependencyValues: (raw.dependencies ?? []).map(sourceId), original: raw });
      if (tasks.length > 10000) bad("Import exceeds 10000 tasks");
      if (raw.subtasks !== undefined) walk(raw.subtasks, id, depth + 1);
    }
  };
  walk(list);
  for (const task of tasks) task.dependencies = task.dependencyValues.map(id => {
    const sibling = task.parentSourceId ? task.parentSourceId + "." + id : null;
    return sibling && seen.has(sibling) ? sibling : id;
  });
  return { tag, tags, tasks };
}

export class TaskmasterTransfer {
  constructor(database, { attachmentsDirectory, events } = {}) {
    this.db = database; this.sql = database.database; this.attachmentsDirectory = attachmentsDirectory; this.events = events;
  }
  project(id) {
    const project = this.db.getProject(id);
    if (!project) bad("Project does not exist", "PROJECT_NOT_FOUND", 404);
    if (id === "jira") bad("TaskMaster transfer is available for local projects only");
    return project;
  }
  hasMappings() { return Boolean(this.sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='taskmaster_sources'").get()); }
  mappings(id) { return this.hasMappings() ? this.sql.prepare("SELECT * FROM taskmaster_sources WHERE project_id=?").all(id) : []; }
  createMappings() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS taskmaster_sources(
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      tag TEXT NOT NULL, source_id TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      parent_source_id TEXT, original TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(project_id,tag,source_id), UNIQUE(project_id,tag,task_id)
    )`);
  }
  prepare(id, input) {
    const project = this.project(id);
    const parsed = parseDocument(input?.document, input?.tag);
    const mappings = this.mappings(id).filter(row => row.tag === parsed.tag);
    const existing = new Map(mappings.map(row => [row.source_id, row.task_id]));
    for (const task of parsed.tasks) {
      const exportedId = task.original.taskboardSource?.taskId;
      if (typeof exportedId !== "string") continue;
      const local = this.db.getTask(exportedId);
      if (local?.projectId === id) existing.set(task.sourceId, local.id);
    }
    // The previous CinemaManager importer wrote an exact path/tag/id marker.
    // Only this known marker is adopted; titles and other projects are never matched.
    if (project.workspacePath) {
      const filename = path.resolve(project.workspacePath, ".taskmaster", "tasks", "tasks.json");
      const key = createHash("sha256").update(filename.toLowerCase() + "|" + parsed.tag).digest("hex").slice(0,16);
      const candidates = this.sql.prepare("SELECT id,description FROM tasks WHERE project_id=?").all(id);
      for (const task of parsed.tasks) {
        if (existing.has(task.sourceId)) continue;
        const marker = "<!-- taskmaster:" + key + ":" + task.sourceId + " -->";
        const matches = candidates.filter(candidate => candidate.description.includes(marker));
        if (matches.length > 1) bad("Multiple existing tasks contain the exact legacy source marker for " + task.sourceId, "TASKMASTER_SOURCE_CONFLICT", 409);
        if (matches.length === 1) existing.set(task.sourceId, matches[0].id);
      }
    }
    const sources = new Set([...existing.keys(), ...parsed.tasks.map(task => task.sourceId)]);
    const graph = new Map(parsed.tasks.map(task => [task.sourceId, task.dependencies]));
    const visit = (id, active, visited) => {
      if (active.has(id)) bad("Circular dependency at " + id);
      if (visited.has(id)) return;
      active.add(id);
      for (const dep of graph.get(id) ?? []) visit(dep, active, visited);
      active.delete(id); visited.add(id);
    };
    for (const task of parsed.tasks) for (const dep of task.dependencies) {
      if (!sources.has(dep)) bad("Missing dependency " + dep + " for " + task.sourceId);
      if (dep === task.sourceId) bad("A task cannot depend on itself");
    }
    const visited = new Set(); for (const task of parsed.tasks) visit(task.sourceId, new Set(), visited);
    return { ...parsed, tasks: parsed.tasks.map(task => ({ ...task, existingId: existing.get(task.sourceId) ?? null })), existing };
  }
  summary(parsed) {
    const tasks = parsed.tasks.map(({ sourceId, title, status, existingId }) => ({ sourceId, title, status, existingId }));
    return { tag: parsed.tag, tags: parsed.tags, tasks, counts: { new: tasks.filter(t => !t.existingId).length, existing: tasks.filter(t => t.existingId).length } };
  }
  preview(id, input) { return this.summary(this.prepare(id, input)); }
  async detect(id, tag) {
    const project = this.project(id);
    if (!project.workspacePath) return { found: false, tags: [], tag: null };
    const root = await realpath(project.workspacePath);
    const filename = path.join(root, ".taskmaster", "tasks", "tasks.json");
    let resolved;
    try { resolved = await realpath(filename); } catch (error) { if (error.code === "ENOENT") return { found: false, tags: [], tag: null }; throw error; }
    if (!inside(root, resolved)) bad("TaskMaster file resolves outside project directory", "TASKMASTER_PATH_OUTSIDE_PROJECT");
    if ((await stat(resolved)).size > 16 * 1024 * 1024) bad("TaskMaster file exceeds 16 MiB");
    let document;
    try { document = JSON.parse((await readFile(resolved, "utf8")).replace(/^\uFEFF/, "")); } catch { bad("TaskMaster file is not valid JSON"); }
    const preview = this.preview(id, { document, tag });
    return { found: true, tags: preview.tags, tag: preview.tag, document, preview };
  }
  import(id, input) {
    const parsed = this.prepare(id, input);
    const imported = [], skipped = parsed.tasks.filter(t => t.existingId).map(t => t.existingId);
    const ids = new Map(parsed.existing);
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      this.createMappings();
      const project = this.sql.prepare("SELECT *, (SELECT identifier FROM tasks WHERE project_id=projects.id ORDER BY created_at,id LIMIT 1) first_identifier FROM projects WHERE id=?").get(id);
      const prefix = projectPrefix(project);
      const max = this.sql.prepare("SELECT MAX(CAST(substr(identifier, ?) AS INTEGER)) maximum FROM tasks WHERE identifier GLOB ?").get(prefix.length + 2, prefix + "-[0-9]*").maximum;
      let number = Math.max(project.next_task_number, (max ?? 0) + 1);
      const timestamp = time();
      for (const task of parsed.tasks) {
        if (task.existingId) {
          this.sql.prepare("INSERT OR IGNORE INTO taskmaster_sources(project_id,tag,source_id,task_id,parent_source_id,original,created_at) VALUES(?,?,?,?,?,?,?)")
            .run(id, parsed.tag, task.sourceId, task.existingId, task.parentSourceId, JSON.stringify(task.original), timestamp);
          continue;
        }
        const taskId = randomUUID();
        this.sql.prepare(`INSERT INTO tasks(id,identifier,project_id,title,description,status,priority,labels,sort_order,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,'[]',?,?,?)`).run(taskId, prefix + "-" + number++, id, task.title, task.description, task.status, task.priority, number * 1000, timestamp, timestamp);
        this.sql.prepare("INSERT INTO taskmaster_sources(project_id,tag,source_id,task_id,parent_source_id,original,created_at) VALUES(?,?,?,?,?,?,?)")
          .run(id, parsed.tag, task.sourceId, taskId, task.parentSourceId, JSON.stringify(task.original), timestamp);
        ids.set(task.sourceId, taskId); imported.push(taskId);
      }
      const relation = this.sql.prepare("INSERT OR IGNORE INTO task_relations(relation_type,source_task_id,target_task_id,origin,created_at) VALUES(?,?,?,'manual',?)");
      for (const task of parsed.tasks.filter(t => !t.existingId)) {
        if (task.parentSourceId) relation.run("parent", ids.get(task.parentSourceId), ids.get(task.sourceId), timestamp);
        for (const dep of task.dependencies) relation.run("blocks", ids.get(dep), ids.get(task.sourceId), timestamp);
      }
      if (imported.length) this.sql.prepare("UPDATE projects SET next_task_number=?,updated_at=? WHERE id=?").run(number,timestamp,id);
      this.sql.exec("COMMIT");
    } catch(error) { this.sql.exec("ROLLBACK"); throw error; }
    for (const taskId of imported) this.events?.emit("task.created", { task: this.db.getTask(taskId) });
    return { ...this.summary(parsed), imported, skipped };
  }
  export(id) {
    this.project(id);
    const tasks = this.sql.prepare("SELECT id FROM tasks WHERE project_id=? ORDER BY created_at,id").all(id).map(row => this.db.getTask(row.id));
    const mappings = this.mappings(id), source = new Map();
    for (const row of mappings) if (!source.has(row.task_id)) source.set(row.task_id, row);
    const idMap = new Map(), used = new Set();
    for (const task of tasks) {
      const row = source.get(task.id);
      let exported = row ? JSON.parse(row.original).id : Number(task.identifier.match(/-(\d+)$/)?.[1]) || Number.parseInt(createHash("sha256").update(task.id).digest("hex").slice(0,12),16);
      // Task ids are scoped to their parent's subtasks, just as in TaskMaster.
      const parent = task.relations.parent?.id ?? "";
      if (used.has(parent + ":" + exported)) exported = Number.parseInt(createHash("sha256").update(task.id).digest("hex").slice(0,12),16);
      if (used.has(parent + ":" + exported)) bad("Stable export id collision", "EXPORT_ID_COLLISION",409);
      used.add(parent + ":" + exported); idMap.set(task.id, exported);
    }
    const nodes = new Map();
    for (const task of tasks) {
      const row = source.get(task.id), original = row ? JSON.parse(row.original) : {};
      const originalDescription = [original.description ?? "", original.details ? "## 实施细节\n" + original.details : "", original.testStrategy ? "## 验证策略\n" + original.testStrategy : ""].filter(Boolean).join("\n\n");
      nodes.set(task.id, { ...original, id: idMap.get(task.id), title: task.title,
        description: task.description === originalDescription ? (original.description ?? "") : task.description,
        ...(task.description === originalDescription ? {} : {details:"",testStrategy:""}),
        status: exportStatuses[task.status], priority: task.priority,
        dependencies: task.relations.blockedBy.map(dep => {
          if (!idMap.has(dep.id)) bad("Cannot export dependency outside this project: " + dep.id, "TASKMASTER_EXTERNAL_DEPENDENCY", 409);
          const target=tasks.find(t=>t.id===dep.id);
          return target?.relations.parent?.id && target.relations.parent.id !== task.relations.parent?.id
            ? String(idMap.get(target.relations.parent.id))+"."+idMap.get(dep.id) : idMap.get(dep.id);
        }),
        subtasks: [],
        taskboardSource: row ? {tag:row.tag,sourceId:row.source_id,taskId:task.id} : {taskId:task.id},
        ...(task.archivedAt ? {taskboardArchivedAt:task.archivedAt} : {}),
      });
    }
    const roots = [];
    for (const task of tasks) {
      const parent = task.relations.parent?.id;
      if (parent && !nodes.has(parent)) bad("Cannot export parent outside this project: " + parent, "TASKMASTER_EXTERNAL_PARENT", 409);
      if (parent && nodes.has(parent)) nodes.get(parent).subtasks.push(nodes.get(task.id)); else roots.push(nodes.get(task.id));
    }
    return { master: { tasks: roots } };
  }
  async backup(id) {
    this.project(id);
    const byTask = table => this.sql.prepare("SELECT * FROM "+table+" WHERE task_id IN (SELECT id FROM tasks WHERE project_id=?)").all(id);
    const optional = (table, query) => this.sql.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) ? this.sql.prepare(query).all(id) : [];
    let backup;
    this.sql.exec("BEGIN");
    try {
      const aiThreads = this.sql.prepare("SELECT * FROM ai_chat_threads WHERE origin_project_id=?").all(id);
      backup = { format:"dashi-taskboard-backup",version:1,createdAt:time(),
        project:this.sql.prepare("SELECT * FROM projects WHERE id=?").get(id),
        tasks:this.sql.prepare("SELECT * FROM tasks WHERE project_id=?").all(id),
        comments:byTask("comments"),activities:byTask("task_activities"),
        relations:this.sql.prepare("SELECT * FROM task_relations WHERE source_task_id IN (SELECT id FROM tasks WHERE project_id=?)").all(id),
        coordination:optional("project_coordination","SELECT * FROM project_coordination WHERE project_id=?"),
        taskmasterSources:this.mappings(id),
        readme:this.sql.prepare("SELECT * FROM project_readmes WHERE project_id=?").all(id),
        summaries:this.sql.prepare("SELECT * FROM project_summaries WHERE project_id=?").all(id),
        aiThreads,
        aiRuns:this.sql.prepare("SELECT * FROM ai_chat_runs WHERE thread_id IN (SELECT id FROM ai_chat_threads WHERE origin_project_id=?)").all(id),
        aiEvents:this.sql.prepare("SELECT * FROM ai_chat_events WHERE thread_id IN (SELECT id FROM ai_chat_threads WHERE origin_project_id=?)").all(id),
        attachments:byTask("attachments").map(row=>({...row,storage:"task"})),
        readmeAttachments:this.sql.prepare("SELECT * FROM project_readme_attachments WHERE project_id=?").all(id).map(row=>({...row,storage:"readme"})),
      };
      this.sql.exec("COMMIT");
    } catch(error) {this.sql.exec("ROLLBACK");throw error;}
    for (const attachment of [...backup.attachments,...backup.readmeAttachments]) {
      try {
        const root = await realpath(this.attachmentsDirectory);
        const filename = await realpath(path.join(root,attachment.id));
        if (!inside(root,filename)) bad("Attachment resolves outside storage");
        const bytes = await readFile(filename);
        if (bytes.length !== attachment.size) bad("Attachment size changed during backup");
        attachment.base64=bytes.toString("base64");
        attachment.sha256=createHash("sha256").update(bytes).digest("hex");
      } catch(error) { bad("Cannot complete backup: attachment "+attachment.id+": "+error.message,"BACKUP_ATTACHMENT_UNAVAILABLE",409); }
    }
    return backup;
  }
}
