<p align="center"><img src="assets/logo.png" width="128" alt="logo" /></p>

# AddOn Update Tool 3.3.5a

A desktop app that keeps World of Warcraft **3.3.5a (WotLK)** addons up to date from GitHub, GitLab and Gitea/Codeberg. It is a modern take on [alchem1ster/AddOns-Update-Tool](https://github.com/alchem1ster/AddOns-Update-Tool).

## What it does better

| | Original | This tool |
|---|---|---|
| Interface | Console | Desktop GUI (Electron) |
| Setup | Hand-written `config.yaml` | Paste a URL, or link addons you already have installed. Old configs can be imported |
| Download | Full `git clone` | Downloads only the archive for the newest commit |
| Update check | Clones each time | One cached API call per addon (ETag). A 304 response does not count against GitHub's rate limit |
| Branch | You choose it | Picks a `wotlk`/`3.3.5` branch automatically when one exists. Wrath *Classic* branches are skipped |
| Compatibility | — | Reads `## Interface` and warns about addons built for newer clients |
| Folder names | — | Fixes `Repo-master` folders, finds addons nested deep in the repo, and keeps embedded libs inside their addon |
| Collection repos | — | Linking one folder to a repo with many addons installs only that folder |
| Safety | Backup | Writes to staging first, then swaps folders in. If an install fails, the previous version is restored |
| Rollback | Manual | Keeps the last 5 versions per addon. Restore with one click, and a restore can itself be undone |
| Unknown addons | — | Lists installed addons that aren't linked to a repo and suggests repos from the `.toc` file and a GitHub search |
| Tokens | — | Optional tokens per host, encrypted with Windows DPAPI |

## Usage

1. Start the app and select `Wow.exe`. If the exe sits in the WoW folder, it finds the folder on its own.
2. **+ Add from URL**: paste e.g. `https://github.com/Zidras/DBM-Warmane`.
3. **Installed, not linked**: use **Find repo…** to link addons you already have.
4. **Check for updates**, then **Update all**, then **▶ Play**.

The tool stores its state in `AddonUpdateTool.json` next to `Wow.exe` and its backups in `Interface/AddOns.backups`. SavedVariables (`WTF/`) are never touched.

## Development

```powershell
npm install
npm start        # run the app
npm test         # node:test suite
npm run dist     # portable .exe in dist/
```

Structure:

- `src/core/`: platform-independent logic (TOC parser, providers, archive analysis, installer, updater), fully covered by tests
- `src/main/`: Electron main process and IPC (sandboxed renderer, contextIsolation)
- `src/renderer/`: UI in plain HTML/CSS/JS, with no framework
