-- Source video coming DOWN from the cloud onto this machine.
--
-- The mirror image of `media_uploads`, and separate from it for the same
-- reason: a multi-gigabyte transfer must not sit in the same queue as a title
-- change. One row per project, because a project has exactly one source.
--
-- `state` is the resting story of the file: 'none' (never asked for),
-- 'pending' (queued), 'downloading', 'done', 'failed'. The record survives a
-- restart so a half-finished download can be resumed or retried rather than
-- silently forgotten, and so the library can still say WHY it failed.
CREATE TABLE `media_downloads` (
	`project_id` text PRIMARY KEY NOT NULL,
	`owner_uid` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`media_id` text,
	`file_name` text DEFAULT '' NOT NULL,
	`bytes_total` integer DEFAULT 0 NOT NULL,
	`bytes_received` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `media_downloads_state_idx` ON `media_downloads` (`owner_uid`,`state`);
