'use client';

import { Amplify } from 'aws-amplify';

const userPoolId       = process.env.NEXT_PUBLIC_USER_POOL_ID;
const userPoolClientId = process.env.NEXT_PUBLIC_USER_POOL_CLIENT_ID;
const cognitoDomain    = process.env.NEXT_PUBLIC_COGNITO_DOMAIN;
const region           = process.env.NEXT_PUBLIC_AWS_REGION ?? 'us-east-1';

// Determine the origin at runtime (handles localhost vs production).
// Social sign-in redirects only happen in the browser, so server-side this is fine as a fallback.
const origin = typeof window !== 'undefined' ? window.location.origin : 'https://dwomohvibe.com';

if (userPoolId && userPoolClientId) {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId,
        loginWith: {
          email: true,
          // Hosted UI / OAuth — required for Google, Apple, Facebook social sign-in
          oauth: cognitoDomain
            ? {
                domain:          cognitoDomain,
                scopes:          ['email', 'openid', 'profile'],
                redirectSignIn:  [`${origin}/auth/callback`],
                redirectSignOut: [origin],
                responseType:    'code',
              }
            : undefined,
        },
        signUpVerificationMethod: 'code',
        userAttributes: {
          email: { required: true },
          name:  { required: false },
        },
      },
    },
  });
}

export const isAmplifyConfigured = Boolean(userPoolId && userPoolClientId);
export const isSocialConfigured  = Boolean(cognitoDomain);
export const cognitoRegion       = region;

export default function ConfigureAmplify() {
  return null;
}
