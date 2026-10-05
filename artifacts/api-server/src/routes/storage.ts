import { createHash, randomUUID } from "node:crypto";
import { getAuth } from "@clerk/express";
import { Router, type IRouter, type Request } from "express";
import { db } from "@workspace/db";
import { productsTable } from "@workspace/db/schema";

const router: IRouter = Router();
const sidecarEndpoint = "http://127.0.0.1:1106";
const missingListingImage = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAGAAAABICAIAAACGBWc0AAAA20lEQVR42u3Yuw0CMRBAwS2DnArogzJISa4O6qMAUjIqoAB0h+UDf7QjvXhlT+R1PB93bRQIAAECBAgQIECABCg70OtyXgvQls4eo0iiU20UeXTqjCKVToURIECAAAECBAgQIC9pu1jWXcw27z/IjyIgQIAECBAgQIAAAQLUo+tt+QzQKs04TDEyzQhMMT5NX6aYhaYXU8xF054pZqRpyRTz0rRhitlp/s0Uh+PpayWDSuaUXHL/nPLzJAUqn/MzoMwBAgQIECBAgAABEiBAgAABAgQIkAABAtSqNzE3v95TpbxhAAAAAElFTkSuQmCC",
  "base64",
);

router.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

function privateObjectDir(): string {
  const directory = process.env.PRIVATE_OBJECT_DIR?.replace(/\/+$/, "");
  if (!directory) throw new Error("PRIVATE_OBJECT_DIR is not configured");
  return directory;
}

function parseObjectPath(path: string): { bucketName: string; objectName: string } {
  const parts = path.replace(/^\/+/, "").split("/");
  if (parts.length < 2) throw new Error("Invalid object path");
  return { bucketName: parts[0], objectName: parts.slice(1).join("/") };
}

async function signedObjectUrl(fullPath: string, method: "GET" | "PUT" | "DELETE"): Promise<string> {
  const { bucketName, objectName } = parseObjectPath(fullPath);
  const response = await fetch(`${sidecarEndpoint}/object-storage/signed-object-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bucket_name: bucketName,
      object_name: objectName,
      method,
      expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Could not sign object URL (${response.status})`);
  const result = await response.json() as { signed_url?: string };
  if (!result.signed_url) throw new Error("Object storage did not return a signed URL");
  return result.signed_url;
}

const safeImageTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

export function isSafeImageUpload(contentType: string, size: number): boolean {
  return safeImageTypes.has(contentType) && Number.isFinite(size) && size > 0 && size <= 15_000_000;
}

function relativePathFromUrl(rawUrl: string): string | null {
  try {
    const pathname = new URL(rawUrl, "https://lumaloop.invalid").pathname;
    const prefix = "/api/storage/objects/";
    const relativePath = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
    return /^uploads\/(?:[a-f0-9]{24}\/)?[a-f0-9-]+$/i.test(relativePath) ? relativePath : null;
  } catch {
    return null;
  }
}

function uploadOwnerId(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 24);
}

function ownedRelativePath(rawPath: string, userId: string): string | null {
  const relativePath = relativePathFromUrl(rawPath);
  return relativePath?.startsWith(`uploads/${uploadOwnerId(userId)}/`) ? relativePath : null;
}

export function publicStoredImageUrl(rawUrl: string): string {
  const relativePath = relativePathFromUrl(rawUrl);
  if (!relativePath) return rawUrl;
  const domain = process.env.REPLIT_DOMAINS?.split(",")[0] || process.env.REPLIT_DEV_DOMAIN;
  return domain
    ? `https://${domain}/api/storage/objects/${relativePath}`
    : `/api/storage/objects/${relativePath}`;
}

function sniffRasterImage(bytes: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((value, index) => bytes[index] === value)) return "image/png";
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return null;
}

async function readStoredImage(relativePath: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const downloadUrl = await signedObjectUrl(`${privateObjectDir()}/${relativePath}`, "GET");
  const response = await fetch(downloadUrl);
  if (!response.ok) return null;
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > 15_000_000) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 15_000_000) return null;
  const contentType = sniffRasterImage(bytes);
  return contentType ? { bytes, contentType } : null;
}

function sendImage(
  res: Parameters<Parameters<IRouter["get"]>[1]>[1],
  bytes: Uint8Array,
  contentType: string,
  cacheControl: string,
): void {
  res.status(200);
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", String(bytes.byteLength));
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
  res.setHeader("Cache-Control", cacheControl);
  res.end(Buffer.from(bytes));
}

export async function validateStoredImageUrl(rawUrl: string, userId?: string): Promise<boolean> {
  const relativePath = relativePathFromUrl(rawUrl);
  if (!relativePath || (userId && !relativePath.startsWith(`uploads/${uploadOwnerId(userId)}/`))) return false;
  try {
    return Boolean(await readStoredImage(relativePath));
  } catch {
    return false;
  }
}

router.post("/storage/uploads/request-url", async (req: Request, res) => {
  const userId = getAuth(req).userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const contentType = typeof req.body?.contentType === "string" ? req.body.contentType : "";
  const size = Number(req.body?.size);
  if (!isSafeImageUpload(contentType, size)) {
    res.status(400).json({ error: "A JPEG, PNG, or WebP image up to 15 MB is required" });
    return;
  }
  try {
    const objectId = randomUUID();
    const relativePath = `uploads/${uploadOwnerId(userId)}/${objectId}`;
    const uploadUrl = await signedObjectUrl(`${privateObjectDir()}/${relativePath}`, "PUT");
    res.json({ uploadUrl, objectPath: `/api/storage/objects/${relativePath}` });
  } catch (error) {
    req.log.error({ err: error }, "Could not create upload URL");
    res.status(503).json({ error: "Photo storage is temporarily unavailable" });
  }
});

router.post("/storage/uploads/cleanup", async (req: Request, res) => {
  const userId = getAuth(req).userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }
  const rawObjectPaths: unknown[] = Array.isArray(req.body?.objectPaths) ? req.body.objectPaths : [];
  if (rawObjectPaths.length < 1 || rawObjectPaths.length > 10 || !rawObjectPaths.every((path): path is string => typeof path === "string")) {
    res.status(400).json({ error: "Provide 1–10 uploaded photo paths" });
    return;
  }
  const objectPaths = rawObjectPaths as string[];
  const relativePaths = objectPaths.map((path) => ownedRelativePath(path, userId));
  if (relativePaths.some((path) => !path)) {
    res.status(400).json({ error: "Every photo must belong to the current upload attempt" });
    return;
  }
  try {
    const listingImages = (await db.select({ images: productsTable.images }).from(productsTable))
      .flatMap((listing) => listing.images)
      .map(relativePathFromUrl)
      .filter((path): path is string => Boolean(path));
    const claimedPaths = new Set(listingImages);
    const unclaimedPaths = relativePaths.filter((path): path is string => typeof path === "string" && !claimedPaths.has(path));
    const outcomes = await Promise.all(unclaimedPaths.map(async (relativePath) => {
      const deleteUrl = await signedObjectUrl(`${privateObjectDir()}/${relativePath!}`, "DELETE");
      const response = await fetch(deleteUrl, { method: "DELETE", signal: AbortSignal.timeout(30_000) });
      return { deleted: response.ok || response.status === 404, relativePath };
    }));
    const deletedPaths = outcomes
      .filter((outcome) => outcome.deleted)
      .map((outcome) => `/api/storage/objects/${outcome.relativePath}`);
    res.json({ deleted: deletedPaths.length, deletedPaths });
  } catch (error) {
    req.log.error({ err: error }, "Could not clean up listing photo uploads");
    res.status(503).json({ error: "Photo cleanup is temporarily unavailable" });
  }
});

router.get("/storage/objects/*path", async (req, res) => {
  const raw = req.params.path;
  const relativePath = Array.isArray(raw) ? raw.join("/") : raw;
  if (!/^uploads\/(?:[a-f0-9]{24}\/)?[a-f0-9-]+$/i.test(relativePath)) {
    res.status(404).json({ error: "Image not found" });
    return;
  }
  try {
    const image = await readStoredImage(relativePath);
    if (!image) {
      sendImage(res, missingListingImage, "image/png", "public, max-age=300");
      return;
    }
    sendImage(res, image.bytes, image.contentType, "public, max-age=31536000, immutable");
  } catch (error) {
    req.log.error({ err: error }, "Could not serve image");
    res.status(500).json({ error: "Could not serve image" });
  }
});

export default router;