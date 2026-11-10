import { z } from 'zod';
import { forbidden, notFound, unauthorized } from '../shared/errors.js';

export const ROLE_RANK = { member: 1, admin: 2, owner: 3 };

const workspaceIdSchema = z.uuid();

/**
 * Authorizes access to /workspaces/:workspaceId/* routes. Membership is checked against the
 * database on every request; non-members get 404 so workspace IDs cannot be probed.
 */
export function requireWorkspace({ db }, minRole = 'member') {
  return async (req, _res, next) => {
    if (!req.user) return next(unauthorized());
    const parsed = workspaceIdSchema.safeParse(req.params.workspaceId);
    if (!parsed.success) return next(notFound('Workspace not found'));

    const row = await db('workspace_members as m')
      .join('workspaces as w', 'w.id', 'm.workspace_id')
      .where({ 'm.workspace_id': parsed.data, 'm.user_id': req.user.id })
      .first('w.*', 'm.role');
    if (!row) return next(notFound('Workspace not found'));
    if (ROLE_RANK[row.role] < ROLE_RANK[minRole]) {
      return next(forbidden(`This action requires the ${minRole} role`));
    }
    const { role, ...workspace } = row;
    req.workspace = workspace;
    req.membership = { role };
    next();
  };
}

/** Inline role check for handlers mounted under requireWorkspace(member). */
export function assertRole(req, minRole) {
  if (!req.membership || ROLE_RANK[req.membership.role] < ROLE_RANK[minRole]) {
    throw forbidden(`This action requires the ${minRole} role`);
  }
}
