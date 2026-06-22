'use client';

import { ReactNode } from 'react';
import { Authenticator } from '@aws-amplify/ui-react';
import '@aws-amplify/ui-react/styles.css';
import { isAmplifyConfigured } from './ConfigureAmplify';

interface AuthWrapperProps {
  children: ReactNode;
}

// When Amplify is not yet configured (env vars missing), the app runs without
// authentication so local development still works without a deployed backend.
export default function AuthWrapper({ children }: AuthWrapperProps) {
  if (!isAmplifyConfigured) {
    return <>{children}</>;
  }

  return (
    <Authenticator loginMechanisms={['email']} signUpAttributes={['email']}>
      {({ signOut }) => (
        <div style={{ position: 'relative', width: '100%', height: '100%' }}>
          <button
            onClick={signOut}
            style={{
              position: 'fixed',
              top: 12,
              right: 12,
              padding: '6px 14px',
              background: '#ef4444',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              cursor: 'pointer',
              fontSize: 13,
              zIndex: 1000,
            }}
          >
            Sign out
          </button>
          {children}
        </div>
      )}
    </Authenticator>
  );
}
