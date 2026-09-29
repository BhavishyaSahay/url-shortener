import { createHash, createHmac, randomUUID } from 'node:crypto';
import { config } from '../config/env.js';
import { isProducerConnected, markSendFailed, markSendSucceeded, producer } from '../config/kafka.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Building click events
// ---------------------------------------------------------------------------

// IPs are personal data. We store an HMAC of the IP, not the IP itself.
// A plain SHA-256 would NOT be enough: there are only ~4 billion IPv4
// addresses, so an attacker could hash them all and reverse any hash in
// minutes. The HMAC key is derived from JWT_SECRET, so without the secret
// the hashes can't be reversed. They still let us count unique visitors.
let ipHashKey;
function hashIp(ip) {
  if (!ip) return null;
  ipHashKey ??= createHash('sha256').update(`ip-hash:${config.auth.jwtSecret}`).digest();
  return createHmac('sha256', ipHashKey).update(ip).digest('hex').slice(0, 32);
}

const truncate = (value, max) => (typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null);

/**
 * The event published to Kafka for every successful redirect.
 * eventId is unique per click; the worker uses it to ignore duplicate deliveries.
 */
export function buildClickEvent({ url, shortCode, ip, userAgent, referrer, now = new Date() }) {
  return {
    eventId: randomUUID(),
    urlId: url.id,
    shortCode,
    timestamp: now.toISOString(),
    ipHash: hashIp(ip),
    userAgent: truncate(userAgent, 512),
    referrer: truncate(referrer, 2048),
  };
}

// ---------------------------------------------------------------------------
// Publishing: fire-and-forget
// ---------------------------------------------------------------------------

// Backpressure: if Kafka is slow or down, sends pile up while they retry.
// Beyond this many in flight, new events are dropped instead of letting
// memory grow without bound.
const MAX_IN_FLIGHT = 1_000;
let inFlight = 0;
let droppedSinceLastLog = 0;

function drop(reason) {
  droppedSinceLastLog++;
  // One summary line per 1000 drops, instead of one line per click.
  if (droppedSinceLastLog % 1000 === 1) {
    logger.warn({ reason, dropped: droppedSinceLastLog }, 'Dropping click events');
  }
}

/**
 * Publish a click event WITHOUT making the redirect wait. The caller doesn't
 * await this: the user already has their 302 by the time Kafka answers.
 * It never throws; failures are logged and the event is dropped.
 * (Analytics are "best effort": losing a few clicks during a Kafka outage
 * is acceptable, slowing down or breaking redirects is not.)
 *
 * @returns {Promise<boolean>} resolves true if Kafka acknowledged the event (awaited only in tests)
 */
export async function publishClickEvent(event) {
  if (!isProducerConnected()) {
    drop('producer not connected');
    return false;
  }
  if (inFlight >= MAX_IN_FLIGHT) {
    drop('too many events in flight');
    return false;
  }

  inFlight++;
  try {
    await producer.send({
      topic: config.kafka.clicksTopic,
      // The KEY decides the partition (hash(key) % partitions). Using the short
      // code means all clicks for one link land in the same partition, in order,
      // handled by one worker, so two workers never update the same link's
      // daily counter at the same time.
      messages: [{ key: event.shortCode, value: JSON.stringify(event) }],
    });
    markSendSucceeded();
    droppedSinceLastLog = 0;
    return true;
  } catch (err) {
    markSendFailed();
    drop(err.message);
    return false;
  } finally {
    inFlight--;
  }
}
