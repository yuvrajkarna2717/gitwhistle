import { useState } from 'react';
import { Button, Field, Input, Notice, Select, Toggle } from '../../components/ui.jsx';
import { eventLabel } from '../../utils/format.js';
import { LIST_OPS, NO_VALUE_OPS, validateRule } from './ruleForm.js';

const OP_LABELS = {
  equals: 'is',
  not_equals: 'is not',
  in: 'is one of',
  not_in: 'is not one of',
  matches: 'matches pattern',
  not_matches: 'does not match pattern',
  exists: 'is set',
  contains: 'includes',
  not_contains: 'does not include',
  contains_any: 'includes any of',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
};
function ValueInput({ condition, fieldType, eventTypes, onChange }) {
  if (NO_VALUE_OPS.includes(condition.operator)) return <span className="self-center text-xs text-slate-400">no value needed</span>;
  if (fieldType === 'boolean') {
    return (
      <Select aria-label="Value" value={String(condition.value ?? true)} onChange={(e) => onChange(e.target.value === 'true')}>
        <option value="true">true</option>
        <option value="false">false</option>
      </Select>
    );
  }
  if (LIST_OPS.includes(condition.operator)) {
    return (
      <Input
        aria-label="Values (comma separated)"
        placeholder="comma, separated"
        value={(Array.isArray(condition.value) ? condition.value : []).join(', ')}
        onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))}
      />
    );
  }
  if (condition.field === 'eventType' && condition.operator === 'equals') {
    return (
      <Select aria-label="Value" value={condition.value || ''} onChange={(e) => onChange(e.target.value)}>
        {eventTypes.map((t) => (
          <option key={t} value={t}>
            {eventLabel(t)} ({t})
          </option>
        ))}
      </Select>
    );
  }
  return <Input aria-label="Value" value={typeof condition.value === 'string' ? condition.value : ''} onChange={(e) => onChange(e.target.value)} placeholder={condition.operator.includes('match') ? 'e.g. release/*' : ''} />;
}

export default function RuleEditor({ initial, meta, channels, onSave, onCancel, onPreview }) {
  const [rule, setRule] = useState(initial);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const [serverError, setServerError] = useState(null);
  const [preview, setPreview] = useState(null);
  const errors = submitted ? validateRule(rule, meta) : {};
  const set = (patch) => setRule((r) => ({ ...r, ...patch }));
  const setAction = (patch) => setRule((r) => ({ ...r, actions: { ...r.actions, ...patch } }));
  const setCondition = (i, patch) => setRule((r) => ({ ...r, conditions: r.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));

  const changeField = (i, field) => {
    const type = meta.fields[field].type;
    const operator = meta.operators[type][0];
    setCondition(i, { field, operator, value: type === 'boolean' ? true : field === 'eventType' ? meta.eventTypes[0] : '' });
  };

  const payload = () => ({ ...rule, priority: Number(rule.priority), description: rule.description || null });

  const save = async (e) => {
    e.preventDefault();
    setSubmitted(true);
    if (Object.keys(validateRule(rule, meta)).length) return;
    setPending(true);
    setServerError(null);
    try {
      await onSave(payload());
    } catch (err) {
      setServerError(err);
      setPending(false);
    }
  };

  const runPreview = async () => {
    setSubmitted(true);
    if (Object.keys(validateRule(rule, meta)).length) return;
    try {
      setPreview(await onPreview(payload()));
    } catch (err) {
      setServerError(err);
    }
  };

  return (
    <form onSubmit={save} className="space-y-5" noValidate>
      {serverError && (
        <Notice tone="error">
          {serverError.message}
          {serverError.details?.map?.((d) => (
            <div key={d.path} className="text-xs">
              {d.path}: {d.message}
            </div>
          ))}
        </Notice>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <Field label="Name" htmlFor="rule-name" error={errors.name}>
            <Input id="rule-name" value={rule.name} onChange={(e) => set({ name: e.target.value })} placeholder="Backend PRs to #backend-team" />
          </Field>
        </div>
        <Field label="Priority" htmlFor="rule-priority" hint="Lower numbers run first" error={errors.priority}>
          <Input id="rule-priority" type="number" min={1} max={10000} value={rule.priority} onChange={(e) => set({ priority: e.target.value === '' ? '' : Number(e.target.value) })} />
        </Field>
      </div>

      <div>
        <div className="mb-2 flex items-center gap-2 text-sm text-slate-700">
          When
          <Select aria-label="Match mode" value={rule.matchMode} onChange={(e) => set({ matchMode: e.target.value })} className="w-24">
            <option value="all">all</option>
            <option value="any">any</option>
          </Select>
          of these conditions match{rule.conditions.length === 0 && ' (no conditions: every event matches)'}:
        </div>
        <div className="space-y-2">
          {rule.conditions.map((c, i) => {
            const type = meta.fields[c.field]?.type;
            return (
              <div key={i}>
                <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1.4fr_auto]">
                  <Select aria-label="Field" value={c.field} onChange={(e) => changeField(i, e.target.value)}>
                    {Object.entries(meta.fields).map(([k, f]) => (
                      <option key={k} value={k}>
                        {f.label}
                      </option>
                    ))}
                  </Select>
                  <Select aria-label="Operator" value={c.operator} onChange={(e) => setCondition(i, { operator: e.target.value, value: LIST_OPS.includes(e.target.value) ? [] : type === 'boolean' ? true : '' })}>
                    {meta.operators[type].map((op) => (
                      <option key={op} value={op}>
                        {OP_LABELS[op] || op}
                      </option>
                    ))}
                  </Select>
                  <ValueInput condition={c} fieldType={type} eventTypes={meta.eventTypes} onChange={(value) => setCondition(i, { value })} />
                  <Button variant="ghost" size="sm" aria-label="Remove condition" onClick={() => set({ conditions: rule.conditions.filter((_, j) => j !== i) })}>
                    Remove
                  </Button>
                </div>
                {errors[`c${i}`] && <p className="mt-1 text-xs text-red-600">{errors[`c${i}`]}</p>}
              </div>
            );
          })}
        </div>
        {rule.conditions.length < 20 && (
          <Button variant="secondary" size="sm" className="mt-2" onClick={() => set({ conditions: [...rule.conditions, { field: 'repository', operator: 'equals', value: '' }] })}>
            + Add condition
          </Button>
        )}
      </div>

      <div className="space-y-3 rounded-md border border-slate-200 p-4">
        <div className="flex items-center gap-3 text-sm">
          <Toggle label="Mute matching events" checked={rule.actions.suppress} onChange={(v) => setAction({ suppress: v })} />
          <span>Mute rule: matching events send nothing (and stop later rules)</span>
        </div>
        {!rule.actions.suppress && (
          <>
            <Field label="Send to channels" error={errors.channels}>
              {channels.length === 0 ? (
                <p className="text-sm text-slate-500">No channels configured yet. Add Slack channels on the Integrations page.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {channels.map((ch) => {
                    const on = rule.actions.channelIds.includes(ch.id);
                    return (
                      <label key={ch.id} className={`flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-sm ring-1 ${on ? 'bg-indigo-50 text-indigo-700 ring-indigo-200' : 'text-slate-600 ring-slate-200'}`}>
                        <input
                          type="checkbox"
                          className="sr-only"
                          checked={on}
                          onChange={() => setAction({ channelIds: on ? rule.actions.channelIds.filter((id) => id !== ch.id) : [...rule.actions.channelIds, ch.id] })}
                        />
                        #{ch.name}
                      </label>
                    );
                  })}
                </div>
              )}
            </Field>
            <div className="flex flex-wrap gap-6 text-sm">
              <label className="flex items-center gap-2">
                <Toggle label="High priority" checked={rule.actions.priority === 'high'} onChange={(v) => setAction({ priority: v ? 'high' : 'normal' })} /> High priority
              </label>
              <label className="flex items-center gap-2">
                <Toggle label="Stop processing" checked={rule.actions.stopProcessing} onChange={(v) => setAction({ stopProcessing: v })} /> Stop evaluating later rules
              </label>
              <label className="flex items-center gap-2">
                <Toggle label="Enabled" checked={rule.enabled} onChange={(v) => set({ enabled: v })} /> Enabled
              </label>
            </div>
          </>
        )}
      </div>

      {preview && (
        <Notice tone="info">
          Matched {preview.matched} of the last {preview.evaluated} events.
          {preview.sample.slice(0, 5).map((s) => (
            <div key={s.id} className="text-xs">
              {s.eventType} · {s.repository} · {s.title}
            </div>
          ))}
        </Notice>
      )}

      <div className="flex gap-2">
        <Button type="submit" pending={pending}>
          Save rule
        </Button>
        <Button variant="secondary" onClick={runPreview}>
          Test against recent events
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
