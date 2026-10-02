import { Router } from 'express';
import authRoutes from './auth.routes.js';
import urlRoutes from './url.routes.js';

// Version 1 of the API, mounted at /api/v1 (a future /api/v2 wouldn't break old clients).
const v1Router = Router();
v1Router.use('/auth', authRoutes);
v1Router.use('/urls', urlRoutes);

export default v1Router;
