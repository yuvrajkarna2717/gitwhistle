import { describe, it, expect } from 'vitest';
import { evaluateRules, globToRegExp } from '../src/modules/rules/engine.js';
import { ruleSchema } from '../src/modules/rules/schema.js';
import { normalizeGitHubEvent } from '../src/modules/github/adapter.js';
import { prPayload, workflowRunPayload, issuePayload } from './helpers.js';

const CH_BACKEND = '11111111-1111-4111-8111-111111111111';
const CH_DEVOPS = '22222222-2222-4222-8222-222222222222';
const CH_DEFAULT = '33333333-3333-4333-8333-333333333333';
const CH_ONCALL = '44444444-4444-4444-8444-444444444444';

const rule = (id, conditions, actions, extra = {}) => ({
  id,
  name: id,
  enabled: true,
  priority: 100,
  matchMode: 'all',
  conditions,
  actions: { channelIds: [], priority: 'normal', stopProcessing: false, suppress: false, ...actions },
  createdAt: '2026-01-01T00:00:00Z',
  ...extra,
});

const withRepo = (e) => ({ ...e, repository: { ...e.repository, fullName: e.repository.fullName } });
const prOpened = withRepo(normalizeGitHubEvent('pull_request', prPayload('opened')));
const ciFailed = withRepo(normalizeGitHubEvent('workflow_run', workflowRunPayload('failure')));
const ciPassed = withRepo(normalizeGitHubEvent('workflow_run', workflowRunPayload('success')));
const criticalIssue = withRepo(normalizeGitHubEvent('issues', issuePayload('opened', { issue: { labels: [{ name: 'critical' }] } })));

const backendPrRule = rule('backend-pr', [
  { field: 'eventType', operator: 'equals', value: 'pull_request.opened' },
  { field: 'repository', operator: 'equals', value: 'acme/api' },
  { field: 'branch', operator: 'equals', value: 'main' },
], { channelIds: [CH_BACKEND] });
const ciFailureRule = rule('ci-failure', [
  { field: 'eventType', operator: 'equals', value: 'workflow_run.completed' },
  { field: 'workflowConclusion', operator: 'equals', value: 'failure' },
], { channelIds: [CH_DEVOPS], priority: 'high' });

describe('rule engine', () => {
  it('routes a matching PR to the configured channel', () => {
    const r = evaluateRules(prOpened, [backendPrRule, ciFailureRule]);
    expect(r.channels).toEqual([{ channelId: CH_BACKEND, ruleIds: ['backend-pr'] }]);
    expect(r.matchedRuleIds).toEqual(['backend-pr']);
    expect(r.priority).toBe('normal');
  });

  it('routes failed workflows with high priority and ignores successful ones', () => {
    expect(evaluateRules(ciFailed, [backendPrRule, ciFailureRule])).toMatchObject({ priority: 'high', channels: [{ channelId: CH_DEVOPS }] });
    expect(evaluateRules(ciPassed, [backendPrRule, ciFailureRule]).channels).toEqual([]);
  });

  it('does not match when any "all" condition fails, and does for "any"', () => {
    const other = { ...prOpened, metadata: { ...prOpened.metadata, baseBranch: 'develop' } };
    expect(evaluateRules(other, [backendPrRule]).channels).toEqual([]);
    expect(evaluateRules(other, [{ ...backendPrRule, matchMode: 'any' }]).channels).toHaveLength(1);
  });

  it('combines multiple matching rules and de-duplicates channels', () => {
    const allPrs = rule('all-prs', [{ field: 'eventType', operator: 'matches', value: 'pull_request.*' }], { channelIds: [CH_BACKEND, CH_ONCALL] }, { priority: 200 });
    const r = evaluateRules(prOpened, [backendPrRule, allPrs]);
    expect(r.channels).toEqual([
      { channelId: CH_BACKEND, ruleIds: ['backend-pr', 'all-prs'] },
      { channelId: CH_ONCALL, ruleIds: ['all-prs'] },
    ]);
  });

  it('honours priority order, stopProcessing, and suppress (mute) rules', () => {
    const stop = { ...backendPrRule, priority: 1, actions: { ...backendPrRule.actions, stopProcessing: true } };
    const later = rule('later', [], { channelIds: [CH_ONCALL] }, { priority: 50 });
    expect(evaluateRules(prOpened, [later, stop]).channels.map((c) => c.channelId)).toEqual([CH_BACKEND]);
    const mute = rule('mute-bob', [{ field: 'actor', operator: 'equals', value: 'BOB' }], { suppress: true }, { priority: 1 });
    const r = evaluateRules(prOpened, [backendPrRule, mute], { fallback: { enabled: true, channelId: CH_DEFAULT } });
    expect(r).toMatchObject({ suppressed: true, channels: [], usedFallback: false });
  });

  it('skips disabled rules and inactive channels', () => {
    expect(evaluateRules(prOpened, [{ ...backendPrRule, enabled: false }]).channels).toEqual([]);
    expect(evaluateRules(prOpened, [backendPrRule], { activeChannelIds: new Set([CH_DEVOPS]) }).channels).toEqual([]);
  });

  it('uses fallback routing only for notable events when nothing matched', () => {
    const fb = { fallback: { enabled: true, channelId: CH_DEFAULT } };
    expect(evaluateRules(prOpened, [], fb)).toMatchObject({ usedFallback: true, channels: [{ channelId: CH_DEFAULT }] });
    expect(evaluateRules(ciPassed, [], fb).channels).toEqual([]);
    expect(evaluateRules(withRepo(normalizeGitHubEvent('pull_request', prPayload('synchronize'))), [], fb).channels).toEqual([]);
    expect(evaluateRules(prOpened, [], { fallback: { enabled: false, channelId: CH_DEFAULT } }).channels).toEqual([]);
    expect(evaluateRules(prOpened, [ciFailureRule], fb).usedFallback).toBe(true);
  });

  it('matches labels and assignees with array operators', () => {
    const critical = rule('critical', [{ field: 'labels', operator: 'contains', value: 'Critical' }], { channelIds: [CH_ONCALL] });
    expect(evaluateRules(criticalIssue, [critical]).channels).toHaveLength(1);
    const unassigned = rule('unassigned', [{ field: 'assignees', operator: 'is_empty' }], { channelIds: [CH_ONCALL] });
    expect(evaluateRules(criticalIssue, [unassigned]).channels).toHaveLength(1);
  });

  it('is deterministic regardless of input order', () => {
    const a = rule('a', [], { channelIds: [CH_BACKEND] }, { priority: 10 });
    const b = rule('b', [], { channelIds: [CH_DEVOPS] }, { priority: 10, createdAt: '2026-02-01T00:00:00Z' });
    expect(evaluateRules(prOpened, [b, a])).toEqual(evaluateRules(prOpened, [a, b]));
  });

  it('compiles globs safely (regex metacharacters are literal)', () => {
    expect(globToRegExp('release/*').test('release/1.2')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
    expect(globToRegExp('(.*)+$').test('anything')).toBe(false);
  });
});

describe('rule schema validation', () => {
  const valid = { name: 'x', conditions: [{ field: 'eventType', operator: 'equals', value: 'push' }], actions: { channelIds: [CH_BACKEND] } };
  it('accepts a valid rule and applies defaults', () => {
    expect(ruleSchema.parse(valid)).toMatchObject({ enabled: true, priority: 100, matchMode: 'all' });
  });
  it.each([
    ['unknown field', { conditions: [{ field: 'payload.__proto__', operator: 'equals', value: 'x' }] }],
    ['operator not valid for field type', { conditions: [{ field: 'labels', operator: 'equals', value: 'x' }] }],
    ['list operator without list', { conditions: [{ field: 'actor', operator: 'in', value: 'bob' }] }],
    ['boolean field with text', { conditions: [{ field: 'draft', operator: 'equals', value: 'yes' }] }],
    ['no destination and not a mute rule', { actions: { channelIds: [] } }],
    ['non-uuid channel', { actions: { channelIds: ['#general'] } }],
  ])('rejects %s', (_label, patch) => {
    expect(ruleSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
  });
});
