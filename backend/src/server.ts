import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
dotenv.config();

import authRoutes from './api/auth';
import webhookRoutes from './api/webhooks';
import notificationsRoutes from './api/notifications';
import installationsRoutes from './api/installations';
import statusRoutes from './api/status';
import { initQueues } from './jobs';

const app = express();
app.use(helmet());
app.use(cors({ 
  origin: ['http://localhost:5173', 'http://localhost:3000'], 
  credentials: true 
}));
app.use(express.json());
app.use(cookieParser());

app.use('/api/auth', authRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/installations', installationsRoutes);
app.use('/api/status', statusRoutes);

const PORT = process.env.PORT || 4000;

(async function start() {
  await initQueues(); // setup connections to Redis queues
  app.listen(PORT, () => console.log(`Server running on ${PORT}`));
})();
