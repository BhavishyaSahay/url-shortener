import { Router } from 'express';

// Version 1 of the public REST API, mounted at /api/v1.
// Versioning in the URL lets us ship breaking changes as /api/v2 later without
// breaking existing clients. Feature routers are added here phase by phase:
//   Phase 3: /auth   Phase 4: /urls   Phase 6: /urls/:id/analytics
const v1Router = Router();

export default v1Router;
