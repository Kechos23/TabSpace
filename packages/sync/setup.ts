import { folderUrl, syncFolder } from "./webdav";
export type ServerType = "nextcloud" | "webdav";
export function setupLocation(
  type: ServerType,
  address: string,
  username: string,
  folder: string,
) {
  let base = folderUrl(address);
  const url = new URL(base);
  if (url.protocol !== "https:")
    throw new Error("Use an HTTPS server address.");
  if (type === "nextcloud") {
    if (!username.trim() || username.includes(":"))
      throw new Error("Enter your Nextcloud username.");
    if (
      !/\/remote\.php\/(?:dav\/files\/[^/]+|webdav)(?:\/|$)/.test(url.pathname)
    ) {
      if (
        /\/remote\.php\/|\/(?:index\.php\/)?apps\/|\/login(?:\/|$)/.test(
          url.pathname,
        )
      )
        throw new Error(
          "Use your Nextcloud base address or its complete WebDAV address, rather than a Files or login page.",
        );
      url.pathname += `remote.php/dav/files/${encodeURIComponent(username.trim())}/`;
      base = url.href;
    }
  }
  return syncFolder(base, folder);
}
