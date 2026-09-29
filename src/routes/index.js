import { Router } from 'express';
import analyticsRoutes from './analytics.routes.js';
import authRoutes from './auth.routes.js';
import urlRoutes from './url.routes.js';

// Version 1 of the public REST API, mounted at /api/v1.
// Versioning in the URL lets us ship breaking changes as /api/v2 later without
// breaking existing clients.
const v1Router = Router();

v1Router.use('/auth', authRoutes);
v1Router.use('/urls', urlRoutes); // /urls, /urls/:id
v1Router.use('/urls', analyticsRoutes); // /urls/:id/analytics

export default v1Router;
