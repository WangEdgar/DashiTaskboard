import { useEffect, useRef, useState } from "react";
import { request } from "../api";
import { useTaskboardI18n } from "../i18n";
import type { CodexProjectIdentity, CodexThreadBinding, Project } from "../types";
import "./ProjectCoordination.css";

interface Manager { id?: string; name: string; scope?: string; threadId: string | null; createRequested?: boolean }
interface CoordinationConfig {
  version: number; enabled: boolean; projectIdentity: Partial<CodexProjectIdentity>;
  generalManager: Manager; businessManagers: Manager[];
}
interface Execution { threadId?: string; state: string; message?: string; lastActivityAt?: string | number; turnId?: string }
interface Assignment { id: string; taskIds: string[]; managerId: string | null; claimantThreadId: string; executorThreadId?: string; state: string; message?: string; updatedAt?: string }
interface Coordination { config: CoordinationConfig; assignments: Assignment[]; runtime: Record<string, Execution> }
const endpoint = (id: string) => `/api/projects/${encodeURIComponent(id)}/coordination`;
const states: Record<string, [string, string]> = {
  claimed: ["总经理已认领", "Claimed by general manager"], queued: ["等待分派 / 执行", "Queued"],
  running: ["正在执行", "Running"], waiting_user: ["等待开发人员", "Waiting for developer"],
  blocked: ["已阻塞", "Blocked"], interrupted: ["执行中断", "Interrupted"],
  awaiting_review: ["待验收", "Awaiting acceptance"], idle: ["空闲", "Idle"],
  unavailable: ["会话暂不可达", "Temporarily unavailable"], completed: ["本轮已结束", "Turn ended"],
};
function useCoordination(projectId: string, active: boolean) {
  const [data, setData] = useState<Coordination | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!active) return;
    setData(null); setError("");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = await request<Coordination>(endpoint(projectId), { signal: controller.signal });
        if (!controller.signal.aborted) { setData(next); setError(""); }
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(read, 5000);
      }
    };
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [projectId, active]);
  return { data, error, setData };
}
function State({ state }: { state: string }) {
  const { text } = useTaskboardI18n();
  return <span className={`coordination-state is-${state}`}>{states[state] ? text(...states[state]) : state}</span>;
}
function activityTime(value: string | number | undefined, locale: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString(locale);
}
function openManager(identity: Partial<CodexProjectIdentity>, threadId: string | null | undefined, onOpen: (binding: CodexThreadBinding) => void) {
  if (threadId && identity.codexProjectId && identity.codexProjectKind && identity.codexHostId && identity.workspacePath) {
    onOpen({ ...identity as CodexProjectIdentity, threadId });
  }
}
export function ProjectCoordination({ project, projectIdentity, onOpenThread }: {
  project: Project; projectIdentity: Partial<CodexProjectIdentity>; onOpenThread: (binding: CodexThreadBinding) => void;
}) {
  const { text, locale } = useTaskboardI18n();
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const { data, error, setData } = useCoordination(project.id, open);
  const [draft, setDraft] = useState<CoordinationConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = useRef(false);
  const [notice, setNotice] = useState("");
  const [saveError, setSaveError] = useState("");
  useEffect(() => {
    if (open) { dirty.current = false; setDraft(null); setNotice(""); setSaveError(""); dialog.current?.showModal(); }
    else dialog.current?.close();
  }, [open]);
  useEffect(() => {
    if (data && !dirty.current) setDraft({
      ...data.config,
      projectIdentity: { codexProjectKind: "local", workspacePath: project.workspacePath ?? undefined, ...projectIdentity, ...data.config.projectIdentity },
      generalManager: data.config.version === 0 && !data.config.generalManager?.threadId
        ? { ...data.config.generalManager, name: `${project.name}｜总经理｜项目总控`, threadId: null, createRequested: true }
        : data.config.generalManager,
      businessManagers: data.config.version === 0 && !data.config.businessManagers?.length
        ? [{ id: "general-development", name: `${project.name}｜业务经理｜综合开发`, scope: "综合开发", threadId: null, createRequested: true }]
        : data.config.businessManagers,
    });
  }, [data, projectIdentity, project.name, project.workspacePath]);
  const edit = (next: CoordinationConfig) => { dirty.current = true; setDraft(next); setNotice(""); setSaveError(""); };
  const save = async () => {
    if (!draft) return;
    setSaving(true); setSaveError(""); setNotice("");
    try {
      const next = await request<Coordination>(endpoint(project.id), { method: "PUT", body: JSON.stringify(draft) });
      dirty.current = false; setData(next); setDraft(next.config);
      setNotice(text("经理绑定已保存。自动检查只唤醒总经理，执行进度以活动记录为准。", "Manager bindings saved. Automatic checks wake only the general manager; activity records show actual execution."));
    } catch (failure) { setSaveError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setSaving(false); }
  };
  const managerFields = (manager: Manager, index: number | null) => {
    const runtimeKey = index === null ? "general" : manager.id!;
    const live = data?.runtime?.[runtimeKey];
    const update = (changes: Partial<Manager>) => {
      if (!draft) return;
      edit(index === null ? { ...draft, generalManager: { ...manager, ...changes } } : {
        ...draft, businessManagers: draft.businessManagers.map((item, i) => i === index ? { ...item, ...changes } : item),
      });
    };
    return <fieldset className="coordination-manager" key={runtimeKey} disabled={saving}>
      <legend>{index === null ? text("总经理 · 认领与调度", "General manager · Claim and coordinate") : text("业务经理 · 开发与验证", "Business manager · Develop and verify")}</legend>
      {index !== null && <label>{text("业务范围", "Business scope")}<input value={manager.scope ?? ""} onChange={event => update({ scope: event.target.value, ...(!manager.threadId ? { name: `${project.name}｜业务经理｜${event.target.value}` } : {}) })} placeholder={text("例如：构建发布-包体版本", "e.g. Build and release")} required /></label>}
      <label>{text("会话名称", "Task name")}<input value={manager.name} onChange={event => update({ name: event.target.value })} required /></label>
      <label>{text("已有会话 ID", "Existing task ID")}<input value={manager.threadId ?? ""} onChange={event => update({ threadId: event.target.value.trim() || null, createRequested: !event.target.value.trim() })} placeholder={text("粘贴已有会话 ID，优先复用", "Paste an existing task ID to reuse it")} /></label>
      {!manager.threadId && <label className="coordination-check"><input type="checkbox" checked={manager.createRequested ?? false} onChange={event => update({ createRequested: event.target.checked })} />{text("自动复用同项目同名会话，找不到时创建", "Reuse a matching task in this project; create one if none exists")}</label>}
      <div className="coordination-manager-actions">
        {live ? <><State state={live.state} /><span>{activityTime(live.lastActivityAt, locale)}</span></> : <span>{text("尚无执行记录", "No execution activity yet")}</span>}
        {(live?.threadId || manager.threadId) && <button type="button" onClick={() => openManager(draft!.projectIdentity, live?.threadId || manager.threadId, onOpenThread)}>{text("打开会话", "Open task")}</button>}
        {index !== null && <button type="button" onClick={() => edit({ ...draft!, businessManagers: draft!.businessManagers.filter((_, i) => i !== index) })}>{text("移除绑定", "Remove binding")}</button>}
      </div>
      {live?.message && <p>{live.message}</p>}
    </fieldset>;
  };
  return <>
    <button type="button" className="coordination-trigger no-drag" onClick={() => setOpen(true)}>{text("经理联动", "Manager coordination")}</button>
    <dialog ref={dialog} className="coordination-dialog no-drag" onCancel={() => setOpen(false)} onClose={() => setOpen(false)}>
      <header><div><h2>{text("经理联动", "Manager coordination")}</h2><p>{project.name}</p></div><button type="button" onClick={() => setOpen(false)} aria-label={text("关闭经理联动", "Close manager coordination")}>×</button></header>
      <div className="coordination-body">
        <p className="coordination-flow">{text("开发人员细化任务 → 总经理认领 → 业务经理开发 → 人工验收", "Developer refines → General manager claims → Business manager develops → Human accepts")}</p>
        <p>{text("描述、附件和最新评论决定执行范围。修改和返工会回到原经理会话；同一业务的任务合并派发。", "Descriptions, attachments and latest comments define the work. Refinements return to the same manager; related tasks are dispatched together.")}</p>
        <p>{text("保存后自动查找同项目同名的经理会话；已有会话优先复用，找不到才创建。可取消下方选项并手动绑定。", "After saving, look for manager tasks with the same project and name. Reuse existing tasks first and create only when none exists. Uncheck the option below to bind manually.")}</p>
        {error && <p role="alert" className="coordination-error">{error}</p>}
        {!draft && !error && <p role="status">{text("正在读取经理绑定…", "Loading manager bindings…")}</p>}
        {draft && <form id="coordination-form" onSubmit={event => { event.preventDefault(); void save(); }}>
          <label className="coordination-check"><input type="checkbox" checked={draft.enabled} disabled={saving} onChange={event => edit({ ...draft, enabled: event.target.checked })} />{text("启用总经理联动", "Enable general manager coordination")}</label>
          <p>{text("启用后，自动检查仅联系固定总经理；经理忙碌时保留队列。关闭后停止后续派发。", "Automatic checks contact the fixed general manager. Work stays queued while busy. Disabling stops new dispatches.")}</p>
          <details className="coordination-project"><summary>{text("项目绑定", "Project binding")}</summary>
            <label>{text("项目目录", "Project directory")}<input value={draft.projectIdentity.workspacePath ?? project.workspacePath ?? ""} onChange={event => edit({ ...draft, projectIdentity: { ...draft.projectIdentity, workspacePath: event.target.value } })} required /></label>
            <label>{text("Codex 项目 ID", "Codex project ID")}<input value={draft.projectIdentity.codexProjectId ?? ""} onChange={event => edit({ ...draft, projectIdentity: { ...draft.projectIdentity, codexProjectId: event.target.value } })} required /></label>
            <label>{text("Codex 主机 ID", "Codex host ID")}<input value={draft.projectIdentity.codexHostId ?? ""} onChange={event => edit({ ...draft, projectIdentity: { ...draft.projectIdentity, codexHostId: event.target.value } })} required /></label>
          </details>
          {managerFields(draft.generalManager, null)}
          {draft.businessManagers.map((manager, index) => managerFields(manager, index))}
          <button type="button" disabled={saving} onClick={() => edit({ ...draft, businessManagers: [...draft.businessManagers, { id: crypto.randomUUID(), name: `${project.name}｜业务经理｜`, scope: "", threadId: null, createRequested: true }] })}>{text("添加业务经理", "Add business manager")}</button>
        </form>}
        {draft && data && draft.version !== data.config.version && <p role="status">{text("经理绑定已在其他位置更新。重新载入后再保存。", "Manager bindings changed elsewhere. Reload before saving.")} <button type="button" disabled={saving} onClick={() => { dirty.current = false; setDraft({ ...data.config, projectIdentity: { codexProjectKind: "local", workspacePath: project.workspacePath ?? undefined, ...projectIdentity, ...data.config.projectIdentity } }); setSaveError(""); }}>{text("重新载入绑定", "Reload bindings")}</button></p>}
        {saveError && <p className="coordination-error" role="alert">{saveError}</p>}
        {notice && <p role="status">{notice}</p>}
      </div>
      <footer><span>{text("保存绑定不代表任务已开始开发。", "Saving a binding does not mean development has started.")}</span><button type="submit" form="coordination-form" disabled={!draft || saving}>{saving ? text("正在保存…", "Saving…") : text("保存经理绑定", "Save manager bindings")}</button></footer>
    </dialog>
  </>;
}
export function TaskCoordination({ projectId, taskId, onOpenThread }: { projectId: string; taskId: string; onOpenThread: (binding: CodexThreadBinding) => void }) {
  const { text, locale } = useTaskboardI18n();
  const { data, error } = useCoordination(projectId, true);
  if (!data && !error) return null;
  const assignments = data?.assignments?.filter(item => item.taskIds.includes(taskId)) ?? [];
  return <section className="task-coordination" aria-label={text("经理执行记录", "Manager execution activity")}>
    <h3>{text("经理执行记录", "Manager execution activity")}</h3>
    {error && <p className="coordination-error" role="alert">{error}</p>}
    {!error && !assignments.length && <p>{text("尚无总经理认领记录。任务处于“处理中”不代表会话正在开发。", "No general manager claim yet. An in-progress task status alone does not indicate active development.")}</p>}
    {assignments.map(assignment => {
      const manager = data!.config.businessManagers.find(item => item.id === assignment.managerId);
      const live = assignment.managerId ? data!.runtime?.[assignment.managerId] : undefined;
      const waitingForDeveloper = assignment.state === "running" && live?.state === "waiting_user";
      const displayedMessage = waitingForDeveloper ? live?.message || assignment.message : assignment.message || live?.message;
      return <div className="task-coordination-entry" key={assignment.id}>
        <State state={waitingForDeveloper ? "waiting_user" : assignment.state} />
        <dl><dt>{text("认领总经理", "Claimed by")}</dt><dd><button type="button" onClick={() => openManager(data!.config.projectIdentity, assignment.claimantThreadId, onOpenThread)}>{data!.config.generalManager.name}</button></dd>
          <dt>{text("执行业务经理", "Executor")}</dt><dd>{manager ? <button type="button" onClick={() => openManager(data!.config.projectIdentity, assignment.executorThreadId || manager.threadId, onOpenThread)}>{manager.name}</button> : text("等待总经理分派", "Awaiting general manager assignment")}</dd>
          <dt>{text("最近活动", "Last activity")}</dt><dd>{activityTime(live?.lastActivityAt || assignment.updatedAt, locale)}</dd></dl>
        {displayedMessage && <p>{displayedMessage}</p>}
      </div>;
    })}
  </section>;
}
