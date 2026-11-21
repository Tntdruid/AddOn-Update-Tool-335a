# Changelog

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
