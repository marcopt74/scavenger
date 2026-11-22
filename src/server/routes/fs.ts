import { Hono } from 'hono';
import { DirectoryBrowseError, browseDirectory } from '../tools/dirBrowser.js';

export const fsRouter = new Hono();

fsRouter.get('/browse', async (c) => {
  const targetPath = c.req.query('path');
  const showHidden = c.req.query('showHidden') === 'true' || c.req.query('showHidden') === '1';
  const fallbackToNearestParent =
    c.req.query('fallback') === 'true' || c.req.query('fallback') === '1';

  try {
    const result = await browseDirectory({
      targetPath,
      showHidden,
      fallbackToNearestParent,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof DirectoryBrowseError) {
      return c.json({ error: err.message, code: err.code }, err.status);
    }
    const message = err instanceof Error ? err.message : 'Failed to browse directory.';
    return c.json({ error: message, code: 'READ_FAILED' }, 500);
  }
});
