'use client';

import { Amplify } from 'aws-amplify';

const userPoolId = process.env.NEXT_PUBLIC_USER_POOL_ID;
const userPoolClientId = process.env.NEXT_PUBLIC_USER_POOL_CLIENT_ID;

// Only configure Amplify when the Cognito identifiers are provided.
// Set NEXT_PUBLIC_USER_POOL_ID and NEXT_PUBLIC_USER_POOL_CLIENT_ID in .env.local
// (or in the Amplify Console → Environment Variables) after deploying the backend.
if (userPoolId && userPoolClientId) {
  Amplify.configure({
    Auth: {
      Cognito: {
        userPoolId,
        userPoolClientId,
        loginWith: {
          email: true,
        },
        signUpVerificationMethod: 'code',
      },
    },
  });
}

export const isAmplifyConfigured = Boolean(userPoolId && userPoolClientId);

export default function ConfigureAmplify() {
  return null;
}
