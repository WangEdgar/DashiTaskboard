# 与原始仓库的区别

记录日期：2026-09-08。本文区分已进入主分支的内容和仅上传到开发分支的实现；上传源码不代表功能验收或安装包发布。

## 仓库关系与比较范围

| 项目 | 原始仓库 | 当前仓库 |
| --- | --- | --- |
| 地址 | [chuspeeism/dashi-taskboard](https://github.com/chuspeeism/dashi-taskboard) | [WangEdgar/DashiTaskboard](https://github.com/WangEdgar/DashiTaskboard) |
| 定位 | 原始 Codex Taskboard 项目 | 独立维护，面向 Windows、多项目复用与经理协作 |
| 本地远程名称 | `upstream` | `origin` |
| 历史与许可 | 上游提交历史、Apache-2.0 | 保留上游历史和许可证 |

下表以开发分支共同使用的上游提交 [`bd264e7ff3402785f1e8b0bb789106358352707b`](https://github.com/chuspeeism/dashi-taskboard/commit/bd264e7ff3402785f1e8b0bb789106358352707b) 为基线，不声称覆盖原始仓库此后的全部更新。

## 已进入 main 的区别

主分支当前主要是原始项目源码，加上独立维护版的中英文说明、本文和本地数据忽略规则。`.runtime/`、`.taskmaster/`、SQLite 数据文件被加入忽略列表；忽略规则不会移除已经被 Git 跟踪的文件。

原有网页任务板、React 界面、SQLite 存储、HTTP API、`taskctl`、Codex 集成及桌面构建能力继承自上游，不作为本仓库新增功能。

**下列经理联动、数据工具与 Windows 修改尚未合并到 main。直接克隆默认分支不会得到这些新增实现。**

## 开发分支中的功能区别

| 领域 | 相对基线的修改 | 主要代码位置 | 当前状态 |
| --- | --- | --- | --- |
| 经理绑定 | 配置固定总经理与业务经理；按项目及命名查找已有任务，缺少时按绑定配置创建并保存 ID | `server/project-coordination.mjs`、`scripts/project-manager-coordinator.mjs`、`web/src/components/ProjectCoordination.tsx` | 经理工具分支 |
| 任务分配 | 总经理认领并分派给业务经理，后续复用绑定的 Codex 任务；记录分配与执行状态 | 同上及 `scripts/codex-injector.mjs` | 经理工具分支 |
| 等待与验收 | 区分等待用户与执行状态；经理提交结果进入待验收流程，不直接视为完成 | `server/project-coordination.mjs`、`ProjectCoordination.tsx` | 经理工具分支 |
| TaskMaster 数据交换 | 检测项目 `.taskmaster/tasks/tasks.json`，预览、选择标签、导入、导出；记录来源映射以支持重复导入去重 | `server/taskmaster-transfer.mjs`、`cli/taskctl.mjs`、`web/src/components/TaskmasterTransfer.tsx` | 经理工具分支 |
| 项目备份 | 导出项目数据与附件；与 TaskMaster 任务交换分开提供 | `server/taskmaster-transfer.mjs` | 经理工具分支 |
| Windows 退出 | 将强制终止路径改为请求正常退出并等待；退出未完成时取消重启 | `scripts/windows-codex.mjs`、`src-tauri/src/main.rs` | Windows 修复分支；完整重启仍待验收 |
| Windows 重启反馈 | 增加重启进度界面，调整启动与窗口聚焦处理 | `src-tauri/src/restart-progress.html`、`src-tauri/src/main.rs`、`scripts/codex-injector.mjs` | Windows 修复分支；不保证重启问题已全部解决 |
| AI 对话工作区 | 不再将其他已保存项目目录自动加入当前项目对话的额外目录 | `server/ai-chat-catalog.mjs` | Windows 修复分支；不代表 AI 导入卡住已修复 |
| 进度统计 | 展示七种任务状态及总数，按总数计算比例；摘要过期时使用当前状态统计 | `web/src/components/DashboardView.tsx`、`DashboardView.css` | Windows 修复分支 |

SQLite 仍是运行时主存储。TaskMaster 是导入/导出格式，未替换数据库，也没有启用自动双向同步。项目备份导出不等同于已经实现一键恢复。

## 对应源码与核验方式

| 分支 | 本次记录的提交 | 用途 |
| --- | --- | --- |
| [`codex/publish-manager-tools`](https://github.com/WangEdgar/DashiTaskboard/tree/codex/publish-manager-tools) | `fbdba9525e1a2186483c8752323b49938cc712c0` | 经理联动、TaskMaster 交换和项目备份 |
| [`codex/publish-windows-fixes`](https://github.com/WangEdgar/DashiTaskboard/tree/codex/publish-windows-fixes) | `d5affd0db5f1acc5eafefd56f01a0cff335469c7` | Windows 生命周期、工作区范围与统计修改 |

两个开发分支分别基于上述上游提交，尚未整合为一个可交付版本，并且都修改了 `scripts/codex-injector.mjs`。不能将任一分支视为包含另一分支的全部能力。

可以在本地查看固定提交的完整差异：

```sh
git fetch origin
git diff bd264e7ff3402785f1e8b0bb789106358352707b fbdba9525e1a2186483c8752323b49938cc712c0
git diff bd264e7ff3402785f1e8b0bb789106358352707b d5affd0db5f1acc5eafefd56f01a0cff335469c7
```

## 交付边界

目前完成的是独立仓库建立和源码分支同步。真实 AI 导入、Windows 完整重启，以及合并后的经理端到端执行仍需最终验收；不能依据本说明认定历史问题全部解决。本仓库尚未发布自己的安装包，继承文档中的上游发行链接也不代表包含这些修改。

公开同步未包含本机任务数据库、项目附件或私人会话绑定。后续维护时应随分支合并、实际验收和版本发布更新本文状态。
