# Akorith V2 findings

## 2026-09-04 implementation start
- User authorized overnight work and parallel agents without routine approvals.
- Fresh full checkout on rebuild/workspace-v2, baseline 1d5af3abe3036b15e4558697b017970f8f4766b5 from origin/main. Old symlink broken; remote source selected under full implementation authorization. No local user changes overwritten.
- macOS 26.6 arm64 8 GiB. Node 22.22.2, Codex CLI 0.144.6, Claude Code 2.1.220, Ollama 0.31.1, OpenCode and Swift 6.3.3 present.
- V2 isolated in v2/; existing app/data preserved. Shared contracts established.
- Auth, live provider calls, native browser/computer operation and packaged tests pending.

## Next
Provider, renderer and host agents implement owned modules. Root implements storage, engine, bootstrap and integration. Do not claim readiness before real tests.

## Cycle 2 — genuine runtime and persistence (2026-09-04 22:10 UTC)

- Public Codex npm runtime 0.153.3 discovers GPT-6 Astra; live Astra host `files_read` round trip passed. Installed system CLI 0.144.6 remains untouched.
- Ollama qwen3:1.7b downloaded locally; real files_read tool loop passed. Model is installed, not bundled into the app.
- OpenCode Go authentication/catalog discovered, but a paid model returned insufficient balance. Separately selected free MiMo V2.5 completed real streaming, approval, MCP file read and final response. No silent billing/provider fallback.
- Claude CLI is installed but its status reports unauthenticated. Native adapter is implemented; paid/authenticated Claude generation cannot be claimed tested.
- Engine tests caught and fixed shutdown writes racing database close, pending approvals overwritten by running status, and millisecond timestamp history ordering. Nine engine behavioral checks passed.
- 29 combined provider/host/engine checks passed. A further legacy migration test passed with idempotency, unchanged source bytes, preserved dates, interrupted output, usage, activities and copied attachments.
- Swift computer helper compiled ARM64; read-only probe reports Accessibility and ScreenRecording granted for its current launch context. Own packaged app permissions still need verification.
- V2 queue prompt editing/removal implemented. Each queued turn snapshots provider/model/effort/mode at submission.
- Electron data path is separate and single-instance locked; source app and original history untouched.
- CUA refused direct inspection of com.openai.codex. No attempt to bypass that restriction; visual work uses the approved product behavior/specification and own app verification.

## Cycle 3 — integrated desktop verification (2026-09-04 22:23 UTC)

- The real Electron UI launched from the production bundle and discovered the public Astra catalog. A real prompt created a self-contained index.html, started the managed preview, used browser form controls, and verified the added task in the DOM.
- Switching to another task preserved its draft. Switching back exposed duplicate transcript DOM despite correct persisted records. Root identified identical sibling React keys on Transcript and Composer; the UI agent fixed them with distinct prefixes. A full packaged regression is pending.
- Fixed renderer output path resolving outside the project. Root/preload/renderer now share the expected out-v2 tree.
- 41 behavior tests passed in the combined suite, including queue edits/removal and persistent cross-provider continuity. Later provider/host extensions add more cases; final counts will come from a fresh run.
- Native provider instruction inheritance caused an unnecessary Sites skill detour. Public Codex skills.include_instructions=false was verified in a fresh live turn: exactly one host files_write, no SKILL.md/native-exec detour. Akorith-selected skill instructions still pass explicitly.
- Skills are scoped by project and enabled skill directories are readable through a read-only registered-root allowance. Disabled/other-project skill directories and external symlinks are excluded.
- Codex and OpenCode native session resumption passed after provider process restart. Live host-tool cancellation samples: Codex54ms, Ollama1ms, OpenCode57ms (samples, not p95 claims).
- Public macOS application packaging underway with a separate bundle ID, native helper, public Codex binary and ad-hoc signature. Original installed Akorith remains unchanged.
- External UI blocker: CUA's attempted inspection of the development Electron app opened macOS's Desktop access prompt for Codex Computer Use. CUA refuses control of UserNotificationCenter. No permission was granted and no alternate mechanism was used to dismiss/bypass it. Foreground computer tests pause; CDP/browser, persistence and packaging tests continue. Native select/snapshot/click/type/capture had genuinely passed before the prompt appeared.

Packaging finding: macOS File Provider recreates FinderInfo attributes on app/framework bundles under the synced Desktop. Ad-hoc signing correctly rejected these bundles. Build packaging moved to ~/Library/Caches/AkorithNext/build; afterPack removes only FinderInfo/ResourceFork, preserving provenance/quarantine and other access controls. No signature checks are disabled.

## Source access restored — 2026-09-05T02:56:30Z

Original AGENTS read succeeded in6ms; normal git status and source reads now work. rebuild/workspace-v2 and all uncommitted work remain intact. Previous stall cause is unproven; no OS permission/action or alternate source path was used. Root and the3existing agents resumed actual engine/provider/renderer/host implementation. G06 access is restored; G01–G05 still open, B01 is not current source. Durable evidence and P01–P28 inventory remain at /Users/ibrahimsaitakarcesme/Library/Application Support/Akorith Next Development/recovery-2026-09-05. Current reviewed process candidate has14focused and6live tests, still awaiting source integration at this checkpoint.

## 2026-09-05T03:13:37.751148+00:00 — resumed integration cycle

- Normal source access restored at02:56:30Z; original path and branch intact. No alternate access/OS permission change. All3existing agents resumed implementation.
- Root: native outcome event tracked independently from quiescence; Stop/Quit during delayed successful cleanup preserves success/usage; original native failures retained; cleanup waits survive persistence faults, new work pauses after storage failure; provider callback storage errors no longer escape into native event loops. Scoped cleanup retry avoids collateral adapter disposal where available.
- Root: idempotent shutdown coordinator settles engine/host/extensions/discovery/accepted IPC independently, retains timed-out operations for retry and closes Store only afterward. No force app.exit on unresolved cleanup; repeated Quit cannot skip ownership. Added diagnostics and fixed discovery errors retaining Checking label.
-21root focused checks pass. Providers report40focused synthetic checks; renderer17state/render checks; host42cases with actual disposable PTY foreground/background and early-leader-exit survivor cleanup plus process preview stop. These counts overlap previous reports and are NOT a fresh full-suite total or GUI acceptance. Extension lifecycle tests are still finishing.
- Renderer CAS/checkpoint guards, bounded sidebar and synchronous composer journal are implemented. Exact submissionStatus receipt prevents accepted-but-unacknowledged prompts resurrecting after restart.
- New package will beB02/version2.0.0-alpha.2 in separate cache build-B02, preserving oldB01. Native process-session helper packaging filter added. No B02 build or readiness claim yet.

## 2026-09-05T03:21:19.532331+00:00 — B02 package acceptance

- Fresh complete current suite:142passed,0failed,0skipped in10.39s under Electron44 Node mode; typecheck passed. Prior full run139passed/2failed retained as reproduced helper-classification defect, now fixed with preflight-before-PTY regression. No parent process kill concealed the original failure.
- B02 alpha.2 built at /Users/ibrahimsaitakarcesme/Library/Caches/AkorithNext/build-B02/mac-arm64/Akorith Next.app; app.asar SHA2563908e4f447bd8270cb73a33c87e58bba7b77d80bb22572ede7654e5ec10b575c. App deep/strict and both native helpers signature verification pass. Ad-hoc, not notarized. B01 and original app/data preserved.
- Real packaged journey launched against fresh synthetic user data. Native two-turn continuation, CAS UI recovery, normal Quit/immediate draft reopen are pending actual result. Current suite proves code behavior; not blanket product readiness.

## 2026-09-05T03:28:34.049010+00:00 — packaged findings and B03 preparation

- B02 actual Astra2turns bothcompleted withnative session andUTF8file preserved. Actualfilelink failed becauseproject canonical/private/var root rejected equivalent/var path. Sourcefix recognizes onlyaliases ofexactworkspace root thenchecksallremainingsegments;48hosttestspass includingaliasCAS/escape/danglinglinkcases.
- B02 normal Quitmenu andactualCmdQviaCUA succeeded;exactPIDs52975/53034absent,storedconversation/draft/nativeIDreopened. These2quitchecksusedreopeneddatafrompriorrealruns; B03freshrealturn+nativeQuit andlivePTY/browser/preview Quit arestillpending. Observationwindowincludesoperatorwait,notshutdownlatency. EarlierCDPMetaQtimeoutisharnesslimitation,notnativeQuitfailure.
- P27attachmentopenroutescurrentlyunderrepairinrenderer;readonlyimagepreviewmustuseexistingtaskmediaauthoritywithoutworkspaceeditingfallback. Scopeauditdocs/current-product-gap-audit.md recordsfullplugin/automation/goal/agent/remotegaps.
- NewB03alpha.3willincludealias+attachmentfixes. Protocol3performanceharnessreadybutnotrun;no3runorblanketreplacementclaim.

## 2026-09-05T03:32:21.979525+00:00 — current B03

- Current full suite152passed/0failed/0skipped in10.44s, tscpassed. B03alpha.3 signed app/nativehelpers deep strictverificationpass; asar628810d2e637b940d178a79896fd83915dd47167eaaa9206a56790703438cddb, CDHash4b3f5fcf776b0af40b119816370bfadd5f96da1e.
- Fresh B03realAstra2turns/resume/UTF8completed; actualCUA paste-newdraft thenimmediateCmdQ requestedafterthoseturns. Reopen/CAS/hostacceptanceharnessrunning.
- Readonlylegacyaggregate1project/25sessions/97messages; noactualmigration.21legacyrunningactivities and timed_out wouldbe falselymappedcompleted; reviewmustfixbeforeimport. Usercontentnotprinted.

## 2026-09-05T03:42:22.113926+00:00 — B03 real journeys passed; B04 fidelity work begun

B03 core journey and six-turn connected workflow passed on the frozen identified package. Actual CUA immediate draft/CmdQ/reopen and Quit with live PTY/preview were exercised. OpenCode second native turn now stays completed after cleanup. Browser form completed via actual Astra host tools. Evidence in B03/journey-1 and B03/connected-1. Three fresh protocol-3 performance runs started with the matching Electron readonly SQLite reader after a preserved no-launch CLI preflight failure. Root and host are writing B04 migration fidelity changes; no new build/tests/models run concurrently with measurements. B03 no longer includes newest source edits. Actual legacy import and installation remain pending.

## 2026-09-05T03:48:42.155291+00:00 — Three B03 performance runs passed

Protocol3 same package/harness/protocol hashes; three fresh1000task/10000message fixtures,120s each. Input p95 30.7/31.2/31.4ms; switch p95 158.8/144.6/133.7ms. No JS errors/forced cleanup. Synthetic2min scope, no competitor/leak claim. Comparison: /Users/ibrahimsaitakarcesme/Library/Application Support/Akorith Next Development/recovery-2026-09-05/B03/performance-v3-series-2/comparison.json. B04 root19focused tests passed. B03 UI queue/Stop confirmed332ms and shell/sleep absence;95s deadline and pending native Quit underway.

## 2026-09-05T03:50:29.976064+00:00 — B03 Stop and native pending Quit passed

Actual Astra terminal_execute fixture, edited/reordered/removed UIqueue, Stop332ms, zero lease/queue/active, confirmed shell/sleep absence and no late write through original95s deadline. Actual OpenCode MCP files_read approval left unanswered; root CUA selected exactB03app, observed approval card, pressed nativeCmdQ. Main69564 and9observed descendants absent. Reopened69904 retains history/nativeID andinterrupted status with no pending replay. Finalownedcleanup succeeded/no forcedkill. Evidence /Users/ibrahimsaitakarcesme/Library/Application Support/Akorith Next Development/recovery-2026-09-05/B03/cancellation-1/cancellation.json. B04 migration20 andreceipt5focused tests passed; still not packaged/imported.

## 2026-09-05T03:52:03.130171+00:00 — Performance series comparability corrected

All3B03individual runs passed, but root identified its concurrent Store attribution edit affected subsequent seed payloads: run1has0attributedmessages,run2/3have10000. The frozen B03 renderer ignores the new field; nevertheless strict same-input comparison is withdrawn andG03reopened. Earlier “three comparable” entries are superseded by this correction. FinalB04will preseed all3fromsamefrozenStore, recordseed/storehashes, thenrun.

## 2026-09-06 — Resumed implementation in independent checkout

Preserved all existing rebuild source in local commit `9dc779c`. Original checkout is clean and retained. Independent non-hardlinked Git clone at `/Users/ibrahimsaitakarcesme/Developer/AkorithNext`, branch `rebuild/codex-interaction-parity`; npm ci and Electron native rebuild succeeded. No automation created or resumed. Direct Codex native UI inspection was refused by Computer Use; no alternate access attempted. Animation equivalence remains unmeasured.

Fixed engine abort ordering so context survives provider cleanup after a storage failure. Added behavioral regression and unchanged/changed native-context continuity tests: focused engine suite 15/15 passes. Plugin/context and renderer integration are in progress; historical package results do not certify this source.

## B05 package and real development acceptance started

Source66f2bca, alpha.5 package built and deep strict codesign verified. Full suite234/234passed after native helper build. Unmodified native screenshots and package receipt in recovery-2026-09-06/B05. Actual Astra service desk and inventory worker projects started through Akorith composer in isolated data; neither acceptance is complete. CUA clipboard/control feedback became delayed and reconnect timed out; no UI workaround/bypass used. B06 source now adds navigation/motion/model picker and readable command summaries; B05 package does not include those.

## B06 live continuation and B07 lifecycle correction

B06 source726640b/alpha.6 full suite254/254passed (initial253/254 PTY readiness race preserved, readiness corrected to await foreground+background). Deep strict codesign passes; asar005b849acaa3f8a4d45bd2d070189df552c117612fdc5c5c068127e74d96ff43. B05 actual native Quit succeeded after unproven stale/blank-on-reload issue. B06 reopened same isolated data with both real projects completed. Native model picker search and provider changes work. A API14/browser7passed; B18passed. Local Ollama followup reached outputlimit and is correctly failed, not credited as code success. OpenCode continuation now requests independently reproduced own-key API validation bug, genuine failing/passing evidence, formatter feature and actual synthetic plugin MCP invocation. Pluginv1 realUI inspected/imported disabled/enabled. Main-shell lifecycle correction hides native views on document reload/failure/exit and adds privacy-bounded diagnostics;4focused tests+typecheckpass, fullblank cause not proven fixed. B07 not yet packaged.

## B07/B08 native acceptance and independent project review

B07 sourceffd8e38 alpha.7:258/258passed, signature verified. Native Browser panel opened actual service-desk localhost4317 with persisted synthetic Support login. Main renderer reload explicitly focused in composer then View→Reload: second navigation-started/dom-ready/load-finished triplet recorded, entire shell and live browser visible, ticket navigation worked afterward. First Reload while browser focused only reloaded browser and is not counted as main reload. B05 fullblank original cause remains unproven. B07 nativeQuit with live browser succeeded. Unmodified screenshots and timestamps under B07/screenshots.

Actual projectA final logs14TAP API tests (13scenarios+parent),9TAP browser tests (8scenarios+parent). Actual projectB OpenCode MiMo continuation repaired inherited-option validation,1pass/6fail before→7pass after, full33pass, newBigIntEURutility. Independent audit confirms realHTTPtests reject withoutjobcreation. Native skill lookup failed but pluginMCP independently returnedV1; extracted exact tool outputs under B06/verified-followup-evidence. Currency helper audit found invalidinputacceptance and noUIintegration; this is now requested through actualB08composer, not silently credited ascomplete.

B07 realUI importedpluginV2 withoutchangingactiveV1, explicitlyactivatedV2; configpreserved intoB08. B08sourcec15abb1 alpha.8:259/259passed,typecheckpassed,deepstrictsignatureverified,asar533deb30ff3bbc09e56e7606594427630e685856e74c8e79365275ad77c1645c. Managedskillcontext now tellsmodels suppliedinstructions arecontext, notnativecatalogentries. B08actualmodelturn toverifythis/V2 pluscurrencyvalidation is inprogress. Noautomationscreated, nopush, oldapp/datauntouched.

## B09 integration — 2026-09-06
Restored native new-project creation and display-name rename, project-scoped @file snapshot attachments, and hidden native browser screenshots using the same WebContents in a never-shown capture owner. Cancellation/error/task-switch cleanup verified with actual Electron pixel fixture. Complete suite 275/275 passed, TypeScript passed. Packaged acceptance pending.
B08 actual provider follow-up completed: genuine currency invalid-input regression 8 failures before fix, 16 formatter tests and 41 full project tests after. Managed plugin V2 actual MCP output succeeded; disabling produced a fresh provider session with zero managed skill/MCP context and the tool absent. Large-number dashboard browser regression remains unproven; normal dashboard snapshot passed, its screenshot failure is addressed by B09.

B09 packaged acceptance passed: native picker created project-create-check plus first task; metadata rename to Project acceptance retained original folder. @README keyboard Down/Enter produced README attachment without sending. Actual OpenCode MiMo turn 8bb886de-d180-4dd2-8377-140c1c382e99 read the copied snapshot, opened localhost inventory and completed browser_screenshot at 2200x1600 while workspace panel closed. Result/activities/AX/PNG and source/package hash receipt retained in B09 evidence. Normal native Quit exited owned B09 process. Package is development preview, not a full replacement-ready claim.
B09 native reopen passed: renamed project with original folder, completed README/screenshot turn, selected model and closed workspace panel survived. Separate development launcher preserves the isolated acceptance profile; old installed app/data untouched. No continuation automation.

## UI-first step after user scope correction
Research now means autoresearch hypothesis/baseline/isolated measured experiments, not web research. Benchmark means side-by-side model/method outputs/video/time/tokens/cost with human quality judgement. Plugins has its own main page. No legacy or ResearchLab source/assets transferred. Official static Codex reference inspected in browser; timings not inferred as measured. Native B04 and old Akorith closed, owned 4310/4311/4317 servers stopped, reference tab closed after evidence. 101 concrete acceptance requirements and source/evidence hash gate created; runtime Stop hook trust not yet confirmed. New UI and domain changes in progress; no readiness claim.

## B10 real-provider and UI acceptance
- New alpha10 Mac package built and codesign --deep --strict passed. B09 Quit verified before B10 launch. Fresh shell screenshot and dedicated Plugins page captured; actual fixture enabled via packaged UI.
- 306 integration tests passed before final UI preset/guard refinements. Final suite still required.
- Research actual Codex Astra run: host baseline133867 -> candidate2297, retained;214841 independent integer cases and actual lookup counts checked. Fractional/Infinity equivalence fails; supplied evaluator scope only. Source project untouched. Evidence B10/research-live/run-towyCz.
- Benchmark actual Codexmini and MiMo text run: both expected result,4.27s/14.70s; costs/tokens available only as reported. Isolated sequential fixtures, portableHTML, clean shutdown. Actual browser recording still in progress.
- Public official InAppBrowser video was played; outlinecontrols/embeddedbrowser layout observed. Exact animation timing/easing remains unmeasured.
- Native CUA snapshots can lag actions and some click/focus paths require another observation. No passing UI flow inferred from attempted click.

## B12 final UI step and independent opinion
Source d884f78 alpha12,315/315 tests and TypeScript passed; strict deep signature verified. Actual native comparison reads12952input/629output, keeps missing data unknown, renders Markdown, shows videos before output. Both actual videos played then paused17.6136/17.6132seconds. Human note persisted through page unmount/reopen. Native QA profile closed; updated launcher reopened B05/live-data with prior projects/plugins preserved. No old source/assets transferred in this step.

Actual browser recording evidence is same MiMo model twice, second cancelled; it verifies recording/comparison plumbing, not two different successful visual model outcomes. Different Codexmini/MiMo text comparisons completed. Research integer-only baseline133867→2297 retained; no fresh B12 research run, no broad numeric correctness claim.

12 narrow functional acceptance items bound to source/receipt hashes;89 remaining. Native Stop hook not proven loaded/trusted; tested Git pre-push guard is distinct. Independent read-only critic finds exact UI parity, native method restrictions and runtime early-stop guarantee incomplete, plus Research stops study on failed experiment. Opinion recorded without product edits or dispatched fixes. Current app is alpha, not full Codex replacement.

## B13 — user screenshot is the binding UI reference
User supplied current Codex/Akorith screenshots and rejected centered composer/vertical suggestion interpretation. Replaced initial composition with bottom composer+projectstrip, central outline emblem/title and four colored cards; moved permission inside toolbar, search/brand/history into sidebar. Native initial image compared at matching whole-window aspect; found ~30px welcome vertical discrepancy and hidden hint-row spacer lifting composer. Corrected offsets/removed empty spacer. Added actual persistent project pinning to match Pinned project hierarchy.318tests/typecheck passed before final CSS-only calibration. Source8673f44; final package/native proof pending. No other feature/backend expansion except projectpin required by visible sidebar behavior.

B13 final source61c04dc alpha13:325/325tests,typecheck,deepstrictsignaturepassed. Native bottom-composer/four-card composition, actual project pin and readonly Astra package.json response, real Files panel, normal quit/reopen persistence observed. Native drag did not yield verifiable width change; leave open. Computer permissions required. Full gate remains blocked (12 historical source hashes stale,89pending); no full-parity/replacement claim. Final screenshots and bound receipt in B13. Independent opinion only, no resulting product edits. Only currentB13 left open, no automation/push.

B14 in progress: actual fullscreen event state, folder disclosure transitions, consistent outline controls, compact provider catalogs/custom permission-effort popovers, progressive actual transcript, persistent local profile, reversible history clear/restore.337tests pass; package/native flow still pending. No legacy source transferred.

B14 final922fc5c:338tests/typecheck/signaturepassed. Native fullscreen control shift and reverse, custommenu keyboard+focus, no searchring, outsideclick focus, actualAstra4readfiles/116717reportedtokens with folded actions, localprofile name/color save/reopen, reversible clear/restore and finalactionfocus verified. Final13archived+1emptytask. Native drag still unverified; exactmotion and computerpermissions/Claudeauth remain open. Gateblocked, no nativeStophookproof, noautomation/push. B13/defaultprofiletestclosed;onlyB14leftopen. Evidence/receiptB14.


## 7 September 2026 — promote V2 to main

The user explicitly authorized promoting Akorith Next to the main Akorith application and pushing main to GitHub. All 18 existing 6 September commits through cb47b0e are retained unchanged, including their original author and committer dates. The promotion itself is a new 7 September commit.

Product/package/window/settings titles now use Akorith, and the macOS package is Akorith.app. V2 retains its existing bundle ID and Akorith Next data directory. No installed app or real user database was replaced.

Validation: typecheck passed; all 338 tests passed; production build and macOS packaging passed; codesign --verify --deep --strict passed. The newly packaged app launched via LaunchServices using disposable user data, displayed title Akorith and the composer, and reported 2.0.0-alpha.14. The owned smoke-test process was closed.

The pre-existing full UI acceptance gate still reports incomplete evidence; this source promotion is user-authorized and is not a full replacement-readiness claim. No acceptance items were marked verified to enable promotion. Public release automation remains the legacy workflow and was not run by this branch push.

Push verification: GitHub default branch `main` resolved to `7d4b2bfafb9c1f2574c3977caf48b7e13f62949e`. GitHub GraphQL contributionCalendar reported 18 contributions on 2026-09-06 and one on 2026-09-07 immediately after the promotion push.
