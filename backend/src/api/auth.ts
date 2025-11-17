import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import db from '../lib/knex';
const router = express.Router();

// Step 1: frontend sends code (after user authorizes app at GitHub OAuth)
router.post('/github/callback', async (req, res) => {
  const { code } = req.body;
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;

  const tokenRes = await axios.post('https://github.com/login/oauth/access_token', {
    client_id: clientId,
    client_secret: clientSecret,
    code
  }, { headers: { Accept: 'application/json' }});

  const access_token = tokenRes.data.access_token;
  // fetch user
  const userRes = await axios.get('https://api.github.com/user', {
    headers: { Authorization: `token ${access_token}` }
  });

  const gh = userRes.data;
  let user = await db('users').where({ github_id: String(gh.id) }).first();
  if (!user) {
    const [id] = await db('users').insert({
      github_id: String(gh.id),
      login: gh.login,
      name: gh.name,
      email: gh.email
    }).returning('id');
    user = { id };
  }

  const jwtToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: process.env.JWT_EXPIRES_IN } as jwt.SignOptions);
  res.json({ token: jwtToken });
});

export default router;
