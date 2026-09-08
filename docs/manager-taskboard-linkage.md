# Project manager coordination

Developers refine task descriptions, comments, attachments and acceptance criteria. The general manager claims eligible work and groups it for fixed business-manager conversations. Business managers implement and report evidence; human acceptance remains separate.

In a project's manager panel, reuse existing conversation IDs or request automatic discovery and creation. The naming convention is `Project｜总经理｜项目总控` and `Project｜业务经理｜Business scope`. First-time configuration offers a general manager and a configurable general-development manager. Same-project, exact-name matches are reused before a new conversation is created. Busy conversations retain queued work.

Task status and actual execution activity are separate. Approval and input waits are displayed explicitly. Missing connections are not interpreted as completed work, and no task is automatically marked done.

The local server persists coordination in SQLite. The injected coordinator communicates with Codex; merely starting the standalone web preview does not start this integration. `taskctl coordination --help` lists claim, dispatch and report commands.

Development validation covers isolated HTTP operations, a controlled RPC adapter and browser flows. Full installed-runtime acceptance and release remain pending. No local project IDs, private conversation IDs or user data are included in this document.
