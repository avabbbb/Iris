# Iris Copilot Instructions

Read [AGENTS.md](../AGENTS.md) first. The canonical document map is [docs/index.md](../docs/index.md). If an older report, audit, ADR, plan, or comment conflicts with those files, treat the older text as historical.

## Current product truth

- Top-level surfaces: Canvas | Cut | Agent (Chinese UI: 画布 | Cut | Agent). The product was renamed Flovart → Iris on 2026-11-20; the second tab was Reverse (逆向) until 2026-11-17, then Iris, and is now Cut; the internal `canvasView: 'reverse'` value and the `reverse` directories are unchanged. The old Table view has been removed.
- Canvas owns the infinite canvas, GenAI generation and the Workflow: nodes, generation tasks, assets, versions.
- Cut is the implemented in-browser video editor (timeline, subtitles, inspector, proxies, MP4 export) plus the "Storyboard · Reverse" sub-view. Its state lives in `services/cut/cutStore.ts`; the UI and the `iris_cut_*` Agent tools share the same operations. The 2026-11-17 plan for a conversation-first "Iris personal agent" tab is archived; do not describe Cut as a coming-soon placeholder.
- Iris is the product name. Older docs that use "Iris" for the second surface / personal agent (2026-11-17 to 11-20) mean the tab now called Cut.
- Agent manages agent connections and state: runtimes, models/providers, external agents (Codex, Claude Code, DSH), health and per-agent status. No chat, no run editing.
- The Canvas Assistant drawer is the built-in Agent's chat, references, tool calls and approvals. Do not embed it inside Agent and do not put Host connection management in it.
- Visual tokens live in [DESIGN.md](../docs/design/DESIGN.md); interaction behavior in [01-interaction.md](../docs/design/01-interaction.md). Glass only on floating chrome. Check references (Inspora, Awwwards, GSAP Showcase, Refero) before UI/motion work and cite them in the PR.
- Do not restore Production Crew / Director / Operator, Production Skill Marketplace, old Canvas/Art dual state, or enterprise org/credits/approval as mandatory product layers.

## Code boundaries

- Root App.tsx composes the Studio surfaces; components/studio/StudioTopMenu.tsx owns the visible Canvas/Cut/Agent switch.
- Workflow UI/state lives under `components/workflow/` (store: `components/workflow/store.ts`).
- Cut UI lives under `components/cut/` and `services/cut/`; the storyboard / reverse sub-view still lives under `components/reverse/` and `services/reverse/` (directory rename is a separate migration).
- Agent connection UI lives under `components/agent/`.
- Shared contextual drawer/chrome lives under `components/studio/`.
- Provider and execution logic stays in `services/`; do not duplicate it in UI or transports.
- Cross-page state uses existing stores; do not add forwarding Manager/Facade/Coordinator layers without a reproduced need.

## Agent integration

The stable baseline operations are `status`, `workflow.inspect`, `workflow.selection.get`, `workflow.apply`, and `workflow.node.run`. CLI + Agent Integration Skill is the default external-agent path; stdio MCP is an optional projection of the same contract.

External agents must not write React/Zustand state, browser storage, Provider private APIs or Runtime databases directly.

## Layout

The current Studio layout is container-driven (#15). Follow the layout section of [Interaction Design](../docs/design/01-interaction.md).

Do not restore JS drawer-inset math, fixed structural viewport patches, legacy `rightPanelInset`/`rightInset`, or page-level absolute columns. Canvas coordinate overlays are a separate concern from page composition.

## Build and validation

Use the repository scripts in `package.json` (command table in [AGENTS.md](../AGENTS.md) §4): `npm test`, `npx tsc --noEmit` (there is no ESLint), `npm run docs:check`, `npm run build`. Match validation to the touched surface; for documentation changes run `npm run docs:check`. Build/mock success is not evidence that a real Provider, coding-agent Host, or Creative Host is certified.

Keep changes narrow, protect existing user changes, and update current-truth docs when a product decision changes.
