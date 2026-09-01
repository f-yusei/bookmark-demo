const decodeHtmlEntities = (value: string) =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'");

const getAttribute = (tagContent: string, attrName: string): string | null => {
  const pattern = new RegExp(`\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const match = tagContent.match(pattern);
  if (!match) return null;
  return match[1] ?? match[2] ?? match[3] ?? null;
};

/**
 * HTML文字列から最初の og:image または og:image:url のURLを取り出します。
 *
 * @param html HTML文字列
 * @param baseUrl 相対URLを絶対URLに解決するためのベースURL
 * @returns og:image の絶対URL。見つからない、または http/https 以外のプロトコルの場合は null
 */
export const extractOgImageUrl = (html: string, baseUrl: string): string | null => {
  // HTMLコメントを除去して、コメントアウトされた meta タグを無視するようにします。
  const cleanHtml = html.replace(/<!--[\s\S]*?-->/g, "");

  const metaTagPattern = /<meta\b([^>]*)\/?>/gi;
  let match: RegExpExecArray | null;

  while ((match = metaTagPattern.exec(cleanHtml)) !== null) {
    const attrs = match[1];
    const property = getAttribute(attrs, "property");
    const name = getAttribute(attrs, "name");

    const isOgImage =
      (property && (property.toLowerCase() === "og:image" || property.toLowerCase() === "og:image:url")) ||
      (name && (name.toLowerCase() === "og:image" || name.toLowerCase() === "og:image:url"));

    if (isOgImage) {
      const content = getAttribute(attrs, "content");
      if (content) {
        try {
          const decodedContent = decodeHtmlEntities(content.trim());
          const resolvedUrl = new URL(decodedContent, baseUrl);
          if (resolvedUrl.protocol === "http:" || resolvedUrl.protocol === "https:") {
            return resolvedUrl.toString();
          }
        } catch {
          // 不正なURL形式の場合は無視して走査を続けます
        }
      }
    }
  }
  return null;
};
