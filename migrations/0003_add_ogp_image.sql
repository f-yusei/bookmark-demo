-- 既存の行や seed データには og:image が無いため、
-- デフォルト値を空文字 ('') とすることで影響なく列を追加できます。
-- このリポジトリのマイグレーション機構は down を実行しないため、この変更は forward-only です。
-- ロールバックが必要な場合は、適用前に取得した SQLite DB のバックアップを復元してください。
-- 生成済みの OGP 画像ファイルは DB と独立しているため、復元後に storage の ogp ディレクトリから削除できます。
ALTER TABLE bookmarks ADD COLUMN ogp_image_url TEXT NOT NULL DEFAULT '';
