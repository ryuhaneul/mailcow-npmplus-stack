const lower = value => String(value ?? '').toLowerCase();
const active = value => ['1', '2'].includes(String(value));
const one = value => String(value) === '1';
const recipients = row => lower(row.goto).split(/[,\s]+/).filter(Boolean);
const parts = address => { const at = address.lastIndexOf('@'); return { local: address.slice(0, at), domain: address.slice(at + 1) }; };
export function senderAddress(value) {
  return typeof value === 'string' && /^[^\s<>@\x00-\x1f\x7f]+@[^\s<>@\x00-\x1f\x7f]+$/.test(value) ? lower(value) : null;
}
function enabledDomain(data, domain) {
  return data.domain.some(row => lower(row.domain) === domain && one(row.active))
    || data.alias_domain.some(row => lower(row.alias_domain) === domain && one(row.active));
}
function aliasEnabled(data, row, domain) {
  return row && one(row.active) && one(row.sender_allowed) && lower(row.domain) === domain && enabledDomain(data, domain);
}

/** Inverse of the Postfix sender-login map, preserving COALESCE and SQL OR/AND precedence. */
export function senderKind(data, actorValue, fromValue) {
  const actor = senderAddress(actorValue), from = senderAddress(fromValue);
  if (!actor || !from) return null;
  if (actor === from) return 'self';
  const { local, domain } = parts(from);
  const eligible = row => active(row.active) && one(row.sender_allowed);
  const selected = data.alias.find(row => lower(row.address) === from && eligible(row))
    ?? data.alias.find(row => lower(row.address) === `@${domain}` && eligible(row));
  if (aliasEnabled(data, selected, domain) && recipients(selected).includes(actor)) return 'alias';
  const mappings = data.alias_domain.filter(row => lower(row.alias_domain) === domain);
  for (const row of data.sender_acl.filter(row => lower(row.logged_in_as) === actor)) {
    const grant = lower(row.send_as);
    // The NOT IN clause belongs ONLY to the last OR term in the original SQL.
    if (grant === `@${domain}` || grant === from || grant === '*'
      || mappings.some(mapping => grant === `@${lower(mapping.target_domain)}`)) return 'acl';
    const excluded = data.alias.filter(alias => lower(alias.address) === from);
    const notIn = !excluded.some(alias => alias.goto === null || lower(alias.goto) === actor);
    if (notIn && mappings.some(mapping => grant === `${local}@${lower(mapping.target_domain)}`)) return 'acl';
  }
  if (mappings.some(mapping => one(mapping.active) && data.mailbox.some(row => active(row.active)
    && lower(row.username) === actor && lower(row.username) === `${local}@${lower(mapping.target_domain)}`))) return 'alias';
  return null;
}

export function senderIdentities(data, session) {
  const actor = lower(session.email);
  const ownName = data.mailbox.find(row => lower(row.username) === actor)?.name || session.name || actor;
  const grants = data.sender_acl.filter(row => lower(row.logged_in_as) === actor);
  const candidates = new Set([actor]);
  for (const row of data.alias) if (!row.address.startsWith('@') && recipients(row).includes(actor)) candidates.add(lower(row.address));
  const explicit = grants.map(row => lower(row.send_as)).filter(value => senderAddress(value));
  for (const address of explicit) candidates.add(address);
  for (const address of [actor, ...explicit]) {
    const { local, domain } = parts(address);
    for (const mapping of data.alias_domain) if (lower(mapping.target_domain) === domain) candidates.add(`${local}@${lower(mapping.alias_domain)}`);
  }
  const domains = new Set();
  for (const row of data.alias) if (row.address.startsWith('@') && recipients(row).includes(actor)) {
    const domain = lower(row.address).slice(1);
    if (aliasEnabled(data, row, domain)) domains.add(`@${domain}`);
  }
  for (const row of grants) if (row.send_as.startsWith('@')) {
    const domain = lower(row.send_as).slice(1); domains.add(`@${domain}`);
    // No active condition on alias_domain in this UNION arm of the original SQL.
    for (const mapping of data.alias_domain) if (lower(mapping.target_domain) === domain) domains.add(`@${lower(mapping.alias_domain)}`);
  }
  const identities = [...candidates].flatMap(address => {
    const kind = senderKind(data, actor, address);
    return kind ? [{ address, name: data.mailbox.find(row => lower(row.username) === address)?.name || ownName, kind }] : [];
  });
  identities.sort((a, b) => (a.kind === 'self' ? -1 : b.kind === 'self' ? 1 : a.address.localeCompare(b.address, 'en')));
  const preferred = senderAddress(session.prefs?.defaultFrom);
  return { identities, anyAtDomains: [...domains].sort(), anyAddress: grants.some(row => row.send_as === '*'), defaultFrom: preferred && senderKind(data, actor, preferred) ? preferred : actor };
}
