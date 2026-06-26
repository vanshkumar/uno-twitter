# uno-twitter
Cuantos tweets a la vez? Uno.

## Extension files

- `manifest.json` registers the private Manifest V3 extension on `https://x.com/*` and `https://twitter.com/*`.
- `content.js` tracks tweet articles, groups adjacent in-feed conversation previews that X has already rendered with avatar-rail connector cues, navigation, keyboard shortcuts, tweet-detail/profile/notification-page suspension, tweet-detail "Discover more" cleanup, and infinite-scroll handoff.
- `content.css` keeps the one-tweet hiding and floating controls minimal.
- `popup.html`, `popup.css`, and `popup.js` provide the extension-menu enable/disable toggle.

## Feed behavior

On supported home/feed pages, Uno shows one standalone tweet or one rendered conversation-preview group at a time. When X displays reply/thread context as adjacent tweet articles with the vertical connector around the avatar rail, Uno keeps that whole preview visible and moves over it as a single navigation item.

## Local install

Open `chrome://extensions`, enable Developer mode, choose "Load unpacked", and select this repo folder.
