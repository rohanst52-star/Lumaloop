const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const serial = process.env.ANDROID_SERIAL;
const apkPath = process.env.ANDROID_AUTH_APK
  ? path.resolve(process.env.ANDROID_AUTH_APK)
  : path.resolve(__dirname, '../android/app/build/outputs/apk/release/app-release.apk');
const packageName = 'com.lumaloop.app';
const timeoutMs = Number(process.env.ANDROID_PROFILE_CHECK_TIMEOUT_MS || 30_000);
const genericFailureCopy = /Your account is not ready yet|A little loop in the road|Sign in to view (?:your )?(?:profile|balance|orders|messages|notifications)|Could not restore the signed-in session/i;
const artifactDirectory = path.resolve(
  process.env.ANDROID_PROFILE_CHECK_ARTIFACT_DIR || path.join(process.cwd(), 'test-results', 'android-profile-menu'),
);
let lastUiDump = '';
let currentStep = 'startup';

function preserveFailureArtifacts(error) {
  const failedStep = currentStep;
  let dump = lastUiDump;
  try {
    if (serial) dump = uiDump();
  } catch {
    // Keep the last successful dump when the device is no longer reachable.
  }

  try {
    fs.mkdirSync(artifactDirectory, { recursive: true });
    const dumpPath = path.join(artifactDirectory, 'profile-menu-failure.xml');
    const summaryPath = path.join(artifactDirectory, 'profile-menu-failure.json');
    fs.writeFileSync(dumpPath, dump || '<ui-dump-unavailable />\n');
    fs.writeFileSync(summaryPath, `${JSON.stringify({
      packageName,
      serial: serial || null,
      apkPath,
      step: failedStep,
      error: error instanceof Error ? error.message : String(error),
      uiDumpPath: dumpPath,
    }, null, 2)}\n`);
    console.error(
      dump
        ? `Profile menu check failed at "${failedStep}". UI dump preserved at ${dumpPath}.`
        : `Profile menu check failed at "${failedStep}". No live UI dump was available; a placeholder was written to ${dumpPath}.`,
    );
    console.error(`Failure summary preserved at ${summaryPath}.`);
  } catch (artifactError) {
    console.error(`Could not preserve the Profile menu failure artifacts: ${artifactError instanceof Error ? artifactError.message : artifactError}`);
  }
}

process.once('uncaughtException', (error) => {
  preserveFailureArtifacts(error);
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});

function adb(...args) {
  return execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8' }).trim();
}

function wait(milliseconds) {
  execFileSync('sleep', [String(milliseconds / 1000)]);
}

function uiDump() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/lumaloop-profile-window.xml');
  lastUiDump = adb('exec-out', 'cat', '/sdcard/lumaloop-profile-window.xml');
  return lastUiDump;
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function nodeFor(xml, attribute, value) {
  const match = xml.match(new RegExp(`<node[^>]*${attribute}="${escaped(value)}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`));
  if (!match) return null;
  return {
    x: Math.round((Number(match[1]) + Number(match[3])) / 2),
    y: Math.round((Number(match[2]) + Number(match[4])) / 2),
  };
}

function hasText(xml, value) {
  return Boolean(nodeFor(xml, 'text', value));
}

function hasDescription(xml, value) {
  return Boolean(nodeFor(xml, 'content-desc', value));
}

function tapNode(xml, attribute, value) {
  const node = nodeFor(xml, attribute, value);
  assert.ok(node, `Could not find ${attribute} "${value}" in the Android UI.`);
  adb('shell', 'input', 'tap', String(node.x), String(node.y));
}

function swipeUp() {
  const size = deviceSize();
  const x = Math.round(size.width / 2);
  adb('shell', 'input', 'swipe', String(x), String(Math.round(size.height * 0.78)), String(x), String(Math.round(size.height * 0.26)), '350');
  wait(250);
}

function deviceSize() {
  const output = adb('shell', 'wm', 'size');
  const matches = [...output.matchAll(/(\d+)x(\d+)/g)];
  assert.ok(matches.length, `Could not read Android viewport size from: ${output}`);
  const last = matches[matches.length - 1];
  const width = Number(last[1]);
  const height = Number(last[2]);
  assert.ok(height > width, `Expected a portrait mobile viewport, received ${width}x${height}.`);
  return { width, height };
}

function waitFor(predicate, description) {
  currentStep = description;
  const deadline = Date.now() + timeoutMs;
  let latest = '';
  while (Date.now() < deadline) {
    latest = uiDump();
    const result = predicate(latest);
    if (result) return result;
    wait(350);
  }
  throw new Error(`Timed out waiting for ${description}.\nLast UI dump:\n${latest}`);
}

function waitForText(text, description = `"${text}"`) {
  return waitFor((xml) => nodeFor(xml, 'text', text) ? xml : null, description);
}

function waitForDescription(text, description = `content description "${text}"`) {
  return waitFor((xml) => nodeFor(xml, 'content-desc', text) ? xml : null, description);
}

function tapTextWhenVisible(text) {
  currentStep = `tap "${text}"`;
  const deadline = Date.now() + timeoutMs;
  let latest = '';
  while (Date.now() < deadline) {
    latest = uiDump();
    if (nodeFor(latest, 'text', text)) {
      tapNode(latest, 'text', text);
      return;
    }
    swipeUp();
  }
  throw new Error(`Could not find "${text}" in the scrollable Profile screen.\nLast UI dump:\n${latest}`);
}

function launch(uri) {
  currentStep = `launch ${uri}`;
  adb('shell', 'am', 'force-stop', packageName);
  adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', uri);
}

function assertHealthySignedInScreen(xml, title) {
  assert.ok(hasText(xml, title), `Expected the ${title} screen.`);
  assert.doesNotMatch(xml, genericFailureCopy, `The ${title} screen showed a generic/auth failure state.`);
  assert.doesNotMatch(xml, /Completing sign in|Try again/, `The ${title} screen did not settle into an honest loaded or empty state.`);
}

function returnToProfile() {
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  return waitForText('Profile', 'the signed-in Profile hub after navigating back');
}

if (!serial) {
  currentStep = 'validate connected Android device';
  throw new Error('Set ANDROID_SERIAL to run the signed-in Profile menu check on a connected Android device.');
}
if (!fs.existsSync(apkPath)) {
  currentStep = 'locate release APK';
  throw new Error(`Release-like APK not found at ${apkPath}. Run pnpm run test:android-auth:release first.`);
}

console.log(`Installing ${path.basename(apkPath)} on ${serial} with adb install -r; the persisted Clerk session will be reused.`);
currentStep = 'verify portrait mobile viewport';
deviceSize();
currentStep = 'install release APK without clearing app data';
adb('install', '-r', apkPath);
launch('lumaloop://profile');

let profile = waitFor((xml) => {
  if (hasText(xml, 'Sign in to view your profile')) {
    throw new Error('The APK did not restore a signed-in Clerk session. Sign in once on this device, then rerun this check.');
  }
  if (genericFailureCopy.test(xml)) {
    throw new Error('The restored session reached a generic/auth failure state instead of the Profile hub.');
  }
  return hasText(xml, 'Profile') && hasText(xml, 'Balance') ? xml : null;
}, 'the restored signed-in Profile hub');
assertHealthySignedInScreen(profile, 'Profile');

for (const destination of [
  { menu: 'Balance', title: 'Balance' },
  { menu: 'Favourite items', title: 'Saved' },
  { menu: 'My orders', title: 'Orders' },
]) {
  currentStep = `open ${destination.menu}`;
  tapTextWhenVisible(destination.menu);
  const screen = waitForText(destination.title, `${destination.title} after tapping ${destination.menu}`);
  assertHealthySignedInScreen(screen, destination.title);
  profile = returnToProfile();
}

currentStep = 'open View profile';
tapNode(profile, 'text', 'View profile');
const viewedProfile = waitForText('View profile', 'the separate View profile destination');
assertHealthySignedInScreen(viewedProfile, 'View profile');
assert.ok(!hasText(viewedProfile, 'Your LumaLoop'), 'View profile opened the account hub instead of the public profile route.');
returnToProfile();

currentStep = 'open Inbox';
profile = waitForDescription('Profile', 'the Profile tab');
tapNode(profile, 'content-desc', 'Inbox');
const inbox = waitForText('Inbox', 'Inbox from the signed-in bottom navigation');
assertHealthySignedInScreen(inbox, 'Inbox');
returnToProfile();

currentStep = 'open Notifications';
launch('lumaloop://notifications');
const notifications = waitForText('Notifications', 'Notifications from the signed-in persisted session');
assertHealthySignedInScreen(notifications, 'Notifications');

console.log('Signed-in Profile menu regression check passed on a portrait mobile viewport.');