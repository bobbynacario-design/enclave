# Enclave

Enclave is an invite-only private community app.

Built with vanilla HTML, CSS, and JavaScript — no frameworks, no build tools. Deployable directly to GitHub Pages.

## Structure

```
enclave/
├── index.html        # Entry point
├── app.js            # App init, router, page stubs
├── style.css         # Global styles
├── firebase.js       # Firebase config + db/auth refs
├── pages/            # Page modules (feed, events, members, messages)
├── components/       # Reusable UI snippets
└── assets/           # Images, icons, fonts
```

## Setup

1. Replace the placeholder values in `firebase.js` with your Firebase project credentials.
2. Deploy the repo root to GitHub Pages.
