# Agent Video Pipeline Commands

> Read this only when the task is to make or revise a video through the pipeline
> (brief → assets → voice → alignment → composition → render → review → archive).
> Design: `docs/design/16-agent-video-pipeline.md`.

Every pipeline call is recorded as a step in the run's trace in the local
`flovart-state.db`, whoever made it: the built-in Agent, the CLI, or MCP. The
user sees the same run as a card in the Canvas drawer's run log.

## Rules

- Every write needs a stable `--mutation-id`. Retrying with the same id replays
  the recorded step instead of running it twice; a new id is a new step.
- Pass `--caller codex` (or `claude-code`, `dsh`, …) so the trace shows who called.
- `pipeline.run.start` confirms the run budget once (`budgetConfirmed: true`);
  calls past the budget fail with `BUDGET_EXCEEDED`. Stop and ask the user.
- `composition.patch` is version-based and respects locked clips. With a
  `reviewRoundId` it may only touch the clips that review's findings point at.
- `composition.render --preset final` needs a passing review of that version.
- Commands that start local processes or write outside the run ask once:
  `pipeline.run.start`, `capture.ui` and `run.archive` fail with
  `CONFIRMATION_REQUIRED` and an `approval.approvalId`. Over MCP (and for the
  built-in agent) a `confirmed` / `budgetConfirmed` you fill in is ignored: ask
  the user to approve it in Iris (Agent → Video pipeline), then resend the same
  arguments. Approvals are single-use and bound to those exact arguments. A
  human running the CLI may pass the flag directly.
- A paid step that returns `UNKNOWN_SUBMIT` may already have been charged. Do
  not retry it on your own; the user checks the provider first and resends
  with `--confirm-resubmit`.
- Image clips may carry `motion: { type, amount?, ease?, flash? }` with type
  `push`, `pull`, `pan-left`, `pan-right`, `tilt-up`, `tilt-down`, `shake`,
  `impact` or `none`. Only `engine: remotion` renders every type; ffmpeg draws
  `push` only. Still-image music edits: the `still-mad` Skill.
- A missing local tool (ffmpeg, Chromium, Remotion) returns
  `CAPABILITY_UNAVAILABLE` with a `diagnose` hint. Report it; do not work around it.

## Commands

| Command | Writes | What it does |
| --- | --- | --- |
| `pipeline.run.start` | yes | Create a run with its brief and budget. |
| `pipeline.run.get` | no | Read the whole trace: steps, versions, renders, reviews, spend, blocker. |
| `asset.import` | yes | Import files from an authorized folder as durable artifacts. |
| `capture.ui` | yes | Open a localhost page (or a file in an authorized folder) in local headless Chromium, run steps, save screenshots or an MP4 recording. |
| `asset.list` | no | List a run's artifacts by kind or tag. |
| `audio.tts` | yes | Voice each script line (counts against the budget). |
| `audio.transcribe` | yes | Word-level transcript of a voice artifact. |
| `timeline.align` | no | Map script lines and action words to milliseconds. |
| `composition.patch` | yes | Create the next spec version (visual, text, captions, audio tracks). |
| `composition.render` | yes | Render a version: `still`, `draft` or `final`; `engine` is `ffmpeg` (default) or `remotion`. |
| `media.probe` | no | Duration, codecs, black frames, silence, loudness, automatic issues. |
| `media.frames` | no | Up to 6 real frames by second, optionally side by side with another version. |
| `review.submit` | yes | One structured review round: findings with time, layer, issue, fix; verdict `pass`, `revise` or `block`. |
| `run.archive` | yes | Copy the final cut, every spec, stems, rejects and reviews to a folder with a sha256 manifest. |

## capture.ui steps

`steps` is a list of `{ action, ... }`: `goto` (url, same boundary),
`click` / `hover` / `waitFor` (selector), `fill` (selector, value), `press`
(key), `scroll` (x, y), `wait` (ms ≤ 15000), `screenshot` (optional `name`,
`selector`, `fullPage`). At most 40 steps and 12 screenshots; recordings stop
at 120 s. In screenshot mode a final screenshot is added when none is listed.

```bash
iris capture.ui --runId <runId> --mutation-id cap-1 --caller codex --args-json '{
  "url": "http://localhost:5173",
  "viewport": { "width": 1170, "height": 2532, "deviceScaleFactor": 1 },
  "steps": [{ "action": "screenshot", "name": "home" }, { "action": "click", "selector": "#generate" },
            { "action": "waitFor", "selector": "#result" }, { "action": "screenshot", "name": "result" }],
  "confirmed": true
}' --json
```

## MCP

The same commands are MCP tools named `iris_` plus the command with dots
turned into underscores: `iris_pipeline_run_start`, `iris_capture_ui`,
`iris_composition_render`, … Pass `agentIdentity` instead of `--caller` and
`mutationId` as a normal argument.
