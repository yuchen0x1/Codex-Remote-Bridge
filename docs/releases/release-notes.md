# Release notes

## v4.2.0 · 2026-11-13

- Web pairing defaults to read-only; select read-write explicitly to control the computer. Connected device sessions can be reviewed and revoked in Settings → Configuration.
- Token rotation now invalidates old sessions, unused pairing codes and WebSocket connections. If you shared a legacy `master:ro` link, rotate the master token and pair devices again.
- Fixed authenticated browser polling quotas, broken pairing/system-control URLs, unbounded scheduled retries, cron re-enable timing and custom data-directory isolation.
- See [the v4.2.0 release guide](v4.2.0.md) for downloads, upgrade compatibility and signing limitations.

- Windows checks the GitHub Release manifest, downloads the installer to a temporary file, verifies its size and SHA-256, and only then starts the installer.
- Android and macOS check the public GitHub update manifest and expose allowlisted HTTPS release assets for user-driven installation.
- Downloads include an update manifest and SHA-256 checksums to check file integrity.
- Android uses a locally held Release signing key. Windows and macOS installers lack platform publisher signatures; the update manifest itself is unsigned.
