# Dashboard UX refresh implementation plan

**Goal:** Simplify the entire private diagnostics app on iPhone and desktop while preserving every diagnostic, community and notification workflow.

**Architecture:** Keep the existing text-only DOM rendering and API contracts. Share one compact neumorphic visual system across Overview, Issues, Discussions, issue details and Settings; use native disclosures for secondary explanations and history.

**Design:** Canvas `#12151f`, panels `#171b28`, controls `#1d2233`, text `#f1f4fb`, amber `#f0b86a`, mint `#7ee0b5`. Use the existing native system font for familiar iPhone controls. Left-align headings and numbers, soften shadows, remove glowing text and uppercase labels. Reserve stronger emphasis for the primary action and actionable states.

```
Desktop                         Phone
Audience | Store                Audience
Latest 3 reviews + history       Store
Release health                  Latest 3 reviews + history
Issues + Discussions            Health / filters / details
Diagnostics and filters         Bottom navigation
```

The existing style is an explicit user preference. The refresh improves hierarchy and interaction instead of introducing new decoration, fonts or dependencies.

## Constraints and review focus

- Exactly three latest Store reviews are visible; older unread reviews remain discoverable in a counted disclosure. Deep links open the correct history entry.
- Keep GA4 listing visitors distinct from extension installations, and rating counts distinct from written reviews.
- Shorten helper copy without hiding stale data, errors, consent or authentication state.
- All mobile actions and summaries retain 44px touch targets; form inputs remain 16px to avoid iOS zoom.
- Preserve text-only rendering, safe external links, request cancellation and notification lifecycle behavior.

## Tasks

- [ ] Refresh growth cards, source explanations and latest-three review history; verify review acknowledgements and deep links.
- [ ] Simplify Overview, public feeds, diagnostic details and Settings with consistent short action labels and secondary disclosures.
- [ ] Apply shared compact surfaces, typography, spacing and responsive layouts; inspect phone and desktop screenshots.
- [ ] Run diagnostics checks and Chromium/WebKit interaction tests, review the patch, commit directly to main and deploy the dashboard.

The physical iPhone received the notification test on 24 October, confirmed by the owner. This refresh still requires browser layout/interaction verification after the final styles are applied.
