import { config } from '../config/env.js';
import * as analyticsService from '../services/analytics.service.js';
import * as urlService from '../services/url.service.js';
import { getUrlStatus } from '../utils/expiration.js';
import { createUrlSchema, idParamsSchema, paginationSchema, updateUrlSchema, validate } from '../utils/validation.js';

const toResponse = (url) => ({
  id: url.id,
  shortCode: url.shortCode,
  shortUrl: `${config.baseUrl}/${url.shortCode}`,
  originalUrl: url.originalUrl,
  isCustomAlias: url.isCustomAlias,
  isActive: url.isActive,
  expiresAt: url.expiresAt,
  status: getUrlStatus(url),
  createdAt: url.createdAt,
});

export async function createUrl(req, res) {
  const { url, customAlias, expiresAt } = validate(createUrlSchema, req.body);
  const created = await urlService.createUrl({ userId: req.user.id, originalUrl: url, customAlias, expiresAt });
  res.status(201).json({ url: toResponse(created) });
}

export async function listUrls(req, res) {
  const { page, limit } = validate(paginationSchema, req.query);
  const { urls, total } = await urlService.listUrls({ userId: req.user.id, page, limit });
  res.json({ urls: urls.map(toResponse), pagination: { page, limit, total } });
}

export async function getUrl(req, res) {
  const { id } = validate(idParamsSchema, req.params);
  res.json({ url: toResponse(await urlService.getUrl({ userId: req.user.id, id })) });
}

export async function updateUrl(req, res) {
  const { id } = validate(idParamsSchema, req.params);
  const { url, ...rest } = validate(updateUrlSchema, req.body);
  const changes = url === undefined ? rest : { ...rest, originalUrl: url };
  res.json({ url: toResponse(await urlService.updateUrl({ userId: req.user.id, id, changes })) });
}

export async function deleteUrl(req, res) {
  const { id } = validate(idParamsSchema, req.params);
  await urlService.deleteUrl({ userId: req.user.id, id });
  res.status(204).end();
}

export async function getAnalytics(req, res) {
  const { id } = validate(idParamsSchema, req.params);
  res.json(await analyticsService.getAnalytics({ userId: req.user.id, id }));
}
