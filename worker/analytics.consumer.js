import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../src/config/env.js';
import { createBlockingRedisClient } from '../src/config/redis.js';
import { logger } from '../src/utils/logger.js';
import { parseClickEvent, storeClickEvents } from './analytics.processor.js';

// ---------------------------------------------------------------------------
// Redis Streams consumer
// ---------------------------------------------------------------------------
// Vocabulary:
//   stream          an append-only log of entries ("url-clicks"); each entry has an
//                   ID like 1727700000000-0 (milliseconds-sequence) and fields
//   consumer group  workers sharing a group split the entries: each entry is
//                   delivered to ONE consumer in the group
//   pending entries entries delivered to a consumer but not yet acknowledged
//   list (PEL)      (XACK). If the consumer crashes, they stay pending, nothing is lost
//   XAUTOCLAIM      take over entries that have been pending too long on another
//                   consumer, presumably dead: the Streams version of a rebalance

const DEFAULTS = {
  batchSize: 100,
  blockMs: 2_000, // how long one XREADGROUP waits for new entries (also bounds shutdown time)
  claimIdleMs: 60_000, // an entry pending this long on some consumer is considered abandoned
  claimEveryMs: 30_000, // how often to look for abandoned entries
  maxDeliveries: 5, // after this many failed attempts an entry goes to the dead-letter stream
  retryBaseMs: 1_000, // first backoff after a failed batch (doubles, max 30 s)
};

/**
 * Turn XREADGROUP / XAUTOCLAIM entries into { id, event } objects. `event` is
 * null for malformed entries (poison messages) and for entries whose data was
 * already trimmed from the stream.
 *   entries: [ ['1727700000000-0', ['event', '{"eventId":…}']], … ]
 */
export function parseStreamEntries(entries) {
  return entries.filter(Boolean).map(([id, fields]) => {
    const index = fields ? fields.indexOf('event') : -1;
    return { id, event: index >= 0 ? parseClickEvent(fields[index + 1]) : null };
  });
}

/**
 * Create the consumer group if it doesn't exist (idempotent).
 * Start ID '0' means a NEW group processes everything already in the stream
 * (like Kafka's fromBeginning); after that the group remembers its position.
 * MKSTREAM creates the stream too if no event has been published yet.
 */
export async function ensureConsumerGroup(client, stream, group) {
  try {
    await client.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
    logger.info({ stream, group }, 'Created consumer group');
  } catch (err) {
    if (!String(err.message).includes('BUSYGROUP')) throw err; // BUSYGROUP = already exists
  }
}

/**
 * Start consuming click events. Returns { stop, getStatus }.
 * Options exist so tests can use tiny timeouts or a failing `store`.
 */
export async function startClickConsumer(options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const stream = opts.stream ?? config.clicks.stream;
  const group = opts.group ?? config.clicks.consumerGroup;
  // Unique per process: in Docker the hostname is the container ID.
  const consumer = opts.consumerName ?? `${os.hostname()}-${process.pid}`;
  const store = opts.store ?? storeClickEvents;
  const deadLetterStream = `${stream}:dead-letter`;

  const client = createBlockingRedisClient();
  // If Redis is down, connect() rejects but ioredis keeps reconnecting in the
  // background, and commands wait for it (maxRetriesPerRequest: null). So the
  // worker simply waits for Redis instead of crashing.
  client.connect().catch(() => {});
  await ensureConsumerGroup(client, stream, group);

  const status = { consuming: true, lastBatchAt: null, consecutiveFailures: 0 };
  let running = true;
  let lastClaimAt = 0;

  async function read(id, blockMs) {
    const args = ['GROUP', group, consumer, 'COUNT', opts.batchSize];
    if (blockMs) args.push('BLOCK', blockMs);
    args.push('STREAMS', stream, id);
    const response = await client.xreadgroup(...args);
    return response ? response[0][1] : [];
  }

  // Entries that keep failing (e.g. a DB error caused by one specific event)
  // would otherwise be retried forever and block everything behind them.
  // After maxDeliveries attempts they're moved to a dead-letter stream for a
  // human to inspect, then acknowledged.
  async function deadLetterExhausted(entries) {
    const pending = await client.xpending(stream, group, '-', '+', opts.batchSize, consumer);
    const exhausted = new Set(pending.filter(([, , , deliveries]) => deliveries > opts.maxDeliveries).map(([id]) => id));
    if (exhausted.size === 0) return entries;

    for (const [id, fields] of entries.filter(([entryId]) => exhausted.has(entryId))) {
      await client.xadd(deadLetterStream, 'MAXLEN', '~', 10_000, '*', 'originalId', id, ...(fields ?? ['event', '']));
      await client.xack(stream, group, id);
      logger.error({ id, deadLetterStream, maxDeliveries: opts.maxDeliveries }, 'Click event moved to dead-letter stream');
    }
    return entries.filter(([id]) => !exhausted.has(id));
  }

  async function processEntries(entries) {
    const parsed = parseStreamEntries(entries);
    const valid = parsed.filter((e) => e.event);
    for (const bad of parsed.filter((e) => !e.event)) {
      // Poison message: acknowledged below with the rest, so it isn't retried forever.
      logger.warn({ id: bad.id }, 'Skipping malformed click event');
    }

    // Throws on DB failure → no XACK → the entries stay pending and are retried.
    const result = await store(valid.map((e) => e.event));

    // Acknowledge only AFTER the database commit (at-least-once). Then delete
    // the entries: with a single consumer group, a processed entry is no longer
    // needed, so the stream stays small and MAXLEN only matters while the worker is down.
    const ids = parsed.map((e) => e.id);
    await client.multi().xack(stream, group, ...ids).xdel(stream, ...ids).exec();

    status.lastBatchAt = new Date().toISOString();
    logger.info({ firstId: ids[0], lastId: ids.at(-1), malformed: parsed.length - valid.length, ...result }, 'Processed click batch');
  }

  const loop = (async () => {
    while (running) {
      try {
        // 1. Take over entries abandoned by consumers that died.
        if (Date.now() - lastClaimAt > opts.claimEveryMs) {
          lastClaimAt = Date.now();
          const [, claimed] = await client.xautoclaim(stream, group, consumer, opts.claimIdleMs, '0-0', 'COUNT', opts.batchSize);
          if (claimed.length > 0) logger.warn({ count: claimed.length }, 'Claimed click events abandoned by another consumer');
        }

        // 2. Our own pending entries first (an earlier failed batch, or claimed ones)...
        let entries = await deadLetterExhausted(await read('0'));
        // 3. ...then new ones, waiting up to blockMs for something to arrive.
        if (entries.length === 0 && running) entries = await read('>', opts.blockMs);
        if (entries.length === 0) continue;

        await processEntries(entries);
        status.consecutiveFailures = 0;
      } catch (err) {
        if (!running) break;
        status.consecutiveFailures++;
        const delayMs = Math.min(opts.retryBaseMs * 2 ** (status.consecutiveFailures - 1), 30_000);
        logger.error({ err, retryInMs: delayMs, failures: status.consecutiveFailures }, 'Click batch failed; entries stay pending and will be retried');
        await sleep(delayMs);
      }
    }
  })();

  logger.info({ stream, group, consumer }, 'Click consumer started');

  return {
    getStatus: () => ({ ...status }),
    // Graceful stop: finish the current batch (a blocking read returns within
    // blockMs), then close the connection. Unacknowledged entries stay pending
    // for the next run, so nothing is lost.
    async stop() {
      running = false;
      status.consuming = false;
      await loop;
      await client.quit().catch(() => client.disconnect());
    },
  };
}
