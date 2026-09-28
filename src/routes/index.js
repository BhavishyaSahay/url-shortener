import { Router } from 'express';
import authRoutes from './auth.routes.js';
import urlRoutes from './url.routes.js';

// Version 1 of the public REST API, mounted at /api/v1.
// Versioning in the URL lets us ship breaking changes as /api/v2 later without
// breaking existing clients. Analytics (/urls/:id/analytics) is added in Phase 6.
const v1Router = Router();

v1Router.use('/auth', authRoutes);
v1Router.use('/urls', urlRoutes);

export default v1Router;
