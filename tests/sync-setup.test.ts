import { expect, it } from "vitest";
import { setupLocation } from "../packages/sync/setup";

it("builds Nextcloud DAV locations from base addresses, subdirectory installs and usernames", () => {
  expect(
    setupLocation("nextcloud", "https://cloud.test", "admin", "TabSpace"),
  ).toBe("https://cloud.test/remote.php/dav/files/admin/TabSpace/");
  expect(
    setupLocation(
      "nextcloud",
      "https://cloud.test/nextcloud/",
      "user@example.org",
      "My work",
    ),
  ).toBe(
    "https://cloud.test/nextcloud/remote.php/dav/files/user%40example.org/My%20work/",
  );
});
it("continues accepting complete Nextcloud DAV addresses without duplicating their prefix", () => {
  for (const path of ["remote.php/dav/files/real-user", "remote.php/webdav"])
    expect(
      setupLocation(
        "nextcloud",
        `https://cloud.test/${path}/`,
        "login",
        "TabSpace",
      ),
    ).toBe(`https://cloud.test/${path}/TabSpace/`);
});
it("keeps arbitrary WebDAV paths intact and rejects unsafe or misleading setup", () => {
  expect(
    setupLocation(
      "webdav",
      "https://dav.test/custom/user/",
      "login",
      "Folder/TabSpace",
    ),
  ).toBe("https://dav.test/custom/user/Folder/TabSpace/");
  for (const url of [
    "https://cloud.test/apps/files/",
    "https://cloud.test/index.php/apps/files",
    "https://cloud.test/login",
    "https://cloud.test/remote.php/dav/files/",
    "http://cloud.test",
    "https://name:password@cloud.test",
  ])
    expect(() =>
      setupLocation("nextcloud", url, "admin", "TabSpace"),
    ).toThrow();
  expect(() =>
    setupLocation("nextcloud", "https://cloud.test", "admin", "../outside"),
  ).toThrow();
});
