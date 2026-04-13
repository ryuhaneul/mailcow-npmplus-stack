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
    tbody.innerHTML = `<tr><td colspan="5" class="loading">${t('error_loading_syncjobs')}</td></tr>`;
  }
}

function renderJobs() {
  const tbody = document.getElementById("jobs-body");
  const headerCheckbox = document.querySelector("#jobs-table thead input[type=checkbox]");
  if (headerCheckbox) headerCheckbox.checked = false;
  if (!allJobs.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="loading">${t('no_syncjobs_found')}</td></tr>`;
    return;
  }

  tbody.innerHTML = allJobs.map(j => {
    const active = j.active === 1 || j.active === "1";
    const lastrun = (j.last_run && j.last_run > 0) ? new Date(j.last_run * 1000).toLocaleString() : t('never');
    const status = active ? t('active') : t('inactive');
    const cls = active ? "status-active" : "status-inactive";
    return `
      <tr>
        <td><input type="checkbox" value="${j.id}" onchange="toggleSelect(this)"></td>
        <td>${esc(j.user1 || "")}@${esc(j.host1 || "")}</td>
        <td>${esc(j.username || j.user2 || "")}</td>
        <td><span class="${cls}">${status}</span></td>
        <td>${lastrun}</td>
      </tr>
    `;
  }).join("");

  updateBulkActions();
}

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

    const result = await api("/syncjobs/api/batch_create", {
      method: "POST",
      body: JSON.stringify({ host1, port1, enc1, accounts }),
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
