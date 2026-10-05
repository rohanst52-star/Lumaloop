import React, { useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import { router, Stack, usePathname } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { ClerkLoaded, ClerkProvider, useAuth, useClerk, useUser } from '@clerk/expo';
import { tokenCache } from '@clerk/expo/token-cache';
import { setAuthTokenGetter, setBaseUrl } from '@workspace/api-client-react';
import { Feather } from '@expo/vector-icons';
import { Platform, Pressable, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';
import { UpdateProvider } from '@/components/UpdateProvider';

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      retryDelay: 1_000,
    },
  },
});
const apiDomain = process.env.EXPO_PUBLIC_DOMAIN?.trim();
const apiOrigin = (() => {
  if (!apiDomain) return null;
  try {
    const candidate = new URL(/^https?:\/\//i.test(apiDomain) ? apiDomain : `https://${apiDomain}`);
    return candidate.protocol === 'https:' && candidate.pathname === '/' && !candidate.search && !candidate.hash
      ? candidate.origin
      : null;
  } catch {
    return null;
  }
})();
setBaseUrl(apiOrigin);
const invalidNativeApiConfiguration = Platform.OS !== 'web' && !apiOrigin;
const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY!;
const proxyUrl = process.env.EXPO_PUBLIC_CLERK_PROXY_URL || undefined;
const usesBearerAuth = Platform.OS !== 'web'
  || (typeof window !== 'undefined' && Boolean(apiOrigin) && apiOrigin !== window.location.origin);

function AuthTokenBridge({ children }: { children: React.ReactNode }) {
  const { getToken, isSignedIn, userId } = useAuth();
  const { user } = useUser();
  const [ready, setReady] = useState(false);
  const [provisionError, setProvisionError] = useState<string | null>(null);
  const [provisionAttempt, setProvisionAttempt] = useState(0);
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const profileName = user?.fullName || user?.firstName || user?.primaryEmailAddress?.emailAddress.split('@')[0] || 'LumaLoop member';
  const profileAvatar = user?.imageUrl || '';

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setProvisionError(null);
    setAuthTokenGetter(usesBearerAuth ? () => getTokenRef.current() : null);

    const provision = async () => {
      if (!isSignedIn || !userId) {
        if (!cancelled) setReady(true);
        return;
      }

      try {
        const token = usesBearerAuth ? await getTokenRef.current() : null;
        if (usesBearerAuth && !token) throw new Error("Could not restore the signed-in session.");
        const origin = apiOrigin ?? '';
        const response = await fetch(`${origin}/api/me`, {
          method: 'PUT',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ name: profileName, avatar: profileAvatar }),
        });
        if (!response.ok) throw new Error(`Account setup failed (${response.status}).`);
        if (!cancelled) setReady(true);
      } catch (error) {
        if (!cancelled) {
          setProvisionError(error instanceof Error ? error.message : 'Account setup failed.');
        }
      }
    };

    void provision();
    return () => {
      cancelled = true;
      setReady(false);
      setAuthTokenGetter(null);
    };
  }, [isSignedIn, profileAvatar, profileName, provisionAttempt, userId]);

  if (ready) return children;
  if (provisionError) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: '#f8f1e7' }}>
        <Text style={{ color: '#182331', fontSize: 22, fontWeight: '700', textAlign: 'center' }}>Your account is not ready yet</Text>
        <Text style={{ color: '#6d726f', fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 10 }}>We couldn’t finish connecting your account. Check your connection, then try again.</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry account setup"
          onPress={() => setProvisionAttempt((attempt) => attempt + 1)}
          style={{ minHeight: 48, minWidth: 150, borderRadius: 14, marginTop: 22, paddingHorizontal: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f2644c' }}
        >
          <Text style={{ color: '#fffaf3', fontWeight: '700' }}>Try again</Text>
        </Pressable>
      </View>
    );
  }
  return null;
}

function AuthCacheBridge() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  const previousUserId = useRef<string | null | undefined>(undefined);

  useEffect(() => addListener(({ user }) => {
    const userId = user?.id ?? null;
    if (previousUserId.current !== undefined && previousUserId.current !== userId) {
      client.clear();
    }
    previousUserId.current = userId;
  }), [addListener, client]);

  return null;
}

function RootLayoutNav() {
  return (
    <Stack screenOptions={{ headerBackTitle: 'Back', contentStyle: { backgroundColor: '#f8f1e7' }, headerTintColor: '#182331' }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="search" options={{ headerShown: false }} />
      <Stack.Screen name="product/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="sell" options={{ headerShown: false }} />
      <Stack.Screen name="messages/[conversationId]" options={{ headerShown: false }} />
      <Stack.Screen name="offers" options={{ headerShown: false }} />
      <Stack.Screen name="orders" options={{ headerShown: false }} />
      <Stack.Screen name="balance" options={{ headerShown: false }} />
      <Stack.Screen name="profile/[id]" options={{ headerShown: false }} />
      <Stack.Screen name="settings" options={{ headerShown: false }} />
      <Stack.Screen name="notifications" options={{ headerShown: false }} />
      <Stack.Screen name="report" options={{ headerShown: false }} />
      <Stack.Screen name="admin" options={{ headerShown: false }} />
      <Stack.Screen name="sign-in" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="sign-up" options={{ headerShown: false, presentation: 'modal' }} />
      <Stack.Screen name="sso-callback" options={{ headerShown: false }} />
    </Stack>
  );
}

function BottomNav() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const pathname = usePathname();
  const { isSignedIn } = useAuth();
  const hidden = pathname === '/sign-in' || pathname === '/sign-up' || pathname === '/sso-callback';
  if (hidden) return null;

  const isActive = (route: string) => route === '/' ? pathname === '/' : pathname.startsWith(route);
  const go = (route: string) => router.push(route as any);
  const item = (route: string, icon: string, label: string) => {
    const active = isActive(route);
    return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={() => go(route)} style={({ pressed }) => [{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 }, pressed && { opacity: .7 }]}><Feather name={icon as any} size={22} color={active ? colors.primary : colors.mutedForeground} /><Text style={{ color: active ? colors.primary : colors.mutedForeground, fontFamily: 'Inter_500Medium', fontSize: 11 }}>{label}</Text></Pressable>;
  };

  return <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 68 + insets.bottom, paddingBottom: insets.bottom, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.background, zIndex: 20 }}><View style={{ flex: 1, flexDirection: 'row', alignItems: 'center' }}>{item('/', 'home', 'Home')}{item('/search', 'grid', 'Browse')}<Pressable accessibilityRole="button" accessibilityLabel="Sell an item" onPress={() => go(isSignedIn ? '/sell' : '/sign-in')} style={({ pressed }) => [{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 4 }, pressed && { opacity: .7 }]}><View style={{ width: 46, height: 46, borderRadius: 23, marginTop: -20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.primary, borderWidth: 4, borderColor: colors.background }}><Feather name="plus" size={24} color={colors.primaryForeground} /></View><Text style={{ color: colors.foreground, fontFamily: 'Inter_500Medium', fontSize: 11 }}>Sell</Text></Pressable>{item('/messages', 'message-circle', 'Inbox')}{item('/profile', 'user', 'Profile')}</View></View>;
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;
  if (!publishableKey) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: '#f8f1e7' }}>
          <Text style={{ color: '#182331', fontSize: 22, fontWeight: '700', textAlign: 'center' }}>LumaLoop needs an app configuration update</Text>
          <Text style={{ color: '#6d726f', fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 10 }}>Please install the latest LumaLoop release.</Text>
        </View>
      </SafeAreaProvider>
    );
  }
  if (invalidNativeApiConfiguration) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, backgroundColor: '#f8f1e7' }}>
          <Text style={{ color: '#182331', fontSize: 22, fontWeight: '700', textAlign: 'center' }}>LumaLoop needs an app configuration update</Text>
          <Text style={{ color: '#6d726f', fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 10 }}>This release cannot securely reach LumaLoop. Please install the latest version.</Text>
        </View>
      </SafeAreaProvider>
    );
  }

  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache} proxyUrl={proxyUrl}>
      <ClerkLoaded>
        <SafeAreaProvider>
          <ErrorBoundary>
            <QueryClientProvider client={queryClient}>
              <AuthTokenBridge>
                <AuthCacheBridge />
                <UpdateProvider>
                  <GestureHandlerRootView>
                    <KeyboardProvider>
                      <View style={{ flex: 1 }}>
                        <RootLayoutNav />
                        <BottomNav />
                      </View>
                    </KeyboardProvider>
                  </GestureHandlerRootView>
                </UpdateProvider>
              </AuthTokenBridge>
            </QueryClientProvider>
          </ErrorBoundary>
        </SafeAreaProvider>
      </ClerkLoaded>
    </ClerkProvider>
  );
}
