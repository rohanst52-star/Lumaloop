import AsyncStorage from '@react-native-async-storage/async-storage';
import { Feather } from '@expo/vector-icons';
import * as Application from 'expo-application';
import Constants from 'expo-constants';
import { File, Paths } from 'expo-file-system';
import * as FileSystem from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import { getGetAndroidUpdateManifestQueryKey, useGetAndroidUpdateManifest, type AndroidUpdateManifest } from '@workspace/api-client-react';
import { sha256 } from 'js-sha256';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '@/hooks/useColors';

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const LAST_CHECK_KEY = 'lumaloop.android-update.last-check';
const DOWNLOAD_STATE_KEY = 'lumaloop.android-update.download';
const PACKAGE_NAME = 'com.lumaloop.app';

type UpdatePhase = 'idle' | 'available' | 'downloading' | 'verifying' | 'error';

type UpdateContextValue = {
  installedVersion: string;
  installedVersionCode: number;
  checking: boolean;
  checkForUpdates: () => Promise<void>;
};

const UpdateContext = createContext<UpdateContextValue | null>(null);

function installedVersionInfo() {
  const configuredVersion = Constants.expoConfig?.version ?? '1.0.0';
  const configuredCode = Constants.expoConfig?.android?.versionCode ?? 1;
  return {
    version: Application.nativeApplicationVersion ?? configuredVersion,
    versionCode: Number(Application.nativeBuildVersion ?? configuredCode),
  };
}

function formatBytes(value?: number) {
  if (!value) return null;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.ceil(value / 1024)} KB`;
}

async function hashFile(uri: string) {
  const hasher = sha256.create();
  const reader = new File(uri).readableStream().getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    hasher.update(chunk.value);
  }
  return hasher.hex();
}

function assertTrustedManifest(manifest: AndroidUpdateManifest) {
  const parsed = new URL(manifest.apkUrl);
  if (parsed.protocol !== 'https:') throw new Error('The update download is not HTTPS.');
  if (manifest.packageName !== PACKAGE_NAME) throw new Error('The update belongs to a different Android app.');
  if (!/^[a-f0-9]{64}$/i.test(manifest.sha256)) throw new Error('The update checksum is invalid.');
}

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const colors = useColors();
  const installed = useMemo(installedVersionInfo, []);
  const query = useGetAndroidUpdateManifest({ query: { queryKey: getGetAndroidUpdateManifestQueryKey(), enabled: false, retry: false } });
  const [checking, setChecking] = useState(false);
  const checkingRef = useRef(false);
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [manifest, setManifest] = useState<AndroidUpdateManifest | null>(null);
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const deferredVersionCode = useRef<number | null>(null);
  const lastCheckedAt = useRef(0);
  const activeDownload = useRef<ReturnType<typeof FileSystem.createDownloadResumable> | null>(null);
  const activeDownloadKey = useRef('');
  const pausePersistence = useRef<Promise<void> | null>(null);

  const runCheck = useCallback(async (manual: boolean) => {
    if (Platform.OS !== 'android') {
      if (manual) setNotice(`LumaLoop ${installed.version} is installed. Direct APK updates are available in the standalone Android app.`);
      return;
    }
    if (checkingRef.current) return;
    checkingRef.current = true;
    setChecking(true);
    try {
      const result = await query.refetch();
      if (!result.data) throw result.error ?? new Error('The update server did not return a release.');
      assertTrustedManifest(result.data);
      lastCheckedAt.current = Date.now();
      await AsyncStorage.setItem(LAST_CHECK_KEY, String(lastCheckedAt.current));
      if (result.data.versionCode <= installed.versionCode) {
        if (manual) Alert.alert('You’re up to date', `LumaLoop ${installed.version} is the latest version.`);
        return;
      }
      if (!manual && !result.data.mandatory && deferredVersionCode.current === result.data.versionCode) return;
      setManifest(result.data);
      setError('');
      setProgress(0);
      setPhase('available');
    } catch {
      if (manual) Alert.alert('Couldn’t check for updates', 'LumaLoop will keep working. Check your connection and try again later.');
    } finally {
      checkingRef.current = false;
      setChecking(false);
    }
  }, [installed.version, installed.versionCode, query.refetch]);

  useEffect(() => {
    let mounted = true;
    void AsyncStorage.getItem(LAST_CHECK_KEY).then((stored) => {
      if (!mounted) return;
      lastCheckedAt.current = Number(stored) || 0;
      void runCheck(false);
    });
    const interval = setInterval(() => void runCheck(false), CHECK_INTERVAL_MS);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && Date.now() - lastCheckedAt.current >= CHECK_INTERVAL_MS) void runCheck(false);
      if ((state === 'background' || state === 'inactive') && activeDownload.current && activeDownloadKey.current) {
        const download = activeDownload.current;
        const storageKey = activeDownloadKey.current;
        pausePersistence.current = download.pauseAsync()
          .then((paused) => AsyncStorage.setItem(storageKey, JSON.stringify(paused)))
          .catch(() => undefined)
          .finally(() => {
            pausePersistence.current = null;
          });
      }
    });
    return () => {
      mounted = false;
      clearInterval(interval);
      subscription.remove();
    };
  }, [runCheck]);

  const dismiss = () => {
    if (!manifest || manifest.mandatory || phase === 'downloading' || phase === 'verifying') return;
    deferredVersionCode.current = manifest.versionCode;
    setPhase('idle');
    setManifest(null);
  };

  const downloadAndInstall = async () => {
    if (!manifest || Platform.OS !== 'android') return;
    let destination = '';
    try {
      assertTrustedManifest(manifest);
      if (manifest.sizeBytes && Paths.availableDiskSpace < manifest.sizeBytes * 1.2) {
        throw new Error('There is not enough free storage for this update.');
      }
      if (!FileSystem.cacheDirectory) throw new Error('Android update storage is unavailable.');
      destination = `${FileSystem.cacheDirectory}lumaloop-${manifest.versionCode}.apk`;
      const savedStateRaw = await AsyncStorage.getItem(DOWNLOAD_STATE_KEY);
      let savedState: FileSystem.DownloadPauseState | null = null;
      try {
        const parsed = savedStateRaw ? JSON.parse(savedStateRaw) : null;
        if (parsed?.url === manifest.apkUrl && parsed?.fileUri === destination && parsed?.resumeData) savedState = parsed;
      } catch {
        savedState = null;
      }
      if (!savedState) await FileSystem.deleteAsync(destination, { idempotent: true });
      setError('');
      setProgress(0);
      setPhase('downloading');
      const download = FileSystem.createDownloadResumable(
        manifest.apkUrl,
        destination,
        {},
        ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
          if (totalBytesExpectedToWrite > 0) setProgress(totalBytesWritten / totalBytesExpectedToWrite);
        },
        savedState?.resumeData,
      );
      activeDownload.current = download;
      activeDownloadKey.current = DOWNLOAD_STATE_KEY;
      await AsyncStorage.setItem(DOWNLOAD_STATE_KEY, JSON.stringify(download.savable()));
      const result = await download.downloadAsync();
      if (!result || (result.status !== 200 && result.status !== 206)) {
        await pausePersistence.current;
        throw new Error('The APK download was interrupted.');
      }
      activeDownload.current = null;
      activeDownloadKey.current = '';
      await AsyncStorage.removeItem(DOWNLOAD_STATE_KEY);
      const info = await FileSystem.getInfoAsync(destination);
      if (!info.exists || !info.size) throw new Error('The downloaded APK is empty.');
      if (manifest.sizeBytes && info.size !== manifest.sizeBytes) throw new Error('The downloaded APK size does not match the release manifest.');
      setPhase('verifying');
      const digest = await hashFile(destination);
      if (digest.toLowerCase() !== manifest.sha256.toLowerCase()) throw new Error('The downloaded APK failed its security check.');
      const contentUri = await FileSystem.getContentUriAsync(destination);
      await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
        data: contentUri,
        type: 'application/vnd.android.package-archive',
        flags: 0x10000001,
      });
      setPhase('available');
    } catch (caught) {
      activeDownload.current = null;
      activeDownloadKey.current = '';
      const message = caught instanceof Error ? caught.message : 'The update could not be installed.';
      const savedStateRaw = await AsyncStorage.getItem(DOWNLOAD_STATE_KEY);
      let hasResumeData = false;
      try {
        hasResumeData = Boolean(savedStateRaw && JSON.parse(savedStateRaw)?.resumeData);
      } catch {
        hasResumeData = false;
      }
      if (!hasResumeData || message.includes('security check') || message.includes('size does not match') || message.includes('empty') || message.includes('not HTTPS')) {
        await AsyncStorage.removeItem(DOWNLOAD_STATE_KEY);
        if (destination) await FileSystem.deleteAsync(destination, { idempotent: true }).catch(() => undefined);
      }
      setError(message);
      setPhase('error');
    }
  };

  const openInstallSettings = () => {
    if (Platform.OS !== 'android') return;
    void IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.MANAGE_UNKNOWN_APP_SOURCES, {
      data: `package:${Application.applicationId ?? PACKAGE_NAME}`,
    }).catch(() => Alert.alert('Open Android settings', 'Allow LumaLoop to install unknown apps, then try the update again.'));
  };

  const value = useMemo<UpdateContextValue>(() => ({
    installedVersion: installed.version,
    installedVersionCode: installed.versionCode,
    checking,
    checkForUpdates: () => runCheck(true),
  }), [checking, installed.version, installed.versionCode, runCheck]);

  const busy = phase === 'downloading' || phase === 'verifying';
  return (
    <UpdateContext.Provider value={value}>
      {children}
      <Modal visible={Boolean(manifest) && phase !== 'idle'} transparent animationType="fade" onRequestClose={dismiss}>
        <View style={modalStyles.backdrop}>
          <View style={[modalStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[modalStyles.icon, { backgroundColor: colors.secondary }]}>
              <Feather name={manifest?.mandatory ? 'shield' : 'download-cloud'} size={25} color={colors.primary} />
            </View>
            <Text style={[modalStyles.eyebrow, { color: colors.primary }]}>{manifest?.mandatory ? 'SECURITY UPDATE REQUIRED' : 'A NEW CHAPTER'}</Text>
            <Text style={[modalStyles.title, { color: colors.foreground }]}>LumaLoop {manifest?.version}</Text>
            <Text style={[modalStyles.copy, { color: colors.mutedForeground }]}>{manifest?.releaseNotes}</Text>
            {manifest?.sizeBytes ? <Text style={[modalStyles.meta, { color: colors.mutedForeground }]}>{formatBytes(manifest.sizeBytes)} · verified before installation</Text> : null}
            {busy && <View style={{ width: '100%', gap: 9 }}>
              <View style={[modalStyles.track, { backgroundColor: colors.muted }]}><View style={[modalStyles.fill, { backgroundColor: colors.primary, width: `${phase === 'verifying' ? 100 : Math.max(3, progress * 100)}%` }]} /></View>
              <Text style={[modalStyles.meta, { color: colors.mutedForeground }]}>{phase === 'verifying' ? 'Verifying SHA-256 integrity…' : `Downloading… ${Math.round(progress * 100)}%`}</Text>
            </View>}
            {phase === 'error' && <View style={[modalStyles.errorBox, { borderColor: colors.border }]}>
              <Text style={[modalStyles.errorText, { color: colors.foreground }]}>{error}</Text>
              <Pressable onPress={openInstallSettings}><Text style={[modalStyles.link, { color: colors.primary }]}>Review install permission</Text></Pressable>
            </View>}
            <Pressable testID="update-now" disabled={busy} onPress={downloadAndInstall} style={[modalStyles.primary, { backgroundColor: busy ? colors.muted : colors.primary }]}>
              {busy ? <ActivityIndicator color={colors.primaryForeground} /> : <Feather name={phase === 'error' ? 'refresh-cw' : 'arrow-down-circle'} size={19} color={colors.primaryForeground} />}
              <Text style={[modalStyles.primaryText, { color: colors.primaryForeground }]}>{phase === 'error' ? 'Try Again' : 'Update Now'}</Text>
            </Pressable>
            {!manifest?.mandatory && !busy && <Pressable testID="update-later" onPress={dismiss} style={modalStyles.later}><Text style={[modalStyles.laterText, { color: colors.mutedForeground }]}>Later</Text></Pressable>}
            {manifest?.mandatory && !busy && <Text style={[modalStyles.mandatory, { color: colors.mutedForeground }]}>You’ll need to install this update before continuing.</Text>}
          </View>
        </View>
      </Modal>
      <Modal visible={Boolean(notice)} transparent animationType="fade" onRequestClose={() => setNotice('')}>
        <View style={modalStyles.backdrop}>
          <View style={[modalStyles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={[modalStyles.icon, { backgroundColor: colors.secondary }]}><Feather name="smartphone" size={25} color={colors.primary} /></View>
            <Text style={[modalStyles.title, { color: colors.foreground }]}>Android updates</Text>
            <Text style={[modalStyles.copy, { color: colors.mutedForeground }]}>{notice}</Text>
            <Pressable testID="update-notice-close" onPress={() => setNotice('')} style={[modalStyles.primary, { backgroundColor: colors.primary }]}>
              <Text style={[modalStyles.primaryText, { color: colors.primaryForeground }]}>Got it</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </UpdateContext.Provider>
  );
}

export function useUpdates() {
  const value = useContext(UpdateContext);
  if (!value) throw new Error('useUpdates must be used inside UpdateProvider');
  return value;
}

const modalStyles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: '#182331aa', justifyContent: 'center', padding: 24 },
  card: { borderRadius: 24, borderWidth: 1, padding: 24, alignItems: 'center', gap: 12 },
  icon: { width: 54, height: 54, borderRadius: 27, alignItems: 'center', justifyContent: 'center' },
  eyebrow: { fontFamily: 'Inter_700Bold', fontSize: 10, letterSpacing: 1.4, marginTop: 2 },
  title: { fontFamily: 'Inter_700Bold', fontSize: 25, letterSpacing: -0.5 },
  copy: { fontFamily: 'Inter_400Regular', fontSize: 14, lineHeight: 21, textAlign: 'center' },
  meta: { fontFamily: 'Inter_500Medium', fontSize: 11, textAlign: 'center' },
  track: { height: 8, borderRadius: 4, overflow: 'hidden' },
  fill: { height: 8, borderRadius: 4 },
  errorBox: { width: '100%', borderWidth: 1, borderRadius: 14, padding: 12, gap: 8 },
  errorText: { fontFamily: 'Inter_500Medium', fontSize: 13, lineHeight: 18, textAlign: 'center' },
  link: { fontFamily: 'Inter_600SemiBold', fontSize: 12, textAlign: 'center' },
  primary: { width: '100%', minHeight: 52, borderRadius: 16, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  primaryText: { fontFamily: 'Inter_700Bold', fontSize: 15 },
  later: { minHeight: 42, justifyContent: 'center', paddingHorizontal: 20 },
  laterText: { fontFamily: 'Inter_600SemiBold', fontSize: 14 },
  mandatory: { fontFamily: 'Inter_400Regular', fontSize: 11, textAlign: 'center', lineHeight: 16 },
});