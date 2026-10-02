-- DropForeignKey
ALTER TABLE "url_daily_stats" DROP CONSTRAINT "url_daily_stats_url_id_fkey";

-- DropIndex
DROP INDEX "click_events_event_id_key";

-- AlterTable
ALTER TABLE "click_events" DROP COLUMN "browser",
DROP COLUMN "event_id",
DROP COLUMN "ip_hash",
DROP COLUMN "referrer_host",
ADD COLUMN     "referrer" VARCHAR(255);

-- DropTable
DROP TABLE "url_daily_stats";

