const BASE = document.querySelector('meta[name="base-url"]').content.replace(/\/$/, '');
let teams = [];
let forwards = [];
let mailboxes = [];
let loadError = null;
let actionError = "";   // last failed add/remove, shown until the next one starts
let loaded = false;
let loadGen = 0;       // only the newest list response may replace the screen
let openTeam = "";     // team whose add panel is open
let addSearch = "";
const busy = new Set(); // teams with a save in flight

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("tm-search").addEventListener("input", render);
  const list = document.getElementById("tm-list");
  list.addEventListener("click", onClick);
  list.addEventListener("input", onInput);
  loadTeams();
});

document.addEventListener("langchange", render);

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

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML.replace(/'/g, "&#39;").replace(/"/g, "&quot;");
}

function showAlert(msg) {
  const el = document.getElementById("tm-alert");
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

function setStatus(msg) { document.getElementById("tm-status").textContent = msg || ""; }

// Translated text for an API error; unknown codes fall back to the server text.
function errText(e) {
  const key = e.code ? `tm_err_${e.code}` : "";
  if (key && t(key) !== key) return t(key);
  return `${t('tm_error')}: ${e.message}`;
}

async function loadTeams() {
  const gen = ++loadGen;
  try {
    const data = await api("/groups/api/teams");
    if (gen !== loadGen) return;  // a newer request owns the screen
    teams = data.teams || [];
    forwards = data.forwards || [];
    mailboxes = data.mailboxes || [];
    loadError = null;
  } catch (e) {
    if (gen !== loadGen) return;
    loadError = e.message;
  }
  loaded = true;
  render();
}

function has(text, q) { return String(text || "").toLowerCase().includes(q); }

function teamMatches(tm, q) {
  return !q || has(tm.mailbox, q) || tm.members.some(m => has(m.address, q) || has(m.name, q));
}

function isMember(tm, address) {
  return tm.members.some(m => m.address.toLowerCase() === address.toLowerCase());
}

function candidates(tm) {
  const q = addSearch.trim().toLowerCase();
  return mailboxes.filter(m => m.address.toLowerCase() !== tm.mailbox.toLowerCase() && !isMember(tm, m.address) &&
    (!q || has(m.address, q) || has(m.name, q)));
}

function optionsHtml(tm) {
  return `<option value="">${esc(t('tm_add_select'))}</option>` +
    candidates(tm).map(m => `<option value="${esc(m.address)}">${esc(m.address)}${m.name ? ` — ${esc(m.name)}` : ""}</option>`).join("");
}

function memberRow(tm, m, canRemove, isBusy, onlyOne) {
  const hintId = `tm-last-${teams.indexOf(tm)}`;
  let btn = "";
  if (canRemove) {
    btn = `<button type="button" class="btn btn-sm btn-danger" data-act="remove" data-team="${esc(tm.mailbox)}" data-addr="${esc(m.address)}"` +
      `${isBusy || onlyOne ? " disabled" : ""}${onlyOne ? ` aria-describedby="${hintId}"` : ""}>${t('tm_remove')}</button>`;
  }
  return `<li class="member-row">
      <span class="member-info">${m.name ? `<span class="member-name">${esc(m.name)}</span>` : ""}<span class="member-addr">${esc(m.address)}</span></span>
      ${btn}
    </li>`;
}

function reasonText(reason) {
  const key = `tm_reason_${reason}`;
  return t(key) !== key ? t(key) : t('tm_reason_unparseable');
}

function teamCard(tm) {
  const isBusy = busy.has(tm.mailbox);
  const canEdit = tm.editable;
  const onlyOne = canEdit && tm.members.length === 1;
  const idx = teams.indexOf(tm);
  const open = canEdit && openTeam === tm.mailbox;
  const header = `<div class="group-header">
      <h2 class="group-name">${esc(tm.mailbox)}</h2>
      <div class="group-actions">
        ${tm.members.length ? `<span class="tag">${esc(t('tm_members_count', tm.members.length))}</span>` : ""}
        ${canEdit ? `<button type="button" class="btn btn-sm" data-act="toggle-add" data-team="${esc(tm.mailbox)}" aria-expanded="${open}"${isBusy ? " disabled" : ""}>${t('tm_add_member')}</button>` : ""}
      </div>
    </div>`;
  const reason = !canEdit ? `<p class="team-reason" role="note">${esc(reasonText(tm.reason))}</p>` : "";
  const rows = tm.members.map(m => memberRow(tm, m, canEdit, isBusy, onlyOne)).join("");
  const lastHint = onlyOne ? `<p class="hint" id="tm-last-${idx}">${esc(t('tm_last_member'))}</p>` : "";
  const panel = open ? `<div class="add-panel">
      <input type="text" class="tm-add-search" data-team="${esc(tm.mailbox)}" value="${esc(addSearch)}" aria-label="${esc(t('tm_add_search'))}" placeholder="${esc(t('tm_search'))}" autocomplete="off">
      <select class="tm-add-select" aria-label="${esc(t('tm_add_select'))}">${optionsHtml(tm)}</select>
      <button type="button" class="btn btn-sm btn-primary" data-act="add" data-team="${esc(tm.mailbox)}"${isBusy ? " disabled" : ""}>${t('tm_add_submit')}</button>
    </div>` : "";
  return `<div class="group-card${canEdit ? "" : " team-readonly"}">${header}${reason}${rows ? `<ul class="member-list">${rows}</ul>` : ""}${lastHint}${panel}</div>`;
}

// Re-render keeps keyboard focus on the same control when it still exists.
function focusKey() {
  const a = document.activeElement;
  return a && a.dataset && a.dataset.act ? { act: a.dataset.act, team: a.dataset.team, addr: a.dataset.addr } : null;
}
function restoreFocus(k) {
  if (!k) return;
  // a removed member's button is gone: land on the team's "add member" button instead
  const hit = [...document.querySelectorAll("#tm-list [data-act]")].find(el =>
    el.dataset.act === k.act && el.dataset.team === k.team && el.dataset.addr === k.addr && !el.disabled);
  const fallback = [...document.querySelectorAll("#tm-list [data-act=toggle-add]")].find(el => el.dataset.team === k.team);
  (hit || fallback || document.getElementById("tm-list")).focus();
}

function render() {
  const list = document.getElementById("tm-list");
  const q = document.getElementById("tm-search").value.trim().toLowerCase();
  const key = focusKey();
  showAlert(loadError ? `${t('tm_load_error')}: ${loadError}` : actionError);
  if (!loaded) return;
  if (loadError && !teams.length) {
    list.innerHTML = `<div class="loading">${esc(t('tm_load_error'))}</div>`;
  } else {
    const shown = teams.filter(tm => teamMatches(tm, q));
    list.innerHTML = shown.length ? shown.map(teamCard).join("")
      : `<div class="loading">${esc(t(teams.length ? 'tm_no_match' : 'tm_empty'))}</div>`;
  }
  const fw = forwards.filter(f => !q || has(f.mailbox, q) || has(f.to, q));
  document.getElementById("tm-forwards").classList.toggle("hidden", !fw.length);
  document.getElementById("tm-forwards-list").innerHTML = fw.map(f =>
    `<li class="member-row"><span class="member-info"><span class="member-addr">${esc(f.mailbox)}</span><span class="fwd-arrow" aria-label="${esc(t('tm_forward_to'))}">→</span><span class="member-addr">${esc(f.to)}</span></span></li>`).join("");
  restoreFocus(key);
}

function onInput(e) {
  const input = e.target.closest(".tm-add-search");
  if (!input) return;
  addSearch = input.value;
  const tm = teams.find(x => x.mailbox === input.dataset.team);
  const sel = input.parentElement.querySelector(".tm-add-select");
  if (tm && sel) sel.innerHTML = optionsHtml(tm);  // only the options; the input keeps focus
}

function onClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn || btn.disabled) return;
  const { act, team, addr } = btn.dataset;
  if (act === "toggle-add") {
    openTeam = openTeam === team ? "" : team;
    addSearch = "";
    render();
    if (openTeam) {
      const inp = document.querySelector(".tm-add-search");
      if (inp) inp.focus();
    }
  } else if (act === "add") {
    const sel = btn.parentElement.querySelector(".tm-add-select");
    if (sel && sel.value) mutate("add", team, sel.value);
  } else if (act === "remove") {
    if (confirm(t('tm_remove_confirm', team, addr))) mutate("remove", team, addr);
  }
}

// One save at a time per team; the screen is reloaded afterwards so it always
// shows what mailcow holds, whatever the outcome.
async function mutate(action, team, address) {
  if (busy.has(team)) return;
  const key = focusKey();   // the control disables while saving; give focus back afterwards
  busy.add(team);
  setStatus(t('tm_saving'));
  actionError = "";
  render();
  try {
    const res = await api(`/groups/api/${action}`, { method: "POST", body: JSON.stringify({ team, address }) });
    setStatus(res.changed ? t(action === "add" ? 'tm_added' : 'tm_removed', address) : t('tm_nochange'));
  } catch (e) {
    setStatus("");
    actionError = errText(e);
  } finally {
    busy.delete(team);
  }
  await loadTeams();
  if (!busy.has(team)) restoreFocus(key);
}
