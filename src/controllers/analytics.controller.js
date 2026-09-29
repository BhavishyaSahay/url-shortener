import * as analyticsService from '../services/analytics.service.js';
import { analyticsQuerySchema, urlIdParamsSchema, validate } from '../utils/validation.js';

export async function getUrlAnalytics(req, res) {
  const { id } = validate(urlIdParamsSchema, req.params);
  const { days } = validate(analyticsQuerySchema, req.query);

  const analytics = await analyticsService.getUrlAnalytics({ userId: req.user.id, id, days });
  res.json(analytics);
}
