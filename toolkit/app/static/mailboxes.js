const BASE = document.querySelector('meta[name="base-url"]').content.replace(/\/$/, '');
let lastResults = [];
let resultTeams = [];            // teams chosen for the batch shown in the results table
let resultsGen = 0;              // a newer batch makes older distribution replies stale
let editableTeams = [];          // team mailbox addresses offered as buttons
let teamsError = false;
let teamsLoaded = false;
const selectedTeams = new Set();

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("mb-teams").addEventListener("click", onTeamClick);
  document.getElementById("mb-results-body").addEventListener("click", onRetryClick);
  loadTeams();
});

document.addEventListener("langchange", () => {
  renderTeams();
  if (lastResults.length) { renderResults(); renderDistSummary(); }
});

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* non-JSON error body */ }
  if (!res.ok || (body && body.ok === false)) {
    const err = new Error((body && body.error) || `API error: ${res.status}`);
    err.code = body && body.code;
    throw err;
  }
  return body;
}

// Translated text for a /groups/api error; unknown codes fall back to the server text.
function errText(e) {
  const key = e.code ? `tm_err_${e.code}` : "";
  if (key && t(key) !== key) return t(key);
  return `${t('tm_error')}: ${e.message}`;
}

function localPart(addr) { return addr.split("@")[0]; }

// -- Team buttons --

async function loadTeams() {
  try {
    const data = await api("/groups/api/teams");
    editableTeams = (data.teams || []).filter(x => x.editable).map(x => x.mailbox);
    teamsError = false;
  } catch (e) {
    editableTeams = [];
    teamsError = true;
  }
  teamsLoaded = true;
  renderTeams();
}

function renderTeams() {
  const el = document.getElementById("mb-teams");
  if (!teamsLoaded) { el.innerHTML = ""; return; }
  if (teamsError) {
    el.innerHTML = `<span class="hint">${esc(t('mb_teams_error'))}</span>`;
  } else if (!editableTeams.length) {
    el.innerHTML = `<span class="hint">${esc(t('mb_teams_none'))}</span>`;
  } else {
    el.innerHTML = editableTeams.map(team => {
      const on = selectedTeams.has(team);
      return `<button type="button" class="btn btn-sm${on ? " btn-primary" : ""}" data-team="${esc(team)}" title="${esc(team)}" aria-pressed="${on}">${esc(localPart(team))}</button>`;
    }).join("");
  }
  document.getElementById("mb-teams-hint").classList.toggle("hidden", teamsError || !editableTeams.length);
}

function onTeamClick(e) {
  const btn = e.target.closest("button[data-team]");
  if (!btn) return;
  const team = btn.dataset.team;
  const on = !selectedTeams.has(team);
  if (on) selectedTeams.add(team); else selectedTeams.delete(team);
  btn.classList.toggle("btn-primary", on);   // in place, so keyboard focus stays on the button
  btn.setAttribute("aria-pressed", String(on));
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
    const teamsSel = [...selectedTeams];
    const confirmText = t('mb_create_confirm', items.length) +
      (teamsSel.length ? `\n${t('mb_teams_confirm', teamsSel.map(localPart).join(", "))}` : "");
    if (!confirm(confirmText)) return;

    const auto_create_domain = document.getElementById("mb-auto-domain").checked;
    const default_quota_mb = document.getElementById("mb-default-quota").value || "2048";

    const result = await api("/mailboxes/api/batch_create", {
      method: "POST",
      body: JSON.stringify({ auto_create_domain, default_quota_mb, items }),
    });

    const myGen = ++resultsGen;
    lastResults = (result.results || []).map(r => ({ ...r, dist: {} }));
    resultTeams = teamsSel;

    // Show results
    const container = document.getElementById("mb-results-container");
    const summary = document.getElementById("mb-results-summary");

    summary.innerHTML = `
      <span class="status-active">${result.success} ${t('succeeded')}</span> /
      <span class="${result.failed ? 'status-error' : ''}">${result.failed} ${t('failed')}</span>
      ${t('out_of')} ${result.total}
    `;

    renderResults();
    renderDistSummary();

    container.classList.remove("hidden");
    document.getElementById("mb-preview-container").classList.add("hidden");
    document.getElementById("mb-copy-status").textContent = "";

    // Only accounts that were created are added to teams; a failure here never removes a mailbox.
    for (let idx = 0; idx < lastResults.length; idx++) {
      if (!lastResults[idx].success) continue;
      for (const team of teamsSel) {
        if (myGen !== resultsGen) return;
        await addToTeam(myGen, idx, team);
      }
    }
  } catch (err) {
    alert(t('error_save'));
  } finally {
    submitBtn.disabled = false;
  }
}

// -- Results table --

function distCell(r, idx) {
  if (!r.success) return `<span class="hint">${esc(t('mb_dist_skipped'))}</span>`;
  return `<ul class="dist-list">${resultTeams.map(team => {
    const d = r.dist[team];
    let state;
    if (!d || d.state === "pending") state = `<span class="status-pending">${esc(t('mb_dist_pending'))}</span>`;
    else if (d.state === "ok") state = `<span class="status-active">${esc(t(d.changed ? 'mb_dist_ok' : 'mb_dist_nochange'))}</span>`;
    else state = `<span class="status-error">${esc(d.msg)}</span>` +
      `<button type="button" class="btn btn-sm" data-retry="1" data-idx="${idx}" data-team="${esc(team)}" ` +
      `aria-label="${esc(t('mb_dist_retry_label', r.email, localPart(team)))}">${esc(t('mb_dist_retry'))}</button>`;
    return `<li><span class="dist-team" title="${esc(team)}">${esc(localPart(team))}</span>${state}</li>`;
  }).join("")}</ul>`;
}

function renderResults() {
  const withTeams = resultTeams.length > 0;
  const a = document.activeElement;
  const focus = a && a.dataset && a.dataset.retry ? { idx: a.dataset.idx, team: a.dataset.team } : null;
  document.getElementById("mb-col-dist").classList.toggle("hidden", !withTeams);
  document.getElementById("mb-dist-note").classList.toggle("hidden", !withTeams);
  document.getElementById("mb-results-body").innerHTML = lastResults.map((r, idx) => `
    <tr>
      <td>${esc(r.email)}</td>
      <td>${r.success ? `<code>${esc(r.password)}</code>` : ""}</td>
      <td>${r.success
        ? `<span class="status-active">${t('ok')}</span>`
        : `<span class="status-error">${esc(r.error)}</span>`
      }</td>
      ${withTeams ? `<td>${distCell(r, idx)}</td>` : ""}
    </tr>
  `).join("");
  if (focus) {
    const hit = [...document.querySelectorAll("#mb-results-body [data-retry]")]
      .find(el => el.dataset.idx === focus.idx && el.dataset.team === focus.team);
    if (hit) hit.focus();
  }
}

function renderDistSummary() {
  const el = document.getElementById("mb-dist-summary");
  let ok = 0, fail = 0, total = 0;
  lastResults.forEach(r => {
    if (!r.success) return;
    resultTeams.forEach(team => {
      total++;
      const d = r.dist[team];
      if (d && d.state === "ok") ok++;
      else if (d && d.state === "fail") fail++;
    });
  });
  if (!total) { el.textContent = ""; return; }
  el.innerHTML = ok + fail < total
    ? esc(t('mb_dist_progress', ok + fail, total))
    : `<span class="status-active">${esc(t('mb_dist_summary_ok', ok))}</span> / <span class="${fail ? "status-error" : ""}">${esc(t('mb_dist_summary_fail', fail))}</span>`;
}

// Add one created account to one team. Idempotent on the server, so a retry is safe.
async function addToTeam(gen, idx, team) {
  const r = lastResults[idx];
  r.dist[team] = { state: "pending" };
  if (gen === resultsGen) { renderResults(); renderDistSummary(); }
  let result;
  try {
    const res = await api("/groups/api/add", { method: "POST", body: JSON.stringify({ team, address: r.email }) });
    result = { state: "ok", changed: !!res.changed };
  } catch (e) {
    result = { state: "fail", msg: errText(e) };
  }
  if (gen !== resultsGen) return;  // a newer batch replaced this table
  r.dist[team] = result;
  renderResults();
  renderDistSummary();
}

function onRetryClick(e) {
  const btn = e.target.closest("button[data-retry]");
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  addToTeam(resultsGen, Number(btn.dataset.idx), btn.dataset.team);
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
