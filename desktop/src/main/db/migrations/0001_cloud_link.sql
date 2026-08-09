-- Links a local project to the Firestore document it corresponds to, so a
-- project that exists in both places is shown ONCE in the library (see
-- src/lib/projects/useProjectLibrary.ts). NULL means "local only", which is
-- every row that existed before this migration.
ALTER TABLE `projects` ADD `cloud_project_id` text;--> statement-breakpoint
CREATE INDEX `projects_cloud_id_idx` ON `projects` (`cloud_project_id`);--> statement-breakpoint
-- Recordings Framevo itself wrote (as opposed to files the user picked, which
-- the app does not own and must never delete). Drives the Storage page's
-- "reclaimable" figure.
ALTER TABLE `media` ADD `owned` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- The project an export belongs to is already stored; its title is not, and an
-- export outlives the project it came from.
ALTER TABLE `exports` ADD `project_title` text DEFAULT '' NOT NULL;
