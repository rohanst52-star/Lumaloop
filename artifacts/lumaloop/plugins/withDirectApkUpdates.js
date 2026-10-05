const fs = require("node:fs");
const path = require("node:path");
const {
  withAppBuildGradle,
  withAndroidManifest,
  withDangerousMod,
} = require("expo/config-plugins");

const permissionName = "android.permission.REQUEST_INSTALL_PACKAGES";
const providerName = "androidx.core.content.FileProvider";
const expectedReleaseCertSha256 = "5069f19a21eefeb28b34929305888d61ce90450b83298d937edfb96444f6c72a";
const expectedReleaseApiHost = "luma-lop-4.replit.app";

function validateReleaseApiHost() {
  if (process.env.EAS_BUILD !== "true" || process.env.EAS_BUILD_PROFILE !== "release") {
    return;
  }

  const configured = process.env.EXPO_PUBLIC_DOMAIN?.trim();
  let candidate;
  try {
    candidate = new URL(/^https?:\/\//i.test(configured || "") ? configured : `https://${configured || ""}`);
  } catch {
    throw new Error("EXPO_PUBLIC_DOMAIN must contain LumaLoop's public HTTPS deployment hostname.");
  }

  if (
    candidate.protocol !== "https:" ||
    candidate.host !== expectedReleaseApiHost ||
    candidate.pathname !== "/" ||
    candidate.search ||
    candidate.hash
  ) {
    throw new Error(
      `LumaLoop release builds must use ${expectedReleaseApiHost} for EXPO_PUBLIC_DOMAIN. Temporary development and local hosts are not allowed.`,
    );
  }
}

function withDirectApkUpdates(config) {
  validateReleaseApiHost();
  config = withAppBuildGradle(config, (modConfig) => {
    const marker = "// LUMALOOP_DIRECT_UPDATE_SIGNING";
    let contents = modConfig.modResults.contents;
    if (!contents.includes(marker)) {
      contents = `${marker}
def lumaloopReleaseStoreFile = project.findProperty("LUMALOOP_RELEASE_STORE_FILE")
def lumaloopReleaseStorePassword = project.findProperty("LUMALOOP_RELEASE_STORE_PASSWORD")
def lumaloopReleaseKeyAlias = project.findProperty("LUMALOOP_RELEASE_KEY_ALIAS")
def lumaloopReleaseKeyPassword = project.findProperty("LUMALOOP_RELEASE_KEY_PASSWORD")
def lumaloopExpectedReleaseCertSha256 = "${expectedReleaseCertSha256}"
def lumaloopConfiguredReleaseCertSha256 = project.findProperty("LUMALOOP_RELEASE_CERT_SHA256")?.replace(":", "")?.toLowerCase()

gradle.taskGraph.whenReady { graph ->
    def buildsRelease = graph.allTasks.any { it.name.toLowerCase().contains("release") }
    // EAS injects and manages the release signing config before Gradle runs.
    // Local release builds still require the explicit production properties.
    def usesEasManagedSigning = System.getenv("EAS_BUILD") == "true"
    def hasLocalSigning = lumaloopReleaseStoreFile && lumaloopReleaseStorePassword && lumaloopReleaseKeyAlias && lumaloopReleaseKeyPassword
    if (buildsRelease && !usesEasManagedSigning && !hasLocalSigning) {
        throw new GradleException("LumaLoop release signing properties are required. Never ship a debug-signed update.")
    }
    if (buildsRelease && !usesEasManagedSigning && file(lumaloopReleaseStoreFile).name.toLowerCase() == "debug.keystore") {
        throw new GradleException("The Android debug keystore cannot sign a LumaLoop release.")
    }
    if (buildsRelease && lumaloopConfiguredReleaseCertSha256 && lumaloopConfiguredReleaseCertSha256 != lumaloopExpectedReleaseCertSha256) {
        throw new GradleException("LUMALOOP_RELEASE_CERT_SHA256 does not match the pinned production certificate.")
    }
}

${contents}`;
      contents = contents.replace(
        /buildTypes\s*\{/,
        `signingConfigs {
        if (lumaloopReleaseStoreFile) {
            lumaloopRelease {
                storeFile file(lumaloopReleaseStoreFile)
                storePassword lumaloopReleaseStorePassword
                keyAlias lumaloopReleaseKeyAlias
                keyPassword lumaloopReleaseKeyPassword
            }
        }
    }

    buildTypes {`,
      );
      contents = contents.replace(
        /(release\s*\{[\s\S]*?signingConfig signingConfigs\.debug)/,
        `$1
            if (lumaloopReleaseStoreFile) {
                signingConfig signingConfigs.lumaloopRelease
            }`,
      );
      contents = contents.replace(
        /android\s*\{/,
        `android {
    // LUMALOOP_DIRECT_UPDATE_PACKAGING
    packagingOptions {
        resources {
            excludes += ["META-INF/versions/9/OSGI-INF/MANIFEST.MF"]
        }
    }`,
      );
      contents += `

tasks.matching { it.name == "assembleRelease" }.configureEach {
    doLast {
        def releaseApk = file("$buildDir/outputs/apk/release/app-release.apk")
        if (!releaseApk.exists()) {
            throw new GradleException("Expected release APK was not produced: " + releaseApk)
        }
        def apksigner = file("\${android.sdkDirectory}/build-tools/\${android.buildToolsVersion}/apksigner")
        def signerOutput = new ByteArrayOutputStream()
        exec {
            commandLine apksigner, "verify", "--print-certs", releaseApk
            standardOutput = signerOutput
        }
        def signerMatch = signerOutput.toString() =~ /Signer #1 certificate SHA-256 digest: ([A-Fa-f0-9:]+)/
        if (!signerMatch.find()) {
            throw new GradleException("Could not read the release APK signer fingerprint.")
        }
        def actualFingerprint = signerMatch.group(1).replace(":", "").toLowerCase()
        if (actualFingerprint != lumaloopExpectedReleaseCertSha256) {
            throw new GradleException("Release APK signer fingerprint does not match the pinned production certificate.")
        }
    }
}
`;
      modConfig.modResults.contents = contents;
    }
    return modConfig;
  });

  config = withAndroidManifest(config, (modConfig) => {
    const manifest = modConfig.modResults.manifest;
    const permissions = manifest["uses-permission"] || [];
    if (!permissions.some((permission) => permission.$?.["android:name"] === permissionName)) {
      permissions.push({ $: { "android:name": permissionName } });
    }
    manifest["uses-permission"] = permissions;

    const application = manifest.application?.[0];
    if (!application) {
      throw new Error("LumaLoop Android application is missing from the manifest");
    }

    application.provider = (application.provider || []).filter(
      (provider) => provider.$?.["android:name"] !== providerName,
    );
    application.provider.push({
      $: {
        "android:name": providerName,
        "android:authorities": "${applicationId}.fileprovider",
        "android:exported": "false",
        "android:grantUriPermissions": "true",
      },
      "meta-data": [
        {
          $: {
            "android:name": "android.support.FILE_PROVIDER_PATHS",
            "android:resource": "@xml/lumaloop_file_paths",
          },
        },
      ],
    });

    return modConfig;
  });

  return withDangerousMod(config, [
    "android",
    async (modConfig) => {
      const xmlDir = path.join(
        modConfig.modRequest.platformProjectRoot,
        "app",
        "src",
        "main",
        "res",
        "xml",
      );
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDir, "lumaloop_file_paths.xml"),
        `<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
  <cache-path name="apk_updates" path="." />
</paths>
`,
      );
      return modConfig;
    },
  ]);
}

module.exports = withDirectApkUpdates;