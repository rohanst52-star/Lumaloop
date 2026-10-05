import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router, type IRouter } from "express";
import { GetAndroidUpdateManifestResponse } from "@workspace/api-zod";

const router: IRouter = Router();
const defaultManifestPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../updates/android-manifest.json",
);
const defaultPackageName = "com.lumaloop.app";
const defaultTrustedHost = "downloads.example.com,expo.dev";

class ManifestError extends Error {
  constructor(
    message: string,
    public readonly statusCode: 404 | 503,
  ) {
    super(message);
  }
}

function manifestPath() {
  const configured = process.env.ANDROID_UPDATE_MANIFEST_PATH;
  return configured
    ? path.resolve(configured)
    : defaultManifestPath;
}

function trustedHosts() {
  return (process.env.ANDROID_UPDATE_TRUSTED_HOSTS || defaultTrustedHost)
    .split(",")
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
}

async function readManifest() {
  let source: string;
  try {
    source = await readFile(manifestPath(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ManifestError("No Android release is configured", 404);
    }
    throw new ManifestError("Android release manifest is unavailable", 503);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new ManifestError("Android release manifest is not valid JSON", 503);
  }

  let manifest: ReturnType<typeof GetAndroidUpdateManifestResponse.parse>;
  try {
    manifest = GetAndroidUpdateManifestResponse.parse(raw);
  } catch {
    throw new ManifestError("Android release manifest failed validation", 503);
  }

  const expectedPackageName =
    process.env.ANDROID_UPDATE_PACKAGE_NAME || defaultPackageName;
  if (manifest.platform !== "android" || manifest.packageName !== expectedPackageName) {
    throw new ManifestError("Android release package does not match this app", 503);
  }

  let apkUrl: URL;
  try {
    apkUrl = new URL(manifest.apkUrl);
  } catch {
    throw new ManifestError("Android APK URL is invalid", 503);
  }

  if (apkUrl.protocol !== "https:" || !trustedHosts().includes(apkUrl.hostname.toLowerCase())) {
    throw new ManifestError("Android APK URL is not from a trusted HTTPS host", 503);
  }

  return {
    ...manifest,
    sha256: manifest.sha256.toLowerCase(),
  };
}

router.get("/updates/android/manifest", async (_req, res) => {
  try {
    res.json(await readManifest());
  } catch (error) {
    if (error instanceof ManifestError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    res.status(503).json({ error: "Android release manifest is unavailable" });
  }
});

export default router;