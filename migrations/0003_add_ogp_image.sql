-- 既存の行や seed データには og:image が無いため、
-- デフォルト値を空文字 ('') とすることで影響なく列を追加できます。
ALTER TABLE bookmarks ADD COLUMN ogp_image_url TEXT NOT NULL DEFAULT '';
