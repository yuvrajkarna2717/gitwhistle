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

router.get('/', authMiddleware, async (req:any, res) => {
  const notifications = await db('notifications').where({ user_id: req.user.id }).orderBy('created_at', 'desc').limit(100);
  res.json(notifications);
});

router.post('/:id/read', authMiddleware, async (req:any, res) => {
  const id = Number(req.params.id);
  await db('notifications').where({ id, user_id: req.user.id }).update({ read: true });
  res.json({ ok: true });
});

export default router;
