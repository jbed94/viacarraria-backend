import { betterAuth } from 'better-auth';
import { anonymous } from 'better-auth/plugins';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to configure Better Auth.');
}

const betterAuthSecret = process.env.BETTER_AUTH_SECRET;
if (process.env.NODE_ENV === 'production' && !betterAuthSecret) {
  throw new Error('BETTER_AUTH_SECRET is required in production.');
}

export const authDatabase = new Pool({
  connectionString: databaseUrl,
  max: 10,
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

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
  basePath: '/api/auth',
  secret:
    betterAuthSecret ??
    'local-development-better-auth-secret-change-me-32-chars',
  trustedOrigins: (
    process.env.FRONTEND_ORIGIN ?? 'http://localhost:4173'
  ).split(','),
  database: authDatabase,
  emailAndPassword: {
    enabled: true,
    autoSignIn: true,
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
        defaultValue: 'FREE',
        returned: true,
      },
      subscriptionExpiresAt: {
        type: 'date',
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
      lemonSqueezyCustomerId: {
        type: 'string',
        required: false,
        input: false,
        returned: false,
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
