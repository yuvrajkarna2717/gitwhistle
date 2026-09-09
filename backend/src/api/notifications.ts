import express from 'express';
import db from '../lib/knex';
const router = express.Router();

// middleware to authenticate (simple)
import jwt from 'jsonwebtoken';
function authMiddleware(req:any, res:any, next:any) {
  const auth = req.headers.authorization?.split(' ')[1];
  if (!auth) return res.status(401).send('unauth');
  try {
    const payload = jwt.verify(auth, process.env.JWT_SECRET as string) as any;
    req.user = { id: payload.userId };
    next();
  } catch (e) { res.status(401).send('invalid token'); }
}

router.get('/', async (req:any, res) => {
  const { repo, type, limit = 50 } = req.query;
  
  let query = db('notifications')
    .leftJoin('repositories', 'notifications.repo_id', 'repositories.id')
    .select('notifications.*', 'repositories.full_name as repo_name')
    .orderBy('notifications.created_at', 'desc');
    
  if (repo && repo !== 'all') {
    query = query.where('repositories.full_name', repo);
  }
  
  if (type && type !== 'all') {
    query = query.where('notifications.type', type);
  }
  
  const notifications = await query.limit(parseInt(limit));
  res.json(notifications);
});

// Get available repositories for filter
router.get('/repositories', async (req, res) => {
  const repos = await db('repositories')
    .where('enabled', true)
    .select('full_name')
    .orderBy('full_name');
  res.json(repos.map(r => r.full_name));
});

// Get available event types for filter
router.get('/types', async (req, res) => {
  const types = await db('notifications')
    .distinct('type')
    .orderBy('type');
  res.json(types.map(t => t.type));
});

router.post('/:id/read', authMiddleware, async (req:any, res) => {
  const id = Number(req.params.id);
  await db('notifications').where({ id, user_id: req.user.id }).update({ read: true });
  res.json({ ok: true });
});

export default router;
