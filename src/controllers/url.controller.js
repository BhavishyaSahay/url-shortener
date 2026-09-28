import { config } from '../config/env.js';
import * as urlService from '../services/url.service.js';
import { getUrlStatus } from '../utils/expiration.js';
import {
  createUrlSchema,
  listUrlsQuerySchema,
  updateUrlSchema,
  urlIdParamsSchema,
  validate,
} from '../utils/validation.js';

// Shape of a URL in API responses. `status` is computed at read time rather
// than stored, so a link becomes "expired" exactly at expiresAt with no
// background job flipping a flag.
function toUrlResponse(url) {
  return {
    id: url.id,
    shortCode: url.shortCode,
    shortUrl: `${config.baseUrl}/${url.shortCode}`,
    originalUrl: url.originalUrl,
    isCustomAlias: url.isCustomAlias,
    isActive: url.isActive,
    expiresAt: url.expiresAt,
    status: getUrlStatus(url),
    createdAt: url.createdAt,
    updatedAt: url.updatedAt,
  };
}

export async function createUrl(req, res) {
  const input = validate(createUrlSchema, req.body);
  const url = await urlService.createUrl({
    userId: req.user.id,
    originalUrl: input.url,
    customAlias: input.customAlias,
    expiresAt: input.expiresAt,
  });
  res.status(201).location(`/api/v1/urls/${url.id}`).json({ url: toUrlResponse(url) });
}

export async function listUrls(req, res) {
  const { page, limit } = validate(listUrlsQuerySchema, req.query);
  const { urls, total } = await urlService.listUrls({ userId: req.user.id, page, limit });
  res.json({
    urls: urls.map(toUrlResponse),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
}

export async function getUrl(req, res) {
  const { id } = validate(urlIdParamsSchema, req.params);
  const url = await urlService.getUrl({ userId: req.user.id, id });
  res.json({ url: toUrlResponse(url) });
}

export async function updateUrl(req, res) {
  const { id } = validate(urlIdParamsSchema, req.params);
  const { url: originalUrl, ...rest } = validate(updateUrlSchema, req.body);
  const changes = { ...rest, ...(originalUrl !== undefined && { originalUrl }) };

  const url = await urlService.updateUrl({ userId: req.user.id, id, changes });
  res.json({ url: toUrlResponse(url) });
}

export async function deleteUrl(req, res) {
  const { id } = validate(urlIdParamsSchema, req.params);
  await urlService.deleteUrl({ userId: req.user.id, id });
  res.status(204).end();
}
