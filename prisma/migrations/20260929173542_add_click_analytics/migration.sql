-- CreateTable
CREATE TABLE "click_events" (
    "id" BIGSERIAL NOT NULL,
    "event_id" UUID NOT NULL,
    "url_id" INTEGER NOT NULL,
    "clicked_at" TIMESTAMPTZ(6) NOT NULL,
    "ip_hash" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "browser" VARCHAR(32) NOT NULL,
    "referrer_host" VARCHAR(255),

    CONSTRAINT "click_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "url_daily_stats" (
    "url_id" INTEGER NOT NULL,
    "day" DATE NOT NULL,
    "clicks" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "url_daily_stats_pkey" PRIMARY KEY ("url_id","day")
);

-- CreateIndex
CREATE UNIQUE INDEX "click_events_event_id_key" ON "click_events"("event_id");

-- CreateIndex
CREATE INDEX "click_events_url_id_clicked_at_idx" ON "click_events"("url_id", "clicked_at");

-- AddForeignKey
ALTER TABLE "click_events" ADD CONSTRAINT "click_events_url_id_fkey" FOREIGN KEY ("url_id") REFERENCES "urls"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "url_daily_stats" ADD CONSTRAINT "url_daily_stats_url_id_fkey" FOREIGN KEY ("url_id") REFERENCES "urls"("id") ON DELETE CASCADE ON UPDATE CASCADE;
