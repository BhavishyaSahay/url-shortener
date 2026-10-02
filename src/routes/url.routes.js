import { Router } from 'express';
import * as urls from '../controllers/url.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import { createUrlRateLimit } from '../middleware/rateLimiter.middleware.js';

const router = Router();

router.use(requireAuth); // every URL endpoint needs a logged-in user

router.post('/', createUrlRateLimit, urls.createUrl);
router.get('/', urls.listUrls);
router.get('/:id', urls.getUrl);
router.patch('/:id', urls.updateUrl);
router.delete('/:id', urls.deleteUrl);
router.get('/:id/analytics', urls.getAnalytics);

export default router;
