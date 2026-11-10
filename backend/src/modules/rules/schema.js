import { z } from 'zod';

/**
 * Declarative rule schema. Rules are data, never code: there is no eval and no user-supplied
 * regular expressions (glob patterns are compiled with every regex metacharacter escaped).
 */
export const RULE_FIELDS = {
  eventType: { type: 'string', label: 'Event type' },
  repository: { type: 'string', label: 'Repository (owner/name)' },
  branch: { type: 'string', label: 'Branch (PR base, push, workflow, deployment)' },
  headBranch: { type: 'string', label: 'PR head branch' },
  actor: { type: 'string', label: 'Actor (GitHub login)' },
  author: { type: 'string', label: 'PR / issue author' },
  prState: { type: 'string', label: 'PR state (open, closed, merged)' },
  draft: { type: 'boolean', label: 'PR is draft' },
  reviewState: { type: 'string', label: 'Review state (approved, changes_requested, commented, dismissed)' },
  workflowName: { type: 'string', label: 'Workflow name' },
  workflowConclusion: { type: 'string', label: 'Workflow conclusion (success, failure, cancelled, timed_out…)' },
  labels: { type: 'array', label: 'Issue / PR labels' },
  assignees: { type: 'array', label: 'Issue assignees' },
  environment: { type: 'string', label: 'Deployment environment' },
  deploymentState: { type: 'string', label: 'Deployment status (success, failure, error…)' },
};

export const OPERATORS = {
  string: ['equals', 'not_equals', 'in', 'not_in', 'matches', 'not_matches', 'exists'],
  boolean: ['equals', 'exists'],
  array: ['contains', 'not_contains', 'contains_any', 'is_empty', 'is_not_empty'],
};

const valueSchema = z.union([z.string().max(200), z.boolean(), z.array(z.string().max(200)).max(50)]);

export const conditionSchema = z
  .object({
    field: z.enum(Object.keys(RULE_FIELDS)),
    operator: z.string(),
    value: valueSchema.optional(),
  })
  .superRefine((c, ctx) => {
    const fieldType = RULE_FIELDS[c.field].type;
    if (!OPERATORS[fieldType].includes(c.operator)) {
      ctx.addIssue({ code: 'custom', message: `Operator "${c.operator}" is not valid for field "${c.field}"` });
      return;
    }
    const needsList = ['in', 'not_in', 'contains_any'].includes(c.operator);
    const noValue = ['exists', 'is_empty', 'is_not_empty'].includes(c.operator);
    if (noValue) return;
    if (needsList && (!Array.isArray(c.value) || c.value.length === 0)) {
      ctx.addIssue({ code: 'custom', message: `Operator "${c.operator}" requires a non-empty list` });
    } else if (!needsList && fieldType === 'boolean' && typeof c.value !== 'boolean') {
      ctx.addIssue({ code: 'custom', message: `Field "${c.field}" requires true or false` });
    } else if (!needsList && fieldType !== 'boolean' && (typeof c.value !== 'string' || !c.value.length)) {
      ctx.addIssue({ code: 'custom', message: `Operator "${c.operator}" requires a text value` });
    }
  });

export const actionsSchema = z
  .object({
    channelIds: z.array(z.uuid()).max(10).default([]),
    priority: z.enum(['normal', 'high']).default('normal'),
    stopProcessing: z.boolean().default(false),
    suppress: z.boolean().default(false),
  })
  .refine((a) => a.suppress || a.channelIds.length > 0, { message: 'Choose at least one channel, or mark the rule as a mute rule' });

export const ruleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(1).max(10_000).default(100),
  matchMode: z.enum(['all', 'any']).default('all'),
  conditions: z.array(conditionSchema).max(20).default([]),
  actions: actionsSchema,
});

export const ruleUpdateSchema = ruleSchema.partial().extend({ actions: actionsSchema.optional() });
