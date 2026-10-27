import { expect, it } from "vitest";
import { WebDAV, RemoteChanged, davETag } from "../packages/sync/webdav";
const xml = (value = "&quot;file-v1&quot;", status = "200 OK") =>
  `<d:multistatus xmlns:d="DAV:"><d:response><d:propstat><d:prop><d:getetag>${value}</d:getetag></d:prop><d:status>HTTP/1.1 ${status}</d:status></d:propstat></d:response></d:multistatus>`;
const client = (
  fetcher: (
    url: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
) =>
  new WebDAV(
    "https://cloud.test/dav/TabSpace/",
    "test",
    "fixture-password",
    fetcher as typeof fetch,
  );

it("uses the canonical DAV ETag when a proxy changes the GET representation ETag", async () => {
  const seen: RequestInit[] = [];
  const dav = client(async (_, init) => {
    seen.push(init!);
    if (init?.method === "PROPFIND") {
      expect((init.headers as Record<string, string>).Depth).toBe("0");
      return new Response(xml(), { status: 207 });
    }
    if (init?.method === "GET") {
      expect((init.headers as Record<string, string>)["If-Match"]).toBe(
        '"file-v1"',
      );
      return new Response("encrypted bytes", {
        headers: { ETag: '"proxy-representation-v1"' },
      });
    }
    return new Response(null, {
      status:
        (init?.headers as Record<string, string>)["If-Match"] === '"file-v1"'
          ? 204
          : 412,
    });
  });
  await expect(
    dav.write(
      "manifest.json",
      new Uint8Array([1]),
      '"proxy-representation-v1"',
    ),
  ).rejects.toBeInstanceOf(RemoteChanged);
  const file = await dav.read("manifest.json", 100);
  expect(file?.etag).toBe('"file-v1"');
  expect(new TextDecoder().decode(file?.bytes)).toBe("encrypted bytes");
  await dav.write("manifest.json", new Uint8Array([2]), file!.etag);
  expect(seen.some((r) => r.method === "PROPFIND")).toBe(true);
});
it("keeps a valid DAV file version even when the GET header is weak after compression", async () => {
  const dav = client(async (_, init) =>
    init?.method === "PROPFIND"
      ? new Response(xml(), { status: 207 })
      : new Response("bytes", { headers: { ETag: 'W/"proxy"' } }),
  );
  expect((await dav.read("manifest.json", 10))?.etag).toBe('"file-v1"');
});
it("still rejects a real concurrent change between metadata lookup and conditional download", async () => {
  const dav = client(async (_, init) =>
    init?.method === "PROPFIND"
      ? new Response(xml(), { status: 207 })
      : new Response(null, { status: 412 }),
  );
  await expect(dav.read("manifest.json", 10)).rejects.toThrow(
    "reading manifest.json (HTTP 412)",
  );
});
it("does not mistake a file removed after metadata lookup for an uninitialized vault", async () => {
  const dav = client(async (_, init) =>
    init?.method === "PROPFIND"
      ? new Response(xml(), { status: 207 })
      : new Response(null, { status: 404 }),
  );
  await expect(dav.read("manifest.json", 10)).rejects.toBeInstanceOf(
    RemoteChanged,
  );
});
it("supports HTTP-only conditional endpoints only when DAV is explicitly unsupported", async () => {
  for (const status of [405, 501]) {
    const dav = client(async (_, init) =>
      init?.method === "PROPFIND"
        ? new Response(null, { status })
        : new Response("bytes", { headers: { ETag: '"http-v1"' } }),
    );
    expect((await dav.read("manifest.json", 10))?.etag).toBe('"http-v1"');
  }
  const forbidden = client(async () => new Response(null, { status: 403 }));
  await expect(forbidden.read("manifest.json", 10)).rejects.toThrow(
    "file version (HTTP 403)",
  );
});
it("accepts DAV namespaces and quoted XML entities without evaluating external entities", () => {
  expect(davETag(xml())).toBe('"file-v1"');
  expect(davETag(xml("&#34;numeric&#x22;"))).toBe('"numeric"');
  expect(
    davETag(
      xml().replaceAll("d:", "").replace('xmlns:d="DAV:"', 'xmlns="DAV:"'),
    ),
  ).toBe('"file-v1"');
  for (const invalid of [
    xml('W/"weak"'),
    xml('"tag"', "404 Not Found"),
    xml().replace("DAV:", "urn:other"),
    `<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///private">]>${xml("&secret;")}`,
  ])
    expect(() => davETag(invalid)).toThrow();
});
it("rejects ambiguous multi-status replies and oversized metadata before downloading content", async () => {
  expect(() =>
    davETag(
      xml().replace(
        "</d:response>",
        xml().match(/<d:propstat>[\s\S]*<\/d:propstat>/)![0] + "</d:response>",
      ),
    ),
  ).toThrow("one valid");
  const dav = client(
    async () => new Response("x".repeat(65537), { status: 207 }),
  );
  await expect(dav.read("manifest.json", 100)).rejects.toThrow(
    "safe processing size",
  );
});
