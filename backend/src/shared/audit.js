import { logger, errSummary } from './logger.js';

/**
 * Records a sensitive administrative action. Audit failures are logged but never block the
 * action itself, because the action has already been committed when this runs.
 */
export async function audit(db, req, { workspaceId, action, targetType, targetId, metadata = {} }) {
  try {
    await db('audit_logs').insert({
      workspace_id: workspaceId ?? req?.workspace?.id ?? null,
      actor_user_id: req?.user?.id ?? null,
      action,
      target_type: targetType,
      target_id: targetId ? String(targetId) : null,
      metadata,
      ip: req?.ip?.slice(0, 64) ?? null,
    });
  } catch (err) {
    logger.error({ err: errSummary(err), action }, 'Failed to write audit log');
  }
}
