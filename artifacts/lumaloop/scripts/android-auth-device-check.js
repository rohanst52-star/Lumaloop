const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const serial = process.env.ANDROID_SERIAL;
const apkPath = process.env.ANDROID_AUTH_APK
  ? path.resolve(process.env.ANDROID_AUTH_APK)
  : path.resolve(__dirname, '../android/app/build/outputs/apk/release/app-release.apk');
const packageName = 'com.lumaloop.app';
const callbackUrl = 'lumaloop://sso-callback';
const forbiddenCopy = /not supported on this platform|expo-auth-session|clerk|provider implementation/i;

if (!serial) {
  throw new Error('Set ANDROID_SERIAL to run the native Android auth handoff check on a connected release-like device.');
}
if (!fs.existsSync(apkPath)) {
  throw new Error(`Release-like APK not found at ${apkPath}. Run pnpm run test:android-auth:release first.`);
}

function adb(...args) {
  return execFileSync('adb', ['-s', serial, ...args], { encoding: 'utf8' }).trim();
}

function wait(milliseconds) {
  execFileSync('sleep', [String(milliseconds / 1000)]);
}

function uiDump() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/lumaloop-auth-window.xml');
  return adb('exec-out', 'cat', '/sdcard/lumaloop-auth-window.xml');
}

function tapText(xml, text) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xml.match(new RegExp(`<node[^>]*text="${escaped}"[^>]*bounds="\\[(\\d+),(\\d+)\\]\\[(\\d+),(\\d+)\\]"`));
  assert.ok(match, `Could not find "${text}" in the Android UI.`);
  const x = Math.round((Number(match[1]) + Number(match[3])) / 2);
  const y = Math.round((Number(match[2]) + Number(match[4])) / 2);
  adb('shell', 'input', 'tap', String(x), String(y));
}

console.log(`Installing ${path.basename(apkPath)} on ${serial}...`);
adb('install', '-r', apkPath);
adb('shell', 'am', 'force-stop', packageName);
adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', 'lumaloop://sign-in');
wait(1500);

const signInUi = uiDump();
assert.match(signInUi, /Continue with Google/, 'The release-like app did not show the Google sign-in action.');
tapText(signInUi, 'Continue with Google');
wait(2000);

const providerActivity = adb('shell', 'dumpsys', 'activity', 'activities');
assert.match(providerActivity, /mResumedActivity=.*(browser|customtab|chrome|com\.google\.android\.gms)/i, 'Google sign-in did not leave LumaLoop for the provider handoff.');

console.log('Returning through lumaloop://sso-callback...');
adb('shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', callbackUrl);
wait(1200);

const callbackUi = uiDump();
assert.match(callbackUi, /Completing sign in/);
assert.doesNotMatch(callbackUi, forbiddenCopy);
assert.match(adb('shell', 'dumpsys', 'activity', 'activities'), /com\.lumaloop\.app/);
console.log('Android auth callback passed without provider implementation details.');