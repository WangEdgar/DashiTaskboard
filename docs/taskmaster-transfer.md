# 项目任务导入、导出与备份

SQLite 是看板的主存储。`.taskmaster/tasks/tasks.json` 用于任务蓝图和交接，不自动双向同步。

## 页面操作

选择具体项目，在“任务数据”中检测项目目录的 `.taskmaster/tasks/tasks.json`，也可以上传 JSON 文件。选择标签，预览新增及已存在任务，再确认导入。导入只创建缺失来源任务，不覆盖已存在任务的描述、状态和人工修改，也不绑定当前操作人的 Codex 会话。

TaskMaster 文件可以使用 `{ "tasks": [...] }` 或 `{ "master": { "tasks": [...] } }`，也支持选择其他标签。任务、子任务和依赖一起校验、导入；未知状态或无法解析的依赖会报错。

来源状态映射：`pending` → `todo`，`in-progress` → `in_progress`，`review` → `in_review`，`done` → `done`，`deferred` → `backlog`。导入复制的是来源记录，不构成新的执行或人工验收证明。

“导出任务”生成 TaskMaster JSON，保存当前任务内容和依赖，适合交接任务蓝图。“完整项目备份”另含评论、执行记录、经理配置和附件内容，适合保留协作记录；它不是全应用 SQLite 数据库备份。完整备份可能包含项目中的私人信息，应按实际共享范围保管。

导出和备份都是手动快照。备份恢复界面不在本次导入功能中，不能将完整备份当作 TaskMaster 任务文件导入。导入本身不创建或派发会话；项目已经启用经理联动时，新导入的待办会按原有联动规则进入后续检查。

## CLI

以下命令均在当前安装版或注入运行时的精确 `taskctl` 命令前缀后执行：

```text
taskmaster detect PROJECT_ID
taskmaster preview PROJECT_ID --file tasks.json --tag master
taskmaster import PROJECT_ID --file tasks.json --tag master
taskmaster export PROJECT_ID --output tasks-export.json
taskmaster backup PROJECT_ID --output project-backup.json
```

省略 `--file` 时，预览或导入会读取当前项目检测到的默认文件。导出和备份的 `--output` 指定写入位置。

## 实现路径

项目入口 → `TaskmasterTransfer` 组件 → `/api/projects/:id/taskmaster` 系列接口 → `server/taskmaster-transfer.mjs` → SQLite 任务及来源映射。CLI 使用同一接口。文件检测只访问已绑定项目内部的默认任务文件。

目前这组接口面向本地项目存储，未实现云端共享库的迁移。

任务 JSON 导出不能完整表达其他项目中的父任务或依赖；遇到这种关系会明确报错，不输出空依赖。完整项目备份保留关联记录，但不包含其他项目的全部数据。

## 直接验证记录

2026-09-08：隔离 HTTP + CLI 使用 实际项目任务文件副本验证 15 条任务导入、人工修改保留、重复导入跳过、导出再导入不重复，以及项目备份文件生成。没有改写 正式看板。

隔离真实 Chrome 验证项目检测、默认预览、上传 JSON、切换标签、确认导入、看板实时刷新和两个实际文件下载。后端直接验证子任务与依赖、评论和 README 附件、归档记录、经理配置，以及导入路径和跨项目归属检查。
