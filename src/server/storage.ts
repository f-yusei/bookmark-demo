import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fetchWithTimeout, readLimitedBody } from "./fetch";
import { extractOgImageUrl } from "./ogp";

const ALLOWED_MIME_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif"
};

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * ページの OGP 画像を取得し、ローカルの指定されたディレクトリに保存します。
 *
 * ## 戻り値に空文字 "" を返す理由:
 * OGP 画像の取得や保存は付加機能（オプショナルな機能）です。外部サイトのダウン、ネットワークエラー、
 * タイムアウト、あるいは無効な画像形式などの理由で処理が失敗した場合でも、メイン機能である
 * 「ブックマークの保存」自体を失敗させてはなりません。そのため、どこかで処理が失敗した場合は、
 * エラーをスローせず安全に空文字 "" を返してフォールバックします。
 *
 * ## 画像種別を主要なWebセーフ画像（PNG, JPEG, WebP, GIF, AVIF）に絞る理由:
 * 1. セキュリティ対策: SVG などの XML ベースの画像形式にはスクリプトが埋め込まれる可能性があり、
 *    XSS（クロスサイトスクリプティング）などの脆弱性を生むリスクがあります。
 * 2. 互換性の確保: Webブラウザで確実に表示でき、かつサイズ制限やデータ保護が容易な一般的なビットマップ画像に限定します。
 * 3. リソース管理: 任意のファイル（悪意のあるバイナリなど）が画像として保存されるのを防ぎます。
 *
 * @param pageUrl ブックマーク対象のWebページURL
 * @param storageDir OGP画像を保存するディレクトリのベースパス
 * @param fetcher HTTPリクエストを行うフェッチャー関数（デフォルトは標準の fetch）
 * @returns 保存された画像のパス（例: "/ogp/<uuid>.<拡張子>"）、失敗時は空文字 ""
 */
export const storeOgpImage = async (
  pageUrl: string,
  storageDir: string,
  fetcher: typeof fetch = fetch
): Promise<string> => {
  try {
    // 1. ページの HTML を取得 (タイムアウト 5 秒、User-Agent: bookmark-demo/0.1)
    const response = await fetchWithTimeout(pageUrl, fetcher, "text/html", 5000);
    if (!response) {
      return "";
    }

    // 2. Content-Type が text/html であることを確認
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("text/html")) {
      return "";
    }

    // 3. レスポンスボディの取得 (HTMLの解析用、上限は 1MB とする)
    const htmlBody = await readLimitedBody(response, 1024 * 1024);
    if (!htmlBody) {
      return "";
    }

    const html = new TextDecoder().decode(htmlBody);

    // 4. og:image の URL を抽出
    const imageUrl = extractOgImageUrl(html, pageUrl);
    if (!imageUrl) {
      return "";
    }

    // 5. 画像の取得 (タイムアウト 5 秒、Accept: image/*)
    const imgResponse = await fetchWithTimeout(imageUrl, fetcher, "image/*", 5000);
    if (!imgResponse) {
      return "";
    }

    // 6. 画像の Content-Type 確認および拡張子の決定
    const imgContentType = imgResponse.headers.get("content-type") ?? "";
    const mimeType = imgContentType.split(";")[0].trim().toLowerCase();
    const extension = ALLOWED_MIME_TYPES[mimeType];
    if (!extension) {
      return "";
    }

    // 7. 画像データの取得 (サイズが 0 または 5MB 超なら null が返る)
    const imgBody = await readLimitedBody(imgResponse, MAX_IMAGE_BYTES);
    if (!imgBody || imgBody.length === 0) {
      return "";
    }

    // 8. OGP画像を保存するディレクトリを作成
    const ogpDir = join(storageDir, "ogp");
    mkdirSync(ogpDir, { recursive: true });

    // 9. ランダムな UUID を用いたファイル名を生成
    const filename = `${randomUUID()}.${extension}`;
    const filepath = join(ogpDir, filename);

    // 10. ファイルの書き込み
    writeFileSync(filepath, imgBody);

    // 11. 保存したパスを返す
    return `/ogp/${filename}`;
  } catch {
    // 予期せぬ例外が発生した場合も、ブックマーク保存を止めないため空文字を返す
    return "";
  }
};
