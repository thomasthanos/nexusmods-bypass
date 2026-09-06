# Changelog

Notable changes to NexusMods Bypass. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow the `manifest.json` version, which is the single source of truth.

This file starts at 2.4.3. Earlier releases predate it and the repository history was
squashed, so reconstructing them accurately is not possible — rather than invent entries,
they are simply not listed.

## [Unreleased] - 2026-09-06

### Security

- **Untrusted Nexus responses no longer pass through the HTML parser.** HTML entities in a download
  response were decoded by writing the whole body into a detached `<textarea>`, which let the parser
  build elements from anything after a stray `</textarea>` and silently truncated the value at that
  point. Entities are now resolved directly, so the parser is never handed the response at all.
- **The download folder no longer goes verbatim into a public bug report.** It is typed by the user
  and the report is pre-filled into a GitHub issue, so it could carry a real name or a full path.
  Whether it is set is the useful diagnostic; the text is not.

### Changed

- **A report now shows what happened just before the fault, and the log switch is gone.** *Verbose
  extension logs* asked the reader to find and flip a setting whose own description admitted it changed
  nothing about bug reports — it only quietened the console. Activity is now recorded regardless and the
  last handful of entries ride along in the report under *Leading up to it*, sanitised the same way
  everything else is. That is the part a maintainer actually needs: not that a download failed, but the
  three steps before it. The console itself stays quiet while things work — only warnings and errors are
  printed, so the extension does not add to the noise a Nexus page already produces.
- **The welcome page was rebuilt.** It was a narrow column down the middle of an empty tab, with the one
  thing a new reader should do — open Nexus Mods — sitting below everything else. The action now comes
  straight after the title, the three quick-start steps run across the page as a joined path that stacks
  on a narrow window, the panels use the width, and the type is large enough for a full page rather than
  a popup. Its three badges were hardcoded English in a project that ships thirteen languages; they and
  the tab title are translated now, and the installed version is shown.
- **The one place a rating is asked for now points at the right store.** Every ask sent people to GitHub,
  where a star does nothing for anyone trying to find the extension. The ask now opens the review page of
  the store the extension came from — detected from the Firefox build marker, then the browser — and it
  appears once, in the deck, after a run of at least five files finished. Dismissing or following it
  settles the matter permanently. The welcome page no longer asks for anything before it has been useful:
  its third card explains Vortex versus browser downloads instead, and the footer links to the source.
- **A rate limit is no longer presented as something to report.** Sign-in, Cloudflare, rate-limit and
  suspension notices offered *Report a bug* next to them, which turns Nexus asking you to wait into an
  issue in the tracker. Those four now offer *What does this mean?* and open the troubleshooting section;
  everything that really is a fault still offers the reporter. Blank issues are off, and the template
  chooser links the same section first.
- **A finished modlist says what to do next, with the real folder.** The run ended with *Download
  finished* and nothing else, leaving the one question that matters unanswered. The last line now names
  the folder the files actually landed in — read back from the browser, not guessed — and what to set it
  as in Wabbajack.
- **An imported modlist no longer offers the Vortex handoff.** A modlist installer reads files from a
  folder on disk, so sending them to Vortex puts them where nothing will look for them. An imported list
  now downloads through the browser, the Vortex option is not drawn at all, and the choice is kept out of
  the saved settings so the next real collection still starts with whatever you had picked.
- **An imported modlist no longer looks like a collection.** The panel that appears after an import is
  headed *Collection Downloader* with a *Ready Queue* badge, which reads as the wrong screen when what
  you just imported was a modlist. It now carries the modlist's own name, says it came from a Wabbajack
  import, opens its log, and states the next step — nothing starts on its own, and there was nothing on
  screen saying so.
- **The list of archives left out is grouped by reason, and names its source.** A big modlist leaves out
  a hundred or more entries; one row each filled a log panel that starts collapsed, and every one of them
  read the same unhelpful *not-on-nexus*. Each reason is now one line with its count and the first few
  names, and the reason carries the downloader Wabbajack recorded — `not-on-nexus:GameFileSource` for
  files taken from your own game install, `not-on-nexus:Http` or `:GitHub` for ones Wabbajack fetches
  itself, `:Manual` for the few that need a person. Nothing there was ever the extension's to download.
- **"Import downloaded mods" only offers mod files.** The picker accepted anything, so selecting a whole
  downloads folder also handed over Vortex's `.meta` sidecar for every archive — each one counted as a
  file that "did not match this collection". It now filters to the archive and installer types Nexus
  actually serves, filters the selection again in code because the picker's filter can be switched off,
  and says when something was left out.
- **Bug reports say what actually happened.** The report now opens with a **Report ID** — a short
  fingerprint of the fault that is identical for everyone hitting the same bug, so a duplicate can be
  found by searching for it — and a *What went wrong* digest that counts every error by code with how
  recently each one last happened. The digest survives every truncation step, so even a report that had
  to be shortened to fit the URL still shows the shape of the failure.
- **A repeating failure is counted instead of flooding the log.** The log holds fifty entries and a
  retry loop could fill all of them with the same error, pushing out the history that explained it. The
  same fault within half an hour now increments a count on one entry, keeps the newest detail, and is
  reported as `×17` with a last-seen time.
- **Stacks no longer repeat the extension address on every frame.** `chrome-extension://<id>/` is folded
  to `ext://`, which shortens every stack, leaves more room inside the URL limit, and makes two people's
  stacks directly comparable.
- **The form's browser field is filled in too,** so a report that had to drop its diagnostics still
  arrives with a browser and version.
- **The report is built once instead of twice.** Opening the reporter read settings, the error log and
  the browser details twice over — long enough that the clipboard copy could lose the permission the
  click gave it.
- **The collection log no longer re-scans a response it has already classified.** Two leftover calls
  re-ran the content classifier over bodies that had been classified when they were read, where it
  could only return the same answer — one of them on every failed collection file. The branches they
  guarded were unreachable; the errors they were meant to raise still come from the request helper.
- **The ZIP checksum walks its buffer by index.** Iterating a multi-megabyte typed array through the
  iterator protocol measured roughly four times slower, and a Wabbajack import runs it on the page's
  main thread.
- **Dead code removed from the shared module.** An unused log-size constant, an unused download-method
  constant and an exported activity getter with no callers are gone, and a collection object now
  starts with its rate-limit counters and flags set instead of relying on `|| 0` everywhere.
- **Wabbajack import now uses a dedicated importer and ZIP reader.** The game registry is aligned with
  current Wabbajack game names, including newer Nexus mappings and Terraria, while the saved beta
  setting and existing interface stay compatible.
- **"Always use English" now takes effect where you set it.** Nothing injected into the page carries
  a translation attribute — every string is baked in when the element is built — so flipping the
  switch changed the flag and nothing else, and it simply looked broken. The settings dialog now
  rebuilds itself in the new language.
- **A settings write is retried like every other message to the worker,** and *Restore Defaults* goes
  through the worker's serialised queue instead of writing straight to storage, where a patch still
  in flight could land afterwards and resurrect the value just reset.

- **The popup's tab bar is translated.** *Controls* and *Help & Bugs* were wired for translation but
  every one of the twelve non-English catalogues still held the English string, so the tab bar read
  English in every language. Long translations now ellipsise rather than widening the popup.

### Fixed

- **Pressing pause or stop no longer writes an error.** With no queue running — every Vortex run, and any
  finished one — those buttons asked the worker to pause a job that does not exist, and the worker filed
  the answer as a background fault. A handful of presses turned into *5 × background_error* at the top of
  a bug report, hiding whatever was actually wrong. A Vortex run now keeps pause and stop local, and the
  worker no longer logs an answer as a failure.
- **One file the browser refuses to start no longer ends the whole queue.** If the downloads API turned a
  file down — cancelled, blocked by policy, no disk space — the error escaped the queue processor and the
  run was marked failed with every remaining file untouched. A refusal is now recorded against that file
  and the queue carries on, exactly as it does when a link cannot be resolved.
- **A rate-limited queue counts down instead of looking hung.** When Nexus throttles a browser-mode run
  the queue waits up to ten minutes and said only that it would resume automatically, which is
  indistinguishable from a freeze. The wait now ticks down in place, the way it already did for a Vortex
  run, and clears itself the moment the next file starts.
- **A large modlist is no longer refused by the queue that runs it.** The importer reads up to 10,000
  archives but the background queue accepted 5,000, so a big list failed with nothing but
  `invalid-job-size`. The two ceilings now match — a queue that size costs about 2 MB of the 10 MB
  storage quota — and a test keeps them from drifting apart again.
- **Large Wabbajack modlists import instead of being refused.** A big list's `modlist` file is a few
  hundred megabytes, nearly all of it the *Directives* array that describes every file the installation
  touches — data the import never looks at. It was read past a 64 MiB ceiling and parsed whole, so lists
  from the popular packs failed with *"too large to read safely"*, and a smaller one still cost the page
  hundreds of megabytes of memory. The reader now lifts out the archive list in one pass and parses only
  that: a 224 MiB modlist is read in about 1.4 s and leaves 13 MB behind instead of 570 MB. The ceiling
  is now 256 MiB, and a refusal states the entry's real size and the limit rather than only that it was
  too large.
- **A logged error keeps the action that caused it.** Every error records what the extension was doing —
  a collection run, an automatic start, a Cloudflare hand-back — but the field was dropped on the way
  into storage, so the line only ever appeared for the error that was on screen. Every entry in a bug
  report now carries it.
- **A file page with several embedded download entries resolves the right one again.** The scanner that
  reads Nexus metadata attributes shared one regular expression with the nested parse it starts, so an
  entry containing further markup rewound the scan: the same entry was read until the parser's work
  budget was spent, and the real link further down the page was never examined. Pages that failed with
  *Nexus Mods did not return a usable download link* now resolve, and the entry for the requested file
  is read first instead of last.
- **A collection queue that loses its file list now reports an error instead of success.** An empty list
  read as "nothing left to do", which finished the run and cleared the collection history — so every
  file looked downloaded when none of them were. Losing the list is now a failure and history is left
  untouched.
- **A running queue is only rejoined when it holds the same files.** Rejoining compared the history type
  but skipped the file set, so starting a download for one revision could attach to a run still working
  through another and quietly fetch the wrong files.
- **The Slow download button is picked up when Nexus relabels it.** A button was inspected once and then
  ignored forever, so an element that showed a countdown first and became *Slow download* afterwards was
  never intercepted and the wait came back.
- **Mod URLs ending in a slash are handled.** `/mods/123/` and `/mods/123` are the same page for Nexus,
  but only the second switched the download hooks on.
- **The File archive button works on URLs that carry a fragment.** The category was appended to the raw
  address, which put it inside the `#…` part where it is ignored, and the button opened the normal file
  list again.
- **A Wabbajack modlist spanning several games keeps one stable history bucket.** It was taken from
  whichever entry happened to be first in the manifest, so a reordered or slightly edited list started
  from a different bucket and every file looked new again. The game with the most files decides it.
- **Handing a file back to the native Nexus buttons is no longer permanent.** Once a file could not be
  resolved it was released for the rest of the session, so signing in or waiting out a moderation hold
  changed nothing until the page was reloaded. The hand-back now lapses after a few minutes, is dropped
  on navigation, and cannot grow without bound.
- **A padded ZIP64 entry field no longer breaks a Wabbajack import.** The per-entry field only has to
  carry the values whose legacy field is saturated, but writers exist that emit the whole set; reading
  it positionally then mistook a file size for a file offset and the import failed on a valid archive.
- **A collection revision with an incomplete file entry loads instead of failing.** A missing file list
  threw before the retry logic could see it, and an entry without a game, mod or file ID produced a
  download address containing "undefined". Such entries are now left out of the queue.
- **An overlong download folder is capped instead of failing every download.** It is typed by hand and
  the browser refuses the whole transfer if the path is too long, reporting nothing useful; the field
  is now also length-limited in the settings dialog.
- **An imported modlist no longer offers "mandatory" and "optional" downloads.** Both held the complete
  list, so choosing one and then the other wrote the same files into two separate history buckets and
  neither could tell the run had already finished.
- **Pause does nothing once a run has finished or stopped.** The button told the worker to pause a queue
  that no longer existed while the display stayed put, leaving the two out of step.
- **Reconnecting to a background queue no longer keeps a dead job ID.** If the queue reported its result
  before the start call returned, the finished ID was written back afterwards and later pause or stop
  requests aimed at it instead of the live run.
- **A bug report keeps the error code and the download state.** The redaction pass treats `code` and
  `state` as secrets — they are OAuth parameter names — and the loose "name: value" rule applied that to
  our own diagnostic lines, so the one field that says what went wrong arrived as `code: [redacted]`.
  As query or JSON keys they are still redacted, and the two copies of the list are now checked against
  each other when the package is built.
- **A Vortex link followed by a separator is no longer refused.** The validity check compared the parsed
  link against a differently normalised copy of the same text, so a link ending in `;` or `)` — as it
  does when it sits inside a script — parsed correctly and was then rejected for not matching itself.
- **Legacy and hidden file pages resolve their intended download more reliably.** The fallback now
  reads embedded Nexus metadata, keeps browser and Vortex links separate, and rejects ambiguous URLs.
- **Wabbajack archives are validated before their manifest is trusted.** Imports now enforce actual
  decompression limits, CRC and size checks, safe ZIP64 bounds, single-disk and unencrypted entries;
  multi-game lists also keep separate history for identical file IDs from different games.
- **Failed Nexus responses are no longer scanned and logged twice.** Both the request helper and the
  login check ran the same classifier over the same body — up to 200 KB lowercased and put through a
  dozen regexes each time — and because building an error also records it, a logged-out collection
  run wrote a duplicate entry for every failure.
- **Typing in a settings field no longer writes on every keystroke.** Each keypress persisted the
  value, reloaded the whole config and re-broadcast it to every content script, so typing `45000`
  into a timeout stored 4, then 45, then 450, then 4500, then 45000. Writes are debounced and
  flushed when the dialog closes, so closing mid-edit still keeps the value.
- **A bug report is assembled once instead of up to eight times.** Fitting it inside GitHub's URL
  limit retries at shrinking sizes, and every attempt re-read the settings and the whole error log
  from storage and re-probed the user agent against a 500 ms timeout.
- **The collection deck's activity log can be selected and copied.** A deck-wide `user-select: none`
  covered the one thing a user needs to copy out of it — the error codes and file names they are
  asked to paste into a bug report.
- **The deck's glass highlight renders again.** A later rule of equal specificity was overriding the
  two injected overlay layers' positioning, turning them into ordinary in-flow spans.
- **The progress bar no longer repaints continuously.** Its shimmer animated `background-position`,
  which repaints the whole bar every frame for as long as a collection is downloading — hours, in a
  large run. It sweeps a composited overlay instead.
- **Escape closes the mod-selection and revision dialogs**, which were the only two that ignored it,
  and the settings dialog now announces itself as a dialog, takes focus when it opens and gives it
  back when it closes.
- **The alert dialog's OK button is translated**, the popup's tab bar has an accessible name in every
  language, and the popup and onboarding pages declare the language they are actually rendered in.
- **The collection deck's title is translated** in Italian, Japanese, Korean, Polish and Turkish,
  where it had stayed *Collection Downloader*.
- **Ad and Premium hiding no longer stalls on a busy page.** The flush was a reset-only debounce:
  each batch of mutations pushed the timer back another 100ms. A page that keeps mutating — Nexus
  with ad slots streaming in is exactly that — never let it fire, so nothing was hidden *and* the
  pending-node queue grew for the life of the tab. The wait is now capped, and the queue is capped
  too: past the point where one document sweep is cheaper than scanning each root, it stops
  accumulating and sweeps once.
- **The file-page button scan stops re-reading the whole page every second.** The 1 Hz poll marked
  only the buttons that matched, so every *other* button on the page had its text read and normalised
  again on every tick, for as long as the tab stayed on a file page. Every examined button is now
  marked; buttons that have not rendered their text yet are deliberately left for the next pass.
- **The Select Mods list is built in one pass.** Each row was created with its own `innerHTML`
  assignment, had its text read back out of the DOM to build a search key, and carried its own click
  closure — on a 500-mod collection that is 500 parses, 500 forced text reads and 500 closures, all
  repeated on every sort. The list is now parsed once with a single delegated handler, and the two
  lookups that scanned every mod for every selected row use an index.
- **The collection init backoff actually retries.** The retry deadline was only consulted when
  something else triggered a route change, so on a quiet page a collection that failed to load once
  stayed broken until the user navigated. It now arms a real timer.
- **The worker's storage write-queue releases finished keys.** Item lists are stored per job id, so
  the map gained a permanent entry for every collection run the worker had ever seen.

- **A Cloudflare challenge no longer fails an entire queue one file at a time.** The worker only
  recognised HTTP 429, so an interstitial — which arrives as an ordinary 200 or 403 carrying a
  challenge page — fell through to a generic request failure. The queue then spent two attempts on
  every remaining file, failing each in turn, when the right answer is to stop once and let the user
  clear the check. Account suspension had the same blind spot. Both are now recognised, by marker and
  by the `Cf-Mitigated` header, and stop the run with the reason. This affects collections as much as
  imported modlists.
- **A collection queue can no longer roll itself backwards.** Job state was persisted by writing a
  whole job object back, but callers held that object across several awaits — reading the item list,
  verifying the transfer size, writing history. Anything that moved in between was silently reverted
  to its stale value. An attach landing while a download finished could reset `index` and
  `activeDownloadId`, so the queue re-downloaded an item it had already finished while the one
  actually in flight was orphaned, and its completion event was dropped — leaving the run stuck at a
  frozen count. Writes now happen against freshly read state and touch only the fields they name.
- **Opening a collection in a second tab no longer hands it the run.** Attaching is passive — it
  happens merely by opening the page — but it moved job ownership to whichever tab attached last, and
  ownership decides which tab closing cancels the run. Closing a throwaway second tab killed a queue
  the original tab was still driving. Ownership now transfers only when the owning tab is really
  gone; pressing Start remains an explicit claim.
- **Import downloaded mods merges instead of replacing.** The three history lists were overwritten
  wholesale, so importing a second folder — or importing at all after a partial run — wiped every mod
  already recorded, and the next run fetched them all again.
- **The Cloudflare fallback only ever navigates to a real mod page.** It could send the tab to a
  `Core/Libs` widget fragment or an `/api/files/` endpoint, where `isModPage()` is false, every
  interceptor switches off, and the user is left on a bare HTML fragment with no download control.
- **A native fallback whose click never lands no longer goes silent.** The watchdog was cancelled
  before the click was attempted; if the button had gone away in the meantime the handler returned
  without re-arming it, so nothing was left watching and the extension never spoke again.

- **A mod you have to download by hand is no longer blocked from being downloaded by hand.** The
  click interceptor is capture-phase and calls `stopImmediatePropagation`, so it matched any link
  carrying `file_id=` — including Nexus's own **Manual download** and **Slow download** buttons — and
  replaced it with the extension's own resolution. When that resolution could not succeed, which is
  exactly the case for a manual-only, off-site or gated file, Nexus's handler had already been
  cancelled: the button was left reading red *Error* and every further click was swallowed the same
  way. The extension's own advice for that error is *"Open the file page and download manually"*,
  which was impossible to follow. A file the extension has failed to resolve is now handed back to
  the native Nexus controls for the rest of the page, and a modified or middle click is never
  intercepted at all.
- **A failed mod in a Vortex collection run no longer downloads into the browser instead.** The links
  the deck offers for failed mods were bare `?tab=files&file_id=N` with no `&nmm=1`, so opening one
  during a Vortex run auto-started it as a *browser* download — into the `NexusMods` subfolder, which
  Vortex does not watch. The file downloaded and was never imported. Deck links now carry the run's
  own download method.
- **`?nmm=0` no longer counts as a Vortex download.** The check was `params.has('nmm')`, which is
  true for any value, so a URL explicitly asking for a browser download was routed down the Vortex
  path — where a manual-only file dead-ends.
- **The Slow download button is no longer a dead control when it has nothing to work with.** Its
  handler cancelled the event as its first two statements and only then checked for a file id, so on
  any page where that check failed the click did nothing at all: no download, no error, no log.
- **A superseded download attempt no longer freezes the button.** Losing a race against a newer
  attempt returned silently, leaving the control stuck on *Please Wait…* with the native button still
  suppressed.

- **Scrolling any Nexus page no longer waits on the extension.** The modal and dropdown scroll guards
  were bound for the whole life of every page the content script matches — the entire site, not just
  pages with extension UI — and they used `passive: false`, which forces the browser to block on
  JavaScript before every wheel and touchmove frame. Each one then ran a document-wide
  `querySelectorAll` only to find no overlay and return. Both listeners are now attached on demand,
  while an overlay is actually open, and removed again after.
- **Browser downloads no longer overwrite each other.** The download folder defaults to `NexusMods`,
  and any path containing a `/` was written with `conflictAction: 'overwrite'` — so on a default
  install two mods that ship the same archive name silently clobbered each other on disk while the
  queue reported both complete. Every download now uniquifies.
- **Rate-limit backoff actually escalates.** Nexus often answers a 429 with no `Retry-After` header,
  which reached the backoff calculation as `''` — and `Number('')` is `0`, which is finite and not
  negative, so the header branch swallowed every call and returned the 30-second floor. The
  exponential ladder behind it had been unreachable; a hard rate limit was retried every 30 seconds
  indefinitely instead of backing off toward the ten-minute cap.
- **Reading a mod description mid-run no longer cancels the collection.** Teardown ran on every
  in-page navigation away from the collection page and stopped the background job, cancelling the
  in-flight archive and dropping the rest of the queue. Clicking a mod title was enough. Teardown now
  only detaches the watcher — the job already survives a full page reload the same way, through the
  worker's reconcile pass and the reattach on return. Only the Stop button halts a run.
- **Retrying a failed mod no longer queues it twice.** A successful retry handed the file to Vortex
  but never recorded it in the download history, so the run still reported it as failed and the next
  run over that collection handed the same file to Vortex again — one duplicate for every file ever
  retried.
- **A stalled collection recovers on its own.** A job left in `running` with no active download had
  nothing to drive it: the deck's own status poll kept the worker awake, so the startup reconcile
  never re-ran, and the poll itself only read state. The queue reported *running* forever while
  nothing downloaded. The poll now nudges a stalled job the way reattaching already did.
- **The bug-report result is visible again.** The popup's status line lived inside the *Controls*
  panel, but **Report a bug** is on *Help & Bugs*, and switching tabs hides the inactive panel
  outright — so every message from the report flow, including *the full copy is on your clipboard*,
  was written into a hidden element. It now sits outside both panels.
- **The Vortex/Browser choice is reachable by keyboard.** Its radio inputs were `display: none`,
  which removes them from the tab order and from the accessibility tree, leaving the collection
  deck's central choice mouse-only. They are visually hidden instead, and the surrounding card shows
  a focus ring.
- **A failed mod no longer costs a full transfer-length pause.** The pacing delay is sized from the
  file's size to space out real Vortex transfers, but it ran after every mod — so a mod whose link
  never resolved still cost minutes of waiting for a download that never started.
- **Backing off on the final attempt no longer wastes the wait.** A rate-limited last attempt sat out
  the whole backoff and then failed the mod regardless. The deadline is shared, so the run still
  paces itself before the next mod; it just no longer stalls to no purpose.
- **A second tab can no longer shorten a long cooldown.** The shared rate-limit deadline was
  overwritten rather than extended, so a tab that hit a short limit could wipe out a longer one
  another tab was already serving.

### Removed

- A stray `<script src="/__l5e/lovable.js">` left behind by a web builder was committed in the
  onboarding page and shipped inside both 2.5.2 store packages, where it resolves to nothing and
  404s on every install. `tools/build-zip.mjs` now fails the build when packaged HTML references a
  file the package does not contain, which is what would have caught it.
- `sectionQuickControls` and `sectionHelpBugs` — 26 shipped strings across 13 locales that no code
  reads. `check-locales.mjs` had been warning about both; it now reports zero warnings.
- 63 lines of popup CSS for four classes that no longer appear in any markup, a hover rule for a
  glass layer that is never added to a modal, and `clearActivity`, which was exported and never
  called.

### Added

- `tools/background-units-test.cjs`, covering the download conflict action, the rate-limit backoff
  ladder, the download-target validator, the job-state read-modify-write and the storage write-queue.
  It runs as part of `tools/build-zip.mjs`.
- **Wabbajack modlist import, behind a beta switch that is off by default.** Turning on
  *Wabbajack modlist import (beta)* in the page settings adds an **Import Wabbajack modlist** button
  to that dialog. It reads the `modlist` manifest out of a `.wabbajack` file and builds a download
  queue from the Nexus files it names — the same queue a collection uses, so pacing, rate-limit
  backoff, download history, resume and both the Vortex and browser paths all apply unchanged.
  Archives hosted outside Nexus, and games this build's registry does not recognise, are counted and
  reported rather than silently dropped: the mod page URL needs the Nexus domain, and that cannot be
  guessed from the Wabbajack game name. The same button also appears in the collection deck's
  **Actions** row while the switch is on, so a modlist can be imported from either place, and both
  follow the switch immediately instead of waiting for a reload.
- `tools/check-locales.mjs` now compares which placeholders a translation uses, not how many. Counting
  alone let a translation swap `$1` for `$2`, or drop one while adding another, and still pass — the
  user would see the wrong value, or a literal `$1`, with the build green.
- `tools/build-zip.mjs` now fails the build if `shared.js` and `background.js` `DEFAULTS` drift. The
  worker validates every settings patch against its own copy and rejects unknown keys, so a mismatch
  would silently stop a setting from saving.


## [2.5.2] — 2026-08-28

### Changed

- **The popup keeps one height on both tabs.** Controls and Help & Bugs differed by roughly 170px,
  so switching tabs resized the window. Both panels now share a minimum height, the popup is 380px
  wide, and the header, tab bar and toggle rows are tighter — the window is about 60px shorter than
  the 2.5.1 Controls tab and no longer jumps. Help & Bugs shows the three steps and the sign-in note
  directly instead of hiding them behind an accordion in an otherwise empty tab, and the version
  moved into a pill next to the title.
- **The page settings dialog uses two real columns.** Language, Files & Pacing and Advanced were
  stretched to the height of the Download Flow list, which left dead space *inside* those cards.
  The column split is now proportioned so both sides come out at nearly the same natural height,
  and whatever they still differ by — fonts and translations both move it — is absorbed as a little
  extra room inside the side cards, so it never appears as a gap between them or a hole underneath.
  The section titles also lost the stray hairline under them that the existing first-row rule had
  always been meant to remove.
  **Advanced** is a full-width strip under both columns and opens its settings side by side, so
  expanding it no longer empties out the bottom of the other column. At 1280×720 the dialog now
  measures about 516px collapsed and 606px expanded — the previous layout filled roughly 730px
  collapsed alone — and neither state needs an inner scrollbar. Narrow and zoomed windows keep
  the single-column fallback.
- **Advanced** opens and closes with a short height-and-fade transition rather than appearing
  instantly, and the three settings in the band are centred on a common line, so the tall toggle
  and the two short numeric fields no longer sit ragged against the top edge.
- **The dialog's closing line became a bar.** *Need help with a download?* and the GitHub link
  moved up beside the **Advanced** pill, which had a full row to itself and used about a tenth of
  it, so the help line now costs no height at all. The link is a pill with the GitHub mark rather
  than an underlined word, and the name and version at the foot of the side column are a stamp
  matching the popup's header pill. Both are read from the extension itself — the version from
  `manifest.json`, the name from the locale catalogue — so a release only changes the manifest.
  The button's *report copied…* status now swaps only its label, leaving the icon in place.
- The popup and the settings dialog now share one toggle size and one radius scale.

### Fixed

- The popup's **Report a bug** button lost its icon. The button carried a `data-i18n` attribute of
  its own in addition to the one on its label, so applying translations replaced the button's entire
  contents — icon included — with plain text.
- The popup's Support view scrolls instead of being clipped. Chrome caps popups at 600px and the
  body could not scroll, so a longer translation lost the bottom of the view with no way to reach it.

## [2.5.1] — 2026-08-28

### Changed

- The page settings dialog now uses a compact two-column desktop layout and height-aware
  spacing, keeping the normal collapsed view visible without scrolling at 720p, 1080p,
  1440p and 4K while preserving safe overflow for narrow windows, zoom and expanded
  Advanced settings.
- The popup reads its version from `manifest.json` before loading settings. Together with
  the settings dialog and package builder, the manifest is now the only displayed/build
  version that needs updating.
- Collection runs now ask the user to confirm that Vortex is installed and running before
  any links are sent. Choosing Browser Download switches and saves the method; cancelling leaves
  progress and history untouched.

### Fixed

- Vortex handoffs no longer claim that a file is downloading or downloaded when Chromium
  can only verify that an `nxm://` link was sent. Single-file buttons briefly show
  **Sent to Vortex** and recover, and collection progress is labelled as a Vortex handoff.

## [2.5.0] — 2026-08-27

### Added

- **Tabbed navigation in popup:** Controls and Help & Bugs are now organized into separate tabs for a cleaner, user-friendly UI.
- **Direct donation options:** Added support buttons for GitHub Sponsors, PayPal (`@Thomasthanos`), and Revolut (`@thomas2873`).

## [2.4.5] — 2026-08-27

### Added

- **The Vortex handoff announces itself before closing the tab.** `location.assign('nxm:…')`
  cannot report whether Vortex received the link — an unregistered protocol handler is
  indistinguishable from success — so a handoff that went nowhere used to end with the tab
  closing on its own and nothing downloaded. The close is now a toast with the remaining
  seconds and a **Keep open** button, which is the last moment a failed handoff is still
  recoverable. Cancelling also invalidates the attempt, so nothing closes the tab afterwards.
- **A "How does it work?" panel in the popup**, with the three steps and, more importantly, the
  sentence that was missing: you have to be signed in to Nexus Mods. Signed out, Nexus answers a
  download request with a verification page, which the extension could only report as a Cloudflare
  block — accurate, and useless to the person reading it.
- **Bug reports now say what the extension was doing.** Every logged error carries the action that
  produced it — manual (you clicked a button), automatic, a collection run, or the Cloudflare
  fallback — together with the transfer method, the file id and whether the tab auto-close was
  armed. A new **Session** block records the download count, the size of the error log, the last
  action, and whether the page is currently parked in the Cloudflare fallback. "cloudflare 403"
  was the same line whether the user pressed a button or the extension acted alone; those two
  fail for different reasons and now read differently.
- **A Cloudflare fallback setting.** The fallback already ran unconditionally, and the tab
  navigating on its own is the part of it nobody expects. It now has a switch in the page settings
  panel that says what it does, and turning it off reports the Cloudflare block instead of moving
  the tab.

### Fixed

- **Archived file buttons could be attached to the wrong file.** The archived list matched headers
  to their download boxes by array index, which assumed the two collections stay the same length
  and in the same order. One stray box and every file after it received another file's buttons —
  you press download on one version and get a different one, with nothing on screen to suggest it.
  Each header now finds its own box through the DOM. There is deliberately no index fallback: a
  fixture with one header missing its box showed the fallback handing that header the *next* file's
  box, which is the same defect wearing a safety label. A file whose box cannot be identified gets
  no buttons, which is recoverable.
- **The navigation poll no longer runs at full speed on the whole site.** The content script loads
  on every `nexusmods.com` URL and polled once a second for the lifetime of the tab, including on
  forums, profiles, search and news where it has nothing to do. It stays at one second on mod and
  collection pages and while a fallback is in progress, and drops to five seconds elsewhere. The
  poll cannot be replaced outright: Nexus routes with `pushState` from the page's own world, which
  a content script in an isolated world cannot observe.

- **The Cloudflare fallback could stop without saying so.** After handing control back to Nexus's
  own download button, every entry point short-circuits while the fallback is active. If that
  button never appeared — a layout the selectors do not know, a disabled control, a method
  mismatch — the retry poll kept looking for it once a second, silently, for as long as the page
  stayed open: no download, no error, no explanation. The fallback now has a deadline. When it
  expires the state is cleared, the normal interceptors are restored and the Cloudflare error is
  shown with its recovery text. A genuine Cloudflare challenge on screen extends the deadline
  rather than tripping it, up to three minutes, because there the user is being asked to verify
  and Cloudflare's own interface is visible.
- **The bug report redacted its own error code.** The report was assembled from individually
  sanitised fields and then sanitised once more as a whole document — and that final pass cannot
  tell the report's `Code:` label from a `code=` query parameter, so every report generated from a
  live error arrived with `Code: [redacted]`. The per-field contract now stands on its own, with
  `Message:`, `Recovery:` and the settings values sanitised at the point they are built.
- **Three popup design tokens were never defined.** `--nxtk-text-muted` resolved to nothing in the
  popup's stylesheet scope, so the status line and two other elements fell back to an inherited
  colour; `--nxtk-accent-border` and `--nxtk-ease` were missing for the same reason. All three now
  exist in `popup/nxtk-shared.css` with the values `content/content-styles.css` already used, so
  the two surfaces agree.
- The popup header no longer ships a stale hardcoded `v2.4.0` that the script replaced a moment
  later.
- **"Report a bug" opened GitHub twice on Firefox, and nothing at all when the tab could not be
  created.** The content script asked the service worker to open the issue and treated the return
  value of `chrome.runtime.sendMessage` as a promise. Firefox's `chrome.*` namespace is
  callback-based and returns `undefined`, so the guard fell through to `window.open` after the
  background had already opened a tab — two tabs, two half-filled reports. In Chrome the opposite
  happened: the background answers a failed `tabs.create` with `{ok: false}`, which *resolves*,
  so `.catch()` never ran and the button did nothing. Both now go through the callback form, which
  behaves the same in every browser and is the only place the background's own reply is visible.
- **The "File archive" button had no styling.** It was created with `className = 'nxtk-archive-btn'`,
  and this extension ships no rule for that class, so the link Nexus users see in place of the
  hidden footer text rendered as bare underlined text between real buttons. It is now built by the
  same helper as the archived download links and carries Nexus's own button classes; the class name
  is kept alongside them as a hook.
- **The error dialog said a truncated report had gone through.** When a report was too long for the
  issue URL *and* the clipboard copy failed, the button read "GitHub opens prefilled…" — the same
  as a successful shortened report, with nothing to say the full text was lost. It now reuses the
  popup's wording for that outcome, which states it plainly and is already translated everywhere.
- **Three settings read differently with "Always use English" turned on.** That switch returns the
  hardcoded fallback string instead of the locale entry, and three had drifted apart: the archived
  files and auto-close labels, and the download folder description — which in the locale explains
  that leaving the folder empty saves straight into Downloads, because some mod managers never look
  inside subfolders. All 104 call sites that carry an English fallback now match their locale
  entry exactly.
- **The settings table in the README described a panel that does not exist.** Archived file buttons
  and the request timeout were listed in the wrong sections, ad hiding was filed under Advanced when
  it is not, the close-tab delay was folded into another row, and the Cloudflare fallback was absent
  entirely. The table now lists what the panel actually shows, checked row by row against the
  grouping rules the panel builds itself from, and the feature list mentions the close countdown
  and the fallback.

### Changed

- Promoted NexusMods Bypass to the repository root. The three unrelated extensions that
  previously shared this repository now live in their own standalone repositories, each
  with its folder history preserved.
- Renamed the GitHub repository from `google_extention_privacy` to `nexusmods-bypass`.

### Internal

- The two `toastClosingIn` plural entries declare their `$1` substitution in a `placeholders`
  block, which the other 39 substituting entries already did. Positional arguments are replaced
  without it — the block is the context the translated files carry, and it was the only place in
  the 13 locales where that was missing.
- `content/errors.js` carried eight LF lines in an otherwise CRLF file. Normalised; every tracked
  source file is now consistent with itself.

## [2.4.4] — 2026-08-24

### Added

- **Firefox support.** `tools/build-zip.mjs` now writes a second archive,
  `dist/nexus.mods.bypass-<version>-firefox.zip`, for addons.mozilla.org. It carries the
  same files as the Chrome package and a manifest derived from `manifest.json` at build
  time, so a permission or content script added for Chrome cannot go missing from the
  Firefox build. The three keys that differ: an add-on id (`browser_specific_settings.gecko`,
  required by Manifest V3 on AMO), `background.scripts` in place of `background.service_worker`
  (Gecko runs the very same `background.js` as an event page), and no `downloads.ui`
  permission, which does not exist in Firefox. Minimum Firefox is 140 — the version that
  honours the `data_collection_permissions` declaration AMO now requires of new listings.
  The Chrome and Edge manifest is untouched — it is still `src/manifest.json`, packaged
  verbatim.

### Fixed

- **Closing a Vortex tab, and opening page settings from the popup, on Firefox.** Both
  called a `chrome.*` method and chained `.then()`/`.catch()` onto the return value.
  Firefox's `chrome` namespace is callback-based, so on Gecko that threw instead of
  running: AutoCloseTab left the tab open and **Page settings** did nothing. Both now use
  the callback form, which behaves identically in every browser.
- **Page settings no longer reports a failure it did not have.** The content script left
  the message port to close unanswered, which sets `runtime.lastError` in the popup and
  made "the modal opened" indistinguishable from "there is no content script in this
  tab". It answers immediately now.
- **Firefox scrollbars and number fields in the settings panel.** The styled scrollbars
  came from `::-webkit-scrollbar` and the compact number inputs from Chrome-only
  `field-sizing`, so Gecko drew OS scrollbars in the dark glass panels and inputs three
  times wider than any value in them. Both are restated with the standard properties
  behind `@supports` gates — Chrome 121+ understands those properties too and would
  otherwise apply them in place of the styling it already has.

### Internal

- **Comments stripped from every file in the repository.** All 876 of them: 650 from the
  packaged source (`background.js`, `shared.js`, `content/`, `popup/`, `onboarding/` —
  roughly a fifth of its bytes), 40 from `tools/`, and 186 from the After Effects promo
  build under `internal/`. Removed with a scanner that tracks string, template and regex
  state, so no `https://` inside a string and no slash inside a regex literal was
  touched; every file was then minified before and after with an independent parser
  (terser for the scripts, clean-css for the stylesheets) and the two outputs compared
  byte for byte: 31 of the 33 files proved identical that way, and the two HTML files
  carried one comment each. The rationale that used to live in the packaged
  source is what the entries above and in 2.4.3 record.
- **The repository root is now four folders.** `src/` is the extension and nothing else —
  `manifest.json`, `background.js`, `shared.js`, `content/`, `popup/`, `onboarding/`,
  `icons/`, `_locales/` — and is what **Load unpacked** should be pointed at. `internal/`
  takes everything a browser never loads (`docs/`, `store-assets/`, `promo/` and the
  hand-built pre-`build-zip` archive), leaving `tools/` and `dist/` beside them. Archive
  layout is unchanged: entry names are still relative to `src/`, so `manifest.json` sits at
  the root of both packages. The packager's forbidden-path list collapses to one rule.

## [2.4.3] — 2026-08-10

### Removed

- **The "hide the browser download button" setting.** `chrome.downloads.setUiOptions` is
  profile-wide: it hid the download button and progress flyout for *every* site, not only
  Nexus Mods. It originally shipped defaulted on, so profiles carried it without ever
  opting in, and nothing on screen linked the missing button back to this extension. The
  setting is gone from the popup, from the page settings panel, and from all 13 locales.

### Fixed

- Profiles that had the setting enabled get the browser download button back automatically
  on update — no browser restart, nothing to click. A one-shot re-enable runs when the
  service worker starts.

### Internal

- `HideDownloadBar` joins `LEGACY_SETTINGS_KEYS`, so the stored value is stripped from
  every profile on update; the migration's `nxtk_download_ui_default_reset` guard key
  joins `RETIRED_STORAGE_KEYS` and is deleted.
- New `tools/build-zip.mjs` packages releases from an explicit allowlist, gates on
  `check-locales.mjs`, verifies every manifest-referenced file is actually included, and
  produces a byte-identical archive for an unchanged tree. The 2.4.2 package was built by
  hand and shipped `docs/store-listing.md`, `README.md` and `PRIVACY.md` inside the
  extension; the allowlist makes that class of mistake impossible.

### Deprecated

- The `downloads.ui` permission is retained for this release only, to perform the restore
  above. It is removed from the manifest in 2.5.0.
