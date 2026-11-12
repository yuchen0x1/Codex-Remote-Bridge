# Release notes

## Unreleased

- Windows checks the GitHub Release manifest, downloads the installer to a temporary file, verifies its size and SHA-256, and only then starts the installer.
- Android and macOS check the public GitHub update manifest and expose allowlisted HTTPS release assets for user-driven installation.
- GitHub Actions now verifies release versions, builds Android/Windows/macOS assets, and publishes `update-manifest.json` plus `SHA256SUMS.txt`.
- Release signing remains explicitly unsigned until protected Android, Windows, and macOS signing credentials are configured.
