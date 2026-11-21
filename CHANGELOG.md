<p align="center"><img src="assets/logo.png" width="72" alt="" /></p>

<h1 align="center">Changelog</h1>

<p align="center">All notable changes to AddOn Update Tool 3.3.5a.<br />
Downloads are on the <a href="https://github.com/Tntdruid/AddOn-Update-Tool-335a/releases">Releases</a> page.</p>

---

## [Unreleased]

### 🐛 Fixed
- Commit hashes ("old → new") in the *Installed* column no longer wrap onto two lines.

---

## [0.2.0] — 2026-11-21

> **Find, inspect and fix.** Browse a catalog of 225 verified 3.3.5a addons, see what an update changes before you install it, and fix missing dependencies with one click.

<img src="assets/screenshots/browse.png" alt="Browse tab" width="720" />

### ✨ New
- **Browse tab.** A catalog of **225 verified 3.3.5a addons**, including ElvUI, DBM, WeakAuras, Skada, Details, Auctionator and Bagnon. It has categories and search and is sorted by popularity. Click *Install* to add one, or *Link installed* for addons you already have.
- **See what's new.** The *Changes* button lists the commits between your version and the latest, with author, date and link, before you update.
- **Missing dependencies.** If an addon needs something you don't have (e.g. `DBM-Core`), you get a warning and an *Install* button that fetches it from the catalog. This also happens right after an install.
- **Repo links.** Each addon has a *Repo ↗* button, the status bar shows the version and links to GitHub, and *Settings → About* links to releases and issues.

### ⚡ Improved
- The catalog is fetched from this repository, so it grows without a new app release. Offline, the bundled copy is used.
- *Find repo…* suggests the catalog match first.

### 🐛 Fixed
- The version shown in the app was Electron's version in some cases.

### 🧰 For contributors
- `tools/build-catalog.js` builds the catalog from GitHub and keeps only addons whose `.toc` says `Interface: 30300`. `tools/catalog-config.json` holds overrides.

---

## [0.1.0] — 2026-11-21

> **First release.** A modern, GUI-based take on [AddOns-Update-Tool](https://github.com/alchem1ster/AddOns-Update-Tool): pick your Wow.exe, paste a URL, and stay up to date.

<img src="assets/screenshots/managed.png" alt="Managed addons" width="720" />

### ✨ New
- **Desktop app** for updating addons from **GitHub, GitLab and Codeberg/Gitea**.
- **Smart branch picking.** A `wotlk` or `3.3.5` branch is chosen automatically when one exists. Wrath *Classic* branches are skipped.
- **Cheap update checks.** Responses are cached with ETags, so checks barely touch GitHub's 60-requests-per-hour limit.
- **Compatibility warnings** for addons built for newer clients than 3.3.5a.
- **Smart folder detection.** Fixes `Repo-master` folder names, finds nested addons, keeps embedded libs, and handles multi-module repos such as DBM.
- **Safe installs with one-click rollback.** Files are staged first, and the last 5 versions of each addon are kept.
- **Installed, not linked.** Finds a repository for addons you already have.
- **Import** of `config.yaml` / `config.json` from the original tool.
- **Optional access tokens**, encrypted with Windows DPAPI, and a **▶ Play** button.

### 🧰 For contributors
- GitHub Actions run the tests on every push and build a portable `.exe` release for every `v*` tag.

[Unreleased]: https://github.com/Tntdruid/AddOn-Update-Tool-335a/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/Tntdruid/AddOn-Update-Tool-335a/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Tntdruid/AddOn-Update-Tool-335a/releases/tag/v0.1.0
