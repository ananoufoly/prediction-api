import express from 'express';
import os from 'os';
import { env } from './env.js';
import { healthRouter } from './routes/health.js';
import { adminRouter } from './routes/admin.js';
import { selectionsRouter } from './routes/selections.js';
import { liveRouter } from './routes/live.js';
import { bankrollRouter } from './routes/bankroll.js';
import { matchesRouter } from './routes/matches.js';
import { predictionRouter } from './prediction/routes.js';
// NOTE: internal node-cron schedulers were removed for the Render deployment —
// all scheduled work (ingest / features / predict / retrain) now runs as
// GitHub Actions workflows (.github/workflows/*). See render.yaml.

const app = express();

app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

app.use('/api', healthRouter);
app.use('/api', adminRouter);
app.use('/api', selectionsRouter);
app.use('/api', liveRouter);
app.use('/api', bankrollRouter);
app.use('/api', matchesRouter);
app.use('/api', predictionRouter);

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Scheduled jobs run via GitHub Actions, not in-process — the web service only
// serves the API.

const server = app.listen(env.PORT, '0.0.0.0', () => {
  const ifaces = os.networkInterfaces();
  const lines: string[] = [`  - http://localhost:${env.PORT}`];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        lines.push(`  - http://${addr.address}:${env.PORT}  (${name})`);
      }
    }
  }
  console.log(`\nServer listening on:\n${lines.join('\n')}\n`);
});

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  server.close(() => process.exit(0));
});
