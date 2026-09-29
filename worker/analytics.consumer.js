import { config } from '../src/config/env.js';
import { kafka } from '../src/config/kafka.js';
import { logger } from '../src/utils/logger.js';
import { parseClickEvent, storeClickEvents } from './analytics.processor.js';

/**
 * Create a Kafka consumer that feeds click events into PostgreSQL.
 * Separate from analytics.worker.js (the process entry point) so tests can
 * start and stop a consumer in-process.
 *
 * @param {object} [options]
 * @param {string} [options.groupId]  consumer group (tests use a unique one per run)
 * @param {boolean} [options.fromBeginning]  where a NEW group starts reading
 * @param {(err: Error) => void} [options.onCrash]  called when the consumer gives up
 */
export async function startClickConsumer({
  groupId = config.kafka.consumerGroup,
  fromBeginning = true,
  onCrash = (err) => logger.error({ err }, 'Click consumer crashed'),
} = {}) {
  const consumer = kafka.consumer({
    groupId,
    // If a member stops heartbeating for sessionTimeout (crashed, hung, network
    // cut), the group declares it dead and reassigns its partitions. A crashed
    // worker can't say goodbye, so this is also how long a restarted worker waits
    // before it gets the partitions back. Measured: 30 s at the kafkajs default.
    // 10 s recovers faster, at the cost of less tolerance for long GC pauses or
    // slow batches (kafkajs heartbeats between batches; we also heartbeat after each one).
    sessionTimeout: 10_000,
    heartbeatInterval: 3_000,
    // "Let it crash": retry transient errors a few times, but never let
    // kafkajs restart the consumer in-process. In testing, that internal
    // restart could hang forever after a broker restart ("coordinator is
    // loading"), silently leaving events unconsumed. Instead the worker exits
    // and its supervisor (Docker restart policy / ECS / Kubernetes) starts a
    // fresh process. That's safe because offsets are only committed after a
    // batch is stored, and storing is idempotent.
    retry: { retries: 5, initialRetryTime: 300, restartOnFailure: async () => false },
  });

  consumer.on(consumer.events.CRASH, ({ payload }) => {
    if (!payload.restart) onCrash(payload.error);
  });

  await consumer.connect();
  // fromBeginning only matters for a group with no committed offsets yet.
  // After that, the group always resumes from its last committed offset.
  await consumer.subscribe({ topic: config.kafka.clicksTopic, fromBeginning });

  await consumer.run({
    // eachBatch (not eachMessage): one DB transaction per batch of messages is
    // far cheaper than one per click.
    //
    // Offset handling (eachBatchAutoResolve, the default): if this function
    // returns, the whole batch is marked processed and its offsets are
    // committed. If it throws, nothing is committed and kafkajs retries the
    // batch (with backoff). That's at-least-once delivery, made safe by the
    // idempotent writes in storeClickEvents().
    eachBatch: async ({ batch, heartbeat }) => {
      const events = [];
      for (const message of batch.messages) {
        const event = parseClickEvent(message.value);
        if (event) {
          events.push(event);
        } else {
          // Poison message: skip it (its offset is still committed) instead of retrying forever.
          logger.warn({ partition: batch.partition, offset: message.offset }, 'Skipping malformed click event');
        }
      }

      const result = await storeClickEvents(events);
      await heartbeat(); // tell the group we're alive after (possibly slow) DB work

      logger.info(
        { partition: batch.partition, firstOffset: batch.firstOffset(), lastOffset: batch.lastOffset(), ...result },
        'Processed click batch',
      );
    },
  });

  return consumer;
}
