/**
 * Front-end for the mGBA WASM core.
 *
 * Input design: the core's own SDL keyboard handling is switched off with
 * `toggleInput(false)`, and every input — keyboard, gamepad buttons, analog
 * stick — is routed through `buttonPress`/`buttonUnpress` instead. That keeps
 * one code path for all devices and makes arbitrary remapping possible.
 */

import mGBA from "/vendor/mgba.js";

// ---------------------------------------------------------------- constants

/** Button names the core understands (see mgba.js `keyBindings`). */
const GBA_ACTIONS = [
  { id: "up",     label: "Up",     key: "ArrowUp",    pad: "b12" },
  { id: "down",   label: "Down",   key: "ArrowDown",  pad: "b13" },
  { id: "left",   label: "Left",   key: "ArrowLeft",  pad: "b14" },
  { id: "right",  label: "Right",  key: "ArrowRight", pad: "b15" },
  { id: "a",      label: "A",      key: "KeyX",       pad: "b0"  },
  { id: "b",      label: "B",      key: "KeyZ",       pad: "b2"  },
  { id: "l",      label: "L",      key: "KeyA",       pad: "b4"  },
  { id: "r",      label: "R",      key: "KeyS",       pad: "b5"  },
  { id: "start",  label: "Start",  key: "Enter",      pad: "b9"  },
  { id: "select", label: "Select", key: "ShiftRight", pad: "b8"  },
];

/** Emulator actions, not GBA buttons. `hold` ones act while pressed. */
const HOTKEY_ACTIONS = [
  { id: "fastForward", label: "Fast-forward (hold)", key: "Space",     pad: "b7", hold: true },
  { id: "rewind",      label: "Rewind (hold)",       key: "Backspace", pad: "b6", hold: true },
  { id: "pause",       label: "Pause / resume",      key: "KeyP",      pad: ""  },
  { id: "saveState",   label: "Save state",          key: "F5",        pad: ""  },
  { id: "loadState",   label: "Load state",          key: "F8",        pad: ""  },
  { id: "reset",       label: "Reset",               key: "",          pad: ""  },
];

const ALL_ACTIONS = [...GBA_ACTIONS, ...HOTKEY_ACTIONS];
const GBA_IDS = new Set(GBA_ACTIONS.map((a) => a.id));

const BINDINGS_KEY = "gbawasm.bindings.v2";
const SETTINGS_KEY = "gbawasm.settings.v2";
const FF_MULTIPLIER = 4;
const AXIS_DEADZONE = 0.5;

// ---------------------------------------------------------------- dom refs

const $ = (id) => document.getElementById(id);
const el = {
  canvas: $("screen"),
  screenWrap: $("screen-wrap"),
  overlay: $("overlay"),
  overlayText: $("overlay-text"),
  overlayAction: $("overlay-action"),
  overlayHint: $("overlay-hint"),
  spinner: $("spinner"),
  status: $("status"),
  romSelect: $("rom-select"),
  fps: $("fps"),
  coreVersion: $("core-version"),
  gamepadStatus: $("gamepad-status"),
  bindingTable: $("binding-table"),
  controlsPanel: $("controls-panel"),
};

function setStatus(text, kind = "") {
  el.status.textContent = text;
  el.status.className = "status" + (kind ? " " + kind : "");
}

function showOverlay(text, { spinner = true, action = null, error = false, hint = false } = {}) {
  el.overlay.hidden = false;
  el.overlayText.textContent = text;
  el.overlayText.className = error ? "error" : "";
  el.spinner.hidden = !spinner;
  if (action) {
    el.overlayAction.hidden = false;
    el.overlayAction.textContent = action.label;
    el.overlayAction.onclick = action.onClick;
  } else {
    el.overlayAction.hidden = true;
    el.overlayAction.onclick = null;
  }
  el.overlayHint.hidden = !hint;
}

const hideOverlay = () => { el.overlay.hidden = true; };

// ---------------------------------------------------------------- settings

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

const saveJSON = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
};

const defaultBindings = () => {
  const out = {};
  for (const a of ALL_ACTIONS) out[a.id] = { key: a.key, pad: a.pad };
  return out;
};

let bindings = loadJSON(BINDINGS_KEY, defaultBindings());
let settings = loadJSON(SETTINGS_KEY, { volume: 70, scale: 3, slot: 1, rom: "" });

// Drop bindings for actions that no longer exist, add ones that are new.
for (const a of ALL_ACTIONS) {
  if (!bindings[a.id] || typeof bindings[a.id] !== "object") {
    bindings[a.id] = { key: a.key, pad: a.pad };
  }
}

const persistBindings = () => saveJSON(BINDINGS_KEY, bindings);
const persistSettings = () => saveJSON(SETTINGS_KEY, settings);

// ---------------------------------------------------------------- key names

/** Turns a KeyboardEvent.code into something readable. */
function keyLabel(code) {
  if (!code) return "—";
  const named = {
    ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
    Space: "Space", Enter: "Enter", Escape: "Esc", Backspace: "Backspace",
    Tab: "Tab", CapsLock: "Caps Lock", ContextMenu: "Menu",
    ShiftLeft: "Left Shift", ShiftRight: "Right Shift",
    ControlLeft: "Left Ctrl", ControlRight: "Right Ctrl",
    AltLeft: "Left Alt", AltRight: "Right Alt",
    MetaLeft: "Left Cmd", MetaRight: "Right Cmd",
    Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
    Backslash: "\\", Semicolon: ";", Quote: "'", Backquote: "`",
    Comma: ",", Period: ".", Slash: "/",
  };
  if (named[code]) return named[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "Numpad " + code.slice(6);
  return code;
}

/** Turns a gamepad binding token ("b0", "a1-") into something readable. */
function padLabel(token) {
  if (!token) return "—";
  if (token.startsWith("b")) {
    const names = {
      b0: "A / ✕", b1: "B / ○", b2: "X / □", b3: "Y / △",
      b4: "LB / L1", b5: "RB / R1", b6: "LT / L2", b7: "RT / R2",
      b8: "Select", b9: "Start", b10: "L-Stick", b11: "R-Stick",
      b12: "D-Pad ↑", b13: "D-Pad ↓", b14: "D-Pad ←", b15: "D-Pad →",
    };
    return names[token] || "Button " + token.slice(1);
  }
  if (token.startsWith("a")) {
    const dir = token.endsWith("+") ? "+" : "−";
    return "Axis " + token.slice(1, -1) + dir;
  }
  return token;
}

// ---------------------------------------------------------------- emulator

/** @type {import('/vendor/mgba.js').mGBAEmulator | null} */
let Module = null;
let running = false;
let paused = false;
let currentRom = null;
let fastForwarding = false;
let rewinding = false;

/**
 * Tracks which sources are holding each GBA button. A button is pressed when
 * its source set becomes non-empty and released when it empties, so keyboard
 * and gamepad can hold the same button without fighting each other.
 */
const heldBy = new Map();

function setButton(buttonId, source, down) {
  if (!Module || !running) return;
  let sources = heldBy.get(buttonId);
  if (!sources) heldBy.set(buttonId, (sources = new Set()));

  const wasDown = sources.size > 0;
  if (down) sources.add(source);
  else sources.delete(source);
  const isDown = sources.size > 0;

  if (isDown === wasDown) return;
  try {
    if (isDown) Module.buttonPress(buttonId);
    else Module.buttonUnpress(buttonId);
  } catch (e) {
    console.warn("input failed", buttonId, e);
  }
}

function releaseAllInputs() {
  for (const [buttonId, sources] of heldBy) {
    if (sources.size > 0) {
      sources.clear();
      try { Module?.buttonUnpress(buttonId); } catch { /* core may be down */ }
    }
  }
  if (fastForwarding) setFastForward(false);
  if (rewinding) setRewind(false);
}

function setFastForward(on) {
  if (!Module || fastForwarding === on) return;
  fastForwarding = on;
  try { Module.setFastForwardMultiplier(on ? FF_MULTIPLIER : 1); } catch { /* ignore */ }
  $("btn-ff").classList.toggle("active", on);
}

function setRewind(on) {
  if (!Module || rewinding === on) return;
  rewinding = on;
  try { Module.toggleRewind(on); } catch { /* ignore */ }
}

function setPaused(next) {
  if (!Module || !running) return;
  paused = next;
  try {
    if (paused) { Module.pauseGame(); releaseAllInputs(); }
    else Module.resumeGame();
  } catch { /* ignore */ }
  $("btn-pause").textContent = paused ? "Resume" : "Pause";
  setStatus(paused ? "paused" : "running", paused ? "" : "ok");
}

let saveSyncTimer = null;
let frameCount = 0;

/**
 * Registers the core callbacks we care about.
 *
 * `loadGame` tears down and rebuilds the core, discarding any callbacks that
 * were registered beforehand, so this has to run again after every load.
 */
function registerCoreCallbacks() {
  if (!Module) return;
  Module.addCoreCallbacks({
    // Push battery saves out to IndexedDB shortly after the game writes them.
    saveDataUpdatedCallback: () => {
      clearTimeout(saveSyncTimer);
      saveSyncTimer = setTimeout(() => Module.FSSync().catch(() => {}), 800);
    },
    videoFrameEndedCallback: () => { frameCount++; },
  });
}

const currentSlot = () => parseInt($("state-slot").value, 10) || 1;

function doSaveState() {
  if (!Module || !running) return;
  const slot = currentSlot();
  const ok = Module.saveState(slot);
  setStatus(ok ? "saved slot " + slot : "save failed", ok ? "ok" : "error");
  Module.FSSync().catch(() => {});
}

function doLoadState() {
  if (!Module || !running) return;
  const slot = currentSlot();
  const ok = Module.loadState(slot);
  setStatus(ok ? "loaded slot " + slot : "no state in slot " + slot, ok ? "ok" : "error");
}

/** Hotkeys that fire once per press. */
function fireHotkey(id) {
  switch (id) {
    case "pause":     setPaused(!paused); break;
    case "saveState": doSaveState(); break;
    case "loadState": doLoadState(); break;
    case "reset":
      if (Module && running) { releaseAllInputs(); Module.quickReload(); setStatus("reset", "ok"); }
      break;
  }
}

/** Hotkeys that act while held. */
function holdHotkey(id, down) {
  if (id === "fastForward") setFastForward(down);
  else if (id === "rewind") setRewind(down);
}

// ---------------------------------------------------------------- keyboard

/** Set while the UI is waiting for the user to press a key to rebind. */
let listening = null;

function isTypingTarget(target) {
  return target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "SELECT" ||
     target.tagName === "TEXTAREA" || target.isContentEditable);
}

/** Finds the action bound to a KeyboardEvent.code, if any. */
function actionForKey(code) {
  for (const a of ALL_ACTIONS) if (bindings[a.id]?.key === code) return a;
  return null;
}

window.addEventListener("keydown", (e) => {
  if (listening) { captureKey(e); return; }
  if (isTypingTarget(e.target)) return;

  const action = actionForKey(e.code);
  if (!action) return;
  e.preventDefault();
  if (e.repeat) return;

  if (GBA_IDS.has(action.id)) setButton(action.id, "kb", true);
  else if (action.hold) holdHotkey(action.id, true);
  else fireHotkey(action.id);
}, { capture: true });

window.addEventListener("keyup", (e) => {
  if (listening || isTypingTarget(e.target)) return;
  const action = actionForKey(e.code);
  if (!action) return;
  e.preventDefault();

  if (GBA_IDS.has(action.id)) setButton(action.id, "kb", false);
  else if (action.hold) holdHotkey(action.id, false);
}, { capture: true });

// Never leave a button stuck down when the page loses focus.
window.addEventListener("blur", releaseAllInputs);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseAllInputs();
});

// ---------------------------------------------------------------- gamepad

/** Previous frame's pressed-state per binding token, per action. */
const padPrev = new Map();
let padConnected = false;

function padPressed(gp, token) {
  if (!token) return false;
  if (token.startsWith("b")) {
    const idx = parseInt(token.slice(1), 10);
    const btn = gp.buttons[idx];
    return !!btn && (typeof btn === "object" ? btn.pressed : btn > 0.5);
  }
  if (token.startsWith("a")) {
    const idx = parseInt(token.slice(1, -1), 10);
    const value = gp.axes[idx];
    if (typeof value !== "number") return false;
    return token.endsWith("+") ? value > AXIS_DEADZONE : value < -AXIS_DEADZONE;
  }
  return false;
}

function pollGamepads() {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  const gp = Array.from(pads).find((p) => p && p.connected);

  if (!!gp !== padConnected) {
    padConnected = !!gp;
    el.gamepadStatus.textContent = gp ? "Gamepad: " + gp.id : "No gamepad detected.";
    el.gamepadStatus.classList.toggle("connected", padConnected);
  }

  if (gp) {
    if (listening?.kind === "pad") capturePad(gp);

    for (const action of ALL_ACTIONS) {
      const token = bindings[action.id]?.pad;
      const down = token ? padPressed(gp, token) : false;
      const was = padPrev.get(action.id) || false;
      padPrev.set(action.id, down);

      if (GBA_IDS.has(action.id)) {
        setButton(action.id, "pad", down);
      } else if (action.hold) {
        if (down !== was) holdHotkey(action.id, down);
      } else if (down && !was) {
        fireHotkey(action.id);
      }
    }

    // The left analog stick always drives the D-pad, on top of any bindings.
    setButton("left",  "stick", gp.axes[0] < -AXIS_DEADZONE);
    setButton("right", "stick", gp.axes[0] >  AXIS_DEADZONE);
    setButton("up",    "stick", gp.axes[1] < -AXIS_DEADZONE);
    setButton("down",  "stick", gp.axes[1] >  AXIS_DEADZONE);
  }

  requestAnimationFrame(pollGamepads);
}

// ---------------------------------------------------------------- rebinding

function stopListening() {
  if (!listening) return;
  listening.slot.classList.remove("listening");
  listening.slot.textContent = listening.previousLabel;
  listening = null;
}

/** Clears a binding held by any *other* action, so two actions can't share one. */
function clearConflicts(actionId, kind, value) {
  for (const a of ALL_ACTIONS) {
    if (a.id === actionId) continue;
    if (bindings[a.id]?.[kind] === value) bindings[a.id][kind] = "";
  }
}

function assign(actionId, kind, value) {
  if (value) clearConflicts(actionId, kind, value);
  bindings[actionId][kind] = value;
  persistBindings();
  renderBindings();
}

function captureKey(e) {
  e.preventDefault();
  e.stopPropagation();
  if (listening.kind !== "key") return;

  const { actionId } = listening;
  if (e.code === "Escape") { stopListening(); return; }
  if (e.code === "Delete") { const id = actionId; stopListening(); assign(id, "key", ""); return; }

  stopListening();
  assign(actionId, "key", e.code);
}

function capturePad(gp) {
  const { actionId } = listening;

  for (let i = 0; i < gp.buttons.length; i++) {
    const btn = gp.buttons[i];
    const pressed = typeof btn === "object" ? btn.pressed : btn > 0.5;
    if (pressed) { stopListening(); assign(actionId, "pad", "b" + i); return; }
  }
  for (let i = 0; i < gp.axes.length; i++) {
    const value = gp.axes[i];
    if (value > 0.85)  { stopListening(); assign(actionId, "pad", "a" + i + "+"); return; }
    if (value < -0.85) { stopListening(); assign(actionId, "pad", "a" + i + "-"); return; }
  }
}

function beginListening(slot, actionId, kind) {
  stopListening();
  listening = { slot, actionId, kind, previousLabel: slot.textContent };
  slot.classList.add("listening");
  slot.textContent = kind === "key" ? "press a key…" : "press a gamepad button…";
  releaseAllInputs();
}

// ---------------------------------------------------------------- binding UI

function renderBindings() {
  // Keep the header row, replace everything after it.
  el.bindingTable.querySelectorAll(".binding-row:not(.header)").forEach((n) => n.remove());

  const addRow = (action, isHotkey) => {
    const row = document.createElement("div");
    row.className = "binding-row";

    const name = document.createElement("span");
    name.className = "action-name" + (isHotkey ? " hotkey" : "");
    name.textContent = action.label;
    row.appendChild(name);

    for (const kind of ["key", "pad"]) {
      const value = bindings[action.id]?.[kind] || "";
      const slot = document.createElement("button");
      slot.className = "slot" + (value ? "" : " unbound");
      slot.textContent = kind === "key" ? keyLabel(value) : padLabel(value);
      slot.title = value ? "Click to rebind — " + value : "Unbound. Click to bind.";
      slot.addEventListener("click", () => beginListening(slot, action.id, kind));
      row.appendChild(slot);
    }

    el.bindingTable.appendChild(row);
  };

  for (const a of GBA_ACTIONS) addRow(a, false);
  for (const a of HOTKEY_ACTIONS) addRow(a, true);
}

// Clicking elsewhere, or pressing Escape, cancels a pending rebind.
document.addEventListener("pointerdown", (e) => {
  if (listening && e.target !== listening.slot) stopListening();
}, true);

// ---------------------------------------------------------------- display

function applyScale() {
  const scale = parseInt(settings.scale, 10) || 0;
  if (scale === 0) {
    el.canvas.style.width = "min(100%, 720px)";
    el.canvas.style.height = "auto";
    el.canvas.style.aspectRatio = "240 / 160";
  } else {
    el.canvas.style.aspectRatio = "";
    el.canvas.style.width = 240 * scale + "px";
    el.canvas.style.height = 160 * scale + "px";
  }
}

// ------------------------------------------------------------- rom library

/** Extensions mGBA's `uploadRom` accepts. */
const ROM_EXTENSIONS = ["gba", "gbc", "gb", "zip", "7z"];

function fileExtension(name) {
  const parts = name.split(".");
  return parts.length < 2 ? "" : parts[parts.length - 1].toLowerCase();
}

const isRomFile = (name) => ROM_EXTENSIONS.includes(fileExtension(name));
const isSaveFile = (name) => {
  const ext = fileExtension(name);
  return ext === "sav" || /^ss\d+$/.test(ext);
};

/**
 * Promise wrapper around mGBA's callback-style upload helpers.
 *
 * Those helpers bail out silently — never invoking the callback — when they
 * don't recognise an extension, so the timeout keeps a rejected file from
 * hanging the caller forever. Callers pre-validate, so it should never fire.
 */
function uploadViaCore(method, file) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("mGBA would not accept " + file.name));
    }, 20000);

    try {
      method.call(Module, file, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    } catch (e) {
      settled = true;
      clearTimeout(timer);
      reject(e);
    }
  });
}

/** ROMs currently stored in this browser. `listRoms` is a raw readdir. */
function libraryRoms() {
  if (!Module) return [];
  try {
    return Module.listRoms()
      .filter((n) => n !== "." && n !== ".." && isRomFile(n))
      .sort();
  } catch {
    return [];
  }
}

function refreshRomLibrary(preferred) {
  const roms = libraryRoms();
  el.romSelect.innerHTML = "";

  if (!roms.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "no ROMs yet";
    el.romSelect.appendChild(option);
    el.romSelect.disabled = true;
    $("btn-remove-rom").disabled = true;
    return roms;
  }

  for (const name of roms) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    el.romSelect.appendChild(option);
  }
  el.romSelect.disabled = false;
  $("btn-remove-rom").disabled = false;

  const candidates = [preferred, settings.rom, roms[0]];
  el.romSelect.value = candidates.find((c) => roms.includes(c)) || roms[0];
  return roms;
}

/** Boots whichever ROM is selected in the picker. */
async function startSelectedRom() {
  const name = el.romSelect.value;
  if (!name) return;
  showOverlay("Starting…");
  unlockAudio();
  try {
    await loadRom(name);
  } catch (e) {
    console.error(e);
    showOverlay(String(e.message || e), { spinner: false, error: true });
    setStatus("load failed", "error");
  }
}

/** The ROM is already in the browser's filesystem, so this just starts it. */
async function loadRom(name) {
  if (!Module) return;
  setStatus("loading…");

  const romPath = Module.filePaths().gamePath + "/" + name;
  if (!Module.loadGame(romPath)) throw new Error("mGBA refused to load " + name);
  registerCoreCallbacks();

  currentRom = name;
  running = true;
  settings.rom = name;
  persistSettings();

  Module.setVolume((parseInt(settings.volume, 10) || 0) / 100);
  setPaused(false);
  hideOverlay();
  el.canvas.focus();
  setStatus("running", "ok");
}

/**
 * Files ROMs and save data into the browser's emulator storage.
 * Returns the name of the last ROM added, or null.
 */
async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length || !Module) return null;

  const roms = [];
  const saves = [];
  const skipped = [];

  for (const file of files) {
    try {
      if (isRomFile(file.name)) {
        await uploadViaCore(Module.uploadRom, file);
        roms.push(file.name);
      } else if (isSaveFile(file.name)) {
        await uploadViaCore(Module.uploadSaveOrSaveState, file);
        saves.push(file.name);
      } else {
        skipped.push(file.name);
      }
    } catch (e) {
      console.error("upload failed:", file.name, e);
      skipped.push(file.name);
    }
  }

  await Module.FSSync().catch(() => {});
  refreshRomLibrary(roms[roms.length - 1]);

  const plural = (n, word) => n + " " + word + (n === 1 ? "" : "s");
  if (roms.length) setStatus("added " + plural(roms.length, "ROM"), "ok");
  else if (saves.length) setStatus("added " + plural(saves.length, "save"), "ok");
  if (skipped.length) {
    setStatus("skipped " + plural(skipped.length, "file"), "error");
    console.warn("unsupported:", skipped.join(", "));
  }

  return roms.length ? roms[roms.length - 1] : null;
}

/** Shared entry point for the file picker and drag-and-drop. */
async function handleIncomingFiles(fileList) {
  if (!Module) return;
  unlockAudio();
  const added = await addFiles(fileList);

  if (added && !running) {
    el.romSelect.value = added;
    await startSelectedRom();
  } else if (!running) {
    showIdleOverlay();
  }
}

async function removeSelectedRom() {
  const name = el.romSelect.value;
  if (!name || !Module) return;
  if (!confirm("Remove " + name + " from this browser?\n\nSave data for it is kept.")) return;

  try {
    Module.FS.unlink(Module.filePaths().gamePath + "/" + name);
  } catch (e) {
    console.warn("could not remove", name, e);
    setStatus("remove failed", "error");
    return;
  }
  await Module.FSSync().catch(() => {});

  if (currentRom === name) {
    releaseAllInputs();
    try { Module.quitGame(); } catch { /* ignore */ }
    running = false;
    paused = false;
    currentRom = null;
  }

  refreshRomLibrary();
  setStatus("removed " + name, "ok");
  if (!running) showIdleOverlay();
}

/** Whatever should be on screen when no game is running. */
function showIdleOverlay(roms = libraryRoms()) {
  if (!roms.length) {
    showOverlay(
      "No ROMs in this browser yet. Add a .gba file to start playing — it stays " +
      "on your machine and is never uploaded anywhere.",
      { spinner: false, hint: true, action: { label: "Choose a ROM file", onClick: () => $("file-input").click() } },
    );
  } else {
    showOverlay("Ready — " + (el.romSelect.value || roms[0]), {
      spinner: false,
      hint: true,
      action: { label: "Click to start", onClick: startSelectedRom },
    });
  }
}

// ---------------------------------------------------------------- audio

let audioReady = false;

/** Browsers keep the audio context suspended until a real user gesture. */
function unlockAudio() {
  if (audioReady || !Module) return;
  const ctx = Module.SDL2?.audioContext;
  if (!ctx) return;
  if (ctx.state === "running") { audioReady = true; return; }
  ctx.resume().then(() => { audioReady = true; }).catch(() => {});
}

document.addEventListener("pointerdown", unlockAudio, true);
document.addEventListener("keydown", unlockAudio, true);

// ------------------------------------------------------------ drag and drop

function wireDragAndDrop() {
  const veil = $("drop-veil");
  let depth = 0;
  const carriesFiles = (e) => Array.from(e.dataTransfer?.types || []).includes("Files");

  window.addEventListener("dragenter", (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    depth++;
    veil.hidden = false;
  });

  window.addEventListener("dragover", (e) => { if (carriesFiles(e)) e.preventDefault(); });

  window.addEventListener("dragleave", (e) => {
    if (!carriesFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) veil.hidden = true;
  });

  window.addEventListener("drop", async (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    depth = 0;
    veil.hidden = true;
    await handleIncomingFiles(e.dataTransfer.files);
  });
}

// ---------------------------------------------------------------- screenshot

function downloadScreenshot() {
  if (!Module || !running) return;
  const name = "gba-wasm-" + new Date().toISOString().replace(/[:.]/g, "-") + ".png";
  try {
    Module.screenshot(name);
    const bytes = Module.FS.readFile(Module.filePaths().screenshotsPath + "/" + name);
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/png" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    setStatus("screenshot saved", "ok");
  } catch (e) {
    console.warn("screenshot failed", e);
    setStatus("screenshot failed", "error");
  }
}

// ---------------------------------------------------------------- toolbar

function wireToolbar() {
  $("btn-pause").addEventListener("click", () => setPaused(!paused));
  $("btn-reset").addEventListener("click", () => fireHotkey("reset"));
  $("btn-ff").addEventListener("click", () => setFastForward(!fastForwarding));
  $("btn-save-state").addEventListener("click", doSaveState);
  $("btn-load-state").addEventListener("click", doLoadState);
  $("btn-shot").addEventListener("click", downloadScreenshot);

  $("btn-fullscreen").addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else el.screenWrap.requestFullscreen?.().catch(() => {});
  });

  $("btn-controls").addEventListener("click", () => {
    el.controlsPanel.hidden = !el.controlsPanel.hidden;
    if (!el.controlsPanel.hidden) el.controlsPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  $("btn-close-controls").addEventListener("click", () => { el.controlsPanel.hidden = true; });

  $("btn-defaults").addEventListener("click", () => {
    stopListening();
    bindings = defaultBindings();
    persistBindings();
    renderBindings();
    setStatus("controls reset", "ok");
  });

  const volume = $("volume");
  volume.value = settings.volume;
  volume.addEventListener("input", () => {
    settings.volume = parseInt(volume.value, 10);
    persistSettings();
    try { Module?.setVolume(settings.volume / 100); } catch { /* ignore */ }
  });

  const scale = $("scale");
  scale.value = String(settings.scale);
  scale.addEventListener("change", () => {
    settings.scale = parseInt(scale.value, 10);
    persistSettings();
    applyScale();
  });

  const slot = $("state-slot");
  slot.value = String(settings.slot);
  slot.addEventListener("change", () => {
    settings.slot = parseInt(slot.value, 10);
    persistSettings();
  });

  $("btn-add-rom").addEventListener("click", () => $("file-input").click());
  $("btn-remove-rom").addEventListener("click", removeSelectedRom);

  $("file-input").addEventListener("change", async (e) => {
    // Copy first: clearing `value` (so picking the same file twice still
    // fires a change event) also empties the live FileList behind `files`.
    const files = Array.from(e.target.files);
    e.target.value = "";
    await handleIncomingFiles(files);
  });

  el.romSelect.addEventListener("change", async () => {
    if (!el.romSelect.value) return;
    settings.rom = el.romSelect.value;
    persistSettings();
    releaseAllInputs();
    if (running) await startSelectedRom();
    else showIdleOverlay();
  });

  // Blur the toolbar after clicking so keys go back to the game.
  document.querySelector(".toolbar").addEventListener("click", (e) => {
    if (e.target instanceof HTMLButtonElement) e.target.blur();
  });
}

// ---------------------------------------------------------------- boot

async function boot() {
  if (!self.crossOriginIsolated) {
    showOverlay(
      "This page is not cross-origin isolated, so the threaded mGBA core cannot start. " +
      "Serve it through the bundled Rust server (cargo run --release).",
      { spinner: false, error: true },
    );
    setStatus("not isolated", "error");
    return;
  }

  wireToolbar();
  renderBindings();
  applyScale();
  requestAnimationFrame(pollGamepads);

  showOverlay("Loading mGBA core…");
  Module = await mGBA({ canvas: el.canvas });
  await Module.FSInit();

  // We drive all input ourselves, so silence the core's own key handling.
  Module.toggleInput(false);
  Module.setCoreSettings({ rewindEnable: true, audioSampleRate: 48000, audioBufferSize: 1024 });

  el.coreVersion.textContent = Module.version.projectName + " " + Module.version.projectVersion;

  // Debug hook: poke at the core from the browser console, e.g. mgba.buttonPress("a").
  window.mgba = Module;

  // Footer readout. Callbacks themselves are registered after each ROM load.
  setInterval(() => {
    el.fps.textContent = running && !paused ? frameCount + " fps" : "—";
    frameCount = 0;
  }, 1000);

  window.addEventListener("beforeunload", () => { try { Module.FSSync(); } catch { /* ignore */ } });

  // The library lives in this browser, so it may already have entries.
  refreshRomLibrary(settings.rom);
  wireDragAndDrop();
  showIdleOverlay();
  setStatus("ready");
}

boot().catch((e) => {
  console.error(e);
  showOverlay("Boot failed: " + (e.message || e), { spinner: false, error: true });
  setStatus("boot failed", "error");
});
