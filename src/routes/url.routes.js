import { Router } from 'express';
import * as urlController from '../controllers/url.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

// Every URL-management endpoint requires a logged-in user.
router.use(requireAuth);

router.post('/', urlController.createUrl); // Redis rate limit added in Phase 5
router.get('/', urlController.listUrls);
router.get('/:id', urlController.getUrl);
router.patch('/:id', urlController.updateUrl);
router.delete('/:id', urlController.deleteUrl);

export default router;
