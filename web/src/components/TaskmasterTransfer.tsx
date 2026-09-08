import { useEffect, useRef, useState } from "react";
import { request, resolveTaskboardUrl } from "../api";
import { taskStatusLabel, useTaskboardI18n } from "../i18n";
import type { Project, TaskStatus } from "../types";
import "./TaskmasterTransfer.css";

interface Preview {
  tag: string;
  tasks: { sourceId: string; title: string; status: TaskStatus; existingId: string | null }[];
  counts: { new: number; existing: number };
}
interface Detection { found: boolean; tags: string[]; tag: string; document?: unknown; preview?: Preview }
function tagsFor(document: unknown): string[] {
  if (!document || typeof document !== "object") return [];
  if (Array.isArray((document as { tasks?: unknown }).tasks)) return ["master"];
  return Object.entries(document).filter(([, value]) => value && typeof value === "object" && Array.isArray((value as { tasks?: unknown }).tasks)).map(([key]) => key);
}
export function TaskmasterTransfer({ project }: { project: Project }) {
  const { text, language } = useTaskboardI18n();
  const [open, setOpen] = useState(false);
  const [detected, setDetected] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const pendingRead = useRef<AbortController | null>(null);
  const [document, setDocument] = useState<unknown>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [tag, setTag] = useState("");
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const base = `/api/projects/${encodeURIComponent(project.id)}/taskmaster`;
  useEffect(() => {
    const controller = new AbortController();
    setDetected(false);
    if (project.workspacePath) void request<Detection>(base, { signal: controller.signal })
      .then(result => { if (!controller.signal.aborted) setDetected(result.found); })
      .catch(() => {});
    return () => controller.abort();
  }, [base, project.workspacePath]);
  useEffect(() => {
    if (!open) { dialog.current?.close(); return; }
    dialog.current?.showModal();
    setDocument(null); setPreview(null); setTags([]); setTag(""); setError(""); setNotice(""); setSource(""); setBusy(true);
    const controller = new AbortController(); pendingRead.current = controller;
    void request<Detection>(base, { signal: controller.signal }).then(async result => {
      if (controller.signal.aborted) return;
      setDetected(result.found);
      if (!result.found) { setNotice(text("项目中未找到 .taskmaster/tasks/tasks.json，请选择 JSON 文件。", "No .taskmaster/tasks/tasks.json found in the project. Choose a JSON file.")); return; }
      setDocument(result.document); setTags(result.tags); setTag(result.tag); setSource(".taskmaster/tasks/tasks.json");
      const next = result.preview ?? await request<Preview>(base + "/preview", { method: "POST", body: JSON.stringify({ document: result.document, tag: result.tag }), signal: controller.signal });
      if (!controller.signal.aborted) setPreview(next);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => { controller.abort(); pendingRead.current?.abort(); };
  }, [open, base, text]);

  async function prepare(nextDocument: unknown, nextTag: string, nextSource: string) {
    pendingRead.current?.abort();
    const controller = new AbortController(); pendingRead.current = controller;
    setBusy(true); setPreview(null); setError(""); setNotice("");
    setDocument(nextDocument); setTags(tagsFor(nextDocument)); setTag(nextTag); setSource(nextSource);
    try {
      const result = await request<Preview>(base + "/preview", { method: "POST", body: JSON.stringify({ document: nextDocument, tag: nextTag || undefined }), signal: controller.signal });
      if (!controller.signal.aborted) { setPreview(result); setTag(result.tag); }
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    pendingRead.current?.abort();
    setError(""); setNotice(""); setPreview(null);
    try {
      const value: unknown = JSON.parse(await file.text());
      await prepare(value, tagsFor(value)[0] ?? "", file.name);
    } catch (failure) { setError(text("无法读取 JSON 文件：", "Cannot read JSON file: ") + (failure instanceof Error ? failure.message : String(failure))); }
  }
  async function importTasks() {
    if (!preview || importing) return;
    setImporting(true); setError(""); setNotice("");
    try {
      const result = await request<Preview & { imported: string[]; skipped: string[] }>(base + "/import", { method: "POST", body: JSON.stringify({ document, tag }) });
      setNotice(text(`已导入 ${result.imported.length} 项，跳过 ${result.skipped.length} 项已有任务。`, `Imported ${result.imported.length} tasks; skipped ${result.skipped.length} existing tasks.`));
      const next = await request<Preview>(base + "/preview", { method: "POST", body: JSON.stringify({ document, tag }) });
      setPreview(next);
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setImporting(false); }
  }
  const close = () => { if (!importing) { pendingRead.current?.abort(); setOpen(false); } };
  return <>
    <button type="button" className="taskmaster-trigger no-drag" onClick={() => setOpen(true)}>{text("任务数据", "Task data")}{detected && <span className="taskmaster-detected">{text("发现文件", "File found")}</span>}</button>
    <dialog ref={dialog} className="taskmaster-dialog no-drag" onCancel={event => { if (importing) event.preventDefault(); else close(); }} onClose={close}>
      <header><div><h2>{text("任务数据", "Task data")}</h2><p>{project.name}</p></div><button type="button" disabled={importing} onClick={close} aria-label={text("关闭任务数据", "Close task data")}>×</button></header>
      <div className="taskmaster-body">
        <p className="taskmaster-storage">{text("SQLite 是主存储。.taskmaster 用于导入和导出，不自动双向同步。", "SQLite is the primary store. .taskmaster is for import and export; changes do not sync automatically.")}</p>
        {!project.workspacePath && <p>{text("此项目尚未绑定目录，可直接选择 JSON 文件导入。", "This project has no directory binding. Choose a JSON file to import.")}</p>}
        <section aria-labelledby="taskmaster-import-heading">
          <h3 id="taskmaster-import-heading">{text("导入 TaskMaster 任务", "Import TaskMaster tasks")}</h3>
          <label className="taskmaster-upload">{text("选择 JSON 文件", "Choose a JSON file")}<input type="file" accept=".json,application/json" disabled={importing} onChange={event => void upload(event.target.files?.[0])} /></label>
          {source && <p className="taskmaster-source">{text("来源：", "Source: ")}{source}</p>}
          {tags.length > 0 && <label className="taskmaster-tag">{text("任务分组（tag）", "Task group (tag)")}<select value={tag} disabled={busy || importing} onChange={event => void prepare(document, event.target.value, source)}>{tags.map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
          {busy && <p role="status">{text("正在读取并预览任务…", "Loading task preview…")}</p>}
          {preview && <>
            <p className="taskmaster-counts">{text(`新增 ${preview.counts.new} 项 · 已存在 ${preview.counts.existing} 项`, `${preview.counts.new} new · ${preview.counts.existing} existing`)}</p>
            <p>{text("按来源去重。已有任务跳过，不覆盖开发人员的修改。", "Duplicates are identified by source. Existing tasks are skipped; developer changes are preserved.")}</p>
            <div className="taskmaster-table-scroll"><table><thead><tr><th>{text("来源 ID", "Source ID")}</th><th>{text("任务", "Task")}</th><th>{text("状态", "Status")}</th><th>{text("导入结果", "Import action")}</th></tr></thead><tbody>{preview.tasks.map(task => <tr key={task.sourceId}><td>{task.sourceId}</td><td>{task.title}</td><td>{taskStatusLabel(language, task.status) ?? task.status}</td><td>{task.existingId ? text("已存在 · 跳过", "Exists · Skip") : text("新增", "Add")}</td></tr>)}</tbody></table></div>
            {!preview.tasks.length && <p>{text("此分组没有任务。", "No tasks in this group.")}</p>}
            <button type="button" className="taskmaster-import-button" disabled={busy || importing || !preview.counts.new} onClick={() => void importTasks()}>{importing ? text("正在导入…", "Importing…") : text(`确认导入 ${preview.counts.new} 项`, `Import ${preview.counts.new} tasks`)}</button>
          </>}
          {error && <p className="taskmaster-error" role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
        </section>
        <section aria-labelledby="taskmaster-export-heading">
          <h3 id="taskmaster-export-heading">{text("导出与备份", "Export and backup")}</h3>
          <p>{text("任务导出适合 TaskMaster 使用，不含评论和附件。需要保留完整项目数据时，下载完整备份。", "Task export is for TaskMaster and excludes comments and attachments. Download a full backup to retain complete project data.")}</p>
          <div className="taskmaster-downloads"><a href={resolveTaskboardUrl(base + "/export")} download>{text("导出 TaskMaster JSON", "Export TaskMaster JSON")}</a><a href={resolveTaskboardUrl(base + "/backup")} download>{text("下载完整备份", "Download full backup")}</a></div>
        </section>
      </div>
    </dialog>
  </>;
}
