'use client';

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react';
import { getCurrentUser, signOut as amplifySignOut, fetchUserAttributes, fetchAuthSession } from 'aws-amplify/auth';

export interface AuthUser {
  userId: string;
  email: string;
  name?: string;
  planId?: string;
  generationsUsed?: number;
}

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  /** Returns the current Cognito ID token for passing to API routes as Bearer token. */
  getToken: () => Promise<string | null>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  refresh: async () => {},
  signOut: async () => {},
  getToken: async () => null,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true);
    // Single 8-second timeout covers the ENTIRE auth load (getCurrentUser + fetchUserAttributes).
    // Cognito can hang on both calls if env vars are missing or network is slow.
    const doLoad = async () => {
      const cu = await getCurrentUser();
      const attrs = await fetchUserAttributes();
      return { cu, attrs };
    };
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('auth_timeout')), 8_000)
    );
    try {
      const { cu, attrs } = await Promise.race([doLoad(), timeout]);
      setUser({
        userId: cu.userId,
        email: attrs.email ?? cu.username,
        name: attrs.name,
      });
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load — no spinner needed since the app starts in loading:true
  useEffect(() => {
    load(false);
  }, [load]);

  // refresh() is called by auth pages right before navigating to a protected route.
  // Passing showLoader:true prevents dashboard guards from firing a spurious redirect.
  const refresh = useCallback(() => load(true), [load]);

  const signOut = useCallback(async () => {
    await amplifySignOut();
    setUser(null);
  }, []);

  const getToken = useCallback(async (): Promise<string | null> => {
    try {
      const session = await fetchAuthSession();
      return session.tokens?.idToken?.toString() ?? null;
    } catch {
      return null;
    }
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, refresh, signOut, getToken }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
