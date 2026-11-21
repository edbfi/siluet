export const gallerySchema = `CREATE TABLE gallery_image (
	job_id TEXT PRIMARY KEY NOT NULL,
	state TEXT NOT NULL CHECK (state IN ('saved', 'unavailable', 'deleting')),
	mime TEXT NOT NULL CHECK (mime IN ('image/png', 'image/jpeg')),
	width INTEGER NOT NULL, height INTEGER NOT NULL, size INTEGER NOT NULL,
	digest TEXT NOT NULL, saved_at INTEGER NOT NULL
);`;
