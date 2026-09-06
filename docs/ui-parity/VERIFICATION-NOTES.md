# Verification notes: 101-item acceptance map

Reviewed 2026-09-06. This document maps the existing acceptance IDs; it does **not** change acceptance.json or certify completion. B10 screenshots predate B11 origin-filter/export refinements and the final source fingerprint. Source inspection and unit tests are weaker evidence than a final packaged interaction. No new UI actions or external tabs were used for this review.

## Evidence and reference boundaries

- **B10 native images inspected:** [new task](</Users/ibrahimsaitakarcesme/Library/Application Support/Akorith Next Development/recovery-2026-09-06/B10/new-task.png>), [Plugins](</Users/ibrahimsaitakarcesme/Library/Application Support/Akorith Next Development/recovery-2026-09-06/B10/plugins.png>), [Research result](</Users/ibrahimsaitakarcesme/Library/Application Support/Akorith Next Development/recovery-2026-09-06/B10/research-real-results.png>). These establish visible states, not transitions.
- **B10 exported comparison inspected:** [two videos](</Users/ibrahimsaitakarcesme/Library/Application Support/Akorith Next Development/recovery-2026-09-06/B10/benchmark-video-comparison.png>). This is an exported HTML page, not the native BenchmarkPage.
- **Research receipts inspected:** [backend run](</Users/ibrahimsaitakarcesme/Library/Application Support/Akorith Next Development/recovery-2026-09-06/B10/research-live/run-towyCz/receipt.json>), [independent review](</Users/ibrahimsaitakarcesme/Library/Application Support/Akorith Next Development/recovery-2026-09-06/B10/research-live/run-towyCz/independent-source-review.json>). Authenticated Codex/Engine/evaluator ran; original project unchanged. 214841 integer cases passed; fractional/Infinity equivalence failed. Metric is counted operations in this fixed local fixture, not measured general speedup, GPU research or scientific validity beyond the protocol.
- **Video receipts inspected:** [decode](</Users/ibrahimsaitakarcesme/Library/Application Support/Akorith Next Development/recovery-2026-09-06/B10/benchmark-real-browser/run-1788708282547/video-verification.json>), [clip playback](</Users/ibrahimsaitakarcesme/Library/Application Support/Akorith Next Development/recovery-2026-09-06/B10/export-clips-playback.json>), [run-aligned seek](</Users/ibrahimsaitakarcesme/Library/Application Support/Akorith Next Development/recovery-2026-09-06/B10/export-run-timeline.json>). Two real H.264 at 1280×720 files decoded; durations 116 s / 87.56 s, 108 / 81 frames. Sampling is roughly 1 Hz and capped at five minutes. It cannot validate frame-accurate transitions or full desktop recording. One variant completed and the other was cancelled.
- **Reference:** [official static screenshot](https://learn.chatgpt.com/images/codex/app/codex-app-basic-dark.webp), [official playable demo audit](REFERENCE-MOTION.md). The latter observed outline controls, browser tabs, anchored comments and successive layouts. **No exact Codex duration, easing, spacing or icon geometry was measured.** Research/Benchmark have user-driven requirements, not an observed Codex equivalent.
- **Tests:** existing renderer tests plus research.test.ts, benchmark.test.ts, benchmark-runtime.test.ts, benchmark-video.test.ts and plugins.test.ts were inspected. The delegated lab slice last passed 8 focused tests and typecheck; final whole-suite/package verification remains root-owned. A named test below describes its actual bounded coverage, not a new execution claim.

## Source design values

Current desktop.css overrides base tokens: dark main #111111, sidebar #202124, surface #252525; light main #fff / sidebar #f4f4f4. Header 49px; outline icon stroke 1.65; typical icon button 29px; composer radius 18px. Base hover 120ms, standard 180ms, panel 220ms; base easing cubic-bezier(.2,.8,.2,1); desktop enter easing(.16,1,.3,1). These are authored choices. Lab page max 1120px, form 780px, study navigation 250px, heading 26px; responsive layout changes at 1100/900px. No equality to Codex is implied.

## Acceptance matrix

Every row states a review criterion, evidence already available, and remaining checks. All final-source visual/motion sign-off remains pending unless the root records fresh fingerprint-bound evidence separately.

### Shell

| ID · requirement | Concrete criterion / source behavior | Available evidence | Still required / limitation |
|---|---|---|---|
| SHELL-001 · window chrome placement | Traffic lights remain separate from clickable header controls; source x18/y19. | B10 new-task image; native window source. | B11 chrome/hit-test check. |
| SHELL-002 · sidebar surface contrast | Dark sidebar #202124 versus main #111111; neutral selection. | B10 new-task/plugins images; desktop.css overrides tokens. | Reference color values not sampled; light theme review. |
| SHELL-003 · main surface contrast | Main #111111; composer #252525; readable muted text. | B10 new-task image. | Contrast measurement and final-package inspection. |
| SHELL-004 · default dimensions | Source default1440×920, minimum760×560; remembered size respected. | index.ts; B10 image1272×768. | Default versus restored-size launch check. |
| SHELL-005 · resize handles | Sidebar/panel resize without content or native view escaping. | App.tsx width persistence and clamping. | Pointer and keyboard resize in final package. |
| SHELL-006 · narrow window containment | At760px, heading/controls remain reachable; no clipped native surface. | Responsive CSS exists. | Minimum-width native review; no B10 narrow evidence. |
| SHELL-007 · header action alignment | 49px header with small outline actions on one row. | B10 new-task image; desktop.css. | Hit areas and exact reference spacing. |
| SHELL-008 · sidebar collapse focus | Collapse moves focus to visible navigation heading. | App.tsx explicit focus. | Native keyboard confirmation. |
| SHELL-009 · panel collapse focus | Close restores focus to workspace-panel toggle. | App.tsx explicit focus. | Native close/reopen/tab-order check. |
| SHELL-010 · no idle animation | No idle welcome animation; active-only pulse/spinner. | desktop.css disables welcome motion; historical transcript tests. | Idle native observation; no continuous trace. |

### Navigation

| ID · requirement | Concrete criterion / source behavior | Available evidence | Still required / limitation |
|---|---|---|---|
| NAVIGATION-001 · new task | New task creates/selects a task and focuses prompt. | B10 new-task image; App action. | B11 keyboard and pointer journey. |
| NAVIGATION-002 · search | Search finds project/task titles without changing task data. | Sidebar/search source. | Query, empty result, Escape and focus flow. |
| NAVIGATION-003 · plugins page | Plugins is an independent destination, not settings-only. | B10 plugins image. | B11 navigation retention. |
| NAVIGATION-004 · research page | Research opens study list/detail with project context. | B10 research-real-results image. | Final form defaults and route return. |
| NAVIGATION-005 · benchmark page | Benchmark opens comparison destination. | B10 benchmark-empty image available; source. | B11 populated native comparison. |
| NAVIGATION-006 · selected section | One selected destination/task is distinguishable. | B10 plugins/research/new-task selected rows. | Selection after history navigation. |
| NAVIGATION-007 · project expansion | Project disclosure preserves task reachability. | B10 expanded project rows; sidebar tests. | Collapse/reopen with keyboard. |
| NAVIGATION-008 · task selection | Task changes preserve drafts, panel state and history. | taskNavigation/composerDraft tests. | Native repeated task switches. |
| NAVIGATION-009 · long title truncation | Single-line labels ellipsize instead of widening sidebar. | B10 research/project truncated titles; sidebar tests. | Accessible full label and narrow width. |
| NAVIGATION-010 · history back and forward | Back/forward skips unavailable tasks and respects editors. | taskNavigation tests incl shortcuts/history bounds. | B11 Cmd-bracket and Alt-arrow behavior. |

### Composer

| ID · requirement | Concrete criterion / source behavior | Available evidence | Still required / limitation |
|---|---|---|---|
| COMPOSER-001 · centered empty composer | Empty composer centered with max820px region. | B10 new-task image; desktop.css. | Final narrow/large window placements. |
| COMPOSER-002 · single line heading | Heading remains restrained, clamp21–28px at ordinary widths. | B10 one-line heading. | Long/localized heading; no reference pixel equality. |
| COMPOSER-003 · attachment button | Paperclip affordance opens actual attachment picker. | B10 visible icon; attachment scope tests. | Native picker cancel/add/remove. |
| COMPOSER-004 · permission selector | Permission choice remains explicit and readable. | B10 Workspace access visible; Composer source. | All modes keyboard selection and persistence. |
| COMPOSER-005 · model selector alignment | One provider/model trigger on lower row, actual catalog only. | B10 Astra/Codex; modelPicker tests. | Large catalog popup geometry. |
| COMPOSER-006 · reasoning selector | Effort choices come from selected model capabilities. | B10 High; modelPicker tests. | Model switch to model without effort. |
| COMPOSER-007 · send circle icon | 29px circular upward send action, empty disabled. | B10 image; desktop.css. | Reference glyph geometry not measured. |
| COMPOSER-008 · stop icon | Active turn shows square Stop, settling state prevents repeat work. | Composer source; cancellation tests. | B11 active visual state and settled response. |
| COMPOSER-009 · growing textarea | Textarea grows to220px then scrolls without pushing footer away. | Composer scrollHeight cap. | Multiline native typing/paste. |
| COMPOSER-010 · keyboard mention list | Mention list supports arrows/Enter and stale-query rejection. | fileMention tests; prior B09 keyboard acceptance recorded. | B11 popup clipping/focus. |
| COMPOSER-011 · Shift Enter newline | Shift+Enter newline, Enter send, composition guarded. | Composer event handling; mention tests. | Native IME and ordinary input. |
| COMPOSER-012 · empty send disabled | Whitespace/empty draft cannot send. | B10 disabled arrow; Composer conditions. | Attachment-only intended behavior review. |
| COMPOSER-013 · queue controls | Queued prompts expose edit/reorder/remove with real state. | Prior B03 queue acceptance in FINDINGS; source. | B11 queue density and controls. |
| COMPOSER-014 · pending persistence | Synchronous draft journal reconciles accepted request IDs. | composerDraft tests incl restart/uncertain ack. | Final package restart without duplicate submit. |

### Conversation

| ID · requirement | Concrete criterion / source behavior | Available evidence | Still required / limitation |
|---|---|---|---|
| CONVERSATION-001 · prompt departure transition | Prompt moves into transcript; stable follow-up composer. | Source branch/layout; official video shows follow-up state. | Actual departure timing/easing unmeasured. |
| CONVERSATION-002 · streamed text layout | Streaming Markdown preserves readable14px/1.7 layout. | Transcript source and desktop.css. | Live long streaming output on B11. |
| CONVERSATION-003 · activity row density | Compact activity rows, bounded100-codepoint command summaries. | transcriptHistory tests; activity CSS. | Active row spacing against reference. |
| CONVERSATION-004 · activity expand | Expand reveals exact tool detail, no invented command. | Historical multiline summary regression test. | Native click/focus and motion. |
| CONVERSATION-005 · activity collapse | Collapse hides detail while retaining summary and state. | Disclosure grid0fr/1fr source. | Native keyboard/motion and interruption. |
| CONVERSATION-006 · code block wrapping | Long code stays contained and readable. | Transcript Markdown rendering/styles. | Wide code and long-token native review. |
| CONVERSATION-007 · copy feedback | Copy confirms with check icon only after copy path. | Transcript copied state. | Clipboard result and feedback duration. |
| CONVERSATION-008 · approval card | Approval keeps real request/command scope and answer choices. | taskReadState and wildcard approval tests. | B11 actual pending card layout. |
| CONVERSATION-009 · error state | Errors preserve partial output and explicit outcome. | transcriptHistory failed/interrupted tests. | Long error wrapping and recovery focus. |
| CONVERSATION-010 · retry path | Retry does not silently duplicate uncertain submissions. | composerDraft request-ID tests. | Visible retry journey after actual failure. |
| CONVERSATION-011 · follow-up flow | Follow-up uses same task/provider context and bottom composer. | Official video follow-up frame; source. | B11 real second turn. |
| CONVERSATION-012 · scroll following | Auto-follow only near bottom; threshold64px. | Transcript source scroll handling. | Continuous native stream observation. |
| CONVERSATION-013 · manual scroll respected | Manual scroll retains position; older-page prepend preserves offset. | Transcript saved positions and100-message paging. | B11 scroll while tools stream. |
| CONVERSATION-014 · final result typography | Final Markdown, links and evidence remain clear without fake success. | Historical transcript tests; official final-result frame. | Final native typography/reference comparison. |

### Plugins

| ID · requirement | Concrete criterion / source behavior | Available evidence | Still required / limitation |
|---|---|---|---|
| PLUGINS-001 · independent page navigation | Sidebar destination and heading separate from Settings. | B10 plugins screenshot. | B11 final route. |
| PLUGINS-002 · search field | Search visible and filters actual catalog metadata. | B10 field; PluginsPage source. | Query/clear/empty interaction. |
| PLUGINS-003 · installed filter | Installed/Enabled views reflect registry; origin filter distinct. | B10 installed tab; B11 origin polish source pending package. | Final origin filtering QA. |
| PLUGINS-004 · plugin row icon | 47px icon container with neutral outline glyph. | B10 plugin row; desktop.css. | No claim exact Codex glyph matching. |
| PLUGINS-005 · plugin description | Name, description and capability counts readable. | B10 actual acceptance fixture row. | Long metadata and empty description. |
| PLUGINS-006 · details panel | Detail dialog560px bounded65vh, close/focus trap. | PluginsPage and Modal source. | Final native detail and keyboard. |
| PLUGINS-007 · skill contents | Declared skill metadata/contents remain inspectable. | contextPlugins tests; plugin backend strict schema. | Native detail expansion of real skill. |
| PLUGINS-008 · MCP contents | Declared MCP packages shown without claiming connected runtime. | contextPlugins tests; plugin fixture row. | Final missing/disabled server detail. |
| PLUGINS-009 · import local | Import inspection executes nothing; starts disabled. | plugins.test.ts inspection/copy/security cases. | B10 fixture registry observed; fresh import UX final. |
| PLUGINS-010 · enable state | Explicit enable activates selected immutable version. | B10 plugin-enabled.png; backend activation tests. | B11 enabled filter after change. |
| PLUGINS-011 · disable state | Disable ends selection, retains needed active copies honestly. | plugins.test.ts usage/retention tests. | Native disable and revert journey. |
| PLUGINS-012 · version selection | Version choice never silently switches active assets. | plugins.test.ts immutable-version/stale-inspection tests. | Native multi-version selection. |

### Research

| ID · requirement | Concrete criterion / source behavior | Available evidence | Still required / limitation |
|---|---|---|---|
| RESEARCH-001 · study creation | Form requires goal/project/model/evaluator; defaults only actual valid context. | labPages defaults test; B10 backend created real study. | B11 native create with new defaults. |
| RESEARCH-002 · goal and hypothesis | Goal/hypothesis persisted and visible in20px detail header. | B10 research-real-results screenshot. | Long-text responsive review. |
| RESEARCH-003 · metric direction | Minimize/maximize determines strict comparison. | research.test.ts strict-improvement tests; B10 lower metric. | Native maximize form path. |
| RESEARCH-004 · fixed evaluator protocol | Pin protocol/script/dependency hashes; reject protected edits. | research.test.ts dependency/script protection; receipt hashes unchanged. | Evaluator dependencies are declared, not auto-discovered. |
| RESEARCH-005 · baseline run | Untouched baseline measured before candidate. | Real receipt baseline133867; source untouched. | Only local integer fixture proven. |
| RESEARCH-006 · isolated candidate | Detached worktree per experiment from recorded source commit. | Real receipt separate cwd; isolation/commit tests. | No GPU or remote research proof. |
| RESEARCH-007 · host measured evidence | Host stdout finite metric, hash/exit/duration; no model-supplied score. | Real receipt + independent integer review. | Operation counts are not wall-time speedup. |
| RESEARCH-008 · keep discard decision | Strict improvement keep; regression discard; override reason required. | B10 candidate2297 kept; backend regression tests. | Native manual override path. |
| RESEARCH-009 · bounded iteration count | 1–20 experiments including baseline,1–120minute budget. | Source validation; B10 bounded2/2 result. | Long-budget exhaustion UX not run. |
| RESEARCH-010 · pause and resume | Stop leads paused state; continue resumes bounded history. | research.test.ts stop/journal tests; SSR stop controls. | Native running→stopping→paused→continue flow. |
| RESEARCH-011 · stop child processes | Stop waits for owned evaluator and Engine turn quiescence. | research.test.ts real process/Engine stop tests. | Final native stop interaction, not broad OS cleanup claim. |
| RESEARCH-012 · reopen history | Persisted study reopens with measurements and decisions. | B10 populated native screenshot; journal tests. | B11 relaunch; async stale-response behavior not UI-tested. |

### Benchmark

| ID · requirement | Concrete criterion / source behavior | Available evidence | Still required / limitation |
|---|---|---|---|
| BENCHMARK-001 · comparison type | Compare actual model/tool profiles; no synthetic ranking. | BenchmarkForm source and labPages tests. | B11 populated native form/detail. |
| BENCHMARK-002 · same immutable prompt | One immutable prompt hash shared across variants. | benchmark.test.ts bind/prompt reuse guards. | B10 real run manifest; final export hash binding. |
| BENCHMARK-003 · model variants | 2–8 distinct editable variant slots; real catalog defaults. | labPages initial variants test; real MiMo A/B recordings. | Final provider switch UI. |
| BENCHMARK-004 · method variants | Default/browser/computer/MCP/custom method recorded explicitly. | Preset scope tests; BenchmarkForm. | Native browser run uses default, not claimed restriction. |
| BENCHMARK-005 · method capability restrictions | Restricted scope enforced only for Ollama host methods; native rejected. | runtime forged-tool/context tests and labPages guard. | Native provider tool scope remains unverified. |
| BENCHMARK-006 · real duration | Monotonic execution duration ends after quiescence. | benchmark timing tests; export135.93s completed/102.96s cancelled. | Not comparable as equal successful outcomes. |
| BENCHMARK-007 · reported tokens | Show reported tokens; absent values remain unknown. | B10 export12952 input/629 output for A; B unavailable. | Source repaired: null total now shows reported input/output components, explicit unknown parts and estimated suffix; no computed sum. Regression covers both parts, partial/zero/absent data. Fresh native package verification pending. |
| BENCHMARK-008 · reported cost | Reported zero cost is0; missing is unavailable. | B10 export A$0/B unavailable; null-v-zero tests. | No invented subscription per-run pricing. |
| BENCHMARK-009 · missing data state | Missing duration/token/cost is not coerced to0. | benchmark restart + labPages tests. | Final native missing-state readability. |
| BENCHMARK-010 · side by side output | Two readable outputs/evidence columns with independent variant selection. | B10 export screenshot; native presenter tests. | Export screenshot is not native BenchmarkPage proof. |
| BENCHMARK-011 · video synchronization | Play both clip beginnings; exported run alignment uses real offsets. | export-clips-playback.json both~51.271s; run40s offsets receipt. | ~1Hz samples, no frame-accurate motion proof. |
| BENCHMARK-012 · playback seeking | Export slider seeks playable media; metadata gate handles load/restart. | export-run-timeline.json; export playback tests. | Native preview only individual seeking; parity pending. |
| BENCHMARK-013 · artifact association | Receipt membership and hashes bind artifacts to variant. | benchmark evidence containment tests; video decode receipt. | Automatic capture is own task browser only. |
| BENCHMARK-014 · export results page | Portable HTML copies exact media and escapes output. | Real export manifest + successful H264 decode; playback receipts. | B11 export polish requires final new receipt. |
| BENCHMARK-015 · human quality judgement | Reviewer notes persist; no percentage/winner computed. | benchmark notes tests; B10 export human-judgement heading. | Native notes save/reopen QA. |

### Motion

| ID · requirement | Concrete criterion / source behavior | Available evidence | Still required / limitation |
|---|---|---|---|
| MOTION-001 · sidebar enter | Sidebar width enter220ms with coordinated native-view hide. | Source panel token/layout coordination; navigation barrier tests. | Reference timing and native animation trace absent. |
| MOTION-002 · sidebar exit | Sidebar exit220ms; focus leaves hidden content. | Source coordination/focus. | Rapid reversal and final focus native QA. |
| MOTION-003 · right panel enter | Right-panel enter220ms with settled geometry reattach. | Layout/native attachment source + barrier tests. | Frame trace and Codex easing comparison. |
| MOTION-004 · right panel exit | Right-panel exit removes native occlusion before collapse. | BrowserPanel layout/source and hidden-capture regression. | Final packaged rapid close. |
| MOTION-005 · page change | Destination page180ms,6px upward enter. | desktop.css destination-enter; lab detail180ms4px. | These are implementation choices, not measured Codex values. |
| MOTION-006 · model menu enter | Model menu uses restrained enter; keyboard focus retained. | ModelPicker source and search/selection tests. | Actual popup enter duration/reference trace. |
| MOTION-007 · modal enter | Modal backdrop140ms; dialog180ms translate8px scale.985. | desktop.css + Modal source. | Native enter/focus and reference timing. |
| MOTION-008 · modal exit | Modal exit110ms translate5px scale.99; disable closing pointer action. | desktop.css closing class; Primitives110ms unmount. | Native Escape/reopen race and focus. |
| MOTION-009 · disclosure expand | Disclosure expand grid0fr→1fr180ms; opacity120ms. | desktop.css disclosure-motion. | Content-height changes and precise comparison. |
| MOTION-010 · disclosure collapse | Disclosure collapse reverses grid/opacity, hides overflow. | desktop.css source. | Keyboard collapse/focus and rapid toggles. |
| MOTION-011 · interrupted transitions | Interrupted layout work must restore latest requested bounds. | Native attachment serialization and hidden capture tests. | Visual sidebar/panel reversal on final package. |
| MOTION-012 · reduced motion | Reduced-motion disables transitions/loops and smooth scroll. | tokens.css0.01ms/oneiteration; desktop/lab overrides; Transcript auto. | OS preference live toggle and resulting native geometry. |
| MOTION-013 · no native view occlusion | Native browser never covers dialog/menu/closed panel. | Host hidden real-pixel capture/cleanup tests; source hide barrier. | B11 overlay stack in active-browser UI. |
| MOTION-014 · focus restoration | Close/menu/navigation return focus to existing visible control. | Modal restores prior focus; App explicit focus targets. | Full final keyboard circuit and reference behavior. |

## Delivery safeguards

The runtime Stop hook configuration exists, but runtime trust/execution has not been proven. Do not describe it as active enforcement. The configured Git pre-push guard has actually been tested to fail; that is a separate mechanism. Exact motion parity, final B11 UI coverage, unrestricted native-provider tool enforcement, GPU research, and frame-accurate recordings remain outside proven acceptance. No automatic percentage, padded checklist, or line-count proxy is used.

## Final B12 observation addendum

Source d884f78, alpha12. This supersedes earlier final-package pending notes only for the following observations: native token fallback12,952input/629output; missing values unchanged; Markdown output; media above output; both actual videos played and paused17.6136/17.6132s; human assessment saved and persisted after page unmount/reopen. Evidence native-B12-paused-videos.txt, native-B12-benchmark.png, native-B12-assessment-reopened.txt under B10. B11 background power interruption is historical; B12 foreground playback passed without disabling power protections. No native seeking or precise animation equivalence claim.

New task and installed Plugins captured in native-B12-new-task.png/native-B12-plugins.png after normal Quit of QA profile and updated launcher reopening B05/live-data.315/315 tests and typecheck passed.12 functional IDs were verified within explicit bounds in acceptance.json;89 remain open. Historical Research evidence was bound through reviewed unchanged evaluator/worktree logic plus current tests, not relabeled as a new execution. See functional-review-B12.md and source-receipt-B12.json.
