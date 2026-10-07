CREATE TYPE "public"."system_notification_kind" AS ENUM('failure', 'weekly_digest');--> statement-breakpoint
CREATE TYPE "public"."system_notification_status" AS ENUM('pending', 'sent', 'failed', 'not_configured', 'skipped');--> statement-breakpoint
CREATE TABLE "system_notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"monitor_id" uuid,
	"kind" "system_notification_kind" NOT NULL,
	"dedupe_key" text NOT NULL,
	"recipient_email" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "system_notification_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"provider_message_id" text,
	"last_error_code" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "system_notification_outbox" ADD CONSTRAINT "system_notification_outbox_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_notification_outbox" ADD CONSTRAINT "system_notification_outbox_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "system_notification_outbox_dedupe_unique" ON "system_notification_outbox" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "system_notification_outbox_pending_idx" ON "system_notification_outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "system_notification_outbox_user_idx" ON "system_notification_outbox" USING btree ("user_id","created_at");