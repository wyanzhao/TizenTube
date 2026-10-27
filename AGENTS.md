# Repository Guidelines (`AGENTS.md`)

This repository is a hardened standalone fork of [reisxd/TizenTube](https://github.com/reisxd/TizenTube) that fixes the 480p resolution cap on 60 fps YouTube playback at speeds above 1x on Samsung Tizen TVs (Cobalt player).

## Architecture & Directory Layout

- `mods/`: Rollup-bundled userscript injected into `https://www.youtube.com/tv`.
  - `mods/userScript.js`: Entry point. Registers feature modules; `mods/userScript.qa.js` optionally imports QA instrumentation when built with `--with-qa`.
  - `mods/features/rateCapFix.js`: Core fix. Wraps `window.MediaSource.isTypeSupported` to normalize high-framerate (`60 < framerate <= 120`, `height <= 1080`) playback-rate capability probes back to `60` fps, and persists native speed selections via `ratechange`.
  - `mods/features/rateCapQA.js`: Optional on-device QA harness (disabled in default production builds; enabled via `python3 tools/build.py --with-qa`).
- `standalone/`: Tizen standalone widget (`TizenTubeS.TizenTube`) and background Node.js service (`TizenTubeS.StandaloneService`).
  - `standalone/service/local-proxy.js`: Loopback-only (`127.0.0.1` / `127.0.0.2`) TLS proxy that injects the compiled userscript into `https://www.youtube.com/tv` HTML responses while tunneling other allowlisted Google hosts transparently.
  - `standalone/service/bounded-https.js`: Bounded HTTP/1.1 client and chunked-encoding parser over verified TLS.
- `tools/`:
  - `tools/build.py`: Builds `dist/userScript.js`, records its SHA-256 hash into `standalone/service/build.json`, runs the unit test suite, and stages an unsigned widget directory at `build/wgt/`.
  - `tools/provision-on-tv.sh`: One-time on-TV provisioning script (generates a device-local root CA on the TV, configures `--content=/home/owner/share/tizentube-content`, enables service `app_onboot`/`app_autorestart`, and disables `prelaunch.support` on native YouTube `9Ur5IzDKqV`).
- `test/`: Node.js built-in test runner (`node --test`) suites covering the capability shim, QA harness, HTTP framing, and local proxy security invariants.
- `docs/RATE_CAP_FIX.md`: First-principles root-cause writeup and verification notes.

## Build & Verification

Always build and run tests via `tools/build.py` before committing changes:

```sh
# Production build (excludes QA harness) + unit tests + stage build/wgt/
python3 tools/build.py

# Include on-device QA harness in the bundle
python3 tools/build.py --with-qa

# Run the Node.js unit test suite directly
node --test test/*.test.cjs
```

- Do not manually edit generated artifacts (`dist/`, `build/`, `standalone/service/userscript.js`, `standalone/service/build.json`); they are gitignored and produced by `tools/build.py`.

## Security, Privacy & Code Invariants

1. **Loopback-Only Proxy**:
   - `standalone/service/local-proxy.js` must bind strictly to loopback (`127.0.0.1` or `127.0.0.2`) and reject non-loopback bindings.
   - Upstream TLS verification must remain enabled (`rejectUnauthorized: true`). Never disable upstream certificate checks.
   - Only `www.youtube.com` / `youtube.com` may be intercepted by the local TLS handler; all other allowlisted Google hosts must be tunneled transparently or rejected.
2. **Zero Third-Party Telemetry or External Requests**:
   - Keep SponsorBlock, DeArrow, and self-updater network calls disabled.
   - Do not add external analytics, update checks, or non-YouTube network requests.
3. **Scoped MediaSource Capability Shim**:
   - In `mods/features/rateCapFix.js`, only normalize `video/*` `MediaSource.isTypeSupported` queries where `60 < framerate <= 120` and `height <= SHIM_MAX_HEIGHT` (`1080`).
   - Preserve sentinel capability probes (such as `framerate=9999`) and codecs/resolutions outside the target envelope untouched.
4. **No Credentials or Device Secrets in Git**:
   - Never commit `.p12`, `.pem`, `.key`, `.crt`, `.pwd`, `author-signature.xml`, `signature1.xml`, or device-specific identifiers (IPs, serials, DUIDs, MAC addresses, or account tokens).
   - Synthetic test certificates in `test/local-proxy.test.cjs` are generated in a temporary directory for local unit tests only and must never be bundled into `standalone/` or `build/wgt/`.
