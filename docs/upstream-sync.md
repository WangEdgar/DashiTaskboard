# 同步上游并保留自有优化

`origin` 应指向自己的仓库，`upstream` 指向原始仓库。首次克隆自己的仓库后配置：

```sh
git remote add upstream https://github.com/chuspeeism/dashi-taskboard.git
npm run upstream:check
```

已有 upstream 时不需要重复添加。检查命令获取双方 main，输出固定提交与双方独有提交数。不会修改当前工作文件。

有上游新提交时执行：

```sh
npm run upstream:prepare
```

脚本从 `origin/main` 创建 `codex/sync-upstream-*` 分支及 `.runtime/sync-upstream-*` 工作区，使用正常 Git 合并准备上游改动，停在未提交状态。没有更新时不创建工作区。冲突时退出码为 1，输出冲突文件并保留现场，不自动选择任一方覆盖。

进入输出的工作区，检查 `git diff --cached`、`git status`，解决冲突，并验证经理绑定与任务分派、TaskMaster 导入导出、Windows 正常退出与重启、任务状态统计。无文本冲突不代表行为兼容。验证完成后提交合并结果，推送该分支并创建到本仓库 main 的 PR；按项目规则完成评审后合并。脚本不会自动提交、推送、合并 main 或发布安装包。

取消准备时在新工作区执行 `git merge --abort`。原工作区中的未提交修改保持原状。

**保留范围是已经进入 origin/main 的自有优化。** 尚在开发分支中的经理工具及 Windows 修复需先完成验收和整合；此命令不会自动纳入这些分支。

当前提供手动检查与准备命令，未配置定时任务。建议定期检查，有重要上游修复时及时处理。
