# B14 — motion, compact controls and local profile

Final source922fc5c, alpha14, branch rebuild/codex-interaction-parity.338tests and TypeScript pass; final ad-hoc package signature deep/strict passes. This is not a full Codex-replacement acceptance.

## User-requested changes
- Folder disclosure stays mounted and animates grid height/opacity; chevron rotates. Collapsed descendants are inert/aria-hidden; focus stays on disclosure.180ms grid and120ms opacity; reduced motion skips transitions. Native open/close and keyboard toggle endpoints observed. These chosen timings are not claimed identical to Codex.
- Sidebar/fullscreen: native enter/leave-full-screen events plus snapshot set root state. Traffic-light reserve is released in fullscreen; native screenshot confirms left controls move from inset to left edge. Leaving fullscreen restores inset. Sidebar show/hide tested; header restores focus. Outline panel icons no longer contain extra arrows, strokes consistent1.6/1.65.
- Permission and effort use custom accessible popovers; native heavy click rings removed. Native Home/Down/Enter changed effort to Medium and restored trigger focus; Escape from permissions restored trigger. No security permission expanded.
- Model menu: connection chips + short rows; actual Codex/OpenCode/Ollama catalogs; missing Claude login stays explicit. Heavy search focus ring removed; subtle row highlight retained. Exact known OpenCode label suffixes omitted only visually, IDs/aria/tooltip preserved. Native outside-click into composer retained textarea focus.
- Prompt flow: consecutive completed actions fold into history while latest2 and running/error/interrupted actions remain visible. Actual Astra separately read4files, showed folded actions while working, completed with name/version and localProfile key. Expanded action details remain accessible. Reported116717tokens includes provider context. Model's reported default data directory is not the active overridden development profile; do not treat that response as proof of current directory.
- Local profile: sidebar identity opens dedicated Settings profile section. Name/bio/color persist locally with bounded validation. Bio is not injected into model instructions. Theme, connection/plugin access, reported usage and reversible history controls work. Detected connections are distinct from authenticated/usable providers.
- History: actual native clear archived conversations and hid project entries, retaining database/files/settings/native sessions. Restore was verified, including after Quit/reopen. Final clear archived13conversations;1new empty task remains. Profile name İbrahim and blue avatar survived relaunch. After final native clear/restore actions focus returned to Clear history; it no longer fell into the background.

## Evidence
B14 final-profile.jpg and final-fullscreen.jpg are final922fc5c; final-model-picker.jpg was captured on2d187e6 before the final profile-only focus/label patch. Live action screenshots are30730a4 before avatar/profile-only follow-ups; transcript code unchanged. final-history-focus-ax.txt binds final focus behavior. final-package-receipt.json includes artifact hashes. Tests/package/typecheck/gate logs preserved.

## Open limits
- Exact icon geometry and every Codex transition duration/easing are not measured equivalents. Native reference access was previously unavailable; supplied images cannot establish animation timing.
- Native sidebar drag remains unverified: CUA attempts showed no confirmed change. No success claimed from attempts/unit tests.
- Computer panel previously reports missing Accessibility/Screen Recording permissions. Claude authentication not established. No full subscription compatibility or full computer-use readiness claim.
- Broad101-item gate remains blocked; B12's12historical validations have stale source hashes and89requirements remain open. Native Stop-hook trust/load/event not proven. No automation was created. Independent opinion remains read-only and does not dispatch edits.

## Resource ledger
B13 and an unintended default-profile B14 opening were normally quit before continuing with the intended B05/live-data development profile. Final only build-B14 remains open; normal helper/provider processes are expected. No fixture servers, browser tabs or recorders opened in this correction. Original installed Akorith remains untouched. No push or runtime data staged.
