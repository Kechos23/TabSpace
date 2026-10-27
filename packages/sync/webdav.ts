export type RemoteFile = { bytes: Uint8Array; etag: string };
export interface SyncTransport {
  read(path: string, limit: number): Promise<RemoteFile | undefined>;
  write(path: string, bytes: Uint8Array, etag: string | null): Promise<void>;
  prepare(): Promise<void>;
}
export class RemoteChanged extends Error {
  constructor(operation = "sync", status?: number) {
    super(
      operation === "sync"
        ? "Cloud data changed during sync. Retry to merge the latest version."
        : `Cloud data changed while ${operation}${status ? ` (HTTP ${status})` : ""}. Retry to merge the latest version.`,
    );
  }
}
const strongETag = (value: string | null): value is string =>
  value !== null && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);

// A deliberately narrow DAV property reader: no DOM in an MV3 worker and no
// DTD/entity expansion. Accept one DAV:getetag in a successful propstat only.
export function davETag(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new Error("Unsupported WebDAV metadata XML.");
  const values: string[] = [];
  for (const stat of xml.matchAll(
    /<(?:[\w.-]+:)?propstat\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?propstat\s*>/g,
  )) {
    if (
      !/<(?:[\w.-]+:)?status\b[^>]*>\s*HTTP\/\d(?:\.\d)?\s+200\b[^<]*<\//.test(
        stat[1],
      )
    )
      continue;
    for (const property of stat[1].matchAll(
      /<((?:[\w.-]+:)?getetag)\b[^>]*>([^<]*)<\/\1\s*>/g,
    )) {
      const prefix = property[1].includes(":") ? property[1].split(":")[0] : "";
      const namespace = prefix ? `xmlns:${prefix}` : "xmlns";
      const escaped = namespace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!new RegExp(`${escaped}\\s*=\\s*["']DAV:["']`).test(xml)) continue;
      const value = property[2]
        .trim()
        .replace(/&(?:quot|amp|apos|lt|gt|#\d+|#x[0-9a-fA-F]+);/g, (entity) => {
          const named: Record<string, string> = {
            "&quot;": '"',
            "&amp;": "&",
            "&apos;": "'",
            "&lt;": "<",
            "&gt;": ">",
          };
          return (
            named[entity] ??
            String.fromCodePoint(
              Number(
                entity.startsWith("&#x")
                  ? `0x${entity.slice(3, -1)}`
                  : entity.slice(2, -1),
              ),
            )
          );
        });
      if (!strongETag(value))
        throw new Error(
          "The WebDAV server must provide a strong file ETag for safe writes.",
        );
      values.push(value);
    }
  }
  if (values.length !== 1)
    throw new Error(
      "The WebDAV server did not return one valid file version. Sync stopped safely.",
    );
  return values[0];
}
export function folderUrl(raw: string) {
  const url = new URL(raw.trim());
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    throw new Error("Use an HTTPS WebDAV folder URL.");
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      "Use a folder URL without embedded credentials or query parameters.",
    );
  url.pathname = url.pathname.replace(/\/+$/, "") + "/";
  return url.href;
}
export function syncFolder(base: string, folder: string) {
  const segments = folder.trim().split("/");
  if (
    !segments.length ||
    segments.some(
      (part) => !part || part === "." || part === ".." || part.includes("\\"),
    )
  )
    throw new Error(
      "Enter a relative sync folder, without empty, dot or parent segments.",
    );
  return folderUrl(base) + segments.map(encodeURIComponent).join("/") + "/";
}
export class WebDAV implements SyncTransport {
  readonly url: string;
  constructor(
    url: string,
    private username: string,
    private password: string,
    private fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    this.url = folderUrl(url);
    if (!username || username.includes(":"))
      throw new Error("Enter a valid WebDAV username.");
    if (!password) throw new Error("Enter a dedicated app password.");
  }
  private async request(
    path: string,
    method: string,
    headers: Record<string, string> = {},
    body?: Uint8Array | string,
  ) {
    if (!/^(?:manifest\.json|blobs\/|blobs\/[a-f0-9-]+\.bin)?$/.test(path))
      throw new Error("Invalid sync path.");
    const credentials = new TextEncoder().encode(
      `${this.username}:${this.password}`,
    );
    const auth = btoa(
      Array.from(credentials, (b) => String.fromCharCode(b)).join(""),
    );
    try {
      return await this.fetcher(this.url + path, {
        method,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(25000),
        headers: { Authorization: `Basic ${auth}`, ...headers },
        body:
          typeof body === "string"
            ? body
            : body
              ? new Uint8Array(body)
              : undefined,
      });
    } catch {
      throw new Error(
        "Cannot reach the sync folder. Check connectivity, HTTPS and server access.",
      );
    }
  }
  async prepare() {
    for (const path of ["", "blobs/"]) {
      const response = await this.request(path, "MKCOL");
      await response.body?.cancel();
      if (![201, 405].includes(response.status))
        throw new Error(
          `Cannot prepare sync folder (HTTP ${response.status}). Create its parent folder first.`,
        );
    }
  }
  async read(path: string, limit: number) {
    let validator: string | undefined;
    if (path === "manifest.json") {
      const metadata = await this.request(
        path,
        "PROPFIND",
        { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
        '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>',
      );
      if (metadata.status === 404) {
        await metadata.body?.cancel();
        return undefined;
      }
      if (metadata.status === 207) {
        validator = davETag(
          new TextDecoder().decode(await this.responseBytes(metadata, 65536)),
        );
      } else {
        await metadata.body?.cancel();
        // Some file-only endpoints implement conditional HTTP without PROPFIND.
        if (![405, 501].includes(metadata.status))
          throw new Error(
            `Cannot read WebDAV file version (HTTP ${metadata.status}).`,
          );
      }
    }
    const response = await this.request(
      path,
      "GET",
      validator ? { "If-Match": validator } : {},
    );
    if (response.status === 412) {
      await response.body?.cancel();
      throw new RemoteChanged(`reading ${path}`, 412);
    }
    if (response.status === 404) {
      await response.body?.cancel();
      if (validator) throw new RemoteChanged(`reading ${path}`, 404);
      return undefined;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Cannot read sync data (HTTP ${response.status}).`);
    }
    const etag = validator ?? response.headers.get("etag");
    if (!strongETag(etag)) {
      await response.body?.cancel();
      throw new Error(
        "The sync server must provide strong ETags for safe writes.",
      );
    }
    return { bytes: await this.responseBytes(response, limit), etag };
  }
  private async responseBytes(response: Response, limit: number) {
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    if (!reader) throw new Error("Empty sync response.");
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.length;
        if (length > limit)
          throw new Error("Sync response exceeds its safe processing size.");
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel();
      throw error;
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
  async write(path: string, value: Uint8Array, etag: string | null) {
    const response = await this.request(
      path,
      "PUT",
      {
        "Content-Type": "application/octet-stream",
        ...(etag ? { "If-Match": etag } : { "If-None-Match": "*" }),
      },
      value,
    );
    await response.body?.cancel();
    if (response.status === 412)
      throw new RemoteChanged(`${etag ? "updating" : "creating"} ${path}`, 412);
    if (![200, 201, 204].includes(response.status))
      throw new Error(`Cannot save sync data (HTTP ${response.status}).`);
  }
}
