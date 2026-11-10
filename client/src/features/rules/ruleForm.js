export const LIST_OPS = ['in', 'not_in', 'contains_any'];
export const NO_VALUE_OPS = ['exists', 'is_empty', 'is_not_empty'];

export const emptyRule = () => ({
  name: '',
  description: '',
  enabled: true,
  priority: 100,
  matchMode: 'all',
  conditions: [{ field: 'eventType', operator: 'equals', value: 'pull_request.opened' }],
  actions: { channelIds: [], priority: 'normal', stopProcessing: false, suppress: false },
});

/** Client-side validation mirroring the server schema, so users get immediate feedback. */
export function validateRule(rule, meta) {
  const errors = {};
  if (!rule.name.trim()) errors.name = 'Give the rule a name';
  rule.conditions.forEach((c, i) => {
    const type = meta.fields[c.field]?.type;
    if (!type) errors[`c${i}`] = 'Choose a field';
    else if (!meta.operators[type].includes(c.operator)) errors[`c${i}`] = 'Choose an operator';
    else if (NO_VALUE_OPS.includes(c.operator)) return;
    else if (LIST_OPS.includes(c.operator) && (!Array.isArray(c.value) || c.value.length === 0)) errors[`c${i}`] = 'Enter at least one value';
    else if (!LIST_OPS.includes(c.operator) && type !== 'boolean' && !String(c.value ?? '').trim()) errors[`c${i}`] = 'Enter a value';
  });
  if (!rule.actions.suppress && rule.actions.channelIds.length === 0) errors.channels = 'Choose at least one channel, or make this a mute rule';
  if (!Number.isInteger(Number(rule.priority)) || rule.priority < 1 || rule.priority > 10000) errors.priority = 'Priority must be between 1 and 10000';
  return errors;
}
