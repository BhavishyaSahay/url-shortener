import { Router } from 'express';
import authRoutes from './auth.routes.js';

// Version 1 of the public REST API, mounted at /api/v1.
// Versioning in the URL lets us ship breaking changes as /api/v2 later without
// breaking existing clients. Feature routers are added here phase by phase:
//   Phase 4: /urls   Phase 6: /urls/:id/analytics
const v1Router = Router();

v1Router.use('/auth', authRoutes);

export default v1Router;
