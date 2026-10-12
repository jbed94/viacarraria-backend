import { betterAuth } from 'better-auth';
import { anonymous } from 'better-auth/plugins';
import { Pool } from 'pg';

import { sharedMailService } from './common/services/mail.service.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to configure Better Auth.');
}

const betterAuthSecret = process.env.BETTER_AUTH_SECRET;
if (!betterAuthSecret) {
  throw new Error('BETTER_AUTH_SECRET is required to configure Better Auth.');
}

const poolSize = Number.parseInt(process.env.DATABASE_POOL_SIZE ?? '30', 10);
export const authDatabase = new Pool({
  connectionString: databaseUrl,
  max: Number.isFinite(poolSize) && poolSize > 0 ? poolSize : 30,
});

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const googleProvider =
  googleClientId && googleClientSecret
    ? {
        google: {
          clientId: googleClientId,
          clientSecret: googleClientSecret,
          prompt: 'select_account' as const,
        },
      }
    : undefined;

const rawAuthUrl = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
const cleanBaseUrl = rawAuthUrl.replace(/\/api(\/auth)?\/?$/, '');

export const auth = betterAuth({
  baseURL: cleanBaseUrl,
  basePath: '/api/auth',
  secret: betterAuthSecret,
  trustedOrigins: (process.env.FRONTEND_ORIGIN ?? 'http://localhost:4173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  database: authDatabase,
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    requireEmailVerification:
      process.env.REQUIRE_EMAIL_VERIFICATION === 'true' ||
      process.env.NODE_ENV !== 'test',
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    expiresIn: 24 * 60 * 60,
    sendVerificationEmail: async ({ user, token }) => {
      const frontendOrigin =
        (process.env.FRONTEND_ORIGIN ?? 'http://localhost:4173')
          .split(',')[0]
          ?.trim() || 'http://localhost:4173';
      const verificationUrl = `${cleanBaseUrl}/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent(`${frontendOrigin}/?verified=true`)}`;
      await sharedMailService.sendVerificationEmail({
        to: user.email,
        name: user.name,
        url: verificationUrl,
        token,
      });
    },
  },
  user: {
    modelName: 'User',
    deleteUser: {
      enabled: true,
    },
    additionalFields: {
      username: {
        type: 'string',
        required: false,
        input: true,
        returned: true,
      },
      subscriptionTier: {
        type: 'string',
        required: false,
        input: false,
        defaultValue: 'REGISTERED',
        returned: true,
      },
      storageLimitMb: {
        type: 'number',
        required: false,
        input: false,
        returned: true,
      },
      preferredLanguage: {
        type: 'string',
        required: false,
        input: false,
        defaultValue: 'en',
        returned: true,
      },
    },
  },
  session: {
    modelName: 'Session',
    expiresIn: 90 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60,
  },
  account: {
    modelName: 'Account',
    identityStrategy: 'provider-id',
  },
  verification: {
    modelName: 'Verification',
  },
  socialProviders: googleProvider,
  databaseHooks: {
    user: {
      create: {
        after: async (user, context) => {
          if (context?.path === '/sign-in/anonymous') {
            await authDatabase.query(
              'UPDATE "User" SET "subscriptionTier" = \'ANONYMOUS\' WHERE "id" = $1',
              [user.id],
            );
          }
        },
      },
    },
  },
  plugins: [
    anonymous({
      onLinkAccount: async ({ anonymousUser, newUser }) => {
        await authDatabase.query(
          'UPDATE "Query" SET "userId" = $1 WHERE "userId" = $2',
          [newUser.user.id, anonymousUser.user.id],
        );
      },
    }),
  ],
});
