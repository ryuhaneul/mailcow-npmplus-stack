const BASE = document.querySelector('meta[name="base-url"]').content.replace(/\/$/, '');
let lastResults = [];

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = String(s);
  return d.innerHTML.replace(/'/g, "&#39;").replace(/"/g, "&quot;");
}

// -- Bulk Create --

function handleCSV(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    document.getElementById("mb-list").value = e.target.result;
  };
  reader.readAsText(file);
}

async function parsePreview() {
  const text = document.getElementById("mb-list").value;
  if (!text.trim()) { alert(t('enter_account_list')); return; }

  try {
    const items = await api("/mailboxes/api/parse_csv", {
      method: "POST",
      body: JSON.stringify({ text }),
    });

    const defaultQuota = document.getElementById("mb-default-quota").value || "2048";
    const container = document.getElementById("mb-preview-container");
    const count = document.getElementById("mb-preview-count");
    const tbody = document.getElementById("mb-preview-body");

    count.textContent = items.length;
    tbody.innerHTML = items.map(m => `
      <tr>
        <td>${esc(m.email)}</td>
        <td>${m.password ? "•".repeat(8) : "—"}</td>
        <td>${esc(m.name || m.email.split("@")[0])}</td>
        <td>${esc(m.quota_mb || defaultQuota)}</td>
      </tr>
    `).join("");

    container.classList.remove("hidden");
  } catch (err) {
    alert(t('error_loading'));
  }
}

async function bulkCreate(e) {
  e.preventDefault();

  const text = document.getElementById("mb-list").value;
  if (!text.trim()) { alert(t('enter_account_list')); return; }

  const submitBtn = e.target.querySelector('[type="submit"]');
  submitBtn.disabled = true;

  try {
    const items = await api("/mailboxes/api/parse_csv", {
      method: "POST",
      body: JSON.stringify({ text }),
    });

    if (!items.length) { alert(t('no_valid_accounts')); return; }
    if (!confirm(t('mb_create_confirm', items.length))) return;

    const auto_create_domain = document.getElementById("mb-auto-domain").checked;
    const default_quota_mb = document.getElementById("mb-default-quota").value || "2048";

    const result = await api("/mailboxes/api/batch_create", {
      method: "POST",
      body: JSON.stringify({ auto_create_domain, default_quota_mb, items }),
    });

    lastResults = result.results || [];

    // Show results
    const container = document.getElementById("mb-results-container");
    const summary = document.getElementById("mb-results-summary");
    const tbody = document.getElementById("mb-results-body");

    summary.innerHTML = `
      <span class="status-active">${result.success} ${t('succeeded')}</span> /
      <span class="${result.failed ? 'status-error' : ''}">${result.failed} ${t('failed')}</span>
      ${t('out_of')} ${result.total}
    `;

    tbody.innerHTML = result.results.map(r => `
      <tr>
        <td>${esc(r.email)}</td>
        <td>${r.success ? `<code>${esc(r.password)}</code>` : ""}</td>
        <td>${r.success
          ? `<span class="status-active">${t('ok')}</span>`
          : `<span class="status-error">${esc(r.error)}</span>`
        }</td>
      </tr>
    `).join("");

    container.classList.remove("hidden");
    document.getElementById("mb-preview-container").classList.add("hidden");
    document.getElementById("mb-copy-status").textContent = "";
  } catch (err) {
    alert(t('error_save'));
  } finally {
    submitBtn.disabled = false;
  }
}

async function copyAllCredentials() {
  const status = document.getElementById("mb-copy-status");
  const lines = lastResults
    .filter(r => r.success && r.password)
    .map(r => `${r.email},${r.password}`);
  if (!lines.length) return;

  try {
    await navigator.clipboard.writeText(lines.join("\n"));
    status.textContent = t('copied');
  } catch (err) {
    status.textContent = "";
    alert(t('error_save'));
  }
}
