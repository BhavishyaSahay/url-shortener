import { Router } from 'express';
import * as analyticsController from '../controllers/analytics.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

router.use(requireAuth);

// GET /api/v1/urls/:id/analytics?days=30 (owner only)
router.get('/:id/analytics', analyticsController.getUrlAnalytics);

export default router;
