# uno-twitter
Cuantos tweets a la vez? Uno.

## Extension files

- `manifest.json` registers the private Manifest V3 extension on `https://x.com/*` and `https://twitter.com/*`.
- `content.js` tracks tweet articles, navigation, keyboard shortcuts, tweet-detail/profile/notification-page suspension, tweet-detail "Discover more" cleanup, and infinite-scroll handoff.
- `content.css` keeps the one-tweet hiding and floating controls minimal.
- `popup.html`, `popup.css`, and `popup.js` provide the extension-menu enable/disable toggle.

## Local install

Open `chrome://extensions`, enable Developer mode, choose "Load unpacked", and select this repo folder.
