import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly resend: Resend;

  constructor(private readonly prisma: PrismaService) {
    this.resend = new Resend(process.env.RESEND_API_KEY!);
  }

  /**
   * Создаёт уведомление в БД. Если channel = EMAIL,
   * крон отправит его через Resend.
   */
  async create(data: {
    userId: string;
    type: any;
    channel?: 'IN_APP' | 'EMAIL';
    title: string;
    body: string;
    data?: any;
  }) {
    return this.prisma.notification.create({
      data: {
        userId: data.userId,
        type: data.type,
        channel: data.channel ?? 'IN_APP',
        title: data.title,
        body: data.body,
        data: data.data ?? {},
      },
    });
  }

  /**
   * Отправляет все EMAIL-уведомления, которые ещё не отправлены.
   * Вызывается из TasksService (крон раз в 6 часов).
   */
  async sendPendingEmails() {
    const pending = await this.prisma.notification.findMany({
      where: {
        channel: 'EMAIL',
        sentAt: null,
        error: null, // не пытаемся повторно отправлять упавшие
      },
      take: 50, // батч, чтобы не превысить лимит Resend
      orderBy: { createdAt: 'asc' },
    });

    if (pending.length === 0) return;

    for (const notification of pending) {
      try {
        const user = await this.prisma.user.findUnique({
          where: { id: notification.userId },
          select: { email: true, name: true },
        });

        if (!user?.email) {
          await this.prisma.notification.update({
            where: { id: notification.id },
            data: { error: 'User has no email' },
          });
          continue;
        }

        const html = this.renderEmail(
          notification.type,
          notification.title,
          notification.body,
        );

        const { error } = await this.resend.emails.send({
          from: process.env.RESEND_FROM_EMAIL!,
          to: user.email,
          subject: notification.title,
          html,
        });

        if (error) {
          this.logger.error(
            `Failed to send email ${notification.id}: ${error.message}`,
          );
          await this.prisma.notification.update({
            where: { id: notification.id },
            data: { error: error.message },
          });
        } else {
          await this.prisma.notification.update({
            where: { id: notification.id },
            data: { sentAt: new Date() },
          });
        }
      } catch (e: any) {
        this.logger.error(
          `Exception sending email ${notification.id}: ${e?.message}`,
        );
        await this.prisma.notification.update({
          where: { id: notification.id },
          data: { error: e?.message ?? 'Unknown error' },
        });
      }
    }

    this.logger.log(`Processed ${pending.length} pending email(s)`);
  }

  /**
   * Простой HTML-шаблон. Для MVP — без React Email,
   * просто оборачиваем текст в базовую вёрстку.
   */
  private renderEmail(type: string, title: string, body: string): string {
    return `
      <!DOCTYPE html>
      <html>
        <head><meta charset="utf-8"></head>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #333;">${title}</h2>
          <p style="color: #555; font-size: 16px;">${body}</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
          <p style="color: #999; font-size: 12px;">Это автоматическое сообщение, не отвечайте на него.</p>
        </body>
      </html>
    `;
  }
}
