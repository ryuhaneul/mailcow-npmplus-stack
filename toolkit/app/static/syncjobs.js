const BASE = document.querySelector('meta[name="base-url"]').content.replace(/\/$/, '');
let allJobs = [];
let selectedIds = new Set();

document.addEventListener("DOMContentLoaded", loadJobs);

document.addEventListener("langchange", () => {
  renderJobs();
});

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

// -- Job List --

async function loadJobs() {
  const tbody = document.getElementById("jobs-body");
  selectedIds.clear();
  try {
    allJobs = await api("/syncjobs/api/list");
    renderJobs();
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="7" class="loading">${t('error_loading_syncjobs')}</td></tr>`;
  }
}

// mailcow returns last_run as a "YYYY-MM-DD HH:MM:SS" string; unset jobs give
// null, "", or a zeroed date.
function hasRealLastRun(lr) {
  return !!lr && !/^0000-00-00/.test(String(lr));
}

function syncStatus(j) {
  const active = j.active === 1 || j.active === "1";
  if (!active) return { cls: "status-inactive", label: t('inactive') };
  if (j.is_running === 1 || j.is_running === "1") return { cls: "status-running", label: t('running') };
  if (!hasRealLastRun(j.last_run)) return { cls: "status-pending", label: t('pending') };
  const ok = j.success === 1 || j.success === "1";
  return ok
    ? { cls: "status-success", label: t('succeeded') }
    : { cls: "status-failed", label: t('failed') };
}

function renderJobs() {
  const tbody = document.getElementById("jobs-body");
  const headerCheckbox = document.querySelector("#jobs-table thead input[type=checkbox]");
  if (headerCheckbox) headerCheckbox.checked = false;
  if (!allJobs.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="loading">${t('no_syncjobs_found')}</td></tr>`;
    return;
  }

  tbody.innerHTML = allJobs.map(j => {
    const lastrun = hasRealLastRun(j.last_run) ? esc(j.last_run) : t('never');
    const st = syncStatus(j);
    const result = (j.exit_status && j.exit_status !== "0") ? esc(j.exit_status) : "-";
    return `
      <tr>
        <td><input type="checkbox" value="${j.id}" onchange="toggleSelect(this)"></td>
        <td>${esc(j.user1 || "")}@${esc(j.host1 || "")}</td>
        <td>${esc(j.username || j.user2 || "")}</td>
        <td><span class="${st.cls}">${st.label}</span></td>
        <td>${lastrun}</td>
        <td>${result}</td>
        <td><button class="btn btn-sm" onclick="openSyncLog(${j.id})" data-i18n="log">${t('log')}</button></td>
      </tr>
    `;
  }).join("");

  updateBulkActions();
}

// -- Sync Log Modal --

async function openSyncLog(id) {
  const overlay = document.getElementById("log-overlay");
  const pre = document.getElementById("log-content");
  pre.textContent = t('loading');
  overlay.classList.remove("hidden");
  try {
    const data = await api(`/syncjobs/api/detail/${id}`);
    const job = Array.isArray(data)
      ? (data.find(j => String(j.id) === String(id)) || data[0] || {})
      : (data || {});
    pre.textContent = job.log ? job.log : t('no_log');
  } catch (e) {
    pre.textContent = t('error_loading');
  }
}

function hideLog() {
  document.getElementById("log-overlay").classList.add("hidden");
}

function closeLog(e) {
  if (e.target === e.currentTarget) hideLog();
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const overlay = document.getElementById("log-overlay");
    if (overlay && !overlay.classList.contains("hidden")) hideLog();
  }
});

function esc(s) {
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML.replace(/'/g, "&#39;").replace(/"/g, "&quot;");
}

function toggleSelect(cb) {
  if (cb.checked) selectedIds.add(parseInt(cb.value));
  else selectedIds.delete(parseInt(cb.value));
  updateBulkActions();
}

function toggleAll(cb) {
  const boxes = document.querySelectorAll("#jobs-body input[type=checkbox]");
  boxes.forEach(b => {
    b.checked = cb.checked;
    if (cb.checked) selectedIds.add(parseInt(b.value));
    else selectedIds.delete(parseInt(b.value));
  });
  updateBulkActions();
}

function updateBulkActions() {
  const el = document.getElementById("bulk-actions");
  const count = document.getElementById("selected-count");
  if (selectedIds.size > 0) {
    el.classList.remove("hidden");
    count.textContent = selectedIds.size;
  } else {
    el.classList.add("hidden");
  }
}

async function bulkToggle(active) {
  try {
    await api("/syncjobs/api/toggle", {
      method: "POST",
      body: JSON.stringify({ ids: [...selectedIds], active }),
    });
    selectedIds.clear();
    loadJobs();
  } catch (err) {
    alert(t('error_save'));
  }
}

async function bulkDelete() {
  if (!confirm(t('delete_confirm', selectedIds.size))) return;
  try {
    await api("/syncjobs/api/delete", {
      method: "POST",
      body: JSON.stringify({ ids: [...selectedIds] }),
    });
    selectedIds.clear();
    loadJobs();
  } catch (err) {
    alert(t('error_save'));
  }
}

// -- Batch Create --

function handleCSV(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById("account-list").value = e.target.result;
  };
  reader.readAsText(file);
}

async function parsePreview() {
  const text = document.getElementById("account-list").value;
  if (!text.trim()) { alert(t('enter_account_list')); return; }

  try {
    const accounts = await api("/syncjobs/api/parse_csv", {
      method: "POST",
      body: JSON.stringify({ text }),
    });

    const container = document.getElementById("preview-container");
    const count = document.getElementById("preview-count");
    const tbody = document.getElementById("preview-body");

    count.textContent = accounts.length;
    tbody.innerHTML = accounts.map(a => `
      <tr>
        <td>${esc(a.user1)}</td>
        <td>${esc(a.username)}</td>
        <td>${"\u2022".repeat(8)}</td>
      </tr>
    `).join("");

    container.classList.remove("hidden");
  } catch (err) {
    alert(t('error_loading'));
  }
}

async function batchCreate(e) {
  e.preventDefault();

  const host1 = document.getElementById("src-host").value;
  const port1 = document.getElementById("src-port").value;
  const enc1 = document.getElementById("src-enc").value;
  const text = document.getElementById("account-list").value;

  if (!text.trim()) { alert(t('enter_account_list')); return; }

  const submitBtn = e.target.querySelector('[type="submit"]');
  submitBtn.disabled = true;

  try {
    const accounts = await api("/syncjobs/api/parse_csv", {
      method: "POST",
      body: JSON.stringify({ text }),
    });

    if (!accounts.length) { alert(t('no_valid_accounts')); return; }
    if (!confirm(t('create_confirm', accounts.length))) return;

    const auto_create_target = document.getElementById("sj-auto-target").checked;
    const default_quota_mb = document.getElementById("sj-default-quota").value || "2048";
    const default_name = document.getElementById("sj-default-name").value;

    const include_folders = document.getElementById("sj-include-folders").value;
    const exclude = document.getElementById("sj-exclude").value;
    const maxage = document.getElementById("sj-maxage").value || "0";
    const subfolder2 = document.getElementById("sj-subfolder2").value;

    const result = await api("/syncjobs/api/batch_create", {
      method: "POST",
      body: JSON.stringify({ host1, port1, enc1, auto_create_target, default_quota_mb, default_name, include_folders, exclude, maxage, subfolder2, accounts }),
    });

    // Show results
    const container = document.getElementById("results-container");
    const summary = document.getElementById("results-summary");
    const tbody = document.getElementById("results-body");

    summary.innerHTML = `
      <span class="status-active">${result.success} ${t('succeeded')}</span> /
      <span class="${result.failed ? 'status-error' : ''}">${result.failed} ${t('failed')}</span>
      ${t('out_of')} ${result.total}
    `;

    tbody.innerHTML = result.results.map(r => `
      <tr>
        <td>${esc(r.user1)}</td>
        <td>${esc(r.username)}</td>
        <td>${r.success
          ? `<span class="status-active">${t('ok')}</span>`
          : `<span class="status-error">${esc(r.error)}</span>`
        }</td>
      </tr>
    `).join("");

    container.classList.remove("hidden");
    document.getElementById("preview-container").classList.add("hidden");

    // Refresh job list
    loadJobs();
  } catch (err) {
    alert(t('error_save'));
  } finally {
    submitBtn.disabled = false;
  }
}
