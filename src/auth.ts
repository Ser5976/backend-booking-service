import 'dotenv/config';
import { APIError, betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { Resend } from 'resend';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import Stripe from 'stripe';

// ВАЖНО: один PrismaClient на всё приложение.
// Сейчас в auth.ts и prisma.service.ts — два разных пула.
// Это может исчерпать лимит соединений Neon.
// TODO: вынести в prisma.client.ts и импортировать в оба места.
const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});
const prisma = new PrismaClient({ adapter });

const resend = new Resend(process.env.RESEND_API_KEY);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-09-30.endive',
});

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  emailAndPassword: {
    enabled: true,
    // Включить перед продом:
    // requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      try {
        const { error } = await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL!,
          to: user.email,
          subject: 'Сброс пароля',
          html: `<p>Перейдите по <a href="${url}">этой ссылке</a>, чтобы сбросить пароль.</p>`,
        });
        if (error) console.error('sendResetPassword failed:', error);
      } catch (e) {
        console.error('sendResetPassword exception:', e);
      }
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      try {
        const { error } = await resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL!,
          to: user.email,
          subject: 'Подтвердите ваш email',
          html: `<p>Перейдите по <a href="${url}">этой ссылке</a>, чтобы подтвердить email.</p>`,
        });
        if (error) console.error('sendVerificationEmail failed:', error);
      } catch (e) {
        console.error('sendVerificationEmail exception:', e);
      }
    },
    sendOnSignUp: true,
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          try {
            // idempotencyKey — на случай retry от Better Auth
            const customer = await stripe.customers.create(
              {
                email: user.email,
                name: user.name ?? undefined,
                metadata: { userId: user.id },
              },
              { idempotencyKey: `customer-${user.id}` },
            );

            await prisma.user.update({
              where: { id: user.id },
              data: { stripeCustomerId: customer.id },
            });
          } catch (error) {
            console.error('Failed to create Stripe customer:', error);
          }
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          const dbUser = await prisma.user.findUnique({
            where: { id: session.userId },
            select: { status: true, deletedAt: true },
          });
          if (
            !dbUser ||
            dbUser.deletedAt ||
            dbUser.status === 'DELETED' ||
            dbUser.status === 'SUSPENDED'
          ) {
            throw new APIError('FORBIDDEN', {
              message: 'Аккаунт заблокирован или удалён',
            });
          }
          return { data: session };
        },
      },
    },
  },
  user: {
    additionalFields: {
      role: {
        type: 'string',
        required: false,
        defaultValue: 'GUEST',
        input: false,
        output: true, // ← явно
      },
    },
  },
  plugins: [bearer()],
  advanced: {
    disableOriginCheck: true, // ← только для dev!
    ipAddress: {
      trustedProxies: ['0.0.0.0/0'], // доверяем всем прокси Render
    },
  },
  trustedOrigins: [
    process.env.FRONTEND_URL ?? 'http://localhost:3000',
    process.env.BETTER_AUTH_URL ?? 'http://localhost:3000',
  ],
});
