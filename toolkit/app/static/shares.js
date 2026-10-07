const BASE = document.querySelector('meta[name="base-url"]').content.replace(/\/$/, '');
let allMailboxes = [];
let grantees = [];
let listOwner = "";  // owner that `grantees` was fetched for ("" = no list loaded)

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("sh-owner").addEventListener("change", loadGrants);
  document.getElementById("sh-list").addEventListener("click", onRevokeClick);
  loadMailboxes();
});

document.addEventListener("langchange", () => {
  renderOwnerSelect();
  renderDetail();
});

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON error body */ }
  if (!res.ok) throw new Error((body && body.error) || `API error: ${res.status}`);
  return body;
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML.replace(/'/g, "&#39;").replace(/"/g, "&quot;");
}

function owner() { return document.getElementById("sh-owner").value; }

function showAlert(msg) {
  const el = document.getElementById("sh-alert");
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

async function loadMailboxes() {
  try {
    allMailboxes = await api("/shares/api/mailboxes");
    renderOwnerSelect();
  } catch (e) {
    showAlert(`${t('error_loading')}: ${e.message}`);
  }
}

function renderOwnerSelect() {
  const sel = document.getElementById("sh-owner");
  const current = sel.value;
  sel.innerHTML = `<option value="">${esc(t('shares_select_owner'))}</option>` +
    allMailboxes.map(m => `<option value="${esc(m.username)}">${esc(m.username)}</option>`).join("");
  sel.value = current;
}

async function loadGrants() {
  showAlert("");
  // Drop the previous owner's list right away so no stale row can be acted on.
  grantees = [];
  listOwner = "";
  document.getElementById("sh-list").innerHTML = "";
  const detail = document.getElementById("sh-detail");
  detail.classList.add("hidden");
  const requested = owner();
  if (!requested) return;
  try {
    const data = await api(`/shares/api/grants?owner=${encodeURIComponent(requested)}`);
    if (requested !== owner()) return;  // owner changed while loading
    grantees = data.grantees;
    listOwner = requested;
    renderDetail();
  } catch (e) {
    if (requested !== owner()) return;
    showAlert(`${t('error_loading')}: ${e.message}`);
  }
}

function renderDetail() {
  const detail = document.getElementById("sh-detail");
  if (!listOwner || listOwner !== owner()) return;
  detail.classList.remove("hidden");

  document.getElementById("sh-list").innerHTML = grantees.length
    ? `<div class="table-wrap"><table><tbody>${grantees.map(g => `
        <tr>
          <td>${esc(g)}</td>
          <td><button class="btn btn-sm btn-danger" data-grantee="${esc(g)}">${t('shares_revoke')}</button></td>
        </tr>`).join("")}</tbody></table></div>`
    : `<div class="loading">${t('shares_none')}</div>`;

  const candidates = allMailboxes.filter(m => m.username !== owner() && !grantees.includes(m.username));
  document.getElementById("sh-grantee").innerHTML =
    `<option value="">${esc(t('shares_select_grantee'))}</option>` +
    candidates.map(m => `<option value="${esc(m.username)}">${esc(m.username)}</option>`).join("");
}

async function change(path, grantee) {
  showAlert("");
  const targetOwner = owner();  // rows only exist for the selected owner (cleared on switch)
  try {
    const res = await api(path, {
      method: "POST",
      body: JSON.stringify({ owner: targetOwner, grantee }),
    });
    if (targetOwner !== owner()) return;  // owner changed while waiting
    grantees = res.grantees;
    listOwner = targetOwner;
    renderDetail();
    if (!res.applied) showAlert(t('shares_not_applied'));
  } catch (e) {
    if (targetOwner !== owner()) return;
    showAlert(`${t('shares_error')}: ${e.message}`);
  }
}

async function grant(e) {
  e.preventDefault();
  const grantee = document.getElementById("sh-grantee").value;
  if (!grantee) return;
  const btn = e.target.querySelector('[type="submit"]');
  btn.disabled = true;
  try { await change("/shares/api/grant", grantee); } finally { btn.disabled = false; }
}

async function onRevokeClick(e) {
  const btn = e.target.closest("button[data-grantee]");
  if (!btn) return;
  const grantee = btn.dataset.grantee;
  if (!confirm(t('shares_revoke_confirm', grantee))) return;
  btn.disabled = true;
  try { await change("/shares/api/revoke", grantee); } finally { btn.disabled = false; }
}
