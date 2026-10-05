import * as WebBrowser from 'expo-web-browser';
import { Platform, Text, View } from 'react-native';
import { callbackMessage } from '@/lib/auth-handoff';

const EXPO_AUTH_HANDLE = 'ExpoWebBrowserRedirectHandle';

let completion: { type: string; message?: string };
if (Platform.OS === 'web') {
  try {
    completion = WebBrowser.maybeCompleteAuthSession({ skipRedirectCheck: true });
  } catch (error) {
    console.error('Google sign-in callback could not complete', error);
    completion = { type: 'failed', message: 'The sign-in window could not reconnect to LumaLoop.' };
  }
} else {
  completion = { type: 'success', message: 'Completing native sign in' };
}

if (
  Platform.OS === 'web'
  && completion.type !== 'success'
  && typeof window !== 'undefined'
  && window.opener
) {
  try {
    // Replit Preview embeds the app in an iframe. Chrome partitions storage for
    // that iframe, so this top-level OAuth popup cannot read the auth handle
    // from its own localStorage. The same-origin opener can still provide it.
    const handle = window.opener.localStorage.getItem(EXPO_AUTH_HANDLE);
    if (handle) {
      window.opener.postMessage(
        { url: window.location.href, expoSender: handle },
        window.location.origin,
      );
      completion = { type: 'success', message: 'Attempting to complete auth' };
    }
  } catch (error) {
    console.error('Google sign-in callback could not reach its opener', error);
  }
}

if (Platform.OS === 'web' && completion.type === 'success' && typeof window !== 'undefined') {
  window.setTimeout(() => window.close(), 250);
  window.setTimeout(() => window.close(), 1000);
}

export default function SSOCallback() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f8f1e7' }}>
      <Text style={{ color: '#182331' }}>
        {callbackMessage(completion.type)}
      </Text>
    </View>
  );
}