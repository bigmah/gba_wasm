# gba-wasm

Plays Game Boy Advance ROMs in a browser using the [mGBA](https://mgba.io) core
compiled to WebAssembly, served by a small Rust web server.

ROMs are supplied by you in the browser and stored in the browser. The server
hosts the emulator and nothing else — no game data ever touches it, and nothing
is ever uploaded anywhere.

There is also a single-file build: `dist/gba-wasm.html` is one self-contained
HTML file — emulator, front end, and wasm core inlined — that runs straight off
a `file://` URL with no server at all.

## Quick start

```bash
cargo run --release
```

Open <http://127.0.0.1:8080/>, then add a ROM — drag a `.gba` file onto the page
or click **Choose a ROM file**. It starts straight away and stays in your library
for next time.

Nothing to hand? `roms/connect4.gba` is a homebrew Connect 4 built for the GBA,
included so there is something to run out of the box. Drag it onto the page.

```bash
cargo run --release -- --port 3000      # different port
cargo run --release -- --host 0.0.0.0   # reachable from your network
cargo run --release -- --help
```

## Your ROM library

Files you add live in the browser's own storage, so they survive reloads and
restarts. Use the picker at the top right to switch between them, **Add ROM…**
to add more, and **Remove** to delete one.

Accepted: `.gba`, `.gbc`, `.gb`, `.zip`, `.7z` for ROMs, and `.sav` / `.ss1`–`.ss9`
if you want to bring existing save data with you. Anything else is skipped with a
notice. You can drop several files at once.

An uploaded `.sav` applies the next time that game is started, not to a session
already in progress.

## Default controls

| GBA | Keyboard | Gamepad |
|---|---|---|
| D-Pad | Arrow keys | D-pad or left stick |
| A | <kbd>X</kbd> | A / ✕ |
| B | <kbd>Z</kbd> | X / □ |
| L | <kbd>A</kbd> | LB / L1 |
| R | <kbd>S</kbd> | RB / R1 |
| Start | <kbd>Enter</kbd> | Start |
| Select | <kbd>Right Shift</kbd> | Select |

| Emulator | Keyboard | Gamepad |
|---|---|---|
| Fast-forward (hold) | <kbd>Space</kbd> | RT / R2 |
| Rewind (hold) | <kbd>Backspace</kbd> | LT / L2 |
| Pause / resume | <kbd>P</kbd> | — |
| Save state | <kbd>F5</kbd> | — |
| Load state | <kbd>F8</kbd> | — |
| Reset | unbound | — |

## Changing the controls

Click **Controls**, click any binding slot, then press the key or gamepad button
you want. <kbd>Esc</kbd> cancels and <kbd>Delete</kbd> clears a binding.

Binding the same input to two actions clears it from the older one, so you can't
get a silent double-bind. **Restore defaults** puts everything back.

Bindings are stored per-browser in `localStorage` and applied immediately — no
reload needed. The left analog stick always works as a D-pad regardless of
bindings.

## Saves

ROMs, battery saves, and save states all live in the browser's IndexedDB.
Battery saves are flushed shortly after the game writes them; save states flush
when you save one.

**Clearing site data for `127.0.0.1` erases all of it**, ROM library included.
To pull a save back out, use the browser console:

```js
mgba.FS.readFile(mgba.saveName)   // Uint8Array of the current battery save
mgba.listSaves()                  // what's stored
mgba.listRoms()                   // your ROM library
```

`window.mgba` is the live emulator module, so the whole
[mGBA WASM API](https://thenick775.github.io/mgba/) is available from the console.

## How it works

- `src/main.rs` — Rust server (axum). Serves `web/` as static files. That's all
  it does; there are no ROM endpoints.
- `web/app.js` — boots the core, manages the ROM library, routes all input.
- `web/vendor/` — prebuilt mGBA cores (`@thenick775/mgba-wasm` v2.5.1, MPL-2.0):
  `mgba.*` is the published threaded build, `mgba-single-thread.*` is the same
  core rebuilt with threading off for the single-file bundle.
- `tools/` — scripts to rebuild the single-threaded core and the bundle.
- `roms/` — the one bundled demo ROM. Everything else in here is gitignored,
  so your own ROMs can sit alongside it without ending up in a commit.

Four details worth knowing if you modify this:

**Cross-origin isolation.** The mGBA build the server uses is threaded, so it
needs `SharedArrayBuffer`, which needs `Cross-Origin-Opener-Policy: same-origin`
and `Cross-Origin-Embedder-Policy: require-corp` on every response. The server
sets both. Serving `web/` from a generic static file server will not work — the
page detects this and says so instead of failing silently.

**Input routing.** The core's own SDL keyboard handling is switched off with
`toggleInput(false)`, and every input is fed through `buttonPress`/
`buttonUnpress` instead. One path for keyboard, gamepad, and analog stick, which
is what makes arbitrary remapping possible. A button is held while *any* source
holds it, so keyboard and gamepad never fight each other.

**Core callbacks must be registered after `loadGame`.** Loading a game rebuilds
the core and discards previously registered callbacks. Registering before the
load leaves save-data syncing silently dead. See `registerCoreCallbacks()`.

**`/data` is IDBFS without `autoPersist`.** Nothing reaches IndexedDB until
`FSSync()` is called, so every write path — adding a ROM, removing one, saving a
state — has to call it explicitly.

Static assets are served with `Cache-Control: no-cache`, so edits to `web/` show
up on reload without restarting the server. Only Rust changes need a rebuild.

## Building the single-file bundle

```bash
python3 tools/bundle.py
```

That writes `dist/gba-wasm.html` (~1 MB): the stylesheet, favicon, front end,
mGBA glue, and the wasm core itself — gzipped, base64'd, and inflated at boot
through Emscripten's `instantiateWasm` hook — all in one file. Open it directly,
email it, put it on any static host. Nothing is fetched at runtime.

It uses the single-threaded core because the threaded one needs
`SharedArrayBuffer`, and a lone HTML file cannot serve itself the COOP/COEP
headers that requires. Everything else behaves the same, except that browsers
differ on whether a `file://` page is allowed IndexedDB at all. Where it isn't,
the core falls back to an in-memory filesystem and the ROM library and saves
last only for that session.

## Rebuilding the mGBA core from source

`web/vendor/mgba-single-thread.*` is checked in, so you only need this if you
want to move to a newer mGBA:

```bash
./tools/build-core.sh          # needs emscripten, cmake, ninja, git
python3 tools/bundle.py        # re-bundle with the new core
```

It clones [thenick775/mgba](https://github.com/thenick775/mgba) `feature/wasm`,
applies `tools/mgba-single-thread.patch`, and builds with `USE_PTHREADS=OFF`.
The patch replaces mGBA's `mCoreThread` API with single-threaded stand-ins that
run the core inline on the browser's main loop — see the comments in the patch
for why each hunk exists.

The threaded `web/vendor/mgba.*` is the published npm package as-is; to update
it, `npm pack @thenick775/mgba-wasm` and copy `mgba.js` / `mgba.wasm` out of
`package/dist/`.

## License

This project's own code — `src/`, `web/app.js`, `web/index.html`,
`web/style.css`, `web/favicon.svg`, `tools/bundle.py`, `tools/build-core.sh` —
is MIT licensed. See [LICENSE](LICENSE).

The bundled mGBA core, `tools/mgba-single-thread.patch`, and the core embedded
in `dist/gba-wasm.html` are mGBA-derived and stay under the Mozilla Public
License 2.0. See [NOTICE](NOTICE) and [LICENSE-MPL-2.0.txt](LICENSE-MPL-2.0.txt).

No ROMs are distributed here. Bring your own.
