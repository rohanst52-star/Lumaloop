import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readProjectFile = (relativePath: string): Promise<string> => readFile(path.join(projectRoot, relativePath), 'utf8');

describe('signed-in Profile menu regression guard', () => {
  test('keeps persisted-session requests authorized and provisioning bounded', async () => {
    const layoutSource = await readProjectFile('app/_layout.tsx');

    assert.match(layoutSource, /setAuthTokenGetter\(usesBearerAuth \? \(\) => getTokenRef\.current\(\) : null\)/);
    assert.match(layoutSource, /const token = usesBearerAuth \? await getTokenRef\.current\(\) : null/);
    assert.match(layoutSource, /Authorization: `Bearer \$\{token\}`/);
    assert.match(layoutSource, /\}, \[isSignedIn, profileAvatar, profileName, provisionAttempt, userId\]\);/);
    assert.doesNotMatch(layoutSource, /\}, \[.*\buser\b.*\]\);/);
    assert.match(layoutSource, /if \(ready\) return children/);
  });

  test('prevents overlapping retry requests', async () => {
    const uiSource = await readProjectFile('components/ui.tsx');

    assert.match(uiSource, /if \(retrying \|\| retryPending\) return;/);
    assert.match(uiSource, /setRetryPending\(true\)/);
    assert.match(uiSource, /disabled=\{isRetrying\}/);
  });

  test('keeps every Profile destination protected and distinct from View profile', async () => {
    const screensSource = await readProjectFile('screens.tsx');

    for (const expression of [
      /useGetSellerBalance\(\{ query: \{ enabled: Boolean\(isSignedIn\) \}/,
      /useListFavourites\(\{ query: \{ enabled: Boolean\(isSignedIn\) \}/,
      /useListOrders\(\{ query: \{ enabled: Boolean\(isSignedIn\) \}/,
      /useListConversations\(\{ query: \{ enabled: Boolean\(isSignedIn\) \}/,
      /useListNotifications\(\{ query: \{ enabled: Boolean\(isSignedIn\)/,
    ]) {
      assert.match(screensSource, expression);
    }

    assert.match(screensSource, /typeof id === 'string' \? <ProfileDetailScreen \/> : <ProfileHubScreen \/>/);
    assert.match(screensSource, /title=\{isOwnProfile \? 'Profile' : 'View profile'\}/);
    assert.match(screensSource, /accessibilityLabel="View profile"/);
    assert.match(screensSource, /title="Balance".*router\.push\('\/balance'/s);
    assert.match(screensSource, /title="Favourite items".*router\.push\('\/favourites'/s);
    assert.match(screensSource, /title="My orders".*router\.push\('\/orders'/s);
  });
});