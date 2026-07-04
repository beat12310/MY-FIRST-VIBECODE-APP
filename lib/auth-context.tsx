'use client';

import { createContext, useContext, useEffect, useState, useCallback, useRef, ReactNode } from 'react';
import { getCurrentUser, signOut as amplifySignOut, fetchUserAttributes, fetchAuthSession } from 'aws-amplify/auth';

export interface AuthUser {
  userId: string;
  email: string;
  name?: string;
  picture?: string;   // Google profile photo URL (absent for email/password users)
  planId?: string;
  generationsUsed?: number;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  getToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null, loading: true,
  refresh: async () => {}, signOut: async () => {}, getToken: async () => null,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user,    setUser]    = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const loadSeq = useRef(0);

  const load = useCallback(async (showLoader = false) => {
    const mySeq = ++loadSeq.current;
    if (showLoader) setLoading(true);
    try {
      // 1. Confirm there is an active Cognito session.
      const cu = await getCurrentUser();

      // 2. Read the stored ID token payload — decoded from the JWT in localStorage,
      //    no network call required. For Google SSO users this is the authoritative
      //    source: email, name, and picture come from Google's OIDC claims as mapped
      //    by Cognito. For email+password users the same claims are present.
      const session = await fetchAuthSession({ forceRefresh: false });
      const jwt = session.tokens?.idToken?.payload ?? {};

      let email   = typeof jwt['email']   === 'string' && jwt['email']   ? jwt['email']   : undefined;
      let name    = typeof jwt['name']    === 'string' && jwt['name']    ? jwt['name']    : undefined;
      let picture = typeof jwt['picture'] === 'string' && jwt['picture'] ? jwt['picture'] : undefined;

      // Compose name from given_name + family_name if the 'name' claim is absent
      if (!name) {
        const gn = typeof jwt['given_name']  === 'string' ? jwt['given_name']  : '';
        const fn = typeof jwt['family_name'] === 'string' ? jwt['family_name'] : '';
        const full = [gn, fn].filter(Boolean).join(' ');
        if (full) name = full;
      }

      // 3. Overlay with User Pool attributes. This picks up user-editable overrides
      //    (e.g. the user changed their display name on the Settings page) and can
      //    fill gaps for email+password users who didn't get IDP-mapped attributes.
      try {
        const attrs = await fetchUserAttributes();
        if (attrs['email'])   email   = attrs['email'];
        if (attrs['name'])    name    = attrs['name'];
        if (attrs['picture']) picture = attrs['picture'];
        // Augment name from given/family if still missing
        if (!name && (attrs['given_name'] || attrs['family_name'])) {
          name = [attrs['given_name'], attrs['family_name']].filter(Boolean).join(' ') || undefined;
        }
      } catch { /* JWT claims already set above — proceed without attrs */ }

      // 4. Last-resort email fallback. Never expose Cognito's internal federated
      //    username (Google_108168..., Facebook_...) as the user's email address.
      if (!email) {
        const isFederated = /^(Google|Facebook|Apple|SignInWithApple)_/i.test(cu.username);
        email = isFederated ? '' : cu.username;
      }

      if (mySeq !== loadSeq.current) return;
      setUser({ userId: cu.userId, email, name, picture });
    } catch {
      if (mySeq !== loadSeq.current) return;
      setUser(null);
    } finally {
      if (mySeq === loadSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => { load(false); }, [load]);

  const refresh  = useCallback(() => load(true), [load]);

  const signOut  = useCallback(async () => {
    await amplifySignOut();
    setUser(null);
  }, []);

  const getToken = useCallback(async (): Promise<string | null> => {
    try {
      const session = await fetchAuthSession();
      return session.tokens?.idToken?.toString() ?? null;
    } catch { return null; }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, refresh, signOut, getToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() { return useContext(AuthContext); }
