export const NATIVE_GOOGLE_REDIRECT_URL = 'lumaloop://sso-callback';

export const GOOGLE_SIGN_IN_ERROR = 'Google sign-in was cancelled or could not be completed. Try again.';
export const GOOGLE_SIGN_UP_ERROR = 'Google sign-up was cancelled or could not be completed. Try again.';

export type GoogleAuthHandoff = 'success' | 'cancelled' | 'interrupted';

export function resolveGoogleAuthHandoff(
  result?: { createdSessionId?: string | null } | null,
  error?: unknown,
): GoogleAuthHandoff {
  if (error) return 'interrupted';
  return result?.createdSessionId ? 'success' : 'cancelled';
}

export function callbackMessage(completionType: string): string {
  return completionType === 'success'
    ? 'Completing sign in…'
    : 'Google sign-in could not be completed. Return to LumaLoop and try again.';
}