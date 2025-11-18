import express from 'express';
import axios from 'axios';
import jwt from 'jsonwebtoken';
import db from '../lib/knex';
import { authenticateToken, AuthRequest } from '../middleware/auth';
const router = express.Router();

// GitHub OAuth redirect
router.get('/github', (req, res) => {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const redirectUri = `http://localhost:4000/api/auth/github/callback`;
  const scope = 'user:email';
  
  console.log('OAuth redirect:', { clientId, redirectUri });
  const githubAuthUrl = `https://github.com/login/oauth/authorize?client_id=${clientId}&redirect_uri=${redirectUri}&scope=${scope}`;
  res.redirect(githubAuthUrl);
});

// Handle GitHub OAuth callback
router.get('/github/callback', async (req, res) => {
  const { code } = req.query;
  
  if (!code) {
    return res.redirect(`${process.env.CLIENT_URL}/?error=no_code`);
  }
  
  try {
    const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
    const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;

    const tokenRes = await axios.post('https://github.com/login/oauth/access_token', {
      client_id: clientId,
      client_secret: clientSecret,
      code
    }, { headers: { Accept: 'application/json' }});

    const access_token = tokenRes.data.access_token;
    const userRes = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `token ${access_token}` }
    });
    
    // Fetch user emails separately
    const emailRes = await axios.get('https://api.github.com/user/emails', {
      headers: { Authorization: `token ${access_token}` }
    });
    
    const gh = userRes.data;
    const primaryEmail = emailRes.data.find(email => email.primary)?.email || gh.email;
    let user = await db('users').where({ github_id: String(gh.id) }).first();
    if (!user) {
      const [id] = await db('users').insert({
        github_id: String(gh.id),
        login: gh.login,
        name: gh.name,
        email: primaryEmail
      }).returning('id');
      user = { id };
    }

    const jwtToken = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: process.env.JWT_EXPIRES_IN } as jwt.SignOptions);
    res.redirect(`${process.env.CLIENT_URL}/?token=${jwtToken}`);
  } catch (error) {
    console.error('OAuth error:', error);
    res.redirect(`${process.env.CLIENT_URL}/?error=auth_failed`);
  }
});

// Get current user
router.get('/me', authenticateToken, (req: AuthRequest, res) => {
  res.json({ user: req.user });
});

export default router;
