# Official desktop reference: motion evidence

Audit: 2026-09-06. Public sources only; no native Codex interaction, private bundles, remote-media downloads, or Akorith UI actions. This is a bounded visual reference audit, not a parity certificate.

## Sources actually inspected

- [OpenAI: Codex for (almost) everything](https://openai.com/index/codex-for-almost-everything/) (16 April 2026). Its second embedded video, **InAppBrowser from OpenAI**, loaded and played in Chrome. The player exposed a 00:50 total duration, a changing playback position, and Pause controls. [Public embedded player](https://player.vimeo.com/video/1183780962?h=deca50f4ea).
- [Official Codex product page](https://openai.com/codex/) was briefly inspected via accessibility text. It currently includes a web demonstration with sidebar, Plugins, project/task rows, composer modes, permission/model menus, and disabled empty Send. This marketing demonstration is not evidence of native desktop transition implementation.
- [Official basic dark screenshot](https://learn.chatgpt.com/images/codex/app/codex-app-basic-dark.webp) is the separate static reference already inspected by the root agent. No animation conclusions are drawn from it here.

## Direct observations from the playing InAppBrowser video

- A transcript frame contains prose, bullet validation results, blue file/localhost links, a compact changed-file strip, and a bottom follow-up composer. Permission, model, effort and microphone controls occupy the composer's lower row.
- Later frames show the same task context with an embedded localhost browser. The browser uses a shallow toolbar, Summary/Browser tabs, and small outline navigation/reload icons. The selected Browser tab has a pale neutral rounded background.
- The top right includes an outline split-panel glyph; the browser has a diagonal expand/collapse glyph. The latter appears over a subtle rounded neutral hover background in a captured frame.
- A subsequent frame shows a selected page region outlined and tinted blue, a blue comment marker, and a white pill-shaped inline text editor with a black circular check action. Browser commenting is visibly anchored to page content.
- The video changes between these states, but observations were discrete tool screenshots rather than a continuous frame-level capture. No exact transition start/end timestamps were recorded. A transient black screenshot occurred during playback; it is not attributed to the desktop product.

## Inferences and unresolved measurements

Keeping task context and the composer visually stable while opening an inspection surface is a useful design inference from the sequence. Small neutral outline controls and restrained selected backgrounds are supported visually. These are reference directions, not proof of equal behavior in Akorith.

**Unverified:** sidebar open/close animation, right-panel duration, easing curves, icon morphs, spring parameters, hover timing, prompt-submit transition timing, focus restoration, reduced-motion behavior, and frame-accurate equivalence. Promotional zoom/cuts and browser playback further limit motion inference. No numeric motion constants should be marked verified from this audit.

Cleanup: the only created reference tab (Chrome 834533575) was explicitly closed. No downloaded media or temporary processes were created. Product source was not modified.
