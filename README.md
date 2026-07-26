# Stop Sync Conflicts

Stops you editing a note before Obsidian Sync has finished bringing it up to
date, which is the usual way sync conflicts get created: you open a note on your
laptop, start typing, and the version your phone saved half a second ago lands
on top of it.

When you open a note, Stop Sync Conflicts covers the editor and holds your keystrokes
until the note is current, then hands it straight back.

## Behaviour

| Situation | What happens |
| --- | --- |
| Obsidian Sync is turned off, or this vault isn't connected to a remote vault | Nothing at all. No banner, no delay. |
| Syncing is paused | Nothing. Waiting could never end. |
| Everything is already synced | Nothing. This is the common case and it costs nothing. |
| A change for **this** note is waiting to download, or the note is transferring | The editor is held until the change arrives. |
| Sync is connected but hasn't reported a finished pass yet (typically just after startup) | The editor is held, because we cannot yet tell whether an update is coming. Configurable. |
| Sync reports an error | Editing is allowed immediately, with a warning that the note may be out of date. Waiting cannot fix an error. |
| Nothing has arrived within the timeout — you're offline | Editing is unblocked with a warning that this note may conflict later. Default 10 seconds. |

While a note is held you always get an **Edit anyway** button, and Cmd/Ctrl
shortcuts such as the command palette keep working.

Nothing here ever writes to your notes. The plugin only stops input from
reaching the editor, so releasing a hold leaves the note exactly as it was.

## Settings

- **Hold notes until they finish syncing** — the master switch.
- **Give up after** — the timeout, 1 to 60 seconds, default 10.
- **Wait while sync is still checking the server** — on by default (safest).
  Turn it off to only ever wait on a confirmed incoming change.
- **Confirm when a note is released** — brief notice once a held note is ready.
- **Warn when sync has an error**.
- **Simulation commands** — see Testing below.
- **Recent activity** — why each note was held or allowed, with a copy button.

## Commands

- **Stop waiting and edit now** — releases any held note.
- **Copy recent activity** — for troubleshooting, including on mobile.
- **Test: …** — the simulation scenarios, when enabled in settings.

## A note on how this works

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
