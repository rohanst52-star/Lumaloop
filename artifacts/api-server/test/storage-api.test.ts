import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, test } from "node:test";
import express from "express";
import storageRouter, { isSafeImageUpload } from "../src/routes/storage";

const originalFetch = globalThis.fetch;
const fixtures = {
  jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0x01, 0x02]),
  png: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]),
  webp: new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]),
} as const;

const storedObjects = new Map<string, Uint8Array>([
  ["uploads/aaaaaaaaaaaaaaaaaaaaaaaa/a1b2c3", fixtures.jpeg],
  ["uploads/aaaaaaaaaaaaaaaaaaaaaaaa/d4e5f6", fixtures.png],
  ["uploads/aaaaaaaaaaaaaaaaaaaaaaaa/abcdef-123", fixtures.webp],
]);

let server: http.Server;
let baseUrl: string;
let sidecarRequests = 0;

async function request(path: string, init?: RequestInit): Promise<globalThis.Response> {
  return originalFetch(`${baseUrl}${path}`, init);
}

before(async () => {
  process.env.PRIVATE_OBJECT_DIR = "test-bucket";

  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "http://127.0.0.1:1106/object-storage/signed-object-url") {
      sidecarRequests += 1;
      const body = JSON.parse(String(init?.body)) as { object_name: string };
      return new Response(JSON.stringify({ signed_url: `https://test-object-storage.invalid/${body.object_name}` }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://test-object-storage.invalid/")) {
      const objectName = new URL(url).pathname.slice(1);
      const bytes = storedObjects.get(objectName);
      return bytes
        ? new Response(bytes, { status: 200 })
        : new Response("not found", { status: 404 });
    }
    return originalFetch(input, init);
  };

  const app = express();
  app.use(express.json());
  app.use("/api", storageRouter);
  server = await new Promise<http.Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  globalThis.fetch = originalFetch;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("marketplace image responses", () => {
  test("serves valid JPEG, PNG, and WebP objects with browser-safe headers", async () => {
    const cases = [
      ["a1b2c3", "image/jpeg", fixtures.jpeg],
      ["d4e5f6", "image/png", fixtures.png],
      ["abcdef-123", "image/webp", fixtures.webp],
    ] as const;

    for (const [name, contentType, expectedBytes] of cases) {
      const response = await request(`/api/storage/objects/uploads/aaaaaaaaaaaaaaaaaaaaaaaa/${name}`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), contentType);
      assert.equal(response.headers.get("content-disposition"), "inline");
      assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
      assert.deepEqual(new Uint8Array(await response.arrayBuffer()), expectedBytes);
    }
  });

  test("serves a missing historical object as a short-cached PNG fallback", async () => {
    const response = await request("/api/storage/objects/uploads/aaaaaaaaaaaaaaaaaaaaaaaa/deadbeef");
    const bytes = new Uint8Array(await response.arrayBuffer());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "image/png");
    assert.equal(response.headers.get("cache-control"), "public, max-age=300");
    assert.equal(response.headers.get("content-type")?.startsWith("application/json"), false);
    assert.deepEqual(Array.from(bytes.slice(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  test("keeps invalid object paths and upload metadata strict", async () => {
    const callsBeforeInvalidPath = sidecarRequests;
    const invalidPath = await request("/api/storage/objects/uploads/not-a-valid-object");
    assert.equal(invalidPath.status, 404);
    assert.equal(invalidPath.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(sidecarRequests, callsBeforeInvalidPath);

    const invalidUploads: Array<[string, number]> = [
      ["image/gif", 100],
      ["image/jpeg", 0],
      ["image/png", 15_000_001],
      ["image/webp", Number.NaN],
    ];
    for (const [contentType, size] of invalidUploads) {
      assert.equal(isSafeImageUpload(contentType, size), false);
    }
    assert.equal(isSafeImageUpload("image/jpeg", 1), true);
    assert.equal(isSafeImageUpload("image/webp", 15_000_000), true);
    assert.equal(isSafeImageUpload("image/gif", 1), false);
    assert.equal(isSafeImageUpload("image/png", 15_000_001), false);
  });
});
