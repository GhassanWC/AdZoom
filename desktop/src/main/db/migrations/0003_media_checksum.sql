-- The BASE64 MD5 of a media file. Firebase Storage reports `md5Hash` for an
-- uploaded object and nothing else we can compare against, so without this the
-- only available integrity check after an upload is the byte count — which
-- catches a truncated transfer but not a corrupted one.
ALTER TABLE `media_uploads` ADD `checksum_md5` text;
