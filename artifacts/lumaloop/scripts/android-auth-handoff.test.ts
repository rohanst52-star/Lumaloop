import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { callbackMessage, GOOGLE_SIGN_IN_ERROR, GOOGLE_SIGN_UP_ERROR, NATIVE_GOOGLE_REDIRECT_URL, resolveGoogleAuthHandoff } from '../lib/auth-handoff';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readProjectFile = (relativePath: string): Promise<string> => readFile(path.join(projectRoot, relativePath), 'utf8');

describe('Android Google auth handoff', () => {
  test('maps successful, cancelled, and interrupted handoffs to stable app states', () => {
    assert.equal(resolveGoogleAuthHandoff({ createdSessionId: 'sess_123' }), 'success');
    assert.equal(resolveGoogleAuthHandoff({ createdSessionId: null }), 'cancelled');
    assert.equal(resolveGoogleAuthHandoff({}), 'cancelled');
    assert.equal(resolveGoogleAuthHandoff(undefined, new Error('browser closed')), 'interrupted');
  });

  test('keeps callback copy product-facing for every callback result', () => {
    const messages = [callbackMessage('success'), callbackMessage('failed'), callbackMessage('cancelled')];
    for (const message of messages) {
      assert.doesNotMatch(message, /not supported|expo|clerk|auth-session|provider/i);
    }
    assert.equal(callbackMessage('success'), 'Completing sign in…');
    assert.match(callbackMessage('failed'), /Return to LumaLoop/);
    assert.equal(GOOGLE_SIGN_IN_ERROR, 'Google sign-in was cancelled or could not be completed. Try again.');
    assert.equal(GOOGLE_SIGN_UP_ERROR, 'Google sign-up was cancelled or could not be completed. Try again.');
  });

  test('keeps the native redirect and callback platform guard intact', async () => {
    const [callbackSource, screensSource, layoutSource, appConfigSource, manifestSource, gradleSource] = await Promise.all([
      readProjectFile('app/sso-callback.tsx'),
      readProjectFile('screens.tsx'),
      readProjectFile('app/_layout.tsx'),
      readProjectFile('app.json'),
      readProjectFile('android/app/src/main/AndroidManifest.xml'),
      readProjectFile('android/app/build.gradle'),
    ]);

    assert.equal(NATIVE_GOOGLE_REDIRECT_URL, 'lumaloop://sso-callback');
    assert.match(callbackSource, /if \(Platform\.OS === 'web'\)/);
    assert.match(callbackSource, /maybeCompleteAuthSession/);
    assert.doesNotMatch(callbackSource, /Not supported on this platform/i);
    assert.doesNotMatch(callbackSource, /completion\.message/);
    assert.match(screensSource, /startSSOFlow\(\{ strategy: 'oauth_google', redirectUrl: googleRedirectUrl\(\) \}\)/);
    assert.match(screensSource, /native: NATIVE_GOOGLE_REDIRECT_URL/);
    assert.match(layoutSource, /name="sso-callback"/);
    assert.match(layoutSource, /pathname === '\/sso-callback'/);
    assert.match(appConfigSource, /"scheme":\s*"lumaloop"/);
    assert.match(manifestSource, /android:launchMode="singleTask"/);
    assert.match(manifestSource, /android:scheme="lumaloop"/);
    assert.match(gradleSource, /assembleRelease/);
    assert.match(gradleSource, /Release APK signer fingerprint does not match/);
  });
});