import { Router } from 'express';
import * as authController from '../controllers/auth.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

// Responses here contain user data or set auth cookies: never let a browser
// or proxy cache them.
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

router.post('/register', authController.register);
router.post('/login', authController.login); // Redis rate limit added in Phase 5
router.post('/logout', authController.logout);
router.get('/me', requireAuth, authController.me);

export default router;
