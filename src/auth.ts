import 'dotenv/config'; // ← убедись, что эта строка есть первой
import { betterAuth } from 'better-auth';
import { bearer } from 'better-auth/plugins';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { Resend } from 'resend';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';
import Stripe from 'stripe';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

const prisma = new PrismaClient({ adapter });

const resend = new Resend(process.env.RESEND_API_KEY);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2026-09-30.endive',
});

export const auth = betterAuth({
  database: prismaAdapter(prisma, {
    provider: 'postgresql',
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  emailAndPassword: {
    enabled: true,
    // requireEmailVerification: true, // ← блокирует вход без верификации
    sendResetPassword: async ({ user, url }) => {
      void resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL!,
        to: user.email,
        subject: 'Сброс пароля',
        html: `<p>Перейдите по <a href="${url}">этой ссылке</a>, чтобы сбросить пароль.</p>`,
      });
    },
  },
  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      void resend.emails.send({
        from: process.env.RESEND_FROM_EMAIL!,
        to: user.email,
        subject: 'Подтвердите ваш email',
        html: `<p>Перейдите по <a href="${url}">этой ссылке</a>, чтобы подтвердить email.</p>`,
      });
    },
    sendOnSignUp: true, // ← отправлять письмо сразу при регистрации
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          try {
            const customer = await stripe.customers.create({
              email: user.email,
              name: user.name ?? undefined,
              metadata: { userId: user.id },
            });

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
  },
  user: {
    additionalFields: {
      role: {
        type: 'string',
        required: false,
        defaultValue: 'GUEST',
        input: false, // ← критично! Пользователь НЕ может задать роль при регистрации
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
    'https://your-app.vercel.app',
    'https://backend-booking-service-h2ey.onrender.com',
  ],
});
