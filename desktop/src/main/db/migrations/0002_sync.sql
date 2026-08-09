-- Local-first sync: durable outbox, per-record sync state, tombstones, and the
-- media/export upload queues.
--
-- NOTE ON PROVENANCE. This file is the drizzle-kit output for the new schema
-- with three statements REMOVED by hand:
--   ALTER TABLE `projects` ADD `cloud_project_id`
--   ALTER TABLE `media`    ADD `owned`
--   ALTER TABLE `exports`  ADD `project_title`
-- plus the duplicate `projects_cloud_id_idx`. drizzle re-emitted them because
-- `0001_cloud_link.sql` was hand-written and never entered meta/_journal.json,
-- so the generator's baseline was one migration behind reality. Every existing
-- install has those columns already, and re-adding them fails the whole
-- migration with "duplicate column name". The journal + snapshot have since
-- been realigned to this file, so the next `npm run db:generate` diffs against
-- the truth.

CREATE TABLE `sync_outbox` (
	`op_id` text PRIMARY KEY NOT NULL,
	`owner_uid` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`base_rev` integer DEFAULT 0 NOT NULL,
	`device_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`last_error` text
);
--> statement-breakpoint
CREATE INDEX `outbox_claim_idx` ON `sync_outbox` (`owner_uid`,`state`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `outbox_entity_idx` ON `sync_outbox` (`entity`,`entity_id`);--> statement-breakpoint
CREATE TABLE `tombstones` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`owner_uid` text,
	`deleted_at` integer NOT NULL,
	`device_id` text NOT NULL,
	`synced` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tombstones_entity_idx` ON `tombstones` (`entity`,`entity_id`);--> statement-breakpoint
CREATE TABLE `media_uploads` (
	`media_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`owner_uid` text NOT NULL,
	`state` text DEFAULT 'local' NOT NULL,
	`checksum_sha256` text,
	`bytes_total` integer DEFAULT 0 NOT NULL,
	`bytes_sent` integer DEFAULT 0 NOT NULL,
	`storage_path` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `media_uploads_state_idx` ON `media_uploads` (`owner_uid`,`state`);--> statement-breakpoint
CREATE TABLE `export_uploads` (
	`output_id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`owner_uid` text NOT NULL,
	`export_doc_id` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`storage_path` text,
	`checksum_sha256` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `export_uploads_state_idx` ON `export_uploads` (`owner_uid`,`state`);--> statement-breakpoint
ALTER TABLE `projects` ADD `owner_uid` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `sync_state` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `base_doc` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `base_rev` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `remote_updated_at` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `last_synced_at` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `last_error` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `conflicts` text;--> statement-breakpoint
CREATE INDEX `projects_sync_idx` ON `projects` (`owner_uid`,`sync_state`);
