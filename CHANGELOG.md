# Changelog

## [0.2.0] - 2026-11-21

### Added
- **Browse** tab: a catalog of 225 verified 3.3.5a addons with categories, search, popularity sorting and one-click install. Addons you already have can be linked with "Link installed".
- The catalog is fetched from the repository, so it can grow without a new app release. Without a connection the bundled copy is used.
- `tools/build-catalog.js` builds the catalog from GitHub. It keeps only repos whose main addon has `## Interface: 30300`, and `tools/catalog-config.json` holds overrides.
- **Changes** button: shows the commits between the installed version and the new one before you update, and explains it when a force-push has rewritten the history.
- Missing dependencies: warns when a required `## Dependencies` entry is not installed and installs it from the catalog with one click, including right after an install.
- Repo links: a "Repo ↗" button on each addon, a GitHub link with the version in the status bar, and an About section in Settings.
- "Find repo…" suggests catalog matches first.

### Fixed
- The version in the app no longer shows Electron's version when the app is started via a custom entry point.

## [0.1.0] - 2026-11-21

First release.

### Added
- Desktop GUI (Electron) for updating World of Warcraft 3.3.5a addons from GitHub, GitLab and Gitea/Codeberg.
- Add addons from a URL. A `wotlk`/`3.3.5` branch is chosen automatically when one exists; Wrath Classic branches are skipped.
- Update checks cached with ETags, so a 304 response does not count against GitHub's rate limit.
- Warns about addons whose `## Interface` targets a newer client than 3.3.5a.
- Smart folder detection: fixes `Repo-master` folders, finds nested addons, keeps embedded libs, and lists multi-module repos (e.g. DBM) under their main folder.
- Staged installs with automatic rollback if an install fails; the last 5 versions per addon are kept and can be restored with one click.
- "Installed, not linked" view, with repo suggestions from `.toc` metadata and a GitHub search filtered to WoW addons.
- Linking one folder to a collection repo installs only that folder.
- Import of `config.yaml`/`config.json` from the original AddOns-Update-Tool.
- Optional per-host access tokens, encrypted with Windows DPAPI.
- Play button that starts Wow.exe.
- GitHub Actions: tests run on every push, and a portable exe is built into a release for every `v*` tag.
