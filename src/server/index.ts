import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { HealthInfo } from '../shared/types.js';
import { warmAgyStatusCheck } from './agyAuth.js';
import { DEFAULT_MODELS, getConfiguredProviders, getDefaultProviderSelection } from './config.js';
import { chatRouter } from './routes/chat.js';
import { fsRouter } from './routes/fs.js';
import { sessionsRouter } from './routes/sessions.js';
import { settingsRouter } from './routes/settings.js';
import { visualsRouter } from './routes/visuals.js';
import { checkD2Available, isImageGenConfigured } from './tools/visualTools.js';

export function createApp(): Hono {
  const app = new Hono();

  app.use('/api/*', cors());

  app.get('/api/health', async (c) => {
    const selection = getDefaultProviderSelection();
    const health: HealthInfo = {
      ok: true,
      defaultProvider: selection.provider,
      defaultModel: selection.model || DEFAULT_MODELS[selection.provider],
      defaultBaseUrl: selection.baseUrl,
      configuredProviders: getConfiguredProviders(),
      d2Available: await checkD2Available(),
      imageGenAvailable: isImageGenConfigured(),
      suggestedRepoPath: process.cwd(),
    };
    return c.json(health);
  });

  app.route('/api/sessions', sessionsRouter);
  app.route('/api/sessions', chatRouter);
  app.route('/api/render', visualsRouter);
  app.route('/api/fs', fsRouter);
  app.route('/api/settings', settingsRouter);

  // Serve built client assets in production if dist/client exists
  const clientDist = path.resolve(process.cwd(), 'dist/client');
  if (fs.existsSync(clientDist)) {
    app.use('/*', serveStatic({ root: './dist/client' }));
    app.get('*', serveStatic({ path: './dist/client/index.html' }));
  }

  return app;
}

const isDirectExecution =
  process.argv[1] &&
  (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'));

if (isDirectExecution) {
  const port = Number(process.env.PORT || 3001);
  const app = createApp();
  warmAgyStatusCheck();
  const selection = getDefaultProviderSelection();
  serve({ fetch: app.fetch, port }, () => {
    console.log(
      `[scavenger] Server listening on http://localhost:${port} (provider: ${selection.provider}, model: ${selection.model})`
    );
  });
}
