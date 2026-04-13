const BASE = document.querySelector('meta[name="base-url"]').content.replace(/\/$/, '');
let allMailboxes = [];
let allGroups = [];

document.addEventListener("DOMContentLoaded", () => {
  loadGroups();
  loadMailboxes();
});

document.addEventListener("langchange", () => {
  renderGroups();
});

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

async function loadGroups() {
  const container = document.getElementById("groups-container");
  try {
    allGroups = await api("/groups/api/list");
    renderGroups();
  } catch (e) {
    container.innerHTML = `<div class="loading">${t('error_loading')}</div>`;
  }
}

async function loadMailboxes() {
  try {
    allMailboxes = await api("/groups/api/mailboxes");
  } catch (e) {
    console.error("Failed to load mailboxes:", e);
  }
}

function renderGroups() {
  const container = document.getElementById("groups-container");
  if (!allGroups.length) {
    container.innerHTML = `<div class="loading">${t('no_groups_yet')}</div>`;
    return;
  }

  container.innerHTML = allGroups.map(g => `
    <div class="group-card">
      <div class="group-header">
        <div class="group-name">${esc(g.name)}</div>
        <div class="group-actions">
          <button class="btn btn-sm" onclick="showEditModal('${esc(g.address)}')">${t('edit')}</button>
          <button class="btn btn-sm btn-danger" onclick="deleteGroup(${g.id}, '${esc(g.name)}')">${t('delete')}</button>
        </div>
      </div>

      <div class="group-section">
        <div class="group-section-title">${t('inbound_addresses')}</div>
        ${g.inbound.map(i => `
          <span class="tag">${esc(i.address)}
            <button class="tag-remove" onclick="removeInbound(${i.id})" aria-label="${t('delete')}">&times;</button>
          </span>
        `).join("") || `<span class="tag tag-empty">${t('none')}</span>`}
        <button class="btn btn-sm tag-add-btn" onclick="showInboundModal('${esc(g.address)}')" aria-label="${t('add_inbound_address')}">+</button>
      </div>

      <div class="group-section">
        <div class="group-section-title">${t('members')}</div>
        ${g.members.map(m => `<span class="tag tag-member">${esc(m)}</span>`).join("") || `<span class="tag tag-empty">${t('none')}</span>`}
      </div>
    </div>
  `).join("");
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML.replace(/'/g, "&#39;").replace(/"/g, "&quot;");
}

// -- Create/Edit Modal --

let lastFocusedElement = null;

function showCreateModal() {
  lastFocusedElement = document.activeElement;
  document.getElementById("modal-title").textContent = t("new_group");
  document.getElementById("group-id").value = "";
  document.getElementById("group-name").value = "";
  renderDomainSelect();
  renderMemberCheckboxes([]);
  document.getElementById("modal-overlay").classList.remove("hidden");
  document.getElementById("group-name").focus();
}

function showEditModal(address) {
  lastFocusedElement = document.activeElement;
  const g = allGroups.find(g => g.address === address);
  if (!g) return;
  document.getElementById("modal-title").textContent = t("edit_group");
  document.getElementById("group-id").value = g.id;
  document.getElementById("group-name").value = g.name;
  renderDomainSelect();
  renderMemberCheckboxes(g.members);
  document.getElementById("modal-overlay").classList.remove("hidden");
  document.getElementById("group-name").focus();
}

function renderDomainSelect() {
  const sel = document.getElementById("group-domain");
  const domains = [...new Set(allMailboxes.map(m => m.username.split("@")[1]))];
  sel.innerHTML = domains.map(d => `<option value="${esc(d)}">${esc(d)}</option>`).join("");
}

function renderMemberCheckboxes(selected) {
  const container = document.getElementById("member-checkboxes");
  container.innerHTML = allMailboxes.map(m => `
    <label>
      <input type="checkbox" value="${esc(m.username)}" ${selected.includes(m.username) ? "checked" : ""}>
      ${esc(m.username)}
    </label>
  `).join("");
}

function hideModal() {
  document.getElementById("modal-overlay").classList.add("hidden");
  if (lastFocusedElement) lastFocusedElement.focus();
}
function closeModal(e) { if (e.target === e.currentTarget) hideModal(); }

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!document.getElementById("inbound-overlay").classList.contains("hidden")) hideInbound();
    else if (!document.getElementById("modal-overlay").classList.contains("hidden")) hideModal();
  }
});

async function saveGroup(e) {
  e.preventDefault();
  const submitBtn = e.target.querySelector('[type="submit"]');
  submitBtn.disabled = true;
  const id = document.getElementById("group-id").value;
  const name = document.getElementById("group-name").value;
  const domain = document.getElementById("group-domain").value;
  const checks = document.querySelectorAll("#member-checkboxes input:checked");
  const members = Array.from(checks).map(c => c.value);

  try {
    if (id) {
      await api("/groups/api/update", {
        method: "POST",
        body: JSON.stringify({ id: parseInt(id), name, members }),
      });
    } else {
      await api("/groups/api/create", {
        method: "POST",
        body: JSON.stringify({ name, domain, members }),
      });
    }
    hideModal();
    loadGroups();
  } catch (err) {
    alert(t('error_save'));
  } finally {
    submitBtn.disabled = false;
  }
}

async function deleteGroup(id, name) {
  if (!confirm(t('delete_group_confirm', name))) return;
  try {
    await api("/groups/api/delete", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    loadGroups();
  } catch (err) {
    alert(t('error_save'));
  }
}

// -- Inbound Modal --

function showInboundModal(groupAddress) {
  lastFocusedElement = document.activeElement;
  document.getElementById("inbound-group-addr").value = groupAddress;
  document.getElementById("inbound-address").value = "";
  document.getElementById("inbound-overlay").classList.remove("hidden");
  document.getElementById("inbound-address").focus();
}
function hideInbound() {
  document.getElementById("inbound-overlay").classList.add("hidden");
  if (lastFocusedElement) lastFocusedElement.focus();
}
function closeInbound(e) { if (e.target === e.currentTarget) hideInbound(); }

async function saveInbound(e) {
  e.preventDefault();
  const submitBtn = e.target.querySelector('[type="submit"]');
  submitBtn.disabled = true;
  const address = document.getElementById("inbound-address").value;
  const groupAddress = document.getElementById("inbound-group-addr").value;
  try {
    await api("/groups/api/add_inbound", {
      method: "POST",
      body: JSON.stringify({ address, group_address: groupAddress }),
    });
    hideInbound();
    loadGroups();
  } catch (err) {
    alert(t('error_save'));
  } finally {
    submitBtn.disabled = false;
  }
}

async function removeInbound(id) {
  if (!confirm(t('remove_inbound_confirm'))) return;
  try {
    await api("/groups/api/remove_inbound", {
      method: "POST",
      body: JSON.stringify({ id }),
    });
    loadGroups();
  } catch (err) {
    alert(t('error_save'));
  }
}
