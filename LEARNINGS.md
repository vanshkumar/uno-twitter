# Learnings

## What Has Worked

## Patterns and Preferences

**2026-06-26 — Chrome extension scaffold**
- Observation: The repo is currently a plain unpacked Chrome extension with root-level MV3 files; there is no package manager or build tooling.
- Action: Keep future extension changes dependency-free and root-level unless a build step is intentionally introduced.
- Confidence: high

**2026-06-26 — X timeline hiding**
- Observation: Collapsing non-current tweet articles with `display: none` makes X timelines feel like they are constantly loading more content because the document height shrinks under the virtualized feed.
- Action: Hide non-current tweets without removing their layout space, and only scroll for more content from the explicit Next-at-end path.
- Confidence: high

**2026-06-26 — X tweet detail pages**
- Observation: Tweet detail URLs use the same `article[data-testid="tweet"]` containers for the main tweet and replies, so one-at-a-time hiding on `/status/:id` pages hides replies.
- Action: Suspend one-tweet mode on tweet-detail URLs and clear any hidden tweet classes there.
- Confidence: high

**2026-06-26 — X notifications**
- Observation: X notification pages also use tweet-like `article[data-testid="tweet"]` containers, so broad article hiding makes only one notification visible.
- Action: Suspend one-tweet mode on `/notifications` and `/i/notifications` routes.
- Confidence: high

## What Has Failed
