// Pure condition structure helpers, shared by importers, the model and browser.
const group = node => node && typeof node === 'object' && Object.hasOwn(node, 'conditions');
const failure = reason => { const error = new Error(reason); error.reason = reason; throw error; };

/** Checks stored normal form. Paths are relative to the supplied rule root. */
export function validateConditionTree(tree) {
  let leaves = 0;
  function visit(node, path, depth, parentMatch) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return { path, reason: 'group_shape' };
    if (!group(node)) {
      if (depth === 0 || Object.hasOwn(node, 'not')) return { path, reason: 'group_shape' };
      if (++leaves > 20) return { path, reason: 'group_shape' };
      return null;
    }
    const children = node.conditions;
    if (!['all', 'any'].includes(node.match) || !Array.isArray(children)
      || depth > 1 || children.length < (depth === 0 ? 1 : 2) || children.length > 10
      || node.match === parentMatch || (children.length === 1 && group(children[0]))
      || (depth > 0 && Object.keys(node).some(key => !['match', 'conditions'].includes(key)))) {
      return { path, reason: 'group_shape' };
    }
    for (const [i, child] of children.entries()) {
      const problem = visit(child, `${path}.conditions[${i}]`, depth + 1, node.match);
      if (problem) return problem;
    }
    return null;
  }
  return visit(tree, '$', 0);
}

/** Input adds {not:node}; output is always a root {match,conditions}. */
export function normalizeConditionTree(node) {
  function flatten(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) failure('group_shape');
    if (Object.hasOwn(value, 'not')) return { not: flatten(value.not) };
    if (!group(value)) return { ...value };
    if (!['all', 'any'].includes(value.match) || !Array.isArray(value.conditions) || !value.conditions.length) failure('group_shape');
    const children = value.conditions.map(flatten).flatMap(child => group(child) && child.match === value.match ? child.conditions : [child]);
    return children.length === 1 ? children[0] : { match: value.match, conditions: children };
  }
  function negate(value, inverted = false) {
    if (Object.hasOwn(value, 'not')) return negate(value.not, !inverted);
    if (group(value)) return {
      match: inverted ? (value.match === 'all' ? 'any' : 'all') : value.match,
      conditions: value.conditions.map(child => negate(child, inverted)),
    };
    if (!inverted) return value;
    if (value.field === 'to' || value.field === 'attachment' || !['has', 'not'].includes(value.op)) failure('negation');
    return { ...value, op: value.op === 'has' ? 'not' : 'has' };
  }
  const normalized = flatten(negate(flatten(node)));
  const tree = group(normalized) ? normalized : { match: 'all', conditions: [normalized] };
  const problem = validateConditionTree(tree);
  if (problem) failure(problem.reason);
  return tree;
}
