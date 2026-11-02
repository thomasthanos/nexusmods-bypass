# Re-downloading collection files

An unavailable Nexus file, a Cloudflare check and a file deleted from your computer need different recovery steps.

| Situation | What the extension can establish | What to do |
| --- | --- | --- |
| Nexus explicitly says a mod/file is removed, hidden or unavailable | That file cannot currently be downloaded. The queue skips it and continues with pacing. | Use an available collection revision or the curator's replacement. Repeating the generator request cannot restore it. |
| Nexus returns a real Cloudflare challenge | Availability is unknown. The queue stops on that file; it is not silently advanced or counted as sent/downloaded. | Open the affected Nexus page, complete verification, then retry the collection. Completed-file history is retained. |
| Nexus rate limits requests | Requests must wait, including when the response also contains challenge markup. | Let the displayed cooldown expire. The queue honours `Retry-After`; repeatedly restarting does not clear that wait. |
| Nexus returns HTTP 502/503/504 or a Cloudflare origin failure (520–524) without a challenge | Nexus or its origin is temporarily unavailable; this does not establish that a mod was deleted. | The queue waits and retries the same file with bounded backoff. If the outage persists, it stops on that file and retains completed-file history. |
| A browser-downloaded archive was deleted locally | Saved history records an earlier completion, not the file's current presence on disk. | Choose **Re-download All** in the history dialog, or clear history and select the missing files. **Skip Downloaded** uses the saved history. |
| A Vortex archive was deleted locally, or Vortex never received a link | The browser cannot inspect Vortex's download inventory. **Sent to Vortex** is separate from **Downloaded**. | Start Vortex, check its Downloads tab, and resend the missing files. Sent-only entries are not skipped on a later run; Vortex decides which archives it already has. |

## History and collection revisions

History counts and the start dialog refer to files in the current selection/revision. Older IDs remain stored so returning to an older revision keeps its progress; they do not inflate the current revision's downloaded/sent counts. A recorded completion is still not a disk-presence check.

Importing local archives adds matching files to history. It does not remove older entries when a file is absent from the selection: a file picker may contain only part of a folder. Clear the applicable history first if you need to rebuild it from the files you currently have.

## Restored mods and refreshed metadata

Collection membership can be fixed to a published revision while its nested file/mod metadata changes. Collection metadata is cached for up to ten minutes, including persisted published-revision responses; it is no longer kept forever. If a restored file is absent from the list, reload the collection after that cache window. A download attempt still checks the live Nexus page before requesting its link.

After a partial run, choose **Skip Downloaded** to continue with files not recorded as completed. If files were deleted locally, use **Re-download All** instead. A genuine challenge requires verification before another attempt; the extension does not infer deletion from Cloudflare alone.

A Vortex tab retains the full server-directed wait. Cooldowns shared from a page-driven run to the browser queue currently have a one-hour publishing bound; keep that tab open when it displays a longer wait.
