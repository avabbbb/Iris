# Iris × DaVinci Resolve Studio 21.1 — Orchestration Contract

Status: **CONTRACT DRAFT** — grounded in repo code + published 21.1 evidence; every real-host assumption is tagged `UNVERIFIED` until the R0–R3 tracer lands.
Authority: subordinate to [PRODUCT_UI_SPEC.md](PRODUCT_UI_SPEC.md) → [14 Creative Hosts](../../../docs/design/14-creative-hosts.md) (historical source: [flovart-native-effects.md](../../../docs/archive/2026-10-07/design/flovart-native-effects.md) §4/§9, archived).
Naming: this contract predates the 2026-11-17 Iris surface. Every "Iris" in the original draft meant Iris itself (retired codename) and now reads Iris. The Resolve path described here is also Iris's first optional context connector ([14](../../../docs/design/14-creative-hosts.md) §7).
Hard rule: Iris does **not** ship a Resolve MCP server (`PRODUCT_UI_SPEC.md` §1, §15). Resolve's native MCP is the Agent control plane; Iris owns generation, identity and durable artifacts.
Updated: 2026-09-27

---

## 0. What Resolve 21.1 actually ships

Sources: official Blackmagic support page (official), community field guide [dmmdea/davinci-resolve-cli `docs/09-resolve-21-1.md`](https://github.com/dmmdea/davinci-resolve-cli/blob/main/docs/09-resolve-21-1.md) measured against Studio 21.1.0.14 (community-observed), and its extracted `api-catalog-21.1.md` from the installed `DaVinciResolveScript.pyi` (doc-level).

| Fact | Confidence |
| --- | --- |
| Native MCP = a stdio zipapp (`ResolveMCP.exe` → `ResolvePython\ResolvePython.exe`), **not** a listening port. Installed for Claude Desktop via `DaVinciResolve.mcpb`; `File > Setup AI Assistants` is the reported entry point for other agents. | community-observed on 21.1.0.14; `UNVERIFIED` on our target host |
| 14 tools measured via `tools/list`: `launch_resolve`, `get_resolve_status`, `get_whats_new`, `get_scripting_api`, `search_scripting_api`, `run_script`, `run_script_unsafe`, `get_scripting_docs`, `list_dctls`, `list_luts`, `update_dctl`, `delete_dctl`, `delete_lut`, `generate_lut`. | community-observed; `UNVERIFIED` — installed build is authoritative (spec §1) |
| `run_script` executes a **bounded** child `ResolvePython` process: audit hook blocks `open`, `os`/`sys`/`subprocess`/`socket`/`pathlib` imports, sockets; `resolve` + `project` injected; returns `{result}` or `{error}`. `run_script_unsafe` runs unbounded in the server process. | community-observed; drives the safety table §7 |
| Server logs every message at DEBUG on **stderr**; a client that does not drain stderr deadlocks after a large reply. | community-observed; matters for any Agent client configuration |
| Requires `BMD_RESOLVE_APP_PATH` when driving `ResolveMCP.exe` directly (the `.mcpb` shim sets it). | community-observed |
| 21.1 scripting: bundled `ResolvePython.exe` = Python 3.14.4, no env vars needed; 64-bit CPython 3.11–3.14 all bound on the measured machine; Python 2 dropped. | community-observed |
| `MediaStorage.GetFileList`/`AddItemListToMediaPool`/`StartCloneMedia` want **backslash paths**; forward slash answers `[]`/False (`no mapped volume found`). | community-observed — encodes a real import trap |
| `MediaPool.ImportMedia([{FilePath, StartIndex?, EndIndex?}]) -> list[MediaPoolItem]` imports into the **current** Media Pool folder; `MediaStorage.AddItemListToMediaPool([{media, startFrame, endFrame}])` does the same via the media-storage plane. | doc (21.1 `.pyi`); `UNVERIFIED` whether native-MCP `run_script` can pass the dict form cleanly — dict forms are the preferred 21.1 signatures (positional overloads deprecated) |
| New 21.1 shortcuts: `resolve.GetCurrentProject()/GetCurrentTimeline()/GetMediaPool()/GetGallery()`; `Timeline.GetSelectedClips()` now returns selected **timeline items**; `TimelineItem.GetType()` → `video|audio|generator|transition`. | doc + community-observed |
| `ArchiveProject` called from a script **crashes Resolve 21.1**; bridge refuses it. | community-observed — hard deny-list entry |
| Windows CJK/UTF-8 failures in generated Python on some Agent hosts (`PYTHONUTF8=1` mitigation reported). | community-observed; checklist §1 requires local reproduction before adopting |

All product-level warnings in `PRODUCT_UI_SPEC.md` §1 apply: the exact tool list is an observed implementation detail, not an Iris compatibility contract.

---

## 1. Orchestration flow

```text
USER (Resolve Studio 21.1 open, clip selected)
   │
   ├── Codex / external Agent
   │      │
   │      ├─ Resolve native MCP  (host control plane — READ + bounded host ops)
   │      │    ├─ get_resolve_status
   │      │    ├─ get_scripting_api / search_scripting_api   (learn current API)
   │      │    └─ run_script  (bounded):
   │      │         · read project / timeline / selection identity
   │      │         · export reference frame  (TimelineItem.ExportCurrentFrameAsStill)
   │      │         · import artifact         (MediaPool.ImportMedia / MediaStorage.AddItemListToMediaPool)
   │      │         · P1 add-track / P2 replace — only after gates §7
   │      │
   │      └─ Iris Skill + legacy `iris` CLI  (generation plane)
   │           ├─ ensure / status
   │           ├─ workflow.inspect / workflow.selection.get / workflow.apply / workflow.node.run
   │           ├─ generate.image / generate.video          → GenerationTask
   │           ├─ task.get / task.list / task.cancel       → provider task identity
   │           └─ durable artifact  (runtime-artifacts/<dir>/<file> + sha256)
   │
   └─ Iris Resolve panel (human review plane — Electron Workflow Integration pkg)
        ├─ Current Clip · Prompt/Refs · Plan/Cost · Task · Candidates · Add to Media Pool
        └─ consumes the SAME task/artifact plane via host-contract bridge; owns no Resolve ops

                                 ↓
              durable Iris artifact (local file + manifest)
                                 ↓
              Resolve Media Pool  (import = the only P0 host write)
                                 ↓
              original Timeline unchanged
```

Ownership rule: **Resolve native MCP owns every project/timeline/selection/import verb.** The Iris plane never touches Resolve state; the panel bridge's `importArtifact` (`main.js:36-74`) is the Workflow Integration fallback used only when the user acts in the panel or the native MCP hits a measured gap (§5).

---

## 2. Operation ownership table

Owner legend: **MCP** = Resolve native MCP `run_script` (bounded) · **CLI** = legacy `iris` CLI / Skill · **PANEL** = Iris Resolve light panel (`dist-studio/resolve`, `integrations/studio/resolve`) · **BRIDGE** = Workflow Integration Electron bridge (measured fallback only).

| # | Operation | Owner | Resolve scripting API / Iris command | Status / gap |
|---|---|---|---|---|
| 1 | Read project identity | MCP | `resolve.GetCurrentProject()` (21.1 shortcut) → `Project.GetName()` / `GetUniqueId()` | OK in doc; existing bridge already uses `ProjectManager.GetCurrentProject` (`main.js:91-95`) |
| 2 | Read current timeline identity | MCP | `resolve.GetCurrentTimeline()` → `Timeline.GetName()`/`GetUniqueId()`/`GetStartFrame()`/`GetEndFrame()` | OK in doc; **gap in our adapter — not captured today** (§3) |
| 3 | Read selection — Media Pool clip | MCP | `resolve.GetMediaPool().GetSelectedClips()` → `GetMediaId()`/`GetUniqueId()`, `GetClipProperty('File Path'|'Type'|'Duration'|…)` | OK in doc; bridge equivalent `main.js:119-127` |
| 4 | Read selection — timeline item | MCP | `Timeline.GetSelectedClips()` (21.1 returns selected items) **or** `GetCurrentVideoItem()` → `GetUniqueId()`, `GetStart()/GetEnd()`, `GetSourceStart/EndFrame()`, `GetTrackTypeAndIndex()`, `GetMediaPoolItem().GetMediaId()` | `GetSelectedClips()` on Timeline is **21.1-new** — preferred over `GetCurrentVideoItem` (which misses selection ≠ playhead). Bridge today only uses `GetCurrentVideoItem` (`main.js:128-132`) |
| 5 | Materialize reference — clip file path | MCP (read-only) | `MediaPoolItem.GetClipProperty('File Path')` + Iris reads the returned path itself | OK; bridge does this `main.js:142` |
| 6 | Materialize reference — current frame still | MCP | `TimelineItem.ExportCurrentFrameAsStill(filePath)`; `Timeline.GetCurrentTimecode()`/`SetCurrentTimecode()` for playhead control | OK in doc; bridge still does tmpdir + `unlinkSync` (`main.js:144-156`) — see §4: frame must land in artifact store, not tmp |
| 7 | Prepare generation plan / cost | CLI / PANEL | Skill ops `workflow.inspect` + Iris task plan (prompt, model route, refs); cost confirmation is an Iris gate, not a Resolve one | OK — `IrisStudioCore` / CLI `generate.*` (cli.js:592-621) |
| 8 | Run paid generation | CLI (PANEL via same task fn) | `generate.video`/`generate.image`/`workflow.node.run` → Runtime task; `task.get`/`task.cancel`/`task.resume` for lifecycle | OK — RuntimeTask + ProductionTask schemas exist (`tools/iris/contracts/runtime/schemas/`) |
| 9 | Durable artifact store | CLI / Runtime only | `runtime-artifacts/<dir>/<file>` + `{artifactId, sha256, byteSize, storeRelpath}` (`src-tauri/src/runtime/worker/local_media.rs:76-93`, persisted in task result `:319-324`) | OK for generation results; **gap** for host-imported/materialized refs — artifactRegistry.ts is session-scoped only (§4) |
| 10 | Import artifact → Media Pool (P0) | MCP first, BRIDGE fallback | `MediaPool.ImportMedia([{FilePath}])` preferred — it takes a bare path and returns `MediaPoolItem`s; `MediaStorage.AddItemListToMediaPool([{media: path}])` is the measured-but-path-picky alternative (backslash required) | `UNVERIFIED` on native MCP — R1 must try `ImportMedia` first; bridge today uses `AddItemListToMediaPool` (`main.js:64-66`). See §5 |
| 11 | Name/flag the imported item | MCP | `MediaPoolItem.SetName()` / `SetMetadata({…})` / `AddFlag()` / `SetClipProperty()` — write back `artifactId`/`sha256` | doc; enables durable mapping (§4) |
| 12 | Add candidate to new track (P1) | MCP | `Timeline.AddTrack('video')` → `MediaPool.AppendToTimeline([{mediaPoolItem, trackIndex, recordFrame, mediaType:1}])`; verify via `GetItemListInTrack` + `TimelineItem.GetStart/GetDuration` | doc + community-observed; **explicit instruction required** (gate §7) |
| 13 | Replace / Commit (P2) | MCP | Identity re-read → `Timeline.DeleteClips([item], rippleDelete?)` + `AppendToTimeline` at captured `recordFrame`, **or** take-based non-destructive path: `TimelineItem.AddTake(mediaPoolItem, startFrame, endFrame)` + `SelectTakeByIndex` | doc; `AddTake` is the safer P2 candidate — original stays as take 0. `UNVERIFIED` for our flow |
| 14 | Delete clips/tracks | MCP | `MediaPool.DeleteClips`, `Timeline.DeleteClips`, `Timeline.DeleteTrack` | confirm-gated; never auto |
| 15 | Render/export | MCP | `SetRenderSettings`/`AddRenderJob`/`RenderWithQuickExport`/`Timeline.Export` | out of P0 scope; explicit instruction |
| 16 | Unsafe arbitrary script / filesystem+network escape | **deny** | `run_script_unsafe`, `run_script` payloads importing `os`/`subprocess`/`socket`/`open` | deny by default (spec §9); bounded `run_script` already blocks these community-observed |
| 17 | Agent conversation / chat | external host | — | never in panel (spec §6, §7.1) |
| 18 | Workflow graphs / complex ops | CLI / PANEL | `workflow.inspect`/`workflow.apply`/`workflow.node.run` | unchanged; Resolve panel never owns a second timeline |

---

## 3. Target identity contract

`GenerationTask.target` must capture an immutable snapshot at submission; later UI selection changes MUST NOT retarget the pending task (spec §8 "Running", design §3.3).

### 3.1 Required fields

```text
target := {
  host:        'resolve',
  projectId:   string            // Project.GetUniqueId()
  timelineId?: string            // Timeline.GetUniqueId() — timeline-item source only
  sourceType:  'media-pool-clip' | 'timeline-item',
  itemId?:     string            // TimelineItem.GetUniqueId()
  clipId?:     string            // MediaPoolItem.GetMediaId() (NOT GetUniqueId — see below)
  track?:      { type: string, index: number }   // TimelineItem.GetTrackTypeAndIndex()
  locator:     Record<string, string|number>     // provider-neutral host locator (existing)
  label:       string            // display name
  kind:        'image' | 'video',
  mimeType?:   string,
  timeRange?:  { startFrame: number, endFrame: number,        // GetStart/GetEnd
                 sourceStartFrame?: number, sourceEndFrame?: number,  // GetSourceStart/EndFrame
                 startTimecode?: string },                    // Timeline.GetStartTimecode + derived
  currentFrame?: string          // Timeline.GetCurrentTimecode() at capture, still-frame refs only
}
```

Rules:
- Exactly one of `clipId` (Media Pool source) or `itemId` (Timeline source) is set. For a timeline item ALSO capture `clipId` from `TimelineItem.GetMediaPoolItem().GetMediaId()` — it links the item back to its pool clip for import dedup.
- `MediaPoolItem.GetMediaId()` is the documented media identity (`api-catalog-21.1`); `GetUniqueId()` also exists. Capture both: `mediaId` primary, `uniqueId` secondary (`UNVERIFIED` which is more stable across reopen — measure in R0).
- `locator` keeps the existing shape consumed by `hostSelectionResource` (`studioContract.ts:189-197`, `host-contract.js:2-10`); extend its payload rather than adding a parallel identity record.

### 3.2 What `host-contract.js` provides today vs missing

| Field | Today (host-contract.js / main.js) | Gap |
| --- | --- | --- |
| `host`, `selectionId`, `label`, `kind`, `mimeType`, `locator` | `normalizeSelection` (`host-contract.js:170-182`) | locator content is host-defined; Resolve currently puts `{projectId, clipId}` or `{projectId, timelineItemId}` (`main.js:126,132`) |
| `projectId` | in locator | OK |
| `timelineId` | **absent** | MISSING — timeline items cannot be re-found across reopen without it |
| `track` | **absent** | MISSING — `GetTrackTypeAndIndex()` not read |
| `timeRange` | **absent** | MISSING — no `GetStart/GetEnd`/timecode capture |
| `sourceType` | implied by which locator key exists | make explicit |
| `currentFrame` | **absent** | needed to re-materialize the same still |

Minimal locator upgrade (keeps shape, adds fields — no second identity system):

```text
locator.media-pool-clip: { projectId, clipId, mediaId? }
locator.timeline-item:   { projectId, timelineId, itemId, trackType, trackIndex, mediaId? }
```

`materializeClip`'s change-check already compares `locatorKey` equality (`main.js:136-137`, `host-contract.js:210`) — adding fields makes the check *stronger*, which is the desired direction, but also means any field that legitimately changes (e.g. user moves the item) now fails closed → reselect. That matches the frozen-target requirement.

### 3.3 Capture-then-freeze proof

Checklist §2 requires: capture identity → change selection in Resolve → prove the captured target does not follow the UI. The panel freezes `target.label` on the task row (spec §8); the CLI path freezes `target` inside the task record's request summary (design §4.2 "固定输入快照").

---

## 4. Durable artifact lifecycle

### 4.1 Current state vs contract

`importArtifact` was fixed: it now writes a content-named file into `app.getPath('userData')/artifacts` (`main.js:31-35`), verifies sha256 before reuse, writes a `.iris.json` manifest (`main.js:49-63`), and **never deletes** after `AddItemListToMediaPool` (`main.js:64-73`) — the comment at `main.js:48` already encodes the reference-vs-copy risk. Remaining gap: `materializeClip` still exports frame stills to `os.tmpdir()` + `unlinkSync` (`main.js:144-156`), and the `artifacts/` dir is a host-bridge-local store, not the Runtime `runtime-artifacts/` registry — two artifact homes now exist (§4.3).
### 4.2 Contract

```text
1. GENERATE    → Runtime writes bytes to staging, verifies sha256+byteSize,
                 atomically commits to  <artifactRoot>/runtime-artifacts/<dir>/<file>
                 (existing: local_media.rs:76-93,310-330)
2. MANIFEST    → artifact record = { artifactId, sha256, byteSize, createdAt,
                 providerTaskId, taskId, prompt, modelId, mimeType, kind,
                 sourceTargetSnapshot }
                 (existing IrisArtifact fields: studioContract.ts:53-68;
                  HostNativeCandidate already carries artifactId+sha256+providerTaskId:
                  studioContract.ts:111-125 — reuse, don't fork)
3. IMPORT      → hand Resolve the STABLE artifact path (never a tmp file)
4. KEEP SOURCE → Iris never deletes an artifact a project references
                 (design §4.3: "素材持有工程引用时不得自动清理")
5. MAP BACK    → write artifactId/sha256 onto the imported MediaPoolItem via
                 SetMetadata/SetClipProperty/AddFlag so reopening the project
                 can resolve clip → artifact version (op #11)
```

### 4.3 Where

- **Generation results**: existing Runtime artifact store (`runtime-artifacts/…`, `storeRelpath`) is the durable home — unchanged.
- **Panel-side session artifacts**: `services/studio/artifactRegistry.ts` is a 30-min, 64-entry **session cache** (`ARTIFACT_TTL_MS`, `MAX_ARTIFACTS`, lines 5-19) over workflow media blobs — NOT the durable store. The bridge path must resolve `artifactId → storeRelpath → absolute path` through the Runtime task result (as `evaluations/reddit-politics-2026-07-25/render-film.ps1:22-27` already demonstrates) instead of streaming `Blob → tmpdir → delete`.
- **Materialized references** (frame stills): same rule — export via `ExportCurrentFrameAsStill` directly into a versioned artifact path, register it; never tmp+delete.

### 4.4 Open question — `UNVERIFIED`, gates R1

**Does `MediaPool.ImportMedia` / `MediaStorage.AddItemListToMediaPool` reference or copy bytes?** Resolve almost certainly references (that is standard NLE media-pool behavior) — the old tmp+delete code only worked if a copy happened; the current durable-dir + keep-source bridge (`main.js:48-73`) already assumes reference semantics. R1 must still test: import artifact → close/reopen project → verify clip online and readable → restart Resolve → verify again (checklist §5).

---

## 5. Media Pool import path analysis

### 5.1 Candidates on the native-MCP plane

| Path | Call | Notes |
| --- | --- | --- |
| **A (preferred)** | `MediaPool.ImportMedia([{ FilePath }])` → `[MediaPoolItem]` | Direct media-pool verb; dict `ImportClipInfo` is the preferred 21.1 signature form; returns items enabling immediate `SetName`/`SetMetadata` mapping (op #11). `UNVERIFIED` through `run_script` — confirm dict payload round-trips |
| **B (fallback on same plane)** | `resolve.GetMediaStorage().AddItemListToMediaPool([{ media: path }])` | What the bridge uses today (`main.js:64-66`). Community-measured trap: **backslash paths required**; forward slash returns `[]` (`no mapped volume found`). On Windows, normalize `path → C:\…` before the call |
| **C (last resort)** | Workflow Integration bridge `importArtifact` IPC (`main.js:36-74`) | Only when A+B measurably fail on the installed build. Requires the Electron panel running; gives up Agent-driven operation. Record a gap (§5.2) before using |

Selection between A/B is a runtime decision inside the Agent's bounded script — try A, on falsy/`[]` result retry B with normalized backslashes, then record. Do NOT add an Iris-side `resolve.import` tool (spec §10 rule: no per-API wrappers).

### 5.2 Gap-record format

Every native-MCP shortfall gets a record before any bridge fallback is justified (design §2.1, checklist §3):

```json
{
  "version": "studio-21.1.0.14",
  "build": "<GetVersionString()>",
  "operation": "media-pool.import",
  "attemptedApi": ["MediaPool.ImportMedia", "MediaStorage.AddItemListToMediaPool"],
  "mcpTool": "run_script",
  "error": "ImportMedia returned [] with FilePath='C:/…' and FilePath='C:\\…'",
  "missingCapability": "media pool import via bounded script",
  "fallbackUsed": "workflow-integration-bridge",
  "evidence": "<script text (redacted), stdout, stderr, timestamp>"
}
```

Store under `artifacts/native-effects/resolve/` beside tracer evidence.

---

## 6. R0–R3 tracer acceptance (concrete)

Each gate produces evidence files, not prose claims. `UNVERIFIED` tags in this doc are lifted only by these runs.

### R0 — environment + native MCP connect (checklist §0-1, spec §12)

- [ ] record env: OS build, Resolve **Studio** exact build (`GetVersionString()` + `IsStudio()`), license, agent name/version, Iris commit, Node/Python — evidence `env.json`
- [ ] `File > Setup AI Assistants` → connect one real Agent → capture **actual** `tools/list` — evidence `mcp-tools.json` (the 14-tool community list is NOT our contract)
- [ ] `run_script` bounded probe: `resolve.GetProductName()/GetVersionString()/IsStudio()/GetCurrentPage()` — evidence `probe.json`
- [ ] UTF-8 tracer: ASCII + Chinese project/bin/marker names and Chinese text in generated script; record repro before any `PYTHONUTF8=1` workaround — evidence `utf8.json`
- [ ] `page-null` check: confirm behavior when Resolve sits on Project Manager (community: reads work, writes return None) — evidence `page-null.json`

### R1 — native MCP + Iris CLI, no panel dependency (checklist §2-3, spec §12)

Golden path, deterministic/fake artifact only:

- [ ] capture frozen target identity per §3 (project+timeline+item or clip, `mediaId`, track, timeRange) — evidence `target-identity.json`
- [ ] change UI selection after capture → prove task target unchanged — evidence `retarget-proof.json`
- [ ] one local deterministic Iris artifact in `runtime-artifacts` — evidence `artifact.json` `{artifactId, sha256, bytes, storeRelpath}`
- [ ] import via §5.1 A→B order — evidence `import.json` incl. which API succeeded
- [ ] Media Pool before/after diff (clip list snapshot) — evidence `mediapool-diff.json`
- [ ] timeline before/after diff (`GetItemListInTrack` per track + `GetStartFrame/GetEndFrame`) — evidence `timeline-unchanged.json`
- [ ] source-lifetime probe: reopen project + restart Resolve → imported clip still online — evidence `lifetime.json` (answers §4.4)
- [ ] stderr-drain client check on large `get_scripting_api` reply — evidence `stderr-drain.log`

### R2 — panel UI on real host (checklist §4, spec §7-8, §13 items 8-10)

- [ ] all 8 required states exercised on real Resolve — screenshot set
- [ ] Media Pool output-select defect fixed and re-verified (`main.js` bridge `{kind:'media-pool'}` vs generic select; spec §7.6, design §3.2, checklist §4)
- [ ] narrow/wide resize, no horizontal scroll, Current-Clip-first ordering
- [ ] candidate primary action = `Add to Media Pool`; `Open in Iris` preserves task context (lands in the Iris Workflow; the Iris tab once it ships)
- [ ] no ports/tokens/MCP JSON/chat in panel

### R3 — one real Provider (checklist §6, spec §12)

- [ ] one approved RunningHub route: selection → materialize → paid generation → durable artifact → Media Pool — evidence `provider-tracer.json` (model, route, providerTaskId, cost, hashes)
- [ ] cancel behavior; unknown-after-submit keeps task identity and queries, never double-submits
- [ ] 429 behavior if hit; reconnect/query path
- [ ] artifact lifetime rechecked end-to-end

R4/R5 remain post-R3: add-to-new-track (op #12) and replace/commit (op #13) each need their own evidence including the §7 recheck.

---

## 7. Safety gates

Direct implementation of spec §9 + checklist §9; adds the measured 21.1 crash boundary.

| Action | Default | Mechanism |
| --- | --- | --- |
| Read project/selection/metadata | auto | bounded `run_script` read payloads |
| Search Resolve API/docs | auto | `get_scripting_api`/`search_scripting_api`/`get_scripting_docs` |
| Prepare Iris generation plan | auto | CLI inspect; cost shown only when needed (spec §7.7) |
| Paid generation | confirm if outside approved scope | Iris cost gate; agent never bypasses (design §5.4) |
| Import result to Media Pool | low-risk, allowed after generation intent | §5.1 path A→B; non-destructive by construction |
| Add candidate to new track | explicit user/Agent instruction | op #12; re-verify track index + insertion range immediately before commit (checklist §7) |
| Replace timeline item | confirm + fresh identity recheck | op #13; conflict if captured target changed/disappeared — never "whatever is selected" (checklist §8) |
| Delete clips/tracks/timelines | confirm | `DeleteClips`/`DeleteTrack`/`DeleteTimelines` |
| Render/export to new path | explicit instruction | per spec §9 |
| Overwrite existing deliverable | confirm | per spec §9 |
| `run_script_unsafe` | **deny by default** | unbounded, runs in server process, timed-out scripts keep running (community-observed) — enabling it to make a demo pass is forbidden (spec §9) |
| `ArchiveProject` from script | **deny always** | community-measured crash on 21.1 — add to deny-list even inside "unsafe" exceptions |
| Payloads importing `os`/`sys`/`subprocess`/`socket`/`pathlib`, calling `open`/`exec`/`eval`/`compile` | deny | bounded `run_script` already blocks these (community-observed audit hook); Iris additionally denies at script-review gate |
| Generated scripts/logs containing private paths or credentials | redact before storing | checklist §9 |
| `Timeline.SetCurrentTimecode` during materialize | allowed but restore playhead | read `GetCurrentTimecode()`, restore after still export — playhead is user-visible state |

Repeated rule from spec §9: if the installed MCP exposes bounded + unsafe, bounded is the only default path.

---

## 8. Evidence wording

Until R0+R1 pass on the recorded environment, Resolve stays **Experimental** (`SUPPORT_MATRIX.md:29` — "native MCP 真实连接、selection → durable artifact → Media Pool tracer 仍是 External Gate"). Approved wording after MCP+P0 only (checklist, evidence wording):

> Resolve Studio 21.1 native MCP and Iris Media Pool generation/import flow were real-host validated on the recorded environment.

Never claim: Free Resolve support, full Resolve support, OFX support, or automatic safe timeline replacement — each needs its own gate.
