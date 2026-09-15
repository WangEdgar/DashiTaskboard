# DashiTaskboard design context

## Product and audience
A dense developer taskboard. Developers refine descriptions, attachments, comments and acceptance criteria; managers coordinate their execution. Manager coordination must make responsibility and actual activity visible without taking over task editing.

## Visual direction
Extend the existing restrained taskboard UI. Keep the existing sans-serif typography, compact controls, neutral surfaces and muted borders. The distinctive element is the explicit developer → general manager → business manager → acceptance sequence, which describes actual responsibility.

## Runtime tokens
Established runtime source: web/src/styles.css. Reuse --surface (#ffffff), --surface-raised, --surface-muted, --text-primary (#1b1b1b), --text-secondary (#5d5d5f), --border (#e1e1e1) and their existing dark overrides. No new global palette or typography. ProjectCoordination.css owns only the manager dialog and execution activity layout.

## Canonical behavior
- Form/API: existing api.ts request and ApiError, versioned coordination endpoint. Show errors inline and retain unsaved edits.
- Overlay: native modal dialog for this longer project settings form; native focus containment and Escape, explicit close and save actions. It extends the project header settings entry pattern.
- Thread links: existing App.openThread and complete CodexThreadBinding. Bind by exact task ID; create only via explicit checkbox using established project manager names.
- Status: assignment and runtime evidence, never infer running from task in_progress. Developer acceptance remains separate.
- Polling: only while dialog/detail is mounted or open. Abort on close; do not overwrite dirty forms. Show newer configuration and explicit reload.
- Editing: TaskDetail remains the canonical owner of descriptions, comments, attachments and status changes.
- Locale: existing useTaskboardI18n. Follow active locale for all dates and labels.
- Narrow layout: dialog fits viewport and body scrolls; action footer stays visible. Task activity labels stack on narrow screens.
- Accessibility: real labels and buttons, native form validation, role alert/status, visible focus.

## Verification
TypeScript check passed. Isolated real Chrome exercised opening the panel, saving versioned bindings, narrow 430px layout, Escape close, and task-detail claimant/executor display after real API claim and dispatch. Queued work was not shown as running. Evidence: .runtime/ui-acceptance-rBoKnO/result.json and screenshots. Fixture data only; no real manager task was sent and user acceptance is pending.
