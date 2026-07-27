# Stop Sync Conflicts

An Obsidian plugin that holds editing on a note until Obsidian Sync has finished
bringing it up to date — so you stop creating sync conflicts.

## Why I built this

I use the same vault from a laptop, a desktop and a phone, and I kept ending up
with `note (conflicted copy).md` files everywhere. The cause is almost always the
same few seconds: you open a note, start typing immediately, and the version
another device saved a moment ago lands on top of what you just wrote. Obsidian
does the only safe thing it can and keeps both — which leaves you merging your
own notes by hand.

Nothing in Obsidian stops you from typing into a note that is about to be
overwritten, so I wrote something that does. When you open a note that has an
update on its way, Stop Sync Conflicts covers the editor and swallows your
keystrokes until the note is current, then hands it straight back with the caret
where you left it. In the normal case — everything already synced — it does
nothing at all and you never notice it.

## Installation

The plugin is not in the Obsidian community plugin store, so pick one of these.

### Manual (recommended)

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/aodetti/obsidian-stop-sync-conflicts/releases/latest).
2. Put them in `<your vault>/.obsidian/plugins/stop-sync-conflicts/` (create the
   folder if it isn't there).
3. In Obsidian, go to **Settings → Community plugins**, hit the reload icon, and
   enable **Stop Sync Conflicts**.

Since the vault is synced, dropping the files into one device's plugin folder is
usually enough — the other devices pick it up on their next sync, and you just
enable it there.

### With BRAT

If you use [BRAT](https://github.com/TfTHacker/obsidian42-brat), add
`aodetti/obsidian-stop-sync-conflicts` as a beta plugin and BRAT will keep it
updated for you.

### From source

```bash
git clone https://github.com/aodetti/obsidian-stop-sync-conflicts.git
cd obsidian-stop-sync-conflicts
npm install
npm run build
```

Then copy `main.js`, `manifest.json` and `styles.css` into
`<your vault>/.obsidian/plugins/stop-sync-conflicts/`.

Requires Obsidian 1.5.0 or later. Works on desktop and mobile. It only does
anything if you have an Obsidian Sync subscription — with sync off, the plugin
stays completely inert.

## Features

- **Holds the editor while a note is catching up.** Opening a note with a
  confirmed incoming change, or one that is downloading right now, puts a
  "Waiting for sync" overlay over the editor until the change lands.
- **Really blocks input, not just clicks.** Typing, pasting, cutting,
  drag-and-drop and IME composition are all suppressed, and the caret is moved
  out of the document, so queued keystrokes have nowhere to land. Cmd/Ctrl
  shortcuts still work, so the command palette and your hotkeys are never
  trapped behind the overlay.
- **Never touches your notes.** The plugin only stops input from reaching the
  editor. Releasing a hold leaves the note byte-for-byte as it was.
- **An escape hatch, always.** Every hold shows an **Edit anyway** button and a
  live countdown of how long it will keep waiting.
- **A timeout, so you can never get stuck.** If sync hasn't caught up within the
  timeout — you're on a train with no signal, say — editing is unblocked with a
  warning that this note may conflict later. Default 10 seconds.
- **It gets out of the way.** Sync off, vault not connected, syncing paused, or
  everything already synced: no banner, no delay, no cost. This is the common
  case.
- **Sensible on errors.** If sync reports an error, waiting cannot fix it, so
  editing is allowed immediately with a warning that the note may be stale.
- **Covers pane switching too.** Switching to a pane that already had the note
  open doesn't fire Obsidian's `file-open` event, but it is still the moment you
  start typing — so that path is guarded as well.
- **Recent activity log.** Every decision, and the reason for it, is recorded in
  settings with a copy button. The console isn't reachable on mobile, which is
  exactly where "why was my note held?" is hardest to answer.
- **Simulation commands.** Fake sync states — downloading, offline, paused,
  error — so you can see exactly how it behaves without a second device.
- **Fails open by design.** If Obsidian changes its sync internals, the plugin
  decides "sync is unavailable" and blocks nothing. A broken assumption makes it
  inert; it can never lock you out of your notes.

### What happens in each situation

| Situation | What happens |
| --- | --- |
| Obsidian Sync is turned off, or this vault isn't connected to a remote vault | Nothing at all. No banner, no delay. |
| Syncing is paused | Nothing. Waiting could never end. |
| Everything is already synced | Nothing. This is the common case and it costs nothing. |
| A change for **this** note is waiting to download, or the note is transferring | The editor is held until the change arrives. |
| A change is waiting for a **different** note | Nothing. The change is elsewhere. |
| Sync is connected but hasn't reported a finished pass yet (typically just after startup) | The editor is held, because we cannot yet tell whether an update is coming. Configurable. |
| Sync reports an error | Editing is allowed immediately, with a warning that the note may be out of date. Waiting cannot fix an error. |
| Nothing has arrived within the timeout — you're offline | Editing is unblocked with a warning that this note may conflict later. Default 10 seconds. |

## Settings

Found under **Settings → Community plugins → Stop Sync Conflicts**.

| Setting | Default | What it does |
| --- | --- | --- |
| **Hold notes until they finish syncing** | On | The master switch. Turning it off releases any note currently held and stops the plugin doing anything. |
| **Give up after** | 10 seconds | How long a note is held before editing is unblocked with a conflict warning. Anywhere from 1 to 60 seconds. Lower means less waiting when you're offline; higher means more protection on a slow connection. |
| **Wait while sync is still checking the server** | On | Just after startup, sync hasn't yet reported which notes changed, so "no pending change" doesn't mean "safe". On is the safest against conflicts. Turn it off if you find the post-startup wait annoying and you'd rather only ever wait on a confirmed incoming change. |
| **Confirm when a note is released** | On | Shows a brief notice once a held note is up to date. Suppressed for holds shorter than about a second, where it would just be noise. |
| **Warn when sync has an error** | On | Since sync errors can't be waited out, editing is allowed straight away — this shows a notice explaining the note may be out of date. |
| **Simulation commands** | Off | Adds the `Test: …` commands described below. Reload the plugin after changing this. |
| **Recent activity** | — | The last 25 decisions the plugin made, newest first, with a **Copy** button that copies the full buffer for troubleshooting (it works on mobile too). The buffer holds 200 entries, lives in memory only, and never leaves your device unless you copy it yourself. |

## Commands

- **Stop waiting and edit now** — releases any held note immediately.
- **Copy recent activity** — the same copy as in settings, from the command palette.
- **Test: …** — the simulation scenarios, when enabled in settings.

## How this works

Obsidian Sync has no public API, so the plugin reads the internal sync instance
at `app.internalPlugins.plugins.sync.instance`. The fields it relies on
(`getStatus()`, `newServerFiles`, `syncingPath`, `initial`) are undocumented and
could change in any Obsidian release.

That risk is contained deliberately:

- Everything that touches internals lives in [`src/sync-api.ts`](src/sync-api.ts).
- The instance is structurally validated before use, and every read is
  feature-detected.
- If anything is missing or throws, the plugin resolves to "sync is
  unavailable" and blocks nothing. A broken assumption makes the plugin
  inert — it can never lock you out of your notes.

## Development

```bash
npm install
npm run dev     # watch build
npm run build   # type-check and production build
npm run lint
npm test        # unit tests
```

### Testing

The decision logic is pure and covered by unit tests:

```bash
npm test
```

There is also an end-to-end suite that drives a real Obsidian instance over the
DevTools protocol. It injects fake sync states, then types with genuine
keystrokes to prove that a held note really cannot be modified:

```bash
open -a Obsidian --args --remote-debugging-port=9222
npm run test:e2e
```

Without a sync subscription you can still exercise every branch by hand: turn on
**Simulation commands** in settings and run any of the `Test: …` commands from
the command palette. Each one tells you what to expect, then run **Test: Use
real sync** to switch back.

Note that the end-to-end suite and the simulation commands both stand in for
real sync traffic. The behaviour against a live, connected sync account has not
been exercised on a real subscription.

## License

[0BSD](LICENSE)
