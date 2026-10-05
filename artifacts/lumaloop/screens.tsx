import { Feather, Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { makeRedirectUri } from 'expo-auth-session';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { File } from 'expo-file-system';
import { fetch as expoFetch } from 'expo/fetch';
import * as Location from 'expo-location';
import * as Linking from 'expo-linking';
import { Image } from 'expo-image';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, KeyboardTypeOptions, Platform, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { KeyboardAwareScrollView, KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAuth, useClerk, useSignIn, useSignUp, useSSO, useUser } from '@clerk/expo';
import type { CreateProductInput, UserProfile } from '@workspace/api-client-react';
import { useColors } from '@/hooks/useColors';
import { categoryCatalog, localImages } from '@/lib/data';
import { GOOGLE_SIGN_IN_ERROR, GOOGLE_SIGN_UP_ERROR, NATIVE_GOOGLE_REDIRECT_URL, resolveGoogleAuthHandoff } from '@/lib/auth-handoff';
import { Avatar, Chip, EmptyState, ErrorState, FadeIn, Field, Header, ListingImage, LoadingState, Logo, PrimaryButton, ProductCard, Screen, SearchBar, SectionTitle, styles } from '@/components/ui';
import { useUpdates } from '@/components/UpdateProvider';
import { useAddFavourite, useAnalyzeListingPhotos, useAnalyzeSellEverything, useCalculateBuyerProtectionFee, useCleanupListingPhotoUploads, useConfirmOrderDelivery, useCreateBoostCheckout, useCreateBuyerProtectionCase, useCreateListingCheckout, useCreateListingsBatch, useCreateOffer, useCreateProduct, useCreateReport, useCreateReview, useGetAdminOverview, useGetCurrentUserProfile, useGetHomeFeed, useGetOfferRange, useGetProduct, useGetSellerBalance, useGetUserProfile, useListAdminReports, useListConversations, useListFavourites, useListMessages, useListMyOffers, useListNotifications, useListOrders, useListProducts, useListSales, useMarkAllNotificationsRead, useMarkNotificationRead, useRemoveFavourite, useRequestBalanceWithdrawal, useRequestListingPhotoUpload, useSendMessage, useStartSellerPayoutOnboarding, useUpdateAdminReport, useUpdateOrderStatus } from '@workspace/api-client-react';

const money = (value: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' }).format(value);
const dateLabel = (value: string) => new Date(value).toLocaleDateString('en-GB', { month: 'short', day: 'numeric' });
const googleRedirectUrl = () => {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return new URL('/sso-callback', window.location.origin).toString();
  }
  return makeRedirectUri({
    scheme: 'lumaloop',
    path: 'sso-callback',
    native: NATIVE_GOOGLE_REDIRECT_URL,
  });
};
type SupportedPhotoType = 'image/jpeg' | 'image/png' | 'image/webp';
type SelectedPhoto = { uri: string; contentType: SupportedPhotoType; size?: number };

const photoType = (asset: ImagePicker.ImagePickerAsset): SupportedPhotoType | null => {
  const declared = asset.mimeType?.toLowerCase();
  if (declared === 'image/jpeg' || declared === 'image/png' || declared === 'image/webp') return declared;
  const path = `${asset.fileName ?? ''} ${asset.uri}`.toLowerCase();
  if (/\.(?:jpg|jpeg)(?:[?#\s]|$)/.test(path)) return 'image/jpeg';
  if (/\.png(?:[?#\s]|$)/.test(path)) return 'image/png';
  if (/\.webp(?:[?#\s]|$)/.test(path)) return 'image/webp';
  return null;
};

const publishError = (error: unknown): { title: string; message: string } => {
  const raw = error instanceof Error ? error.message : '';
  const detail = raw.replace(/^HTTP \d+\s*[^:]*:\s*/i, '').trim();
  if (/401|authentication|sign in|session/i.test(raw)) return { title: 'Sign in again', message: 'Your session expired before the photos could be published. Sign in again, then retry this draft.' };
  if (/15 MB|unsupported|JPEG|PNG|WebP|image type/i.test(raw)) return { title: 'Photo not supported', message: detail || 'Use a JPEG, PNG or WebP photo no larger than 15 MB.' };
  if (/storage|prepare/i.test(raw)) return { title: 'Photo storage unavailable', message: detail || 'Photo storage is temporarily unavailable. Your draft is still here; try again shortly.' };
  if (/network|fetch|timeout|timed out|connection|upload/i.test(raw)) return { title: 'Connection interrupted', message: 'The photo transfer did not finish. Your draft and selected photos are still here; check your connection and retry.' };
  return { title: 'Listing not published', message: detail || 'The server could not publish this listing. Your draft is still here so you can try again.' };
};

const analysisError = (error: unknown): { title: string; message: string } => {
  const raw = error instanceof Error ? error.message : '';
  const detail = raw.replace(/^HTTP \d+\s*[^:]*:\s*/i, '').trim();
  if (/401|authentication|sign in|session/i.test(raw)) return { title: 'Sign in again', message: 'Your session expired before the photos could be analysed. Sign in again, then retry.' };
  if (/429|six requests|limited/i.test(raw)) return { title: 'AI is taking a breather', message: detail || 'Wait a minute, then try analysing these photos again.' };
  if (/15 MB|unsupported|JPEG|PNG|WebP|image type/i.test(raw)) return { title: 'Photo not supported', message: detail || 'Use a JPEG, PNG or WebP photo no larger than 15 MB.' };
  if (/storage|prepare/i.test(raw)) return { title: 'Photo storage unavailable', message: detail || 'Photo storage is temporarily unavailable. Your selected photos are still here; try again shortly.' };
  if (/network|fetch|timeout|timed out|connection|upload/i.test(raw)) return { title: 'Connection interrupted', message: 'The photo transfer or analysis did not finish. Your selected photos are still here; check your connection and retry.' };
  return { title: 'Analysis unavailable', message: detail || 'AI could not analyse these photos right now. You can retry or complete the listing manually.' };
};
const navigateAfterAuth = ({ session, decorateUrl }: { session?: { currentTask?: unknown } | null; decorateUrl: (url: string) => string }) => {
  if (session?.currentTask) return;
  const destination = decorateUrl('/');
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    window.location.replace(destination);
    return;
  }
  router.replace(destination as any);
};

function useWarmUpBrowser() {
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    void WebBrowser.warmUpAsync();
    return () => {
      void WebBrowser.coolDownAsync();
    };
  }, []);
}

type CategoryCard = { id: string; name: string; count: number; image: any; icon: string; blurb: string };

function CategoryTile({ category, compact = false }: { category: CategoryCard; compact?: boolean }) {
  const colors = useColors();
  const empty = category.count === 0;
  const countLabel = `${category.count} ${category.count === 1 ? 'piece' : 'pieces'}`;
  return <Pressable accessibilityRole="button" accessibilityLabel={empty ? `Browse ${category.name}, nothing listed yet` : `Browse ${category.name}, ${countLabel}`} onPress={() => router.push(`/search?category=${category.name}` as any)} style={({ pressed }) => [{ width: compact ? '48%' : 132, height: compact ? 124 : 144, borderRadius: 20, overflow: 'hidden', backgroundColor: colors.secondary }, pressed && { opacity: .84, transform: [{ scale: .97 }] }]}><Image source={category.image} contentFit="cover" style={{ width: '100%', height: '100%', opacity: .78 }} /><View style={{ position: 'absolute', inset: 0, backgroundColor: '#18233155' }} /><View style={{ position: 'absolute', left: 12, right: 10, top: 11, flexDirection: 'row', justifyContent: 'space-between' }}><View style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: '#fffaf3dd', alignItems: 'center', justifyContent: 'center' }}><Feather name={category.icon as any} size={14} color={colors.foreground} /></View><Text style={{ color: '#fffaf3', fontFamily: 'Inter_600SemiBold', fontSize: 10, backgroundColor: '#182331aa', paddingHorizontal: 7, paddingVertical: 4, borderRadius: 10 }}>{empty ? 'Nothing listed yet' : countLabel}</Text></View><View style={{ position: 'absolute', left: 12, bottom: 12 }}><Text style={{ color: '#fffaf3', fontFamily: 'Inter_700Bold', fontSize: 16 }}>{category.name}</Text><Text style={{ color: '#fffaf3cc', fontFamily: 'Inter_400Regular', fontSize: 10, marginTop: 2 }}>{empty ? 'Nothing listed yet' : category.blurb}</Text></View></Pressable>;
}

function CategoryRail({ selected }: { selected?: string }) {
  const current = selected?.toLowerCase();
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 20 }}><Chip label="All" active={!current} onPress={() => router.push('/search' as any)} />{categoryCatalog.map((category) => <Chip key={category.id} label={category.name} active={current === category.name.toLowerCase()} onPress={() => router.push(`/search?category=${category.name}` as any)} />)}</ScrollView>;
}

function AuthRequired({ title, detail }: { title: string; detail: string }) {
  return <EmptyState icon="lock" title={title} detail={detail} action="Sign in" onPress={() => router.push('/sign-in' as any)} />;
}

function profileFromClerk(user: ReturnType<typeof useUser>['user']): UserProfile | null {
  if (!user) return null;
  return {
    id: user.id,
    name: user.fullName || user.firstName || user.primaryEmailAddress?.emailAddress.split('@')[0] || 'LumaLoop member',
    rating: 0,
    reviewCount: 0,
    reviews: [],
    avatar: user.imageUrl || '',
    location: 'United Kingdom',
    joinedAt: user.createdAt?.toISOString() || new Date().toISOString(),
    bio: '',
  };
}

export function HomeScreen() {
  const colors = useColors();
  const { isSignedIn } = useAuth();
  const feedQuery = useGetHomeFeed({
    query: { retry: 1, retryDelay: 1_000 } as any,
    request: { timeoutMs: 10_000 },
  });
  const notificationsQuery = useListNotifications({ query: { enabled: Boolean(isSignedIn), refetchInterval: 15_000 } as any });
  const unreadNotifications = notificationsQuery.data?.filter((notification) => !notification.readAt).length ?? 0;
  const raw = feedQuery.data;
  const categories = (raw?.categories ?? []).map((category) => {
    const metadata = categoryCatalog.find((item) => item.id === category.id || item.name.toLowerCase() === category.name.toLowerCase());
    return {
      ...metadata,
      ...category,
      image: category.image ?? metadata?.image ?? localImages.home,
      icon: metadata?.icon ?? 'grid',
      blurb: metadata?.blurb ?? 'Find something good',
    };
  });
  const data = raw ? { ...raw, categories } : null;
  const [homeSearch, setHomeSearch] = useState('');
  const homeSearchQuery = useListProducts({ search: homeSearch.trim() || undefined, limit: 30 });
  const searchSource = homeSearchQuery.data?.items ?? [];
  const searchTerm = homeSearch.trim().toLowerCase();
  const homeSearchResults = searchTerm ? searchSource.filter((item) => `${item.title} ${item.description} ${item.category}`.toLowerCase().includes(searchTerm)) : [];
  if (feedQuery.isLoading) return <Screen><LoadingState /></Screen>;
  if (feedQuery.isError || !data) {
    const message = feedQuery.error instanceof Error ? feedQuery.error.message : '';
    const detail = /timed out|network request failed|failed to fetch|connection/i.test(message)
      ? 'LumaLoop couldn’t reach the marketplace. Check your connection, then try again.'
      : 'The marketplace is temporarily unavailable. Please try again shortly.';
    return <Screen><ErrorState detail={detail} retrying={feedQuery.isFetching} onRetry={() => { if (!feedQuery.isFetching) void feedQuery.refetch(); }} /></Screen>;
  }
  return <Screen>
    <FadeIn>
      <View style={{ paddingTop: 10, flexDirection: 'row', alignItems: 'center' }}>
        <Logo />
        <View style={{ marginLeft: 'auto', flexDirection: 'row', gap: 18 }}>
          <Pressable accessibilityLabel={unreadNotifications ? `Notifications, ${unreadNotifications} unread` : 'Notifications'} onPress={() => router.push('/notifications' as any)}>
            <Ionicons name="notifications-outline" size={24} color={colors.foreground} />
            {unreadNotifications > 0 && <View style={styles.badge}><Text style={styles.badgeText}>{unreadNotifications > 99 ? '99+' : unreadNotifications}</Text></View>}
          </Pressable>
        </View>
      </View>
      <View style={{ marginTop: 24 }}>
        <SearchBar value={homeSearch} onChangeText={setHomeSearch} />
      </View>
    </FadeIn>
    {homeSearch.trim() ? <View style={{ marginTop: 24 }}>
      <SectionTitle title="Search results" action={`${homeSearchResults.length} finds`} />
      <View style={styles.grid}>{homeSearchResults.map((item) => <ProductCard key={item.id} product={item} />)}</View>
      {homeSearchResults.length === 0 && <EmptyState icon="search" title="Nothing here yet" detail="Try a different word or browse all categories below." />}
    </View> : <><SectionTitle title="Fresh finds" action="Browse all" onPress={() => router.push('/search' as any)} />
      {data.featured.length ? <View style={styles.grid}>{data.featured.map((item) => <ProductCard key={item.id} product={item} />)}</View> : <EmptyState icon="shopping-bag" title="No listings yet" detail="New pieces will appear here as the community lists them." />}
      <View style={{ marginTop: 28, marginBottom: 2, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <View><Text style={styles.sectionTitle}>Find your kind of good</Text><Text style={[styles.muted, { marginTop: 4, fontSize: 13 }]}>All categories, all in one place</Text></View>
        <Pressable onPress={() => router.push('/search' as any)}><Text style={styles.link}>Search all</Text></Pressable>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingVertical: 14 }}>{data.categories.map((category) => <CategoryTile key={category.id} category={category} compact />)}</View>
      <View style={{ marginTop: 12, borderRadius: 20, padding: 18, backgroundColor: colors.accent, flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: '#fffaf388', alignItems: 'center', justifyContent: 'center' }}><Feather name="refresh-cw" size={19} color={colors.accentForeground} /></View>
        <View style={{ flex: 1 }}><Text style={[styles.sellerName, { color: colors.accentForeground }]}>Keep good things moving</Text><Text style={[styles.muted, { color: colors.accentForeground, opacity: .8, fontSize: 12, marginTop: 3 }]}>Every piece has another chapter.</Text></View>
        <Feather name="arrow-up-right" size={20} color={colors.accentForeground} />
      </View>
      <SectionTitle title="Freshly looped" action="Explore" onPress={() => router.push('/search?sort=newest' as any)} />
      <View style={styles.grid}>{data.recommended.map((item) => <ProductCard key={item.id} product={item} />)}</View>
    </>}
  </Screen>;
}

export function SearchScreen() {
  const colors = useColors();
  const params = useLocalSearchParams<{ category?: string; sort?: string }>();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState(params.sort === 'newest' || params.sort === 'price_low' || params.sort === 'price_high' ? params.sort : 'recommended');
  const [pickupOnly, setPickupOnly] = useState(false);
  const [radiusKm, setRadiusKm] = useState<number | undefined>();
  const [coordinates, setCoordinates] = useState<{ latitudeE6: number; longitudeE6: number } | null>(null);
  const getLocation = async () => {
    if (Platform.OS === 'web') {
      if (!navigator.geolocation) return Alert.alert('Location unavailable', 'Enter a pickup filter on a device that supports location.');
      navigator.geolocation.getCurrentPosition((position) => setCoordinates({ latitudeE6: Math.round(position.coords.latitude * 1e6), longitudeE6: Math.round(position.coords.longitude * 1e6) }), () => Alert.alert('Location not shared', 'You can still browse all pickup listings.'));
      return;
    }
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return Alert.alert('Location not shared', 'You can still browse all pickup listings.');
    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    setCoordinates({ latitudeE6: Math.round(position.coords.latitude * 1e6), longitudeE6: Math.round(position.coords.longitude * 1e6) });
  };
  const queryParams = useMemo(() => ({ search: search || undefined, category: params.category, sort: sort as any, limit: 30, pickup: pickupOnly || undefined, radiusKm: coordinates ? radiusKm : undefined, ...coordinates }), [search, params.category, sort, pickupOnly, radiusKm, coordinates]);
  const query = useListProducts(queryParams);
  const source = query.data?.items ?? [];
  const shown = source.filter((item) => !params.category || item.category.toLowerCase() === params.category.toLowerCase()).filter((item) => !search || `${item.title} ${item.description}`.toLowerCase().includes(search.toLowerCase()));
  if (query.isLoading) return <Screen><Header back title="Explore" /><LoadingState /></Screen>;
  if (query.isError) return <Screen><Header back title="Explore" /><ErrorState onRetry={() => query.refetch()} /></Screen>;
  return <Screen><Header back title="Explore" /><SearchBar value={search} onChangeText={setSearch} /><Text style={[styles.settingsLabel, { marginTop: 24, marginBottom: 9 }]}>SHOP BY CATEGORY</Text><CategoryRail selected={params.category} /><View style={[styles.filterCard, { backgroundColor: colors.card, borderColor: colors.border }]}><View style={styles.rowBetween}><View><Text style={styles.sellerName}>Local pickup</Text><Text style={[styles.muted, { fontSize: 12 }]}>Show nearby collection listings</Text></View><Switch testID="search-pickup-toggle" value={pickupOnly} onValueChange={setPickupOnly} trackColor={{ true: colors.primary }} /></View>{pickupOnly && <><View style={styles.chipRow}>{[5, 15, 30, 60].map((distance) => <Chip key={distance} label={`${distance} km`} active={radiusKm === distance} onPress={() => setRadiusKm(distance)} />)}</View><Pressable testID="search-use-location" onPress={getLocation} style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 }}><Feather name="crosshair" size={17} color={colors.primary} /><Text style={styles.link}>{coordinates ? 'Location added' : 'Use my location'}</Text></Pressable></>}</View><View style={[styles.sortRow, { marginTop: 22 }]}><Text style={styles.resultCount}>{shown.length} thoughtful finds</Text><View style={{ flexDirection: 'row', gap: 10 }}>{['recommended', 'newest', 'price_low'].map((item) => <Pressable accessibilityRole="button" key={item} onPress={() => setSort(item)}><Text style={[styles.sortText, sort === item && { color: colors.primary }]}>{item === 'price_low' ? 'Price ↑' : item === 'newest' ? 'New' : 'For you'}</Text></Pressable>)}</View></View><View style={styles.grid}>{shown.map((item) => <ProductCard key={item.id} product={item} />)}</View>{shown.length === 0 && <EmptyState icon="search" title="Nothing here yet" detail="Try a broader search or browse one of our edits." action="Reset search" onPress={() => { setSearch(''); setSort('recommended'); router.push('/search' as any); }} />}</Screen>;
}

export function ProductScreen() {
  const colors = useColors();
  const { isSignedIn } = useAuth();
  const { id } = useLocalSearchParams<{ id: string }>();
  const productId = typeof id === 'string' ? id : '';
  const query = useGetProduct(productId, { query: { enabled: Boolean(productId) } as any });
  const favourites = useListFavourites({ query: { enabled: Boolean(isSignedIn) } as any });
  const [savedOverride, setSavedOverride] = useState<boolean | null>(null);
  const [offerOpen, setOfferOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const add = useAddFavourite();
  const remove = useRemoveFavourite();
  const offer = useCreateOffer();
  const fee = useCalculateBuyerProtectionFee({ price: query.data?.price ?? .01 }, { query: { enabled: Boolean(isSignedIn && query.data?.price) } as any });
  const offerRange = useGetOfferRange(productId, { query: { enabled: Boolean(isSignedIn && productId) } as any });
  const checkout = useCreateListingCheckout({ request: { headers: { 'Idempotency-Key': `checkout-${productId}` } } });
  const authenticate = () => { router.push('/sign-in' as any); return false; };
  if (query.isLoading) return <Screen><Header back /><LoadingState /></Screen>;
  if (query.isError || !query.data) return <Screen><Header back /><EmptyState icon="shopping-bag" title="Listing not found" detail="This listing is no longer available." action="Browse listings" onPress={() => router.replace('/search' as any)} /></Screen>;
  const product = query.data;
  const saved = savedOverride ?? Boolean(favourites.data?.items.some((item) => item.id === product.id));
  const doSave = () => {
    if (!isSignedIn) return authenticate();
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const nextSaved = !saved;
    setSavedOverride(nextSaved);
    (saved ? remove : add).mutate({ productId: product.id }, {
      onSuccess: async () => { await favourites.refetch(); setSavedOverride(null); },
      onError: () => setSavedOverride(null),
    });
  };
  const doBuy = () => { if (!isSignedIn) return authenticate(); checkout.mutate({ data: { productId: product.id, successUrl: Linking.createURL('/orders'), cancelUrl: Linking.createURL(`/product/${product.id}`) } }, { onSuccess: (session) => Linking.openURL(session.url).catch(() => Alert.alert('Checkout unavailable', 'Please try again.')), onError: () => Alert.alert('Couldn’t open checkout', 'Please try again in a moment.') }); };
  const doOffer = () => { if (!isSignedIn) return authenticate(); offer.mutate({ data: { productId: product.id, amount: Number(amount) } }, { onSuccess: () => { setOfferOpen(false); Alert.alert('Offer sent', 'We’ll let the seller know.'); }, onError: () => Alert.alert('Offer not sent', 'Please try again.') }); };
  const suggested = offerRange.data?.recommended ?? Math.round(product.price * .85);
  return <Screen><Header back /><ListingImage uri={product.images[0]} style={styles.detailImage} /><Text style={styles.detailCategory}>{product.category.toUpperCase()} · {product.condition.toUpperCase()}</Text><Text style={styles.detailTitle}>{product.title}</Text><Text style={styles.detailPrice}>{money(product.price)}</Text><Text style={styles.detailDescription}>{product.description}</Text><View style={{ borderRadius: 16, padding: 14, backgroundColor: colors.accent, marginTop: 18 }}><Text style={[styles.sellerName, { color: colors.accentForeground }]}>Buyer Protection included</Text><Text style={[styles.muted, { color: colors.accentForeground, fontSize: 12 }]}>Covered for non-delivery, misrepresentation and counterfeits.</Text><Text style={[styles.sellerName, { color: colors.accentForeground, marginTop: 5 }]}>{fee.data ? `Fee ${money(fee.data.buyerProtectionFee)} · Total ${money(fee.data.total)}` : isSignedIn ? 'Calculating protection fee…' : 'Sign in to see your buyer protection fee'}</Text></View>{offerOpen && <View style={[styles.offerBox, { borderColor: colors.border, backgroundColor: colors.card }]}><Text style={styles.sectionTitle}>Your offer</Text><Text style={styles.muted}>Suggested {money(suggested)} · {offerRange.data ? `${money(offerRange.data.minimum)}–${money(offerRange.data.maximum)}` : 'loading range…'}</Text><Field label="Amount" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder={money(suggested)} /><PrimaryButton label={offer.isPending ? 'Sending…' : 'Send offer'} disabled={offer.isPending || !amount} onPress={doOffer} /></View>}<View style={styles.bottomActions}><Pressable testID="product-make-offer" onPress={() => { if (!isSignedIn) return authenticate(); setOfferOpen(!offerOpen); if (!amount) setAmount(String(suggested)); }} style={[styles.secondaryButton, { borderColor: colors.foreground }]}><Text style={styles.secondaryText}>{offerOpen ? 'Cancel' : 'Make an offer'}</Text></Pressable><PrimaryButton label={checkout.isPending ? 'Opening…' : 'Buy now'} disabled={checkout.isPending} onPress={doBuy} /></View></Screen>;
}

export function SellScreen() {
  const colors = useColors();
  const { isSignedIn } = useAuth();
  const [images, setImages] = useState<SelectedPhoto[]>([]);
  const [sellEverything, setSellEverything] = useState(false);
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState('Home');
  const [condition, setCondition] = useState('Excellent');
  const [description, setDescription] = useState('');
  const [keywords, setKeywords] = useState('');
  const [priceChoice, setPriceChoice] = useState<'sellFaster' | 'recommended' | 'maximum'>('recommended');
  const [pickupAvailable, setPickupAvailable] = useState(false);
  const [pickupArea, setPickupArea] = useState('');
  const [availability, setAvailability] = useState<string[]>([]);
  const [locationPoint, setLocationPoint] = useState<{ latitudeE6: number; longitudeE6: number } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const submitLock = useRef(false);
  const uploadedPaths = useRef(new Map<string, string>());
  const webObjectUrls = useRef(new Set<string>());
  const draftKey = useRef(`listing-${Date.now()}-${Math.random().toString(36).slice(2)}`).current;
  const create = useCreateProduct({ request: { headers: { 'Idempotency-Key': draftKey } } });
  const prepareUpload = useRequestListingPhotoUpload();
  const cleanupUploads = useCleanupListingPhotoUploads();
  const analyze = useAnalyzeListingPhotos({ request: { timeoutMs: 90_000 } });
  const analyzeBatch = useAnalyzeSellEverything({ request: { timeoutMs: 90_000 } });
  const createBatch = useCreateListingsBatch({ request: { headers: { 'Idempotency-Key': draftKey } } });
  const cleanupPaths = async (paths: string[]) => {
    const uniquePaths = [...new Set(paths)];
    const deletedPaths = new Set<string>();
    for (let index = 0; index < uniquePaths.length; index += 10) {
      const result = await cleanupUploads.mutateAsync({ data: { objectPaths: uniquePaths.slice(index, index + 10) } });
      result.deletedPaths.forEach((path) => deletedPaths.add(path));
    }
    for (const [uri, path] of uploadedPaths.current) {
      if (deletedPaths.has(path)) uploadedPaths.current.delete(uri);
    }
  };
  const uploadPhoto = async (photo: SelectedPhoto): Promise<string> => {
    const existingPath = uploadedPaths.current.get(photo.uri);
    if (existingPath) return existingPath;

    let body: Blob | File;
    let size = photo.size;
    if (Platform.OS === 'web') {
      const localResponse = await fetch(photo.uri);
      if (!localResponse.ok) throw new Error('Could not read the selected photo');
      const blob = await localResponse.blob();
      body = blob;
      size = blob.size;
    } else {
      const file = new File(photo.uri);
      body = file;
      size = size ?? file.size;
    }
    if (!size || size > 15_000_000) throw new Error('Use a JPEG, PNG or WebP photo no larger than 15 MB');

    const ticket = await prepareUpload.mutateAsync({ data: { contentType: photo.contentType, size } });
    if (!ticket.uploadUrl.startsWith('https://') || !ticket.objectPath.startsWith('/api/storage/objects/uploads/')) {
      throw new Error('Photo storage returned an invalid upload destination');
    }
    try {
      const upload = Platform.OS === 'web'
        ? await fetch(ticket.uploadUrl, { method: 'PUT', headers: { 'Content-Type': photo.contentType }, body })
        : await expoFetch(ticket.uploadUrl, { method: 'PUT', headers: { 'Content-Type': photo.contentType }, body });
      if (!upload.ok) throw new Error(`Photo upload was rejected (${upload.status})`);
    } catch (error) {
      await cleanupPaths([ticket.objectPath]).catch(() => undefined);
      throw error;
    }
    uploadedPaths.current.set(photo.uri, ticket.objectPath);
    return ticket.objectPath;
  };
  const applySelectedPhotos = (selected: SelectedPhoto[], selectedCount: number) => {
    if (selected.length !== selectedCount) {
      Alert.alert('Some photos were not added', 'LumaLoop supports JPEG, PNG and WebP photos up to 15 MB.');
    }
    const nextImages = selected.slice(0, sellEverything ? 10 : 8);
    const nextUris = new Set(nextImages.map((photo) => photo.uri));
    const abandonedPaths = [...uploadedPaths.current.entries()]
      .filter(([uri]) => !nextUris.has(uri))
      .map(([, path]) => path);
    if (abandonedPaths.length) void cleanupPaths(abandonedPaths).catch(() => undefined);
    for (const uri of webObjectUrls.current) {
      if (!nextUris.has(uri)) {
        URL.revokeObjectURL(uri);
        webObjectUrls.current.delete(uri);
      }
    }
    setImages(nextImages);
  };
  const pick = async () => {
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png,image/webp';
      input.multiple = true;
      input.onchange = () => {
        const files = Array.from(input.files ?? []);
        const selected = files.flatMap((file): SelectedPhoto[] => {
          const contentType = file.type.toLowerCase();
          if ((contentType !== 'image/jpeg' && contentType !== 'image/png' && contentType !== 'image/webp') || file.size <= 0 || file.size > 15_000_000) return [];
          const uri = URL.createObjectURL(file);
          webObjectUrls.current.add(uri);
          return [{ uri, contentType, size: file.size }];
        });
        applySelectedPhotos(selected, files.length);
      };
      input.click();
      return;
    }
    let result: ImagePicker.ImagePickerResult;
    try {
      result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, quality: .85 });
    } catch {
      Alert.alert('Photo library unavailable', 'The photo library could not be opened. Please try again.');
      return;
    }
    if (result.canceled) return;
    const selected: SelectedPhoto[] = result.assets.flatMap((asset) => {
      const contentType = photoType(asset);
      return contentType && (!asset.fileSize || asset.fileSize <= 15_000_000) ? [{ uri: asset.uri, contentType, size: asset.fileSize }] : [];
    });
    applySelectedPhotos(selected, result.assets.length);
  };
  const useDeviceLocation = async () => {
    if (Platform.OS === 'web') {
      if (!navigator.geolocation) return Alert.alert('Location unavailable', 'Add an approximate pickup area instead.');
      navigator.geolocation.getCurrentPosition((position) => setLocationPoint({ latitudeE6: Math.round(position.coords.latitude * 1e6), longitudeE6: Math.round(position.coords.longitude * 1e6) }), () => Alert.alert('Location not shared', 'Add an approximate pickup area instead.'));
      return;
    }
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) return Alert.alert('Location not shared', 'Add an approximate pickup area instead.');
    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    setLocationPoint({ latitudeE6: Math.round(position.coords.latitude * 1e6), longitudeE6: Math.round(position.coords.longitude * 1e6) });
  };
  const runAnalysis = async () => {
    if (!images.length) return Alert.alert('Add photos first', 'AI can help once you select at least one photo.');
    if (!isSignedIn) { router.push('/sign-in' as any); return; }
    setUploading(true);
    try {
      const photos = images.slice(0, sellEverything ? 10 : 6);
      const objectPaths: string[] = [];
      for (const photo of photos) objectPaths.push(await uploadPhoto(photo));
      if (sellEverything) {
        const result = await analyzeBatch.mutateAsync({ data: { groups: objectPaths.map((path) => [path]) } });
        setTitle(`${result.items.length} listings ready to review`);
        return;
      }
      const result = await analyze.mutateAsync({ data: { images: objectPaths } });
      setTitle(result.title);
      setDescription(result.description);
      setCategory(result.category);
      setCondition(result.condition);
      setKeywords(result.keywords.join(', '));
      setPrice(String(result.prices[priceChoice]));
    } catch (error) {
      const feedback = analysisError(error);
      Alert.alert(feedback.title, feedback.message);
    } finally {
      setUploading(false);
    }
  };
  const submit = async () => {
    if (submitLock.current) return;
    const errors: string[] = [];
    if (!title.trim()) errors.push('Add a title.');
    const numericPrice = Number(price);
    if (!price.trim() || !Number.isFinite(numericPrice) || numericPrice <= 0) errors.push('Enter a price greater than £0.');
    if (!images.length) errors.push('Add at least one photo.');
    if (errors.length) {
      setFormError(errors.join(' '));
      return;
    }
    setFormError(null);
    if (!isSignedIn) { router.push('/sign-in' as any); return; }
    submitLock.current = true;
    setUploading(true);
    const uploadedImages: string[] = [];
    let published = false;
    try {
      for (const photo of images) {
        uploadedImages.push(await uploadPhoto(photo));
      }
      const payload: CreateProductInput = { title, price: Number(price), category, condition, description, location: pickupArea || 'United Kingdom', images: uploadedImages, pickupAvailable, pickupArea: pickupArea || undefined, sellerAvailability: availability, keywords: keywords.split(',').map((item) => item.trim()).filter(Boolean), ...locationPoint };
      if (sellEverything) {
        await createBatch.mutateAsync({ data: { items: uploadedImages.map((image, index) => ({ ...payload, title: index === 0 ? title : `${title} ${index + 1}`, images: [image] })) } });
        published = true;
        router.push('/profile' as any);
      } else {
        const item = await create.mutateAsync({ data: payload });
        published = true;
        router.push(`/product/${item.id}` as any);
      }
    } catch (error) {
      if (!published && uploadedImages.length) {
        await cleanupPaths(uploadedImages).catch(() => undefined);
      }
      const feedback = publishError(error);
      Alert.alert(feedback.title, feedback.message);
    } finally {
      submitLock.current = false;
      setUploading(false);
    }
  };
  useEffect(() => () => {
    const temporaryPaths = [...uploadedPaths.current.values()];
    if (temporaryPaths.length) void cleanupPaths(temporaryPaths).catch(() => undefined);
    for (const uri of webObjectUrls.current) URL.revokeObjectURL(uri);
    webObjectUrls.current.clear();
  }, []);
  const publishing = uploading || create.isPending || createBatch.isPending;
  return <Screen><Header back title={sellEverything ? 'Sell everything' : 'List a piece'} /><View style={styles.chipRow}><Chip label="One item" active={!sellEverything} onPress={() => setSellEverything(false)} /><Chip label="Sell Everything" active={sellEverything} onPress={() => setSellEverything(true)} /></View><Text style={styles.sellLead}>{sellEverything ? 'Photograph. Review.\nList together.' : 'Give it another\ngood chapter.'}</Text><Text style={styles.muted}>{sellEverything ? 'Add several photos; AI groups each photo into a draft listing for a quick review.' : 'Clear photos and a little context help the right person find it.'}</Text><Pressable testID="sell-add-photos" disabled={publishing} onPress={pick} style={[styles.upload, { borderColor: colors.primary }, publishing && { opacity: .55 }]}><Feather name="camera" size={25} color={colors.primary} /><Text style={styles.uploadTitle}>{images.length ? `${images.length} photo${images.length > 1 ? 's' : ''} selected` : `Add up to ${sellEverything ? 10 : 8} photos`}</Text><Text style={styles.muted}>Tap to choose photos</Text></Pressable>{images.length > 0 && <><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, marginBottom: 12 }}>{images.map((photo) => <Image key={photo.uri} source={{ uri: photo.uri }} style={{ width: 70, height: 70, borderRadius: 12 }} />)}</ScrollView><PrimaryButton label={uploading || analyze.isPending || analyzeBatch.isPending ? 'Analysing photos…' : sellEverything ? 'Group with AI' : 'Fill with AI'} disabled={uploading || analyze.isPending || analyzeBatch.isPending} onPress={runAnalysis} /></>}<View style={{ gap: 18, marginTop: 18 }}><Field label={sellEverything ? 'Batch title (review before publishing)' : 'What are you listing?'} value={title} onChangeText={(value: string) => { setTitle(value); setFormError(null); }} placeholder="e.g. Hand-thrown stoneware vase" /><Field label="Price" value={price} onChangeText={(value: string) => { setPrice(value); setFormError(null); }} placeholder="0" keyboardType="decimal-pad" /><Text style={styles.label}>AI price choice</Text><View style={styles.chipRow}>{([['sellFaster', 'Sell faster'], ['recommended', 'Recommended'], ['maximum', 'Maximum price']] as const).map(([key, label]) => <Chip key={key} label={label} active={priceChoice === key} onPress={() => setPriceChoice(key)} />)}</View><Text style={styles.label}>Category</Text><View style={styles.chipRow}>{categoryCatalog.map((item) => <Chip key={item.id} label={item.name} active={category === item.name} onPress={() => setCategory(item.name)} />)}</View><Text style={styles.label}>Condition</Text><View style={styles.chipRow}>{['Like new', 'Excellent', 'Good'].map((item) => <Chip key={item} label={item} active={condition === item} onPress={() => setCondition(item)} />)}</View><Field label="Keywords (comma separated)" value={keywords} onChangeText={setKeywords} placeholder="ceramic, handmade, neutral" /><Field label="The story" value={description} onChangeText={setDescription} placeholder="What makes it special? Be honest and specific." multiline /><View style={[styles.filterCard, { backgroundColor: colors.card, borderColor: colors.border }]}><View style={styles.rowBetween}><Text style={styles.sellerName}>Offer local pickup</Text><Switch testID="sell-pickup-toggle" value={pickupAvailable} onValueChange={setPickupAvailable} trackColor={{ true: colors.primary }} /></View>{pickupAvailable && <><Field label="Approximate area" value={pickupArea} onChangeText={setPickupArea} placeholder="e.g. East London" /><Pressable testID="sell-use-location" onPress={useDeviceLocation} style={{ minHeight: 44, justifyContent: 'center' }}><Text style={styles.link}>{locationPoint ? 'Device location added' : 'Use device location'}</Text></Pressable><Text style={styles.label}>Availability</Text><View style={styles.chipRow}>{['Weekdays', 'Evenings', 'Weekends'].map((item) => <Chip key={item} label={item} active={availability.includes(item)} onPress={() => setAvailability((current) => current.includes(item) ? current.filter((value) => value !== item) : [...current, item])} />)}</View></>}</View>{formError ? <Text accessibilityRole="alert" style={{ color: colors.destructive, marginTop: 2 }}>{formError}</Text> : null}<PrimaryButton testID="sell-publish" label={uploading ? 'Uploading photos…' : publishing ? 'Publishing…' : sellEverything ? 'Create batch listings' : 'Publish listing'} disabled={publishing} onPress={submit} /></View></Screen>;
}

export function FavouritesScreen() {
  const { isSignedIn } = useAuth();
  const query = useListFavourites({ query: { enabled: Boolean(isSignedIn) } as any });
  if (!isSignedIn) return <Screen><Header title="Saved" /><AuthRequired title="Sign in to save finds" detail="Your saved listings are private to your account." /></Screen>;
  if (query.isLoading) return <Screen><Header title="Saved" /><LoadingState /></Screen>;
  if (query.isError) return <Screen><Header title="Saved" /><ErrorState onRetry={() => query.refetch()} /></Screen>;
  const items = query.data?.items ?? [];
  return <Screen><Header title="Saved" right={<Pressable onPress={() => router.push('/search' as any)}><Feather name="plus" size={23} color="#182331" /></Pressable>} /><Text style={styles.pageLead}>Keep the good ones close.</Text><Text style={styles.muted}>Your saved pieces live here until they find a new home.</Text>{items.length ? <View style={[styles.grid, { marginTop: 25 }]}>{items.map((item) => <ProductCard key={item.id} product={item} initialSaved />)}</View> : <EmptyState title="No saved pieces yet" detail="Tap the heart on a listing to keep it here." action="Browse listings" onPress={() => router.push('/search' as any)} />}</Screen>;
}

export function MessagesScreen() {
  const { isSignedIn } = useAuth();
  const query = useListConversations({ query: { enabled: Boolean(isSignedIn) } as any });
  if (!isSignedIn) return <Screen><Header title="Inbox" /><AuthRequired title="Sign in to view messages" detail="Conversations are kept private to your account." /></Screen>;
  if (query.isLoading) return <Screen><Header title="Inbox" /><LoadingState /></Screen>;
  if (query.isError) return <Screen><Header title="Inbox" /><ErrorState onRetry={() => query.refetch()} /></Screen>;
  const items = query.data ?? [];
  return <Screen><Header title="Inbox" /><Text style={styles.pageLead}>Conversations with context.</Text>{items.length ? <View style={{ marginTop: 18, gap: 4 }}>{items.map((item) => <Pressable key={item.id} onPress={() => router.push(`/messages/${item.id}` as any)} style={styles.conversation}><Avatar user={item.participant} /><View style={{ flex: 1, gap: 4 }}><View style={styles.rowBetween}><Text style={styles.sellerName}>{item.participant.name}</Text><Text style={styles.timestamp}>{dateLabel(item.updatedAt)}</Text></View><Text style={styles.muted}>{item.productTitle}</Text><Text numberOfLines={1} style={styles.messagePreview}>{item.lastMessage}</Text></View>{item.unreadCount > 0 && <View style={styles.unread}><Text style={styles.unreadText}>{item.unreadCount}</Text></View>}</Pressable>)}</View> : <EmptyState icon="message-circle" title="No conversations yet" detail="Messages with buyers and sellers will appear here." />}</Screen>;
}

export function ChatScreen() {
  const colors = useColors();
  const { isSignedIn, userId } = useAuth();
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const id = typeof conversationId === 'string' ? conversationId : '';
  const query = useListMessages(id, { query: { enabled: Boolean(isSignedIn && id) } as any });
  const send = useSendMessage();
  const [body, setBody] = useState('');
  const submit = () => {
    if (!body.trim() || !id) return;
    send.mutate({ conversationId: id, data: { body } }, { onSuccess: () => { setBody(''); query.refetch(); }, onError: () => Alert.alert('Message not sent', 'Please try again.') });
  };
  if (!isSignedIn) return <Screen><Header back title="Conversation" /><AuthRequired title="Sign in to view messages" detail="Conversations are kept private to your account." /></Screen>;
  if (query.isLoading) return <Screen><Header back title="Conversation" /><LoadingState /></Screen>;
  if (query.isError) return <Screen><Header back title="Conversation" /><ErrorState onRetry={() => query.refetch()} /></Screen>;
  const items = query.data ?? [];
  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.background }} behavior="padding"><Screen scroll={false}><Header back title="Conversation" /><FlatList data={items} ListEmptyComponent={<EmptyState icon="message-circle" title="Start the conversation" detail="Write a message below when you’re ready." />} keyExtractor={(item) => item.id} contentContainerStyle={{ paddingVertical: 20, gap: 12, flexGrow: 1 }} renderItem={({ item }) => { const mine = item.senderId === userId; return <View style={[styles.bubble, mine ? styles.myBubble : styles.theirBubble]}><Text style={mine ? styles.myBubbleText : styles.theirBubbleText}>{item.body}</Text><Text style={mine ? styles.myTime : styles.theirTime}>{dateLabel(item.createdAt)}</Text></View>; }} /><View style={[styles.chatInputRow, { borderTopColor: colors.border }]}><Field value={body} onChangeText={setBody} placeholder="Write a thoughtful note…" /><Pressable disabled={!body.trim() || send.isPending} onPress={submit} style={[styles.sendButton, (!body.trim() || send.isPending) && { opacity: .45 }]}><Feather name="arrow-up" size={20} color={colors.primaryForeground} /></Pressable></View></Screen></KeyboardAvoidingView>;
}

export function OffersScreen() {
  const { isSignedIn } = useAuth();
  const query = useListMyOffers({ query: { enabled: Boolean(isSignedIn) } as any });
  if (!isSignedIn) return <Screen><Header title="Offers" /><AuthRequired title="Sign in to view offers" detail="Your negotiations are private to your account." /></Screen>;
  if (query.isLoading) return <Screen><Header title="Offers" /><LoadingState /></Screen>;
  if (query.isError) return <Screen><Header title="Offers" /><ErrorState onRetry={() => query.refetch()} /></Screen>;
  const items = query.data ?? [];
  return <Screen><Header title="Offers" /><Text style={styles.pageLead}>A little room to negotiate.</Text>{items.length ? <View style={{ gap: 12, marginTop: 22 }}>{items.map((offer) => <Pressable key={offer.id} onPress={() => router.push(`/product/${offer.productId}` as any)} style={styles.offerRow}><View style={{ flex: 1, gap: 5 }}><Text style={styles.sellerName}>{offer.productTitle}</Text><Text style={styles.muted}>Your offer · {money(offer.amount)}</Text><Text style={styles.offerStatus}>{offer.status}</Text></View><Feather name="chevron-right" size={19} color="#6d726f" /></Pressable>)}</View> : <EmptyState icon="tag" title="No offers yet" detail="Offers you make on listings will appear here." action="Browse listings" onPress={() => router.push('/search' as any)} />}</Screen>;
}

export function OrdersScreen() {
  const { isSignedIn } = useAuth();
  const query = useListOrders({ query: { enabled: Boolean(isSignedIn) } as any });
  const salesQuery = useListSales({ query: { enabled: Boolean(isSignedIn) } as any });
  const updateStatus = useUpdateOrderStatus();
  const confirmDelivery = useConfirmOrderDelivery();
  const createReview = useCreateReview();
  const createCase = useCreateBuyerProtectionCase();
  const boost = useCreateBoostCheckout();
  const [reviewingOrderId, setReviewingOrderId] = useState<string | null>(null);
  const [reviewRating, setReviewRating] = useState(0);
  const [reviewBody, setReviewBody] = useState('');
  const advanceSale = (orderId: string, status: 'packed' | 'shipped') => {
    updateStatus.mutate({ orderId, data: { status } }, { onSuccess: () => salesQuery.refetch(), onError: () => Alert.alert('Status not updated', 'Please try again.') });
  };
  const closeReview = () => {
    setReviewingOrderId(null);
    setReviewRating(0);
    setReviewBody('');
  };
  const submitReview = (orderId: string) => {
    const body = reviewBody.trim();
    if (!reviewRating || !body) {
      Alert.alert('Finish your review', 'Choose a star rating and write a short review.');
      return;
    }
    createReview.mutate({ orderId, data: { rating: reviewRating, body } }, {
      onSuccess: async () => {
        closeReview();
        await query.refetch();
        Alert.alert('Review published', 'Your verified review now appears on the seller’s profile.');
      },
      onError: () => Alert.alert('Review not published', 'Only delivered purchases can be reviewed once. Refresh your orders and try again.'),
    });
  };
  const openCase = (orderId: string) => Alert.alert('Buyer Protection', 'Choose the issue you need help with.', [
    ...(['non_delivery', 'misrepresentation', 'counterfeit'] as const).map((reason) => ({ text: reason.replace('_', ' '), onPress: () => createCase.mutate({ data: { orderId, reason, details: `Buyer opened a ${reason.replace('_', ' ')} case from their order.` } }, { onSuccess: (caseItem) => Alert.alert('Case created', `Case ${caseItem.id} is ${caseItem.status}. Our team will update you here.`), onError: () => Alert.alert('Case not created', 'Please try again.') }) })),
    { text: 'Cancel', style: 'cancel' },
  ]);
  const boostSale = (productId: string) => boost.mutate({ data: { productId, tier: 'basic', successUrl: Linking.createURL('/orders'), cancelUrl: Linking.createURL('/orders') } }, { onSuccess: (session) => { void Linking.openURL(session.url); }, onError: () => Alert.alert('Boost unavailable', 'Please try again.') });
  if (!isSignedIn) return <Screen><Header title="Orders" /><AuthRequired title="Sign in to view orders" detail="Purchases and tracking are private to your account." /></Screen>;
  if (query.isLoading || salesQuery.isLoading) return <Screen><Header title="Orders" /><LoadingState /></Screen>;
  if (query.isError || salesQuery.isError) return <Screen><Header title="Orders" /><ErrorState onRetry={() => { void query.refetch(); void salesQuery.refetch(); }} /></Screen>;
  const items = query.data ?? [];
  const sales = salesQuery.data ?? [];
  return <Screen><Header title="Orders" /><Text style={styles.pageLead}>Everything in motion.</Text><SectionTitle title="Your purchases" />{items.length ? <View style={{ gap: 16 }}>{items.map((order) => <View key={order.id} style={{ gap: 10 }}><Pressable style={styles.orderCard} onPress={() => Alert.alert('Tracking', order.trackingCode ?? 'Tracking will appear when this ships.')}><Image source={order.product.images[0]} style={styles.orderImage} /><View style={{ flex: 1, gap: 5 }}><Text style={styles.sellerName}>{order.product.title}</Text><Text style={styles.muted}>{money(order.amount)} · Est. {order.deliveryEstimate}</Text><View style={styles.statusLine}><View style={[styles.statusDot, { backgroundColor: order.status === 'delivered' ? '#6d8c72' : '#f2644c' }]} /><Text style={styles.offerStatus}>{order.status}</Text></View></View><Feather name="chevron-right" size={19} color="#6d726f" /></Pressable>{order.status === 'shipped' ? <PrimaryButton label={confirmDelivery.isPending ? 'Confirming…' : 'Confirm delivery'} disabled={confirmDelivery.isPending} onPress={() => confirmDelivery.mutate({ orderId: order.id }, { onSuccess: () => { void query.refetch(); Alert.alert('Delivery confirmed', 'The seller has been notified and their funds are now available.'); }, onError: () => Alert.alert('Could not confirm delivery', 'This order may have changed. Refresh and try again.') })} /> : null}{order.status === 'delivered' && order.review ? <View style={styles.review}><Text style={styles.sellerName}>Your verified review</Text><Text style={{ color: '#f2644c', fontSize: 18 }}>{'★'.repeat(Math.round(order.review.rating))}{'☆'.repeat(5 - Math.round(order.review.rating))}</Text><Text style={styles.reviewText}>{order.review.body}</Text></View> : null}{order.status === 'delivered' && !order.review && reviewingOrderId !== order.id ? <Pressable accessibilityRole="button" onPress={() => { closeReview(); setReviewingOrderId(order.id); }} style={{ alignSelf: 'flex-start' }}><Text style={styles.link}>Leave a seller review</Text></Pressable> : null}{reviewingOrderId === order.id ? <View style={styles.review}><Text style={styles.sellerName}>Review {order.product.seller.name}</Text><Text style={styles.muted}>Verified purchase of {order.product.title}</Text><View style={{ flexDirection: 'row', gap: 9 }}>{[1, 2, 3, 4, 5].map((rating) => <Pressable key={rating} accessibilityRole="button" accessibilityLabel={`${rating} star${rating === 1 ? '' : 's'}`} onPress={() => setReviewRating(rating)} hitSlop={6}><Ionicons name={rating <= reviewRating ? 'star' : 'star-outline'} size={29} color="#f2644c" /></Pressable>)}</View><Field label="Your review" value={reviewBody} onChangeText={setReviewBody} placeholder="How was the item and seller?" multiline /><View style={{ flexDirection: 'row', gap: 12 }}><Pressable accessibilityRole="button" disabled={createReview.isPending} onPress={closeReview} style={[styles.secondaryButton, { flex: 1 }]}><Text style={styles.secondaryText}>Cancel</Text></Pressable><View style={{ flex: 1 }}><PrimaryButton label={createReview.isPending ? 'Publishing…' : 'Publish review'} disabled={createReview.isPending || !reviewRating || !reviewBody.trim()} onPress={() => submitReview(order.id)} /></View></View></View> : null}</View>)}</View> : <EmptyState icon="package" title="No purchases yet" detail="Your purchases and delivery updates will appear here." action="Browse listings" onPress={() => router.push('/search' as any)} />}<SectionTitle title="Your sales" />{sales.length ? <View style={{ gap: 16 }}>{sales.map((order) => { const nextStatus = order.status === 'paid' ? 'packed' : order.status === 'packed' ? 'shipped' : null; return <View key={order.id} style={styles.orderCard}><Image source={order.product.images[0]} style={styles.orderImage} /><View style={{ flex: 1, gap: 5 }}><Text style={styles.sellerName}>{order.product.title}</Text><Text style={styles.muted}>{money(order.amount)}</Text><Text style={styles.offerStatus}>{order.status}</Text>{nextStatus && <Pressable accessibilityRole="button" disabled={updateStatus.isPending} onPress={() => advanceSale(order.id, nextStatus)}><Text style={styles.link}>{updateStatus.isPending ? 'Updating…' : `Mark ${nextStatus}`}</Text></Pressable>}{order.status === 'shipped' ? <Text style={styles.muted}>Waiting for the buyer to confirm delivery.</Text> : null}</View></View>; })}</View> : <EmptyState icon="shopping-bag" title="No sales yet" detail="Orders for your listings will appear here." />}</Screen>;
}

export function BalanceScreen() {
  const { isSignedIn } = useAuth();
  const colors = useColors();
  const balanceQuery = useGetSellerBalance({ query: { enabled: Boolean(isSignedIn) } as any });
  const withdrawalKey = useRef(`withdrawal-${Date.now()}-${Math.random().toString(36).slice(2)}`).current;
  const withdrawal = useRequestBalanceWithdrawal({
    request: { headers: { 'Idempotency-Key': withdrawalKey } },
    mutation: {
      onSuccess: async (payout) => {
        await balanceQuery.refetch();
        Alert.alert(payout.status === 'paid' ? 'Payout sent' : 'Payout update', payout.status === 'paid' ? `${money(payout.amount)} was sent to your connected Stripe account.` : 'Your payout is still being confirmed.');
      },
      onError: () => Alert.alert('Payout unavailable', 'Your confirmed balance changed before the payout completed. Refresh and try again.'),
    },
  });
  const onboarding = useStartSellerPayoutOnboarding({
    mutation: {
      onSuccess: async (account) => {
        await balanceQuery.refetch();
        await Linking.openURL(account.onboardingUrl);
      },
      onError: () => Alert.alert('Stripe onboarding unavailable', 'We could not start secure payout onboarding. Please try again.'),
    },
  });

  if (!isSignedIn) return <Screen><Header back title="Balance" /><AuthRequired title="Sign in to view your balance" detail="Your earnings and sales are private to your account." /></Screen>;
  if (balanceQuery.isLoading) return <Screen><Header back title="Balance" /><LoadingState /></Screen>;
  if (balanceQuery.isError || !balanceQuery.data) return <Screen><Header back title="Balance" /><ErrorState onRetry={() => balanceQuery.refetch()} /></Screen>;

  const balance = balanceQuery.data;
  const payoutAccount = balance.payoutAccount;
  const startOnboarding = () => onboarding.mutate({ data: { refreshUrl: Linking.createURL('/balance'), returnUrl: Linking.createURL('/balance') } });
  const statusMessage = balance.payoutStatus === 'ready'
    ? 'These funds were released by the server and are ready for payout.'
    : balance.payoutStatus === 'pending'
      ? 'Funds stay pending until delivery is confirmed.'
      : balance.paidOutFunds > 0
        ? 'All released funds have been paid out.'
        : 'Confirmed sales and payouts will appear here.';
  const saleStatus = (status: 'pending' | 'available' | 'reserved' | 'paid_out' | 'cancelled' | 'verification_hold') => status === 'paid_out' ? 'Paid out' : status === 'reserved' ? 'Payout in progress' : status === 'available' ? 'Available' : status === 'verification_hold' ? 'Verification hold' : status === 'cancelled' ? 'Cancelled' : 'Pending';

  return <Screen><Header back title="Balance" /><Text style={styles.pageLead}>Your money, in motion.</Text><Text style={styles.muted}>Only server-confirmed funds can appear as available or paid out.</Text>{balance.reversedPendingFunds > 0 ? <Text style={styles.muted}>{money(balance.reversedPendingFunds)} is held while Stripe reversal details are reconciled.</Text> : null}<View style={{ marginTop: 16, padding: 16, borderRadius: 16, backgroundColor: colors.card, gap: 6 }}><Text style={styles.settingsLabel}>PAYOUT ACCOUNT</Text><Text style={styles.settingText}>{payoutAccount.status === 'active' ? 'Stripe account ready' : payoutAccount.status === 'disabled' ? 'Stripe account needs attention' : 'Set up Stripe payouts'}</Text><Text style={styles.muted}>{payoutAccount.status === 'active' ? 'Withdrawals are sent securely to your connected Stripe account.' : 'Complete Stripe Express onboarding before you can withdraw.'}</Text>{payoutAccount.status !== 'active' ? <View style={{ marginTop: 5 }}><PrimaryButton label={onboarding.isPending ? 'Opening Stripe…' : payoutAccount.accountId ? 'Continue Stripe setup' : 'Set up Stripe payouts'} disabled={onboarding.isPending} onPress={startOnboarding} /></View> : null}</View><View style={{ marginTop: 22, padding: 22, borderRadius: 20, backgroundColor: colors.secondary, gap: 8 }}><Text style={styles.settingsLabel}>AVAILABLE TO WITHDRAW</Text><Text style={{ color: colors.text, fontFamily: 'Inter_700Bold', fontSize: 36 }}>{money(balance.availableFunds)}</Text><Text style={styles.muted}>{statusMessage}</Text>{balance.payoutStatus === 'ready' && balance.availableFunds > 0 && payoutAccount.status === 'active' ? <View style={{ marginTop: 8 }}><PrimaryButton testID="balance-withdraw" label={withdrawal.isPending ? 'Sending payout…' : `Withdraw ${money(balance.availableFunds)}`} disabled={withdrawal.isPending} onPress={() => withdrawal.mutate()} /></View> : null}</View><View style={{ flexDirection: 'row', gap: 12, marginTop: 14 }}><View style={[styles.metric, { backgroundColor: colors.card }]}><Text style={styles.settingsLabel}>PENDING</Text><Text style={styles.metricValue}>{money(balance.pendingFunds)}</Text></View><View style={[styles.metric, { backgroundColor: colors.card }]}><Text style={styles.settingsLabel}>PAID OUT</Text><Text style={styles.metricValue}>{money(balance.paidOutFunds)}</Text></View></View><View style={{ flexDirection: 'row', gap: 12, marginTop: 12 }}><View style={[styles.metric, { backgroundColor: colors.card }]}><Text style={styles.settingsLabel}>GROSS SALES</Text><Text style={styles.metricValue}>{money(balance.grossSales)}</Text></View><View style={[styles.metric, { backgroundColor: colors.card }]}><Text style={styles.settingsLabel}>PLATFORM FEES</Text><Text style={styles.metricValue}>{money(balance.platformFees)}</Text></View></View><SectionTitle title="Payout history" />{balance.payouts.length ? <View style={{ gap: 10 }}>{balance.payouts.map((payout) => <View key={payout.id} style={[styles.settingRow, { minHeight: 62 }]}><View style={{ flex: 1, gap: 4 }}><Text style={styles.settingText}>Payout</Text><Text style={styles.muted}>{payout.status === 'paid' ? 'Sent to Stripe' : payout.status === 'reversed' ? 'Reversed — funds restored' : payout.status === 'partially_reversed' ? 'Partially reversed — reconciliation pending' : payout.status === 'failed' ? 'Failed — funds restored' : 'Sending'} · {dateLabel(payout.completedAt ?? payout.createdAt)}</Text></View><Text style={styles.sellerName}>{money(payout.amount)}</Text></View>)}</View> : <Text style={styles.muted}>Completed withdrawals will appear here.</Text>}<SectionTitle title="Sale funds" />{balance.sales.length ? <View style={{ gap: 10 }}>{balance.sales.slice(0, 12).map((sale) => <View key={sale.id} style={[styles.settingRow, { minHeight: 68 }]}><View style={{ flex: 1, gap: 4 }}><Text style={styles.settingText}>{sale.title}</Text><Text style={styles.muted}>{saleStatus(sale.status)} · {dateLabel(sale.createdAt)}</Text><Text style={styles.timestamp}>Gross {money(sale.grossAmount)} · Fee {money(sale.platformFee)}</Text></View><Text style={styles.sellerName}>{money(sale.netAmount)}</Text></View>)}</View> : <EmptyState icon="credit-card" title="No earnings yet" detail="When one of your listings sells, its server-confirmed balance entry will appear here." action="Sell a piece" onPress={() => router.push('/sell' as any)} />}</Screen>;
}

function ProfileMenuRow({ icon, title, detail, value, onPress }: { icon: string; title: string; detail?: string; value?: string; onPress: () => void }) {
  const colors = useColors();
  return <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress} style={({ pressed }) => [{ minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: 14, borderBottomWidth: 1, borderColor: colors.border, paddingVertical: 10 }, pressed && { opacity: .72 }]}><View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: colors.secondary, alignItems: 'center', justifyContent: 'center' }}><Feather name={icon as any} size={19} color={colors.foreground} /></View><View style={{ flex: 1 }}><Text style={styles.settingText}>{title}</Text>{detail ? <Text style={[styles.muted, { fontSize: 12, marginTop: 3 }]}>{detail}</Text> : null}</View>{value ? <Text style={[styles.muted, { fontSize: 13 }]}>{value}</Text> : null}<Feather name="chevron-right" size={19} color={colors.mutedForeground} /></Pressable>;
}

function ProfileDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { isSignedIn, userId } = useAuth();
  const { user } = useUser();
  const isOwnProfile = typeof id !== 'string';
  const profileId = typeof id === 'string' ? id : (userId ?? '');
  const ownProfileQuery = useGetCurrentUserProfile({ query: { enabled: isOwnProfile && Boolean(isSignedIn) } as any });
  const publicProfileQuery = useGetUserProfile(profileId, { query: { enabled: !isOwnProfile && Boolean(profileId) } as any });
  const query = isOwnProfile ? ownProfileQuery : publicProfileQuery;
  const listingsQuery = useListProducts({ limit: 50 }, { query: { enabled: Boolean(profileId) } as any });
  const favouritesQuery = useListFavourites({ query: { enabled: isOwnProfile && Boolean(isSignedIn) } as any });
  const clerkProfile = isOwnProfile ? profileFromClerk(user) : null;
  const person = query.data ?? clerkProfile;

  if (isOwnProfile && !isSignedIn) {
    return <Screen><Header title="Profile" /><AuthRequired title="Sign in to view your profile" detail="Your profile and account activity are private." /></Screen>;
  }

  if (query.isLoading && !person) {
    return <Screen><Header back={!isOwnProfile} title={isOwnProfile ? 'Profile' : 'View profile'} /><LoadingState /></Screen>;
  }

  if (!person) {
    return <Screen><Header back={!isOwnProfile} title={isOwnProfile ? 'Profile' : 'View profile'} /><EmptyState icon="user-x" title="Profile not found" detail="This seller profile is no longer available." action={isOwnProfile ? 'Refresh' : 'Go back'} onPress={isOwnProfile ? () => query.refetch() : () => router.back()} /></Screen>;
  }

  const pieces = (listingsQuery.data?.items ?? []).filter((item) => item.seller.id === person.id);
   const savedCount = favouritesQuery.data?.items.length ?? 0;
  if (isOwnProfile) return <ProfileHubScreen />;
  return <Screen><Header back={!isOwnProfile} title={isOwnProfile ? 'Profile' : 'View profile'} />{isOwnProfile ? <>{query.isError ? <Pressable accessibilityRole="button" accessibilityLabel="Retry profile sync" onPress={() => query.refetch()} style={{ borderRadius: 14, padding: 12, backgroundColor: '#ebe2d6', marginTop: 8, marginBottom: 4 }}><Text style={[styles.muted, { textAlign: 'center' }]}>Your account is available. Tap to retry syncing marketplace details.</Text></Pressable> : null}<View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18, borderRadius: 18, backgroundColor: '#ebe2d6', marginTop: 8 }}><Avatar user={person} size={64} /><View style={{ flex: 1, gap: 4 }}><Text style={styles.profileName}>{person.name}</Text><Text style={styles.muted}>Member since {new Date(person.joinedAt).getFullYear()}</Text><Pressable accessibilityRole="button" accessibilityLabel="View profile" onPress={() => router.push(`/profile/${person.id}` as any)}><Text style={styles.link}>View profile</Text></Pressable></View></View><Text style={styles.settingsLabel}>YOUR LUMALOOP</Text><View><ProfileMenuRow icon="credit-card" title="Balance" detail="Track earnings from your sales" onPress={() => router.push('/balance' as any)} /><ProfileMenuRow icon="heart" title="Favourite items" value={favouritesQuery.isLoading ? '…' : String(savedCount)} onPress={() => router.push('/favourites' as any)} /><ProfileMenuRow icon="shopping-bag" title="My orders" detail="Purchases and tracking" onPress={() => router.push('/orders' as any)} /><ProfileMenuRow icon="tag" title="Sell a piece" detail={pieces.length ? `${pieces.length} active listing${pieces.length === 1 ? '' : 's'}` : 'Give something a new chapter'} onPress={() => router.push('/sell' as any)} /></View><Text style={styles.settingsLabel}>PREFERENCES & SUPPORT</Text><View><ProfileMenuRow icon="sliders" title="Account settings" detail="Profile, notifications and sign out" onPress={() => router.push('/settings' as any)} /><ProfileMenuRow icon="help-circle" title="LumaLoop guide" detail="How buying and selling works" onPress={() => Alert.alert('LumaLoop guide', 'Browse thoughtfully, ask questions, and keep every transaction in the app.')} /></View></> : <View style={styles.profileHero}><Avatar user={person} size={78} /><Text style={styles.profileName}>{person.name}</Text><Text style={styles.muted}>{person.location} · On LumaLoop since {new Date(person.joinedAt).getFullYear()}</Text>{person.reviewCount ? <View style={styles.ratingRow}><Text style={styles.ratingBig}>{person.rating}</Text><Text style={styles.muted}>/ 5 from {person.reviewCount} {person.reviewCount === 1 ? 'review' : 'reviews'}</Text></View> : <Text style={styles.muted}>No ratings yet</Text>}</View>}{!isOwnProfile && person.bio ? <Text style={styles.bio}>{person.bio}</Text> : null}<SectionTitle title="Reviews" />{person.reviews.length ? <View style={{ gap: 12 }}>{person.reviews.map((review) => <View key={review.id} style={styles.review}><View style={styles.rowBetween}><Text style={styles.sellerName}>{review.reviewerName}</Text><Text style={{ color: '#f2644c', fontSize: 16 }}>{'★'.repeat(Math.round(review.rating))}{'☆'.repeat(5 - Math.round(review.rating))}</Text></View><Text style={styles.reviewText}>{review.body}</Text><Text style={styles.timestamp}>Verified purchase · {review.productTitle} · {dateLabel(review.createdAt)}</Text></View>)}</View> : <EmptyState icon="star" title="No reviews yet" detail="Verified buyer reviews will appear after completed orders." />}<SectionTitle title={isOwnProfile ? 'Your pieces' : 'Their pieces'} />{listingsQuery.isLoading ? <LoadingState /> : listingsQuery.isError ? <ErrorState onRetry={() => listingsQuery.refetch()} /> : pieces.length ? <View style={styles.grid}>{pieces.map((item) => <ProductCard key={item.id} product={item} />)}</View> : <EmptyState icon="shopping-bag" title={isOwnProfile ? 'No active listings' : 'No active listings'} detail="Pieces you list will appear here." />}</Screen>;
}

function ProfileHubScreen() {
  const colors = useColors();
  const { isSignedIn } = useAuth();
  const { user } = useUser();
  const profileQuery = useGetCurrentUserProfile({ query: { enabled: Boolean(isSignedIn) } as any });
  const listingsQuery = useListProducts({ limit: 50 }, { query: { enabled: Boolean(isSignedIn) } as any });
  const favouritesQuery = useListFavourites({ query: { enabled: Boolean(isSignedIn) } as any });
  const clerkProfile = profileFromClerk(user);
  const person = profileQuery.data ?? clerkProfile;

  if (!isSignedIn) {
    return <Screen><Header title="Profile" /><AuthRequired title="Sign in to view your profile" detail="Your profile and account activity are private." /></Screen>;
  }

  if (profileQuery.isLoading && !person) {
    return <Screen><Header title="Profile" /><LoadingState /></Screen>;
  }

  if (!person) {
    return <Screen><Header title="Profile" /><ErrorState onRetry={() => profileQuery.refetch()} detail="We couldn’t load your account profile. Your listings and account actions are still safe." /></Screen>;
  }

  const pieces = (listingsQuery.data?.items ?? []).filter((item) => item.seller.id === person.id);
  const savedCount = favouritesQuery.data?.items.length ?? 0;

  return <Screen>
    <Header title="Profile" />
    {profileQuery.isError ? <Pressable accessibilityRole="button" accessibilityLabel="Retry profile sync" onPress={() => profileQuery.refetch()} style={[{ flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 14, borderWidth: 1, padding: 12, marginTop: 8, marginBottom: 4 }, { backgroundColor: colors.secondary, borderColor: colors.border }]}><Feather name="refresh-cw" size={16} color={colors.foreground} /><Text style={[styles.muted, { flex: 1 }]}>Your account is available. Tap to retry syncing marketplace details.</Text><Feather name="chevron-right" size={17} color={colors.mutedForeground} /></Pressable> : null}
    <View style={[{ borderRadius: 24, padding: 20, marginTop: 10, gap: 10 }, { backgroundColor: colors.secondary }]}>
      <View style={styles.rowBetween}>
        <Avatar user={person} size={68} />
        <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 7 }, { backgroundColor: colors.card }]}><Feather name="check" size={14} color={colors.primary} /><Text style={[styles.timestamp, { color: colors.foreground }]}>Member</Text></View>
      </View>
      <Text style={styles.profileName}>{person.name}</Text>
      <Text style={styles.muted}>{person.location} · On LumaLoop since {new Date(person.joinedAt).getFullYear()}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="View profile" onPress={() => router.push(`/profile/${person.id}` as any)} style={[{ minHeight: 44, borderRadius: 14, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 6 }, { borderColor: colors.border, backgroundColor: colors.card }]}>
        <Text style={[styles.link, { color: colors.foreground }]}>View profile</Text><Feather name="arrow-up-right" size={16} color={colors.foreground} />
      </Pressable>
    </View>
    <View style={{ flexDirection: 'row', gap: 8, marginTop: 14 }}>
      <View style={[styles.metric, { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1 }]}><Text style={styles.settingsLabel}>LISTINGS</Text><Text style={styles.metricValue}>{listingsQuery.isLoading ? '…' : pieces.length}</Text></View>
      <View style={[styles.metric, { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1 }]}><Text style={styles.settingsLabel}>REVIEWS</Text><Text style={styles.metricValue}>{person.reviewCount}</Text></View>
      <View style={[styles.metric, { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1 }]}><Text style={styles.settingsLabel}>SAVED</Text><Text style={styles.metricValue}>{favouritesQuery.isLoading ? '…' : savedCount}</Text></View>
    </View>
    <SectionTitle title="Your LumaLoop" />
    <View style={[{ borderRadius: 20, borderWidth: 1, paddingHorizontal: 16 }, { backgroundColor: colors.card, borderColor: colors.border }]}><ProfileMenuRow icon="credit-card" title="Balance" detail="Track earnings from your sales" onPress={() => router.push('/balance' as any)} /><ProfileMenuRow icon="heart" title="Favourite items" value={favouritesQuery.isLoading ? '…' : String(savedCount)} onPress={() => router.push('/favourites' as any)} /><ProfileMenuRow icon="shopping-bag" title="My orders" detail="Purchases and tracking" onPress={() => router.push('/orders' as any)} /><ProfileMenuRow icon="tag" title="Sell a piece" detail={pieces.length ? `${pieces.length} active listing${pieces.length === 1 ? '' : 's'}` : 'Give something a new chapter'} onPress={() => router.push('/sell' as any)} /></View>
    <SectionTitle title="Preferences & support" />
    <View style={[{ borderRadius: 20, borderWidth: 1, paddingHorizontal: 16 }, { backgroundColor: colors.card, borderColor: colors.border }]}><ProfileMenuRow icon="sliders" title="Account settings" detail="Profile, notifications and sign out" onPress={() => router.push('/settings' as any)} /><ProfileMenuRow icon="help-circle" title="LumaLoop guide" detail="How buying and selling works" onPress={() => Alert.alert('LumaLoop guide', 'Browse thoughtfully, ask questions, and keep every transaction in the app.')} /></View>
  </Screen>;
}

export function ProfileScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return typeof id === 'string' ? <ProfileDetailScreen /> : <ProfileHubScreen />;
}

export function SettingsScreen() {
  const colors = useColors();
  const { isSignedIn } = useAuth();
  const { user } = useUser();
  const { signOut } = useClerk();
  const person = profileFromClerk(user);
  const { installedVersion, installedVersionCode, checking, checkForUpdates } = useUpdates();
  const updateSection = <><Text style={styles.settingsLabel}>ABOUT LUMALOOP</Text><Pressable testID="settings-check-updates" disabled={checking} onPress={() => void checkForUpdates()} style={styles.settingRow}><Feather name="refresh-cw" size={19} color={colors.foreground} /><View style={{ flex: 1 }}><Text style={styles.settingText}>{checking ? 'Checking for updates…' : 'Check for updates'}</Text><Text style={[styles.muted, { fontSize: 12, marginTop: 3 }]}>Version {installedVersion} ({installedVersionCode})</Text></View><Feather name="chevron-right" size={18} color={colors.mutedForeground} /></Pressable></>;
  if (!isSignedIn || !person) return <Screen><Header title="Settings" /><AuthRequired title="Sign in to manage your account" detail="Your profile, orders and preferences are private." />{updateSection}</Screen>;
  const leave = async () => { await signOut(); router.replace('/' as any); };
  return <Screen><Header title="Settings" /><View style={styles.settingsProfile}><Avatar user={person} size={54} /><View><Text style={styles.sellerName}>{person.name}</Text><Text style={styles.muted}>View your profile</Text></View><Pressable onPress={() => router.push(`/profile/${person.id}` as any)} style={{ marginLeft: 'auto' }}><Feather name="chevron-right" size={20} color={colors.mutedForeground} /></Pressable></View><Text style={styles.settingsLabel}>YOUR ACCOUNT</Text>{[['user', 'Profile details', `/profile/${person.id}`], ['shopping-bag', 'Orders & offers', '/orders'], ['bell', 'Notifications', '/notifications']].map(([icon, label, path]) => <Pressable key={label} onPress={() => router.push(path as any)} style={styles.settingRow}><Feather name={icon as any} size={19} color={colors.foreground} /><Text style={styles.settingText}>{label}</Text><Feather name="chevron-right" size={18} color={colors.mutedForeground} /></Pressable>)}<Text style={styles.settingsLabel}>COMMUNITY</Text><Pressable onPress={() => router.push('/admin' as any)} style={styles.settingRow}><MaterialCommunityIcons name="view-dashboard-outline" size={20} color={colors.foreground} /><Text style={styles.settingText}>Admin dashboard</Text><Feather name="chevron-right" size={18} color={colors.mutedForeground} /></Pressable>{updateSection}<Pressable onPress={leave} style={[styles.signOut, { borderColor: colors.border }]}><Text style={{ color: colors.primary, fontFamily: 'Inter_600SemiBold' }}>Sign out</Text></Pressable></Screen>;
}

export function NotificationsScreen() {
  const colors = useColors();
  const { isSignedIn } = useAuth();
  const query = useListNotifications({ query: { enabled: Boolean(isSignedIn), refetchInterval: 15_000 } as any });
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();
  const items = query.data ?? [];
  const unreadCount = items.filter((item) => !item.readAt).length;
  const openNotification = (item: (typeof items)[number]) => {
    const navigate = () => {
      if (item.conversationId) router.push(`/messages/${item.conversationId}` as any);
      else if (item.orderId) router.push('/orders' as any);
      else if (item.productId) router.push(`/product/${item.productId}` as any);
      else if (item.offerId) router.push('/offers' as any);
    };
    if (item.readAt) {
      navigate();
      return;
    }
    markRead.mutate({ notificationId: item.id }, {
      onSuccess: async () => {
        await query.refetch();
        navigate();
      },
      onError: navigate,
    });
  };
  const iconFor = (type: (typeof items)[number]['type']) => {
    if (type === 'offer') return 'tag';
    if (type === 'message') return 'message-circle';
    if (type === 'favourite') return 'heart';
    if (type === 'delivery') return 'truck';
    return 'shopping-bag';
  };
  if (!isSignedIn) return <Screen><Header back title="Notifications" /><AuthRequired title="Sign in to view notifications" detail="Account notifications are private." /></Screen>;
  if (query.isLoading) return <Screen><Header back title="Notifications" /><LoadingState /></Screen>;
  if (query.isError) return <Screen><Header back title="Notifications" /><ErrorState onRetry={() => query.refetch()} /></Screen>;
  const markEverythingRead = () => markAllRead.mutate(undefined, { onSuccess: () => query.refetch() });
  return <Screen><Header back title="Notifications" right={unreadCount ? <Pressable accessibilityRole="button" onPress={markEverythingRead} disabled={markAllRead.isPending}><Text style={styles.link}>{markAllRead.isPending ? 'Marking…' : 'Mark all read'}</Text></Pressable> : undefined} />{items.length ? <View style={{ marginTop: 8 }}>{items.map((item) => <Pressable key={item.id} accessibilityRole="button" accessibilityLabel={`${item.readAt ? '' : 'Unread: '}${item.title}`} onPress={() => openNotification(item)} style={({ pressed }) => [styles.notification, !item.readAt && { backgroundColor: colors.card, marginHorizontal: -10, paddingHorizontal: 10, borderRadius: 14 }, pressed && { opacity: .72 }]}><View style={[styles.notifIcon, { backgroundColor: item.readAt ? colors.secondary : colors.accent }]}><Feather name={iconFor(item.type) as any} size={18} color={item.readAt ? colors.foreground : colors.accentForeground} /></View><View style={{ flex: 1 }}><View style={styles.rowBetween}><Text style={styles.notificationTitle}>{item.title}</Text>{!item.readAt && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.primary }} />}</View><Text style={styles.muted}>{item.body}</Text><Text style={[styles.timestamp, { marginTop: 7 }]}>{dateLabel(item.createdAt)}</Text></View><Feather name="chevron-right" size={18} color={colors.mutedForeground} /></Pressable>)}</View> : <EmptyState icon="bell" title="You’re all caught up" detail="New offers, messages, favourites, orders and delivery updates will show up here." />}</Screen>;
}

export function ReportScreen() {
  const colors = useColors();
  const { isSignedIn } = useAuth();
  const params = useLocalSearchParams<{ targetType?: 'user' | 'listing'; targetId?: string }>();
  const [reason, setReason] = useState('');
  const create = useCreateReport();
  const validTarget = Boolean(params.targetType && params.targetId);
  const submit = () => {
    if (!params.targetType || !params.targetId) return;
    create.mutate({ data: { targetType: params.targetType, targetId: params.targetId, reason } }, { onSuccess: () => { Alert.alert('Thanks for looking out', 'Our team will review this report privately.'); router.back(); }, onError: () => Alert.alert('Report not sent', 'Please try again when you are connected.') });
  };
  if (!isSignedIn) return <Screen><Header back title="Safety centre" /><AuthRequired title="Sign in to send a report" detail="Reports are private and connected to your account." /></Screen>;
  if (!validTarget) return <Screen><Header back title="Safety centre" /><EmptyState icon="shield" title="Nothing selected to report" detail="Open a listing or seller profile and choose Report." action="Browse listings" onPress={() => router.replace('/search' as any)} /></Screen>;
  return <Screen><Header back title="Safety centre" /><Text style={styles.sellLead}>Keep the loop{'\n'}a good place.</Text><Text style={styles.muted}>Tell us what happened. Reports are private and reviewed by our trust team.</Text><Text style={[styles.settingsLabel, { marginTop: 32 }]}>WHY ARE YOU REPORTING THIS?</Text><View style={{ gap: 10 }}>{['Something feels misleading', 'Item or profile is inappropriate', 'I suspect a scam', 'Other'].map((item) => <Pressable key={item} onPress={() => setReason(item)} style={[styles.reason, { borderColor: reason === item ? colors.primary : colors.border, backgroundColor: reason === item ? '#f8e2db' : colors.card }]}><View style={[styles.radio, { borderColor: reason === item ? colors.primary : colors.border }]}>{reason === item && <View style={styles.radioDot} />}</View><Text style={styles.settingText}>{item}</Text></Pressable>)}</View><PrimaryButton label={create.isPending ? 'Sending…' : 'Send report'} disabled={!reason || create.isPending} onPress={submit} /></Screen>;
}

export function AdminScreen() {
  const colors = useColors();
  const { isSignedIn } = useAuth();
  const overview = useGetAdminOverview({ query: { enabled: Boolean(isSignedIn) } as any });
  const reports = useListAdminReports(undefined, { query: { enabled: Boolean(isSignedIn && overview.data) } as any });
  const updateReport = useUpdateAdminReport();
  const forbidden = (overview.error as any)?.status === 403;
  const refresh = () => {
    void overview.refetch();
    void reports.refetch();
  };
  const setStatus = (reportId: string, status: 'reviewing' | 'resolved' | 'dismissed') => {
    updateReport.mutate({ reportId, data: { status } }, { onSuccess: refresh });
  };

  if (!isSignedIn) return <Screen><Header back title="Admin dashboard" /><AuthRequired title="Sign in to continue" detail="Moderator tools require an authenticated account." /></Screen>;
  if (forbidden) return <Screen><Header back title="Admin dashboard" /><EmptyState icon="lock" title="Moderator access only" detail="Your account is signed in, but it does not have permission to view LumaLoop moderation tools." action="Back to marketplace" onPress={() => router.replace('/' as any)} /></Screen>;
  if (overview.isLoading) return <Screen><Header back title="Admin dashboard" /><LoadingState /></Screen>;
  if (overview.isError || !overview.data) return <Screen><Header back title="Admin dashboard" /><ErrorState onRetry={() => overview.refetch()} /></Screen>;
  const counts = overview.data.counts;
  const reportItems = reports.data ?? [];
  return <Screen><Header back title="Admin dashboard" /><Text style={styles.pageLead}>Trust, kept in motion.</Text><Text style={styles.muted}>A live view of the LumaLoop marketplace and the reports that need a considered response.</Text><View style={[styles.metrics, { flexWrap: 'wrap', marginTop: 24 }]}>{[['Users', counts.users], ['Listings', counts.listings], ['Reports', counts.reports], ['Orders', counts.orders]].map(([label, value]) => <View key={label as string} style={[styles.metric, { flexBasis: '46%' }]}><Text style={styles.settingsLabel}>{label as string}</Text><Text style={styles.metricValue}>{value as number}</Text></View>)}</View><View style={styles.rowBetween}><Text style={styles.sectionTitle}>Reports</Text><Text style={styles.muted}>{counts.openReports} open</Text></View>{reports.isLoading ? <LoadingState /> : reports.isError ? <ErrorState onRetry={() => reports.refetch()} /> : reportItems.length ? <View style={{ gap: 12, marginTop: 14 }}>{reportItems.map((report) => <View key={report.id} style={{ borderRadius: 16, padding: 16, backgroundColor: colors.card, gap: 2 }}><View style={styles.rowBetween}><View style={{ flex: 1 }}><Text style={styles.settingsLabel}>{report.targetType} · {report.status}</Text><Text style={styles.sellerName}>{report.targetId}</Text></View><Text style={styles.timestamp}>{dateLabel(report.createdAt)}</Text></View><Text style={[styles.muted, { marginTop: 10 }]}>{report.reason}</Text><Text style={[styles.timestamp, { marginTop: 9 }]}>Reported by {report.reporterId}</Text>{report.audit.length > 0 && <Text style={[styles.timestamp, { marginTop: 6 }]}>Last action: {report.audit[report.audit.length - 1].newStatus} by {report.audit[report.audit.length - 1].moderatorId}</Text>}<View style={{ flexDirection: 'row', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>{report.status === 'open' && <Pressable onPress={() => setStatus(report.id, 'reviewing')} disabled={updateReport.isPending} style={{ minHeight: 38, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderColor: colors.border }}><Text style={styles.secondaryText}>Review</Text></Pressable>}{report.status !== 'resolved' && <Pressable onPress={() => setStatus(report.id, 'resolved')} disabled={updateReport.isPending} style={{ minHeight: 38, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderColor: colors.primary, backgroundColor: colors.primary }}><Text style={[styles.secondaryText, { color: colors.primaryForeground }]}>Resolve</Text></Pressable>}{report.status !== 'dismissed' && <Pressable onPress={() => setStatus(report.id, 'dismissed')} disabled={updateReport.isPending} style={{ minHeight: 38, borderRadius: 12, borderWidth: 1, paddingHorizontal: 12, alignItems: 'center', justifyContent: 'center', borderColor: colors.border }}><Text style={styles.secondaryText}>Dismiss</Text></Pressable>}</View></View>)}</View> : <EmptyState icon="shield" title="No reports to review" detail="New safety reports will appear here as the community flags them." />}</Screen>;
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function friendlyAuthError(error: unknown, fallback: string): string {
  const candidate = error as { code?: string; longMessage?: string; message?: string } | null;
  const code = candidate?.code?.toLowerCase() ?? '';
  const message = `${candidate?.longMessage ?? ''} ${candidate?.message ?? ''}`.toLowerCase();
  if (code.includes('identifier_not_found') || code.includes('form_identifier_not_found')) return 'We couldn’t find an account with that email. Check it or create a new account.';
  if (code.includes('form_identifier_exists') || code.includes('identifier_exists')) return 'An account already uses this email. Try signing in instead.';
  if (code.includes('form_password_incorrect') || code.includes('password_incorrect') || message.includes('incorrect password')) return 'That password doesn’t match this account. Try again or reset it.';
  if (code.includes('verification_expired') || code.includes('code_expired') || message.includes('expired')) return 'That code has expired. Request a new code and try again.';
  if (code.includes('verification_failed') || code.includes('code_invalid') || message.includes('invalid code')) return 'That code isn’t right. Check your email and try again.';
  if (code.includes('too_many') || code.includes('rate_limit') || message.includes('too many') || message.includes('rate limit')) return 'Too many attempts. Wait a moment, then try again.';
  if (code.includes('password') && (message.includes('requirements') || message.includes('weak'))) return 'Choose a stronger password that meets the requirements below.';
  if (code.includes('network') || message.includes('network')) return 'Check your connection and try again.';
  return fallback;
}

function localEmailError(email: string): string {
  if (!email.trim()) return 'Enter your email address.';
  if (!emailPattern.test(email.trim())) return 'Enter a valid email address.';
  return '';
}

function localPasswordError(password: string, confirmation?: string): string {
  if (!password) return 'Enter your password.';
  if (password.length < 8) return 'Use at least 8 characters.';
  if (confirmation !== undefined && password !== confirmation) return 'Passwords don’t match.';
  return '';
}

function AuthInput({
  label,
  value,
  onChangeText,
  placeholder,
  secureTextEntry = false,
  onToggleSecure,
  error,
  keyboardType = 'default',
  autoCapitalize = 'sentences',
  autoComplete,
  textContentType,
  testID,
  returnKeyType,
  onSubmitEditing,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  secureTextEntry?: boolean;
  onToggleSecure?: () => void;
  error?: string;
  keyboardType?: KeyboardTypeOptions;
  autoCapitalize?: 'none' | 'sentences' | 'words' | 'characters';
  autoComplete?: 'email' | 'password' | 'new-password' | 'off';
  textContentType?: 'emailAddress' | 'password' | 'newPassword' | 'oneTimeCode' | 'none';
  testID?: string;
  returnKeyType?: 'next' | 'done' | 'send';
  onSubmitEditing?: () => void;
}) {
  const colors = useColors();
  return <View style={{ gap: 7 }}>
    <Text style={[styles.label, { color: colors.mutedForeground }]}>{label}</Text>
    <View style={{ minHeight: 52, borderWidth: 1, borderRadius: 15, borderColor: error ? colors.primary : colors.border, backgroundColor: colors.card, flexDirection: 'row', alignItems: 'center' }}>
      <TextInput
        testID={testID}
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.mutedForeground}
        secureTextEntry={secureTextEntry}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        autoComplete={autoComplete}
        textContentType={textContentType}
        returnKeyType={returnKeyType}
        onSubmitEditing={onSubmitEditing}
        style={{ flex: 1, minHeight: 50, paddingHorizontal: 15, color: colors.foreground, fontFamily: 'Inter_400Regular', fontSize: 15 }}
      />
      {onToggleSecure ? <Pressable accessibilityRole="button" accessibilityLabel={secureTextEntry ? `Show ${label.toLowerCase()}` : `Hide ${label.toLowerCase()}`} onPress={onToggleSecure} hitSlop={10} style={{ paddingHorizontal: 15, minHeight: 50, justifyContent: 'center' }}>
        <Feather name={secureTextEntry ? 'eye' : 'eye-off'} size={19} color={colors.mutedForeground} />
      </Pressable> : null}
    </View>
    {error ? <Text accessibilityRole="alert" style={{ color: colors.primary, fontFamily: 'Inter_500Medium', fontSize: 12, lineHeight: 17 }}>{error}</Text> : null}
  </View>;
}

function AuthLink({ label, onPress, disabled = false }: { label: string; onPress: () => void; disabled?: boolean }) {
  const colors = useColors();
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [{ minHeight: 40, justifyContent: 'center', alignItems: 'center' }, pressed && { opacity: .7 }, disabled && { opacity: .5 }]}>
    <Text style={[styles.link, { color: colors.primary }]}>{label}</Text>
  </Pressable>;
}

function AuthNotice({ children, tone = 'error' }: { children: React.ReactNode; tone?: 'error' | 'info' | 'hint' }) {
  const colors = useColors();
  const color = tone === 'error' ? colors.primary : colors.mutedForeground;
  return <Text accessibilityRole={tone === 'error' ? 'alert' : undefined} style={{ color, fontFamily: tone === 'hint' ? 'Inter_400Regular' : 'Inter_500Medium', fontSize: 12, lineHeight: 18 }}>{children}</Text>;
}

function AuthShell({ children, title, copy, alternate }: { children: React.ReactNode; title: string; copy: string; alternate: React.ReactNode }) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  return <KeyboardAwareScrollView bottomOffset={24} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false} contentContainerStyle={{ flexGrow: 1, paddingHorizontal: 20, paddingTop: (Platform.OS === 'web' ? 67 : insets.top) + 8, paddingBottom: (Platform.OS === 'web' ? 34 : insets.bottom) + 28, backgroundColor: colors.background }}>
    <Pressable accessibilityRole="button" accessibilityLabel="Close authentication" onPress={() => router.back()} hitSlop={12} style={{ alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' }}>
      <Feather name="x" size={23} color={colors.foreground} />
    </Pressable>
    <View style={{ marginTop: 28, alignItems: 'center' }}>
      <Logo />
      <Text style={[styles.authTitle, { color: colors.foreground, textAlign: 'center' }]}>{title}</Text>
      <Text style={[styles.authCopy, { color: colors.mutedForeground }]}>{copy}</Text>
    </View>
    <View style={{ gap: 17, marginTop: 30 }}>{children}</View>
    {alternate}
    <Text style={[styles.terms, { color: colors.mutedForeground }]}>By continuing, you agree to our Terms and Privacy Policy.</Text>
  </KeyboardAwareScrollView>;
}

function GoogleButton({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} style={({ pressed }) => [styles.googleButton, disabled && { opacity: .55 }, pressed && { opacity: .75 }]} onPress={onPress}>
    <Ionicons name="logo-google" size={18} color="#182331" />
    <Text style={styles.googleText}>{label}</Text>
  </Pressable>;
}

function SignInForm() {
  const { signIn, errors, fetchStatus } = useSignIn();
  const { startSSOFlow } = useSSO();
  useWarmUpBrowser();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [resetStep, setResetStep] = useState<'none' | 'code' | 'password'>('none');
  const [localError, setLocalError] = useState('');
  const [info, setInfo] = useState('');
  const [googleBusy, setGoogleBusy] = useState(false);
  const busy = fetchStatus === 'fetching' || googleBusy;
  const submit = async () => {
    const emailError = localEmailError(email);
    const passwordError = localPasswordError(password);
    if (emailError || passwordError) {
      setLocalError(emailError || passwordError);
      return;
    }
    setLocalError('');
    setInfo('');
    try {
      const { error } = await signIn.password({ emailAddress: email.trim().toLowerCase(), password });
      if (error) {
        setLocalError(friendlyAuthError(error, 'We couldn’t sign you in. Check your details and try again.'));
        return;
      }
      if (signIn.status === 'complete') {
        await signIn.finalize({ navigate: navigateAfterAuth });
        return;
      }
      setLocalError('This account needs another verification step. Try Google sign-in or reset your password.');
    } catch (error) {
      setLocalError(friendlyAuthError(error, 'We couldn’t sign you in. Check your connection and try again.'));
    }
  };
  const startReset = async () => {
    const emailError = localEmailError(email);
    if (emailError) {
      setLocalError(emailError);
      return;
    }
    setLocalError('');
    setInfo('');
    try {
      const { error } = await signIn.create({ identifier: email.trim().toLowerCase() });
      if (error) {
        setLocalError(friendlyAuthError(error, 'We couldn’t start password recovery. Check your email and try again.'));
        return;
      }
      const sent = await signIn.resetPasswordEmailCode.sendCode();
      if (sent.error) {
        setLocalError(friendlyAuthError(sent.error, 'We couldn’t send a reset code. Try again in a moment.'));
        return;
      }
      setResetStep('code');
      setInfo(`We sent a reset code to ${email.trim().toLowerCase()}.`);
    } catch (error) {
      setLocalError(friendlyAuthError(error, 'We couldn’t start password recovery. Check your connection and try again.'));
    }
  };
  const verifyResetCode = async () => {
    if (code.trim().length < 4) {
      setLocalError('Enter the reset code from your email.');
      return;
    }
    setLocalError('');
    try {
      const { error } = await signIn.resetPasswordEmailCode.verifyCode({ code: code.trim() });
      if (error) {
        setLocalError(friendlyAuthError(error, 'That reset code isn’t right. Check your email or request a new one.'));
        return;
      }
      setResetStep('password');
      setInfo('Choose a new password for your account.');
    } catch (error) {
      setLocalError(friendlyAuthError(error, 'We couldn’t verify that code. Request a new one and try again.'));
    }
  };
  const finishReset = async () => {
    const passwordError = localPasswordError(newPassword);
    if (passwordError) {
      setLocalError(passwordError);
      return;
    }
    setLocalError('');
    try {
      const { error } = await signIn.resetPasswordEmailCode.submitPassword({ password: newPassword });
      if (error) {
        setLocalError(friendlyAuthError(error, 'We couldn’t update your password. Choose a different password and try again.'));
        return;
      }
      if (signIn.status === 'complete') {
        await signIn.finalize({ navigate: navigateAfterAuth });
        return;
      }
      setResetStep('none');
      setPassword('');
      setInfo('Your password was updated. Sign in with your new password.');
    } catch (error) {
      setLocalError(friendlyAuthError(error, 'We couldn’t update your password. Check your connection and try again.'));
    }
  };
  const resendResetCode = async () => {
    setLocalError('');
    try {
      const { error } = await signIn.resetPasswordEmailCode.sendCode();
      if (error) {
        setLocalError(friendlyAuthError(error, 'We couldn’t send another code yet. Try again in a moment.'));
        return;
      }
      setInfo(`A new reset code was sent to ${email.trim().toLowerCase()}.`);
    } catch (error) {
      setLocalError(friendlyAuthError(error, 'We couldn’t send another code. Check your connection and try again.'));
    }
  };
  const google = async () => {
    if (googleBusy) return;
    setGoogleBusy(true);
    setLocalError('');
    try {
      const result = await startSSOFlow({ strategy: 'oauth_google', redirectUrl: googleRedirectUrl() });
      if (resolveGoogleAuthHandoff(result) === 'success') {
        if (!result.setActive) throw new Error('session');
        await result.setActive({ session: result.createdSessionId, navigate: navigateAfterAuth });
      } else {
        setLocalError(GOOGLE_SIGN_IN_ERROR);
      }
    } catch {
      setLocalError(GOOGLE_SIGN_IN_ERROR);
    } finally {
      setGoogleBusy(false);
    }
  };
  const identifierError = errors.fields.identifier?.message;
  const passwordFieldError = errors.fields.password?.message;
  const alternate = <View style={styles.authFooter}><Text style={styles.muted}>{resetStep === 'none' ? 'New to LumaLoop?' : 'Remembered your password?'}</Text><Pressable accessibilityRole="button" onPress={resetStep === 'none' ? () => router.replace('/sign-up' as any) : () => { setResetStep('none'); setLocalError(''); setInfo(''); }}><Text style={styles.link}> {resetStep === 'none' ? 'Create account' : 'Back to sign in'}</Text></Pressable></View>;
  if (resetStep === 'code') return <AuthShell title="Check your inbox." copy={info || `We sent a reset code to ${email}.`} alternate={alternate}><AuthInput label="Reset code" value={code} onChangeText={setCode} placeholder="Six-digit code" keyboardType="number-pad" autoCapitalize="none" autoComplete="off" textContentType="oneTimeCode" error={localError} testID="reset-code" returnKeyType="done" onSubmitEditing={verifyResetCode} /><PrimaryButton testID="verify-reset-code" label={fetchStatus === 'fetching' ? 'Checking…' : 'Verify code'} disabled={!code.trim() || busy} onPress={verifyResetCode} /><AuthLink label="Resend code" onPress={resendResetCode} disabled={busy} /></AuthShell>;
  if (resetStep === 'password') return <AuthShell title="Set a new password." copy={info || 'Choose a password you will remember.'} alternate={alternate}><AuthInput label="New password" value={newPassword} onChangeText={setNewPassword} placeholder="At least 8 characters" secureTextEntry={!showNewPassword} onToggleSecure={() => setShowNewPassword((visible) => !visible)} autoCapitalize="none" autoComplete="new-password" textContentType="newPassword" error={localError} testID="new-password" returnKeyType="done" onSubmitEditing={finishReset} /><AuthNotice tone="hint">Use at least 8 characters. Avoid using a password you use elsewhere.</AuthNotice><PrimaryButton testID="finish-password-reset" label={fetchStatus === 'fetching' ? 'Updating…' : 'Update password'} disabled={!newPassword || busy} onPress={finishReset} /></AuthShell>;
  return <AuthShell title="Welcome back." copy="Your saved finds are waiting." alternate={alternate}><AuthInput label="Email address" value={email} onChangeText={(value) => { setEmail(value); setLocalError(''); }} placeholder="you@example.com" keyboardType="email-address" autoCapitalize="none" autoComplete="email" textContentType="emailAddress" error={identifierError ? friendlyAuthError({ message: identifierError }, 'Check your email address.') : ''} testID="sign-in-email" returnKeyType="next" /><AuthInput label="Password" value={password} onChangeText={(value) => { setPassword(value); setLocalError(''); }} placeholder="Your password" secureTextEntry={!showPassword} onToggleSecure={() => setShowPassword((visible) => !visible)} autoCapitalize="none" autoComplete="password" textContentType="password" error={passwordFieldError ? friendlyAuthError({ message: passwordFieldError }, 'Check your password.') : ''} testID="sign-in-password" returnKeyType="done" onSubmitEditing={submit} /><View style={{ alignItems: 'flex-end', marginTop: -7 }}><AuthLink label="Forgot password?" onPress={startReset} disabled={busy} /></View>{localError ? <AuthNotice>{localError}</AuthNotice> : null}{info ? <AuthNotice tone="info">{info}</AuthNotice> : null}<PrimaryButton testID="sign-in-submit" label={fetchStatus === 'fetching' ? 'Signing in…' : 'Continue'} disabled={!email || !password || busy} onPress={submit} /><GoogleButton label={googleBusy ? 'Opening Google…' : 'Continue with Google'} onPress={google} disabled={busy} /></AuthShell>;
}

function SignUpForm() {
  const { signUp, errors, fetchStatus } = useSignUp();
  const { startSSOFlow } = useSSO();
  useWarmUpBrowser();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [step, setStep] = useState<'form' | 'verify'>('form');
  const [localError, setLocalError] = useState('');
  const [emailError, setEmailError] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [info, setInfo] = useState('');
  const [googleBusy, setGoogleBusy] = useState(false);
  const busy = fetchStatus === 'fetching' || googleBusy;
  const submit = async () => {
    const nextEmailError = localEmailError(email);
    const nextPasswordError = localPasswordError(password);
    setEmailError(nextEmailError);
    setPasswordError(nextPasswordError);
    if (nextEmailError || nextPasswordError) {
      setLocalError('');
      return;
    }
    setLocalError('');
    setInfo('');
    try {
      const { error } = await signUp.password({ emailAddress: email.trim().toLowerCase(), password });
      if (error) {
        setLocalError(friendlyAuthError(error, 'We couldn’t create your account. Check your details and try again.'));
        return;
      }
      const sent = await signUp.verifications.sendEmailCode();
      if (sent.error) {
        setLocalError(friendlyAuthError(sent.error, 'Your account is almost ready, but we couldn’t send the code. Try again.'));
        return;
      }
      setStep('verify');
      setInfo(`We sent a verification code to ${email.trim().toLowerCase()}.`);
    } catch (error) {
      setLocalError(friendlyAuthError(error, 'We couldn’t create your account. Check your connection and try again.'));
    }
  };
  const verify = async () => {
    if (code.trim().length < 4) {
      setLocalError('Enter the verification code from your email.');
      return;
    }
    setLocalError('');
    try {
      const result = await signUp.verifications.verifyEmailCode({ code: code.trim() });
      if (result.error) {
        setLocalError(friendlyAuthError(result.error, 'That verification code isn’t right. Check your email and try again.'));
        return;
      }
      if (signUp.status === 'complete') {
        await signUp.finalize({ navigate: navigateAfterAuth });
        return;
      }
      setLocalError(`Your account still needs ${signUp.missingFields.join(', ') || 'one more step'}.`);
    } catch (error) {
      setLocalError(friendlyAuthError(error, 'We couldn’t verify that code. Request a new one and try again.'));
    }
  };
  const resend = async () => {
    setLocalError('');
    try {
      const { error } = await signUp.verifications.sendEmailCode();
      if (error) {
        setLocalError(friendlyAuthError(error, 'We couldn’t send another code yet. Try again in a moment.'));
        return;
      }
      setInfo(`A new verification code was sent to ${email.trim().toLowerCase()}.`);
    } catch (error) {
      setLocalError(friendlyAuthError(error, 'We couldn’t send another code. Check your connection and try again.'));
    }
  };
  const changeEmail = async () => {
    setLocalError('');
    try {
      const { error } = await signUp.reset();
      if (error) {
        setLocalError(friendlyAuthError(error, 'We couldn’t restart sign-up. Please try again.'));
        return;
      }
      setCode('');
      setInfo('');
      setEmailError('');
      setPasswordError('');
      setStep('form');
    } catch {
      setLocalError('We couldn’t restart sign-up. Please try again.');
    }
  };
  const google = async () => {
    if (googleBusy) return;
    setGoogleBusy(true);
    setLocalError('');
    try {
      const result = await startSSOFlow({ strategy: 'oauth_google', redirectUrl: googleRedirectUrl() });
      if (resolveGoogleAuthHandoff(result) === 'success') {
        if (!result.setActive) throw new Error('session');
        await result.setActive({ session: result.createdSessionId, navigate: navigateAfterAuth });
      } else {
        setLocalError(GOOGLE_SIGN_UP_ERROR);
      }
    } catch {
      setLocalError(GOOGLE_SIGN_UP_ERROR);
    } finally {
      setGoogleBusy(false);
    }
  };
  const alternate = <View style={styles.authFooter}><Text style={styles.muted}>{step === 'form' ? 'Already have an account?' : 'Using a different email?'}</Text><Pressable accessibilityRole="button" onPress={step === 'form' ? () => router.replace('/sign-in' as any) : changeEmail}><Text style={styles.link}> {step === 'form' ? 'Sign in' : 'Change email'}</Text></Pressable></View>;
  if (step === 'verify') return <AuthShell title="Check your inbox." copy={info || `We sent a verification code to ${email}.`} alternate={alternate}><AuthInput label="Verification code" value={code} onChangeText={setCode} placeholder="Six-digit code" keyboardType="number-pad" autoCapitalize="none" autoComplete="off" textContentType="oneTimeCode" error={localError} testID="sign-up-code" returnKeyType="done" onSubmitEditing={verify} /><PrimaryButton testID="sign-up-verify" label={fetchStatus === 'fetching' ? 'Checking…' : 'Verify email'} disabled={!code.trim() || busy} onPress={verify} /><AuthLink label="Resend code" onPress={resend} disabled={busy} /></AuthShell>;
  return <AuthShell title="Join the good loop." copy="Buy better. Sell thoughtfully. Keep things moving." alternate={alternate}><AuthInput label="Email address" value={email} onChangeText={(value) => { setEmail(value); setEmailError(value && !emailPattern.test(value.trim()) ? 'Enter a valid email address.' : ''); setLocalError(''); }} placeholder="you@example.com" keyboardType="email-address" autoCapitalize="none" autoComplete="email" textContentType="emailAddress" error={emailError || (errors.fields.emailAddress?.message ? friendlyAuthError({ message: errors.fields.emailAddress.message }, 'Check your email address.') : '')} testID="sign-up-email" returnKeyType="next" /><AuthInput label="Password" value={password} onChangeText={(value) => { setPassword(value); setPasswordError(value && value.length < 8 ? 'Use at least 8 characters.' : ''); setLocalError(''); }} placeholder="At least 8 characters" secureTextEntry={!showPassword} onToggleSecure={() => setShowPassword((visible) => !visible)} autoCapitalize="none" autoComplete="new-password" textContentType="newPassword" error={passwordError || (errors.fields.password?.message ? friendlyAuthError({ message: errors.fields.password.message }, 'Choose a different password.') : '')} testID="sign-up-password" returnKeyType="done" onSubmitEditing={submit} />{!passwordError ? <AuthNotice tone="hint">Use at least 8 characters. We’ll email you a verification code next.</AuthNotice> : null}{localError ? <AuthNotice>{localError}</AuthNotice> : null}<PrimaryButton testID="sign-up-submit" label={fetchStatus === 'fetching' ? 'Creating account…' : 'Create account'} disabled={!email || !password || busy} onPress={submit} /><GoogleButton label={googleBusy ? 'Opening Google…' : 'Continue with Google'} onPress={google} disabled={busy} /><View nativeID="clerk-captcha" /></AuthShell>;
}

export function AuthScreen({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const { isSignedIn } = useAuth();
  if (isSignedIn) return <Redirect href="/" />;
  return mode === 'sign-in' ? <SignInForm /> : <SignUpForm />;
}
