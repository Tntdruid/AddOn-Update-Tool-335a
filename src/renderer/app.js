'use strict';

/* global api */
const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = { settings: null, overview: null, tab: 'managed', filter: '', busy: new Set() };

const STATUS_LABEL = {
  ok: 'Up to date',
  update: 'Update available',
  error: 'Error',
  missing: 'Files missing',
  unknown: 'Not checked',
  'not-installed': 'Not installed',
};
const COMPAT_LABEL = { ok: '3.3.5a', newer: 'newer client', older: 'older client', unknown: '', 'missing-toc': 'no .toc' };

async function call(fn, ...args) {
  const r = await fn(...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isError ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 4500);
}

async function withBusy(btn, fn) {
  if (btn) {
    btn.disabled = true;
    btn.classList.add('busy');
  }
  try {
    return await fn();
  } catch (err) {
    toast(err.message, true);
    return undefined;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('busy');
    }
  }
}

function relTime(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return 'just now';
  const units = [
    [60, 'minute'],
    [60, 'hour'],
    [24, 'day'],
    [30, 'month'],
    [12, 'year'],
  ];
  let v = s;
  let unit = 'second';
  for (const [n, u] of units) {
    if (v < n) break;
    v /= n;
    unit = u;
  }
  const n = Math.floor(v);
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

function shortList(items, max = 4) {
  if (!items.length) return '—';
  return items.length <= max ? items.join(', ') : `${items.slice(0, max).join(', ')} +${items.length - max} more`;
}

/* ---------- loading ---------- */

async function refresh() {
  state.settings = await call(api.settings);
  const hasWow = Boolean(state.settings.wowPath);
  $('#welcome').hidden = hasWow;
  $('#wowPath').textContent = hasWow ? state.settings.wowPath : 'No WoW folder selected';
  for (const id of ['#btnCheck', '#btnLaunch', '#btnAdd', '#btnImport']) $(id).disabled = !hasWow;
  if (!hasWow) {
    state.overview = null;
    render();
    return;
  }
  state.overview = await call(api.overview).catch((e) => {
    toast(e.message, true);
    return null;
  });
  render();
}

function render() {
  const ov = state.overview;
  const managed = ov ? ov.addons : [];
  const local = ov ? ov.unmanaged : [];
  $('#countManaged').textContent = managed.length;
  $('#countLocal').textContent = local.length;
  const updates = managed.filter((a) => a.status === 'update').length;
  const btn = $('#btnUpdateAll');
  btn.disabled = !updates;
  btn.textContent = updates ? `Update all (${updates})` : 'Update all';
  if (ov && ov.rateLimit) $('#rate').textContent = `GitHub API: ${ov.rateLimit.remaining}/${ov.rateLimit.limit}`;
  renderManaged(managed);
  renderLocal(local);
  renderSettings();
}

function matches(...fields) {
  const f = state.filter.trim().toLowerCase();
  return !f || fields.some((x) => String(x || '').toLowerCase().includes(f));
}

/* ---------- managed ---------- */

function renderManaged(list) {
  const view = $('#view-managed');
  if (!list.length) {
    view.innerHTML = `<div class="empty">No managed addons yet.<br />Add one from a GitHub/GitLab URL, link an installed addon, or import your old config.<br />
      <button class="btn primary" data-act="add">+ Add from URL</button></div>`;
    return;
  }
  const rows = list
    .filter((a) => matches(a.title, a.id, a.folders.join(' ')))
    .sort((a, b) => (a.status === 'update' ? -1 : 0) - (b.status === 'update' ? -1 : 0) || a.title.localeCompare(b.title))
    .map((a) => {
      const sha = a.installedSha ? a.installedSha.slice(0, 7) : '—';
      const newSha = a.status === 'update' && a.remoteSha ? ` → ${a.remoteSha.slice(0, 7)}` : '';
      const err = a.lastError ? `<div class="error-text">${esc(a.lastError)}</div>` : '';
      const compat = a.compat && a.compat !== 'unknown' && a.compat !== 'ok' ? `<span class="compat ${a.compat}">${COMPAT_LABEL[a.compat]}</span>` : '';
      return `<tr data-id="${esc(a.id)}">
        <td><div class="name">${esc(a.title)}${compat}</div>
          <div class="sub" title="${esc(a.folders.join(', '))}">${esc(shortList(a.folders))}${a.missing.length ? ` · missing: ${esc(a.missing.join(', '))}` : ''}</div></td>
        <td><a data-act="open" data-url="${esc(a.url)}">${esc(a.id.replace(/^[^/]+\//, ''))}</a><div class="sub">${esc(a.provider)}</div></td>
        <td><button class="btn small ghost" data-act="branch" title="Change branch">${esc(a.branch)}</button></td>
        <td><span class="mono">${esc(sha)}${esc(newSha)}</span><div class="sub">${esc(a.version || '')}${a.version && a.commitDate ? ' · ' : ''}${esc(relTime(a.commitDate))}</div></td>
        <td><span class="badge ${a.ignored ? 'muted' : a.status}">${a.ignored ? 'Ignored' : STATUS_LABEL[a.status] || a.status}</span>${err}</td>
        <td class="actions">
          ${a.status === 'update' || a.status === 'missing' || a.status === 'error' || a.status === 'not-installed' ? `<button class="btn small primary" data-act="update">${a.status === 'update' ? 'Update' : 'Reinstall'}</button>` : ''}
          <button class="btn small" data-act="history" title="Backups / rollback">History</button>
          <button class="btn small ghost" data-act="more" title="More">⋯</button>
        </td></tr>`;
    })
    .join('');
  view.innerHTML = `<table><thead><tr><th>AddOn</th><th>Source</th><th>Branch</th><th>Installed</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* ---------- local ---------- */

function renderLocal(list) {
  const view = $('#view-local');
  if (!list.length) {
    view.innerHTML = `<div class="empty">Every installed addon is managed. Nice.</div>`;
    return;
  }
  const rows = list
    .filter((a) => matches(a.title, a.folder, a.modules.join(' ')))
    .map(
      (a) => `<tr data-folder="${esc(a.folder)}">
        <td><div class="name">${esc(a.title)}<span class="compat ${a.compat}">${esc(COMPAT_LABEL[a.compat] || '')}${a.interface && a.compat !== 'ok' ? ` (${a.interface})` : ''}</span></div>
          <div class="sub">${esc([a.folder, ...a.modules].join(', '))}</div></td>
        <td>${esc(a.version || '')}<div class="sub">${esc(a.author || '')}</div></td>
        <td>${a.hints.length ? '<span class="badge ok">repo in .toc</span>' : ''}</td>
        <td class="actions"><button class="btn small primary" data-act="link">Find repo…</button></td></tr>`,
    )
    .join('');
  view.innerHTML = `<p class="sub" style="margin:0 0 10px">These folders are in Interface/AddOns but aren't linked to a repository. Link them to keep them updated; the current files are backed up first.</p>
    <table><thead><tr><th>AddOn</th><th>Version</th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

/* ---------- settings ---------- */

function renderSettings() {
  const s = state.settings;
  if (!s) return;
  const has = (h) => s.tokenHosts.includes(h);
  $('#view-settings').innerHTML = `<div class="settings">
    <h3>WoW folder</h3>
    <p>${esc(s.wowPath || 'Not set')}</p>
    <div class="inline"><button class="btn" data-act="pick">Change…</button>
      <button class="btn ghost" data-act="folder" data-which="addons" ${s.wowPath ? '' : 'disabled'}>Open AddOns folder</button>
      <button class="btn ghost" data-act="folder" data-which="backups" ${s.wowPath ? '' : 'disabled'}>Open backups</button></div>
    ${s.recentWowPaths.length > 1 ? `<p style="margin-top:10px">Recent: ${s.recentWowPaths.map((p) => `<a data-act="usewow" data-path="${esc(p)}">${esc(p)}</a>`).join(' · ')}</p>` : ''}
    <h3>Behaviour</h3>
    <label class="check"><input type="checkbox" data-setting="autoCheck" ${s.autoCheck ? 'checked' : ''} /> Check for updates on start</label>
    <label class="check"><input type="checkbox" data-setting="closeOnLaunch" ${s.closeOnLaunch ? 'checked' : ''} /> Close this app when starting WoW</label>
    <h3>Access tokens</h3>
    <p>Optional. Without a token GitHub allows 60 API requests/hour (update checks are cached, so this is usually enough). A token with no scopes raises it to 5000 and allows private repos. Tokens are encrypted with Windows DPAPI.</p>
    ${['github.com', 'gitlab.com', 'codeberg.org']
      .map(
        (h) => `<div class="field"><label>${h}${has(h) ? ' · saved ✓' : ''}</label>
        <div class="inline"><input type="password" id="tok-${h}" placeholder="${has(h) ? '••••••••' : 'Paste token'}" />
        <button class="btn" data-act="token" data-host="${h}">Save</button>${has(h) ? `<button class="btn ghost danger" data-act="token-clear" data-host="${h}">Remove</button>` : ''}</div></div>`,
      )
      .join('')}
  </div>`;
}

/* ---------- modals ---------- */

function modal(title, html) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
  $('#modal').hidden = false;
  const first = $('#modalBody input, #modalBody select');
  if (first) first.focus();
  return $('#modalBody');
}
const closeModal = () => ($('#modal').hidden = true);

function addDialog(prefill = '', adopt = null) {
  const body = modal(
    adopt ? `Link “${adopt.title}”` : 'Add addon from URL',
    `<div class="field"><label>Repository URL</label><input id="addUrl" value="${esc(prefill)}" placeholder="https://github.com/owner/repo" />
      <div class="hint">GitHub, GitLab and Gitea/Codeberg. Leave branch empty to auto-pick a 3.3.5a/WotLK branch when one exists.</div></div>
     <div class="field"><label>Branch (optional)</label><input id="addBranch" placeholder="auto" /></div>
     ${adopt ? `<div class="hint" style="margin-bottom:12px">The existing folders (${esc([adopt.folder, ...adopt.modules].join(', '))}) are backed up and replaced by the repository version.</div>` : ''}
     <div class="row-end"><button class="btn" data-act="close">Cancel</button><button class="btn primary" id="addGo">Install</button></div>`,
  );
  const go = async () => {
    const url = $('#addUrl').value.trim();
    if (!url) return;
    await withBusy($('#addGo'), async () => {
      const opts = { branch: $('#addBranch').value.trim() || undefined };
      if (adopt) opts.adoptFolders = [adopt.folder, ...adopt.modules];
      const r = await call(api.add, url, opts);
      closeModal();
      toast(`Installed ${r.installed.join(', ')} (${r.addon.branch})${r.warnings.length ? ` — ${r.warnings[0]}` : ''}`, r.warnings.length > 0);
      await refresh();
    });
  };
  $('#addGo').onclick = go;
  body.onkeydown = (e) => e.key === 'Enter' && go();
}

async function linkDialog(folder) {
  const a = state.overview.unmanaged.find((x) => x.folder === folder);
  const body = modal(`Find repository for “${a.title}”`, `<p class="sub">Searching…</p>`);
  let cands = [];
  try {
    cands = await call(api.suggest, a.folder, a.title, a.hints);
  } catch (e) {
    body.innerHTML = `<p class="error-text">${esc(e.message)}</p>`;
  }
  if ($('#modal').hidden) return;
  body.innerHTML = `${
    cands.length
      ? `<div class="list">${cands
          .map(
            (c, i) => `<div class="cand"><div class="grow"><div><a data-act="open" data-url="${esc(c.url)}">${esc(c.name)}</a>
          ${/3\.?3\.?5|wotlk|wrath/i.test(`${c.name} ${c.description}`) ? '<span class="tag335">3.3.5a</span>' : ''}
          ${c.source === 'toc' ? '<span class="tag335">from .toc</span>' : ''}</div>
          <div class="desc">${esc(c.description || '')}${c.stars != null ? ` · ★ ${c.stars}` : ''}${c.updated ? ` · ${esc(relTime(c.updated))}` : ''}</div></div>
          <button class="btn small primary" data-pick="${i}">Use</button></div>`,
          )
          .join('')}</div>`
      : '<p class="sub">No candidates found. Paste the URL instead.</p>'
  }
  <div class="row-end"><button class="btn" id="manual">Enter URL manually…</button></div>`;
  body.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => addDialog(cands[Number(b.dataset.pick)].url, a)));
  $('#manual').onclick = () => addDialog('', a);
}

async function historyDialog(id) {
  const body = modal('Backups', '<p class="sub">Loading…</p>');
  const list = await call(api.backups, id).catch((e) => (toast(e.message, true), []));
  body.innerHTML = list.length
    ? `<p class="sub">The last 5 versions are kept. Restoring backs up the current version first, so it can be undone.</p><div class="list">${list
        .map(
          (b) => `<div class="cand"><div class="grow"><div>${esc(b.id.replace(/T(\d\d)-(\d\d)-(\d\d).*/, ' $1:$2:$3'))}
          ${b.meta && b.meta.sha ? `<span class="mono"> · ${esc(b.meta.sha.slice(0, 7))}</span>` : ''}${b.meta && b.meta.uninstalled ? ' · uninstalled' : ''}</div>
          <div class="desc">${esc(b.folders.join(', '))}</div></div>
          <button class="btn small" data-restore="${esc(b.id)}">Restore</button></div>`,
        )
        .join('')}</div>`
    : '<p class="sub">No backups yet. One is made automatically before every update.</p>';
  body.querySelectorAll('[data-restore]').forEach(
    (b) =>
      (b.onclick = () =>
        withBusy(b, async () => {
          await call(api.rollback, id, b.dataset.restore);
          closeModal();
          toast('Restored');
          await refresh();
        })),
  );
}

async function branchDialog(id) {
  const a = state.overview.addons.find((x) => x.id === id);
  const body = modal(`Branch for ${a.title}`, '<p class="sub">Loading branches…</p>');
  const branches = await call(api.branches, id).catch((e) => (toast(e.message, true), [a.branch]));
  body.innerHTML = `<div class="field"><label>Branch</label><select id="branchSel">${branches
    .map((b) => `<option ${b === a.branch ? 'selected' : ''}>${esc(b)}</option>`)
    .join('')}</select></div>
    <div class="row-end"><button class="btn" data-act="close">Cancel</button><button class="btn primary" id="branchGo">Switch & install</button></div>`;
  $('#branchGo').onclick = () =>
    withBusy($('#branchGo'), async () => {
      const r = await call(api.changeBranch, id, $('#branchSel').value);
      closeModal();
      toast(r.warnings.length ? r.warnings[0] : 'Branch switched', r.warnings.length > 0);
      await refresh();
    });
}

function moreDialog(id) {
  const a = state.overview.addons.find((x) => x.id === id);
  const body = modal(a.title, `<div class="list">
    <button class="btn" data-m="reinstall">Reinstall current version</button>
    <button class="btn" data-m="ignore">${a.ignored ? 'Stop ignoring updates' : 'Ignore updates (pin this version)'}</button>
    <button class="btn" data-m="unlink">Stop managing (keep files)</button>
    <button class="btn danger" data-m="delete">Uninstall (move files to backups)</button></div>`);
  body.querySelectorAll('[data-m]').forEach(
    (b) =>
      (b.onclick = () =>
        withBusy(b, async () => {
          const m = b.dataset.m;
          if (m === 'reinstall') await call(api.update, [id]);
          if (m === 'ignore') await call(api.ignore, id, !a.ignored);
          if (m === 'unlink') await call(api.remove, id, { deleteFiles: false });
          if (m === 'delete') await call(api.remove, id, { deleteFiles: true });
          closeModal();
          await refresh();
        })),
  );
}

/* ---------- actions ---------- */

async function checkAll() {
  await withBusy($('#btnCheck'), async () => {
    const r = await call(api.check);
    await refresh();
    const n = state.overview.addons.filter((a) => a.status === 'update').length;
    const failed = r.filter((x) => !x.ok).length;
    toast(`${n ? `${n} update${n > 1 ? 's' : ''} available` : 'Everything is up to date'}${failed ? ` · ${failed} failed` : ''}`, failed > 0);
  });
}

async function updateIds(ids, btn) {
  await withBusy(btn, async () => {
    const r = await call(api.update, ids);
    const failed = r.filter((x) => !x.ok);
    const warn = r.flatMap((x) => x.warnings);
    toast(failed.length ? `${failed.length} failed: ${failed[0].error}` : warn.length ? warn[0] : `Updated ${r.length} addon${r.length === 1 ? '' : 's'}`, failed.length > 0);
    await refresh();
  });
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const row = el.closest('tr');
  const id = row && row.dataset.id;
  if (act === 'add') addDialog();
  else if (act === 'close') closeModal();
  else if (act === 'open') api.openUrl(el.dataset.url);
  else if (act === 'update') updateIds([id], el);
  else if (act === 'history') historyDialog(id);
  else if (act === 'branch') branchDialog(id);
  else if (act === 'more') moreDialog(id);
  else if (act === 'link') linkDialog(row.dataset.folder);
  else if (act === 'pick') withBusy(el, async () => (await call(api.pickWow)) && refresh());
  else if (act === 'usewow') withBusy(null, async () => (await call(api.useWow, el.dataset.path), refresh()));
  else if (act === 'folder') api.openFolder(el.dataset.which);
  else if (act === 'token' || act === 'token-clear') {
    const host = el.dataset.host;
    const value = act === 'token' ? document.getElementById(`tok-${host}`).value : '';
    if (act === 'token' && !value.trim()) return;
    await withBusy(el, async () => {
      state.settings = await call(api.setToken, host, value);
      toast(value ? `Token for ${host} saved` : `Token for ${host} removed`);
      renderSettings();
    });
  }
});

document.addEventListener('change', async (e) => {
  const key = e.target.dataset && e.target.dataset.setting;
  if (key) state.settings = await call(api.saveSettings, { [key]: e.target.checked });
});

document.querySelectorAll('.tab').forEach(
  (t) =>
    (t.onclick = () => {
      state.tab = t.dataset.tab;
      document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${state.tab}`));
    }),
);

$('#filter').oninput = (e) => {
  state.filter = e.target.value;
  render();
};
$('#btnCheck').onclick = checkAll;
$('#btnUpdateAll').onclick = (e) => updateIds(null, e.currentTarget);
$('#btnLaunch').onclick = (e) => withBusy(e.currentTarget, () => call(api.launch));
$('#btnAdd').onclick = () => addDialog();
$('#btnImport').onclick = (e) =>
  withBusy(e.currentTarget, async () => {
    const r = await call(api.importConfig);
    if (!r) return;
    toast(`Imported ${r.filter((x) => x.ok).length} of ${r.length}`, r.some((x) => !x.ok && !/already/.test(x.error)));
    await refresh();
  });
$('#wowPath').onclick = $('#btnPickWelcome').onclick = (e) => withBusy(e.currentTarget, async () => (await call(api.pickWow)) && refresh());
$('#modalClose').onclick = closeModal;
$('#modal').onclick = (e) => e.target.id === 'modal' && closeModal();
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeModal());
$('#logToggle').onclick = () => ($('#log').hidden = !$('#log').hidden);

api.onLog((entry) => {
  const line = document.createElement('div');
  line.className = entry.level;
  line.innerHTML = `<time>${new Date(entry.time).toLocaleTimeString()}</time>${esc(entry.message)}`;
  const log = $('#log');
  log.appendChild(line);
  while (log.children.length > 300) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
  $('#logLast').textContent = entry.message;
});

(async () => {
  await refresh();
  if (state.settings && state.settings.wowPath && state.settings.autoCheck && state.overview && state.overview.addons.length) {
    checkAll();
  }
})();
