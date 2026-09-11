#!/usr/bin/env python3
"""Bundle the emulator into one self-contained HTML file.

Everything the page needs is inlined: stylesheet, favicon, the mGBA glue, the
front-end, and the wasm core itself. The wasm is gzipped and base64'd rather
than embedded raw, which roughly thirds it; the page inflates it with
DecompressionStream and hands the bytes to Emscripten through its
`instantiateWasm` hook.

This uses the single-threaded core (web/vendor/mgba-single-thread.*), which is
what lets the result run from a file:// URL. The threaded core in
web/vendor/mgba.js needs SharedArrayBuffer, and so needs COOP/COEP response
headers that a lone HTML file cannot supply for itself.
"""

import base64
import gzip
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
OUT = ROOT / "dist" / "gba-wasm.html"


def read(path):
    return (WEB / path).read_text(encoding="utf-8")


def patch_app_js(src):
    """Adapt the front-end from 'ES module served over HTTP' to 'inline script'."""
    # The core is inlined above us as a classic script, so it is already a global.
    src, n = re.subn(r'^import mGBA from "[^"]+";\n', "", src, count=1, flags=re.M)
    if n != 1:
        sys.exit("bundle: could not find the mGBA import in app.js")

    # The single-threaded core does not use SharedArrayBuffer, so the isolation
    # gate that the threaded build needs would now reject a perfectly good page.
    guard = re.search(
        r"  if \(!self\.crossOriginIsolated\) \{.*?\n  \}\n\n", src, flags=re.S
    )
    if not guard:
        sys.exit("bundle: could not find the cross-origin-isolation guard in app.js")
    src = src[: guard.start()] + src[guard.end() :]

    # Feed the core its wasm from the blob inlined below rather than a fetch.
    old = "await mGBA({ canvas: el.canvas })"
    if old not in src:
        sys.exit("bundle: could not find the mGBA() call in app.js")
    src = src.replace(
        old, "await mGBA({ canvas: el.canvas, instantiateWasm: bundledInstantiateWasm })", 1
    )
    return src


def main():
    html = read("index.html")
    css = read("style.css")
    app = patch_app_js(read("app.js"))
    core = read("vendor/mgba-single-thread.js")

    wasm = (WEB / "vendor" / "mgba-single-thread.wasm").read_bytes()
    packed = base64.b64encode(gzip.compress(wasm, 9, mtime=0)).decode("ascii")

    favicon = base64.b64encode((WEB / "favicon.svg").read_bytes()).decode("ascii")

    loader = """
// The wasm core, gzipped and base64'd. Inflated at boot and handed to
// Emscripten through instantiateWasm, so nothing is ever fetched.
const WASM_GZ_B64 = "%s";

async function bundledInstantiateWasm(imports, receiveInstance) {
  const packed = atob(WASM_GZ_B64);
  const bytes = new Uint8Array(packed.length);
  for (let i = 0; i < packed.length; i++) bytes[i] = packed.charCodeAt(i);

  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  const wasm = await new Response(stream).arrayBuffer();

  const { instance } = await WebAssembly.instantiate(wasm, imports);
  receiveInstance(instance);
  return instance.exports;
}
""" % packed

    html = html.replace(
        '<link rel="icon" href="/favicon.svg" type="image/svg+xml">',
        '<link rel="icon" href="data:image/svg+xml;base64,%s">' % favicon,
        1,
    )
    html = html.replace(
        '<link rel="stylesheet" href="/style.css">',
        "<style>\n%s\n</style>" % css.strip(),
        1,
    )
    html = html.replace(
        '<script type="module" src="/app.js"></script>',
        "<script>\n%s\n</script>\n<script>\n%s\n</script>\n<script>\n%s\n</script>"
        % (core.strip(), loader.strip(), app.strip()),
        1,
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(html, encoding="utf-8")

    size = OUT.stat().st_size
    print("wrote %s (%.2f MB)" % (OUT.relative_to(ROOT), size / 1048576))
    print("  wasm %.2f MB -> %.2f MB gzipped+base64" % (len(wasm) / 1048576, len(packed) / 1048576))


if __name__ == "__main__":
    main()
