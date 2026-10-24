# Dashboard UX refresh implementation plan

**Goal:** Simplify the entire private diagnostics app on iPhone and desktop while preserving every diagnostic, community and notification workflow.

**Architecture:** Keep the existing text-only DOM rendering and API contracts. Share one compact charcoal glass visual system across Overview, Issues, Discussions, issue details and Settings; use native disclosures for secondary explanations and history.

**Design:** The owner's supplied reference refines the visual direction to charcoal glass: canvas `#0d0e10`, panels `#1b1c1f`, controls `#26272a`, text `#f6f4f0`, gold `#f3c77a`, mint `#a1f0c8`. Use the existing native system font for familiar iPhone controls. Left-align headings and numbers, use translucent surfaces with fine light borders and warm background light, and reserve gold illumination for active navigation and primary actions. Shared trusted SVG icons identify sections.

```
Desktop                         Phone
Audience | Store                Audience
Latest 3 reviews + history       Store
Release health                  Latest 3 reviews + history
Issues + Discussions            Health / filters / details
Diagnostics and filters         Bottom navigation
```

The supplied image is the visual reference for all screens. Metrics remain real API values; the backend supplies no time series, so the layout does not invent charts or unsupported date-range controls. No external fonts, image downloads or new dependencies are needed.

## Constraints and review focus

- Exactly three latest Store reviews are visible; older unread reviews remain discoverable in a counted disclosure. Deep links open the correct history entry.
- Keep GA4 listing visitors distinct from extension installations, and rating counts distinct from written reviews.
- Shorten helper copy without hiding stale data, errors, consent or authentication state.
- All mobile actions and summaries retain 44px touch targets; form inputs remain 16px to avoid iOS zoom.
- Preserve text-only rendering, safe external links, request cancellation and notification lifecycle behavior.

## Tasks

- [x] Refresh growth cards, source explanations and latest-three review history; verify review acknowledgements and deep links.
- [x] Simplify Overview, public feeds, diagnostic details and Settings with consistent short action labels and secondary disclosures.
- [x] Apply shared compact surfaces, typography, spacing and responsive layouts; inspect phone and desktop screenshots.
- [x] Run diagnostics checks and Chromium/WebKit interaction tests, review the patch, commit directly to main and deploy the dashboard.

The physical iPhone received the notification test on 24 October, confirmed by the owner. The refreshed layouts passed Chromium and WebKit checks at 320, 390, 430 and 1280px; 387 diagnostics tests and 31 browser tests per engine passed. The follow-up viewport matrix reported no CSP violations. Independent review findings about hidden history errors and blocked decorative icons were fixed and rechecked.

Deployed on 24 October as Worker version `6a5b15dc-af45-4060-b7d9-76dc4a964efe`. The protected production UI showed real GA4 and Store metrics, exactly three review cards and closed history. Settings retained the existing device registration, and unauthenticated page, script and admin endpoint checks still required Access. This is browser layout verification; the new visual design has not been separately confirmed on the physical phone.
