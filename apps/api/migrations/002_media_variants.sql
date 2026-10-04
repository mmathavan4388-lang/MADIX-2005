ALTER TABLE files ADD COLUMN optimized_key text;      -- 720p H.264 faststart rendition for fast streaming
CREATE INDEX posts_feed_idx ON posts (created_at DESC) WHERE status='published';
