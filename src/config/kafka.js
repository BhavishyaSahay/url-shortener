import { setTimeout as sleep } from 'node:timers/promises';
import { Kafka, Partitioners, logLevel } from 'kafkajs';
import { config } from './env.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Kafka client, shared by the API (producer) and the analytics worker (consumer)
// ---------------------------------------------------------------------------
// Vocabulary:
//   topic           a named, append-only log of messages ("url-clicks")
//   partition       a topic is split into N ordered logs, the unit of parallelism
//   producer        appends messages to a topic (the API, on every redirect)
//   consumer group  consumers sharing a group ID split the partitions between
//                   them; each message is processed by ONE member of the group
//   offset          a message's position in its partition; the group commits
//                   "processed up to offset X" so it can resume after a restart

// Route kafkajs's internal logs through our structured logger. During an
// outage kafkajs logs the same connection error many times per second, so
// identical messages are logged at most once every 30 s.
const KAFKAJS_TO_PINO = { [logLevel.ERROR]: 'error', [logLevel.WARN]: 'warn', [logLevel.INFO]: 'info', [logLevel.DEBUG]: 'debug' };
const LOG_THROTTLE_MS = 30_000;
const lastLoggedAt = new Map();
const logCreator = () => ({ level, log }) => {
  const { message, ...extra } = log;
  const now = Date.now();
  if (now - (lastLoggedAt.get(message) ?? 0) < LOG_THROTTLE_MS) return;
  lastLoggedAt.set(message, now);
  logger[KAFKAJS_TO_PINO[level] ?? 'info']({ kafka: { error: extra.error, broker: extra.broker, groupId: extra.groupId } }, `kafkajs: ${message}`);
};

export const kafka = new Kafka({
  clientId: config.kafka.clientId,
  brokers: config.kafka.brokers,
  logLevel: logLevel.WARN,
  logCreator,
  connectionTimeout: 3_000,
  requestTimeout: 5_000,
  // Fail reasonably fast: the redirect path never waits on these retries,
  // but pending sends still hold memory while they retry.
  retry: { retries: 3, initialRetryTime: 200 },
});

// ---------------------------------------------------------------------------
// Topic setup
// ---------------------------------------------------------------------------

/**
 * Create the click-events topic if it doesn't exist (idempotent). Run by the
 * worker at startup, retrying until Kafka is reachable. The broker has
 * auto-create disabled, so topics exist only because we created them on purpose.
 *
 * Partitions = maximum parallelism: with 3 partitions, up to 3 worker
 * instances in the same group can consume at once (a 4th would sit idle).
 */
export async function ensureClickTopic({ maxAttempts = 15 } = {}) {
  const admin = kafka.admin();
  for (let attempt = 1; ; attempt++) {
    try {
      await admin.connect();
      const created = await admin.createTopics({
        waitForLeaders: true,
        topics: [{ topic: config.kafka.clicksTopic, numPartitions: config.kafka.clicksPartitions, replicationFactor: 1 }],
      });
      logger.info({ topic: config.kafka.clicksTopic, created }, created ? 'Kafka topic created' : 'Kafka topic already exists');
      return;
    } catch (err) {
      if (attempt >= maxAttempts) throw new Error(`Kafka not reachable after ${attempt} attempts: ${err.message}`, { cause: err });
      const delayMs = Math.min(500 * 2 ** (attempt - 1), 5_000);
      logger.warn({ attempt, retryInMs: delayMs, reason: err.message }, 'Kafka not ready, retrying');
      await sleep(delayMs);
    } finally {
      await admin.disconnect().catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Producer (used by the API)
// ---------------------------------------------------------------------------

export const producer = kafka.producer({
  allowAutoTopicCreation: false,
  // Chosen explicitly: murmur2 hash of the message key, the same algorithm as
  // the Java client, so a given key maps to the same partition no matter which
  // client produced it.
  createPartitioner: Partitioners.DefaultPartitioner,
});

let producerConnected = false;
let lastSendFailedAt = 0;
let reconnectTimer = null;

/**
 * Connect the producer without blocking API startup. Like Redis, Kafka is
 * not required to serve redirects: if it's down we keep redirecting, drop the
 * click events, and keep retrying the connection in the background.
 */
export async function connectProducer() {
  try {
    await producer.connect();
    producerConnected = true;
    logger.info('Kafka producer connected');
  } catch (err) {
    logger.warn({ reason: err.message }, 'Kafka unavailable, click events will be dropped until it connects (retrying in 5 s)');
    reconnectTimer = setTimeout(connectProducer, 5_000);
    reconnectTimer.unref(); // never keep the process alive just to retry
  }
}

export async function disconnectProducer() {
  clearTimeout(reconnectTimer);
  if (!producerConnected) return;
  producerConnected = false;
  await producer.disconnect(); // flushes in-flight sends first
  logger.info('Kafka producer disconnected');
}

export const markSendSucceeded = () => {
  lastSendFailedAt = 0;
};
export const markSendFailed = () => {
  lastSendFailedAt = Date.now();
};

/**
 * Is the producer usable? Connected, and no send has failed in the last 30 s.
 * (kafkajs stays "connected" while the broker is down; failed sends are how we notice.)
 */
export const isProducerHealthy = () => producerConnected && Date.now() - lastSendFailedAt > 30_000;
export const isProducerConnected = () => producerConnected;
