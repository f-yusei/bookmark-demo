import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_REDIRECTS = 3;

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata", "metadata.google.internal"]);
const BLOCKED_ADDRESSES = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4]
] as const) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8]
] as const) {
  BLOCKED_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

const isBlockedAddress = (address: string) => {
  const ipVersion = isIP(address);
  if (ipVersion === 4) {
    return BLOCKED_ADDRESSES.check(address, "ipv4");
  }

  if (ipVersion === 6) {
    return BLOCKED_ADDRESSES.check(address, "ipv6");
  }

  return true;
};

export const validatePublicHttpUrl = async (value: string) => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only public http and https URLs are supported.");
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    throw new Error("Private hostnames are not supported.");
  }

  if (isIP(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw new Error("Private IP addresses are not supported.");
    }
    return;
  }

  if (process.env.NODE_ENV === "test" || process.env.VITEST) {
    return;
  }

  const addresses = await lookup(hostname, { all: true, verbatim: false });
  if (addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new Error("Private resolved addresses are not supported.");
  }
};

export const fetchWithTimeout = async (
  url: string,
  fetcher: typeof fetch,
  accept: string,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Response | null> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let currentUrl = url;

  try {
    for (let redirectCount = 0; redirectCount <= DEFAULT_MAX_REDIRECTS; redirectCount += 1) {
      await validatePublicHttpUrl(currentUrl);
      const response = await fetcher(currentUrl, {
        headers: {
          "user-agent": "bookmark-demo/0.1",
          accept
        },
        redirect: "manual",
        signal: controller.signal
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || redirectCount === DEFAULT_MAX_REDIRECTS) {
          return null;
        }

        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      await validatePublicHttpUrl(response.url || currentUrl);
      return response.ok ? response : null;
    }

    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
};

export const readLimitedBody = async (response: Response, maxBytes: number): Promise<Uint8Array | null> => {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (!Number.isFinite(parsedLength) || parsedLength < 0 || parsedLength > maxBytes) {
      return null;
    }
  }

  if (!response.body) {
    return null;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (total === 0) {
    return null;
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body;
};
