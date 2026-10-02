import { prisma } from '../src/config/database.js';
import { logger } from '../src/utils/logger.js';

/** Save one click taken from the queue (a JSON string pushed by the API). */
export async function saveClick(raw) {
  let click;
  try {
    click = JSON.parse(raw);
  } catch {
    logger.warn('Skipping malformed click');
    return;
  }

  try {
    await prisma.clickEvent.create({
      data: {
        urlId: click.urlId,
        clickedAt: new Date(click.clickedAt),
        referrer: click.referrer,
        userAgent: click.userAgent,
      },
    });
  } catch (err) {
    // e.g. the link was deleted after the click (foreign key): nothing to record.
    logger.warn({ urlId: click.urlId, reason: err.message }, 'Could not save click');
  }
}
