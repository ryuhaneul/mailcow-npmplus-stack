const lower = value => String(value ?? '').toLowerCase();
// MariaDB utf8mb4_general_ci equality ignores case and trailing ASCII spaces.
const sqlValue = value => lower(value).replace(/ +$/, '');
const active = value => ['1', '2'].includes(String(value));
const one = value => String(value) === '1';
const recipients = row => lower(row.goto).split(/[,\s]+/).filter(Boolean);
const parts = address => { const at = address.lastIndexOf('@'); return { local: address.slice(0, at), domain: address.slice(at + 1) }; };
export function senderAddress(value) {
  return typeof value === 'string' && /^[^\s<>@\x00-\x1f\x7f]+@[^\s<>@\x00-\x1f\x7f]+$/.test(value) ? lower(value) : null;
}
function senderName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return senderAddress(name) ? '' : name;
}
function enabledDomain(data, domain) {
  return data.domain.some(row => sqlValue(row.domain) === domain && one(row.active))
    || data.alias_domain.some(row => sqlValue(row.alias_domain) === domain && one(row.active));
}
function aliasEnabled(data, row, domain) {
  return row && one(row.active) && one(row.sender_allowed) && sqlValue(row.domain) === domain && enabledDomain(data, domain);
}

/** Inverse of the Postfix sender-login map, preserving COALESCE and SQL OR/AND precedence. */
export function senderKind(data, actorValue, fromValue) {
  const actor = senderAddress(actorValue), from = senderAddress(fromValue);
  if (!actor || !from) return null;
  if (actor === from) return 'self';
  const { local, domain } = parts(from);
  const eligible = row => active(row.active) && one(row.sender_allowed);
  const selected = data.alias.find(row => sqlValue(row.address) === from && eligible(row))
    ?? data.alias.find(row => sqlValue(row.address) === `@${domain}` && eligible(row));
  if (aliasEnabled(data, selected, domain) && recipients(selected).includes(actor)) return 'alias';
  const mappings = data.alias_domain.filter(row => sqlValue(row.alias_domain) === domain);
  for (const row of data.sender_acl.filter(row => sqlValue(row.logged_in_as) === actor)) {
    const grant = sqlValue(row.send_as);
    // The NOT IN clause belongs ONLY to the last OR term in the original SQL.
    if (grant === `@${domain}` || grant === from || grant === '*'
      || mappings.some(mapping => grant === `@${sqlValue(mapping.target_domain)}`)) return 'acl';
    const excluded = data.alias.filter(alias => sqlValue(alias.address) === from);
    const notIn = !excluded.some(alias => alias.goto === null || sqlValue(alias.goto) === actor);
    if (notIn && mappings.some(mapping => grant === `${local}@${sqlValue(mapping.target_domain)}`)) return 'acl';
  }
  if (mappings.some(mapping => one(mapping.active) && data.mailbox.some(row => active(row.active)
    && sqlValue(row.username) === actor && sqlValue(row.username) === `${local}@${sqlValue(mapping.target_domain)}`))) return 'alias';
  return null;
}

export function senderIdentities(data, session) {
  const actor = lower(session.email);
  const ownName = senderName(data.mailbox.find(row => sqlValue(row.username) === actor)?.name) || senderName(session.name);
  const grants = data.sender_acl.filter(row => sqlValue(row.logged_in_as) === actor);
  const candidates = new Set([actor]);
  for (const row of data.alias) if (!row.address.startsWith('@') && recipients(row).includes(actor)) candidates.add(sqlValue(row.address));
  const explicit = grants.map(row => sqlValue(row.send_as)).filter(value => senderAddress(value));
  for (const address of explicit) candidates.add(address);
  for (const address of [actor, ...explicit]) {
    const { local, domain } = parts(address);
    for (const mapping of data.alias_domain) if (sqlValue(mapping.target_domain) === domain) candidates.add(`${local}@${sqlValue(mapping.alias_domain)}`);
  }
  const domains = new Set();
  for (const row of data.alias) if (row.address.startsWith('@') && recipients(row).includes(actor)) {
    const domain = sqlValue(row.address).slice(1);
    if (aliasEnabled(data, row, domain)) domains.add(`@${domain}`);
  }
  for (const row of grants) if (row.send_as.startsWith('@')) {
    const domain = sqlValue(row.send_as).slice(1); domains.add(`@${domain}`);
    // No active condition on alias_domain in this UNION arm of the original SQL.
    for (const mapping of data.alias_domain) if (sqlValue(mapping.target_domain) === domain) domains.add(`@${sqlValue(mapping.alias_domain)}`);
  }
  const identities = [...candidates].flatMap(address => {
    const kind = senderKind(data, actor, address);
    return kind ? [{ address, name: senderName(data.mailbox.find(row => sqlValue(row.username) === address)?.name) || ownName, kind }] : [];
  });
  identities.sort((a, b) => (a.kind === 'self' ? -1 : b.kind === 'self' ? 1 : a.address.localeCompare(b.address, 'en')));
  const preferred = senderAddress(session.prefs?.defaultFrom);
  return { identities, anyAtDomains: [...domains].sort(), anyAddress: grants.some(row => sqlValue(row.send_as) === '*'), defaultFrom: preferred && senderKind(data, actor, preferred) ? preferred : actor };
}
