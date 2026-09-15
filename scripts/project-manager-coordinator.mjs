import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const normalizeRoot = (value) => {
  const root = String(value ?? "").replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:/i.test(root) ? root.toLowerCase() : root;
};
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const isBusy = (thread) => thread?.status?.type === "active"
  || thread?.turns?.some((turn) => turn.status === "inProgress" || turn.status === "in_progress");
const taskVersionMap = (tasks) => Object.fromEntries(tasks.map((task) => [task.id, task.version]));
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const waitPattern = /(?:请|暂时|暂不|先|需要).{0,8}(?:暂停|等待|不要执行|不要开发)|等待(?:确认|确定|验收|通知)|on hold|do not (?:start|implement)/i;
const compact = (value, limit = 220) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
};
const managerTaskSummary = (tasks) => tasks.map((task) => ({
  id: task.id,
  key: task.identifier,
  title: compact(task.title, 120),
  status: task.status,
  version: task.version,
  latestUserComment: compact(
    [...(task.coordinationComments ?? [])].reverse().find((comment) => comment.authorType !== "agent")?.body,
  ),
}));
const managerAssignmentSummary = (assignment) => assignment ? {
  id: assignment.id,
  state: assignment.state,
  managerId: assignment.managerId,
  taskIds: assignment.taskIds,
} : null;

export function managerCliPrefix(runtimeFile) {
  const cli = fileURLToPath(new URL("../cli/taskctl.mjs", import.meta.url));
  return (process.platform === "win32" ? "& " : "") + quote(process.execPath)
    + " " + quote(cli) + " --runtime-file " + quote(runtimeFile);
}

export function managerWakePrompt({ projectId, config, tasks, assignments, runtimeFile, managerId, assignment }) {
  const prefix = managerCliPrefix(runtimeFile);
  const common = [
    "DashiTaskboard 经理联动：只在当前固定经理会话执行，不要创建临时会话，也不要发到普通项目会话。",
    "项目目录：" + config.projectIdentity.workspacePath,
    "taskctl 前缀：" + prefix,
    "先读取 AGENTS.md、PROJECT_AGENTS.md，并对本轮任务执行 issue get、comment list、attachment list --task 后再行动；最新评论要求等待时先报告 waiting_user。",
    "不能重启 Codex、停止 Taskboard、抢占其他经理会话，或自动标记 done。",
    "任务摘要：" + JSON.stringify(managerTaskSummary(tasks)),
  ];
  if (managerId === "general") {
    return [
      ...common,
      "角色：你是项目总经理。先认领允许开始且依赖已 done 的 todo，再按业务边界分组派给已配置业务经理；不要亲自逐卡开发。",
      "查看：" + prefix + " coordination get " + projectId,
      "认领命令：" + prefix + " coordination claim " + quote(projectId) + " --task-ids '任务UUID,任务UUID' --versions '最新任务ID到version的JSON对象' --thread-id " + quote(config.generalManager.threadId),
      "分派命令：" + prefix + " coordination dispatch " + quote(projectId) + " --task-ids '同业务的一组任务UUID' --manager-id '已配置业务经理ID' --versions '重新读取的版本JSON' --thread-id " + quote(config.generalManager.threadId),
      "分派后由常驻调度器唤醒业务经理；不要调用 send_message_to_thread 或 create_thread 重复派发。",
      "业务经理：" + JSON.stringify(config.businessManagers.map(({ id, name, scope, threadId }) => ({ id, name, scope, threadId }))),
      "现有分组：" + JSON.stringify((assignments ?? []).map(managerAssignmentSummary)),
    ].join("\n");
  }
  return [
    ...common,
    "角色：你是被总经理分派的业务经理，只处理这个分组：" + JSON.stringify(managerAssignmentSummary(assignment)),
    "总经理已认领。按最新任务说明和开发人员最新评论实现并直接验证；开始前核对任务绑定确属本会话。",
    "有效进展用 comment add 记录；结束时必须用 coordination report 回写。",
    "回写命令：" + prefix + " coordination report " + quote(projectId) + " --task-ids " + quote(tasks.map((task) => task.id).join(",")) + " --state awaiting_review --message '实际改动、验证结果和剩余事项' --versions '结束时重新读取的任务版本JSON' --thread-id " + quote(config.businessManagers.find((manager) => manager.id === managerId)?.threadId),
    "不能完成时 state 使用 waiting_user、blocked 或 interrupted 并写明原因；只有实现且验证后才能报 awaiting_review。",
    "版本参考（结束时重新读取）：" + JSON.stringify(taskVersionMap(tasks)),
  ].join("\n");
}

// One resident scheduler for the injected App; no cron conversations are created.
export function createProjectManagerCoordinator({ request, rpc, runtimeFile, disableLegacy = async () => {}, log = () => {}, now = () => Date.now() }) {
  let pending;
  let stopped = false;
  const projectPath = (id) => "/api/projects/" + encodeURIComponent(id) + "/coordination";
  const updateRuntime = (id, body) => request(projectPath(id) + "/runtime", { method: "POST", body });
  async function managerThread(project, managerId, manager) {
    const { config, projectId } = project;
    const identity = config.projectIdentity;
    if (!manager.threadId) {
      if (!manager.createRequested) return null;
      const matches = new Map();
      let cursor;
      do {
        const page = await rpc(identity.codexHostId, "thread/list", {
          cwd: identity.workspacePath, searchTerm: manager.name,
          limit: 100, archived: false,
          sourceKinds: ["cli", "vscode", "exec", "appServer", "subAgent", "subAgentReview", "subAgentCompact", "subAgentThreadSpawn", "subAgentOther", "unknown"],
          ...(cursor ? { cursor } : {}),
        });
        if (!Array.isArray(page?.data)) throw new Error("无法核对已有经理会话，暂不创建新会话。");
        for (const item of page.data) {
          if (item.name === manager.name && normalizeRoot(item.cwd) === normalizeRoot(identity.workspacePath)) matches.set(item.id, item);
        }
        cursor = page.nextCursor;
      } while (cursor);
      if (matches.size > 1) throw new Error("此项目存在多个同名经理，请填写要复用的会话 ID。");
      if (matches.size === 1) {
        manager.threadId = matches.keys().next().value;
        await updateRuntime(projectId, { managerId, threadId: manager.threadId, state: "idle", message: "已复用同项目的固定经理会话。" });
        return managerThread(project, managerId, manager);
      }
      const result = await rpc(identity.codexHostId, "thread/start", {
        cwd: identity.workspacePath, runtimeWorkspaceRoots: [identity.workspacePath],
        approvalPolicy: "on-request", sandbox: "workspace-write",
      });
      const thread = result?.thread;
      if (!thread?.id || normalizeRoot(thread.cwd) !== normalizeRoot(identity.workspacePath)) {
        throw new Error("新会话未绑定到配置的项目目录，已停止派发。");
      }
      // Save returned identity before naming so a naming failure cannot create duplicates.
      await updateRuntime(projectId, { managerId, threadId: thread.id, state: "idle", message: "会话已创建，正在设置名称。", lastActivityAt: new Date(now()).toISOString() });
      manager.threadId = thread.id;
      await rpc(identity.codexHostId, "thread/name/set", { threadId: thread.id, name: manager.name });
      await updateRuntime(projectId, { managerId, state: "idle", message: "固定会话已创建并命名，等待分派。" });
      return thread;
    }
    let thread;
    try {
      thread = (await rpc(identity.codexHostId, "thread/read", { threadId: manager.threadId, includeTurns: true }))?.thread;
    } catch (error) {
      // Empty unstarted threads may need loading; do not interpret transport errors as missing.
      if (!/rollout.*empty|not.*loaded/i.test(String(error?.message))) throw error;
      thread = (await rpc(identity.codexHostId, "thread/resume", { threadId: manager.threadId }))?.thread;
    }
    if (!thread || thread.id !== manager.threadId || normalizeRoot(thread.cwd) !== normalizeRoot(identity.workspacePath)) {
      throw new Error("经理会话与项目目录不一致，请修正绑定；没有创建替代会话。");
    }
    return thread;
  }

  async function snapshots(projectId) {
    const tasks = (await request("/api/tasks?projectId=" + encodeURIComponent(projectId))).tasks;
    if (!Array.isArray(tasks)) throw new Error("任务列表无效");
    return Promise.all(tasks.filter((task) => !task.archivedAt).map(async (task) => {
      const base = "/api/tasks/" + encodeURIComponent(task.id);
      const [comments, attachments] = await Promise.all([request(base + "/comments"), request(base + "/attachments")]);
      return { ...task, coordinationComments: comments.comments ?? [], coordinationAttachments: attachments.attachments ?? [] };
    }));
  }
  function taskFingerprint(tasks) {
    return tasks.map((task) => ({
      id: task.id, status: task.status, title: task.title, description: task.description,
      priority: task.priority, labels: task.labels, dueDate: task.dueDate,
      binding: task.threadBinding, dependencies: task.relations?.blockedBy,
      // Agent bookkeeping must not produce an endless self-wake loop.
      feedback: task.coordinationComments.filter((comment) => comment.authorType !== "agent").map((comment) => [comment.id, comment.version, comment.body, comment.attachments]),
      attachments: task.coordinationAttachments.map((item) => [item.id, item.filename, item.size]),
    }));
  }
  async function startTurn(project, managerId, manager, fingerprint, tasks, assignment) {
    if (stopped) return;
    const identity = project.config.projectIdentity;
    const body = {
      managerId, state: "waiting_user", fingerprint,
      message: "正在提交执行请求；若连接中断，请先核实会话，避免重复执行。",
      lastActivityAt: new Date(now()).toISOString(),
    };
    await updateRuntime(project.projectId, body);
    await rpc(identity.codexHostId, "thread/resume", { threadId: manager.threadId });
    if (stopped) return;
    const result = await rpc(identity.codexHostId, "turn/start", {
      threadId: manager.threadId,
      input: [{ type: "text", text: managerWakePrompt({
        ...project, tasks, runtimeFile, managerId, assignment,
      }) }],
    });
    if (!result?.turn?.id) throw new Error("Codex 未确认启动执行，本轮不重复提交。");
    await updateRuntime(project.projectId, {
      ...body, state: "running", threadId: manager.threadId, turnId: result.turn.id,
      ...(assignment ? { assignmentId: assignment.id } : {}),
      message: managerId === "general" ? "总经理正在核对、认领并分组派发。" : "业务经理正在处理总经理分派的任务。",
    });
  }

  async function tickProject(project) {
    const { projectId, config } = project;
    const managers = [{ ...config.generalManager, id: "general" }, ...config.businessManagers];
    const threads = new Map();
    for (const manager of managers) {
      if (!manager?.name) continue;
      try {
        const thread = await managerThread(project, manager.id, manager);
        if (thread) threads.set(manager.id, { manager, thread });
      } catch (error) {
        await updateRuntime(projectId, { managerId: manager.id, state: "interrupted", message: error.message });
      }
    }
    if (!config.enabled) return;
    await disableLegacy(projectId);
    const tasks = await snapshots(projectId);
    // Refresh to include identities created above and reports made during thread reads.
    const refreshed = await request(projectPath(projectId));
    project = { projectId, ...refreshed };
    if (!project.config.enabled) return;
    const assignments = project.assignments ?? [];
    for (const { manager, thread } of threads.values()) {
      const runtime = project.runtime?.[manager.id] ?? {};
      if (isBusy(thread)) {
        const flags = thread.status?.activeFlags ?? [];
        const waiting = flags.includes("waitingOnApproval") || flags.includes("waitingOnUserInput");
        const state = waiting ? "waiting_user" : "running";
        const message = flags.includes("waitingOnApproval") ? "Codex 正在等待命令授权，请打开经理会话处理；新增任务保持排队。"
          : waiting ? "Codex 正在等待用户回复；新增任务保持排队。" : "会话忙碌，新增任务和修改保持排队。";
        if (runtime.state !== state || runtime.message !== message) await updateRuntime(projectId, { managerId: manager.id, state, message });
        continue;
      }
      if (runtime.turnId && ["running", "waiting_user"].includes(runtime.state)) {
        const turn = thread.turns?.find((item) => item.id === runtime.turnId);
        if (!turn) continue; // Missing evidence is not completion.
        if (turn.status === "failed" || turn.status === "interrupted" || turn.status === "completed") {
          const assigned = assignments.find((item) => item.managerId === manager.id && item.state === "running");
          await updateRuntime(projectId, {
            managerId: manager.id, state: turn.status === "completed" ? (assigned ? "waiting_user" : "idle") : "interrupted",
            ...(assigned ? { assignmentId: assigned.id } : {}),
            message: turn.status === "completed"
              ? (assigned ? "会话已结束，但尚未收到任务验收报告，请核对结果。" : "本轮会话已结束。")
              : (turn.error?.message || "执行已中断，等待经理重新安排。"),
            lastActivityAt: new Date(now()).toISOString(),
          });
        }
      }
      if (manager.id === "general") continue;
      const runnable = assignments.find((item) => {
        if (item.managerId !== manager.id) return false;
        if (item.state === "queued") return true;
        return ["running", "waiting_user", "blocked", "interrupted"].includes(item.state);
      });
      if (!runnable) continue;
      const group = tasks.filter((task) => runnable.taskIds.includes(task.id));
      if (group.length !== runnable.taskIds.length || group.some((task) => (
        task.status !== "in_progress"
        || task.threadBinding?.threadId !== manager.threadId
        || waitPattern.test((task.description ?? "") + "\n" + (task.coordinationComments.at(-1)?.body ?? ""))
      ))) {
        await updateRuntime(projectId, { managerId: manager.id, assignmentId: runnable.id, state: "waiting_user", message: "任务状态、绑定或最新评论要求等待，暂停唤醒业务经理。" });
        continue;
      }
      const fingerprint = hash([runnable.id, runnable.updatedAt, taskFingerprint(group)]);
      if (runtime.fingerprint === fingerprint) continue;
      try { await startTurn(project, manager.id, manager, fingerprint, group, runnable); }
      catch (error) { await updateRuntime(projectId, { managerId: manager.id, assignmentId: runnable.id, state: "interrupted", message: error.message }); }
    }
    const general = threads.get("general");
    if (!general || isBusy(general.thread)) return;
    const latest = await request(projectPath(projectId));
    const relevant = tasks.filter((task) => {
      if (task.source === "jira" || task.relations?.blockedBy?.some(item => item.status !== "done")) return false;
      const lastComment = task.coordinationComments.at(-1)?.body ?? "";
      if (waitPattern.test((task.description ?? "") + "\n" + lastComment)) return false;
      const assignment = (latest.assignments ?? []).find(item => item.taskIds.includes(task.id));
      const bound = task.threadBinding?.threadId ?? task.threadId;
      if (!assignment) return task.status === "todo" && (!bound || bound === general.manager.threadId);
      if (assignment.claimantThreadId !== general.manager.threadId || ["queued", "running"].includes(assignment.state)) return false;
      if (bound && ![assignment.claimantThreadId, assignment.executorThreadId].includes(bound)) return false;
      return task.status === "todo" || (task.status === "in_progress" && assignment.state === "claimed");
    });
    if (!relevant.length) {
      if (latest.runtime?.general?.state !== "idle" || latest.runtime?.general?.fingerprint) await updateRuntime(projectId, { managerId: "general", state: "idle", message: "没有需要总经理分配的任务。", fingerprint: null });
      return;
    }
    let notified = {};
    try {
      const saved = JSON.parse(latest.runtime?.general?.fingerprint ?? "null");
      if (saved?.kind === "allocation") notified = saved.requests ?? {};
    } catch { /* Earlier fingerprints were a single hash; evaluate eligible work once. */ }
    const requests = Object.fromEntries(relevant.map(task => [task.id, hash([
      general.manager.threadId,
      // Claiming is part of the same allocation request, not a new notification.
      taskFingerprint([{ ...task, status: "allocation", threadBinding: null }]),
    ])]));
    const pendingTasks = relevant.filter(task => notified[task.id] !== requests[task.id]);
    if (!pendingTasks.length) return;
    const fingerprint = JSON.stringify({ kind: "allocation", requests });
    try {
      await startTurn({ projectId, ...latest }, "general", general.manager, fingerprint, pendingTasks);
    } catch (error) {
      await updateRuntime(projectId, { managerId: "general", state: "interrupted", message: error.message });
    }
  }

  return {
    stop() { stopped = true; },
    tick() {
      if (stopped) return Promise.resolve();
      if (pending) return pending;
      pending = (async () => {
        const response = await request("/api/local/coordination");
        for (const project of response.projects ?? []) {
          try { await tickProject(project); }
          catch (error) {
            log("项目经理联动失败：" + error.message);
            await updateRuntime(project.projectId, { managerId: "general", state: "interrupted", message: error.message }).catch(() => {});
          }
        }
      })().finally(() => { pending = null; });
      return pending;
    },
  };
}
