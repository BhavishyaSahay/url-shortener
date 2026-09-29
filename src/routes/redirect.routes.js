import { Router } from 'express';
import * as redirectController from '../controllers/redirect.controller.js';

const router = Router();

// The public short link: GET /aB92x → 302 to the original URL.
// Mounted LAST in app.js: it matches any single-segment path, so /health,
// /ready and /api/* must be registered before it.
router.get('/:shortCode', redirectController.redirect);

export default router;
