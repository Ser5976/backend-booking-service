import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateReviewDto } from './dto/create-review.dto.js';
import { ReplyReviewDto } from './dto/reply-review.dto.js';
import { QueryReviewsDto } from './dto/query-reviews.dto.js';
import { Actor } from '../common/auth/actor.js';
import { UserRole } from '../generated/prisma/client.js';

@Injectable()
export class ReviewsService {
  constructor(private readonly prisma: PrismaService) {}

  // ============================================================
  // СОЗДАНИЕ ОТЗЫВА (гость → жильё/хост)
  // ============================================================

  async create(bookingId: string, dto: CreateReviewDto, actor: Actor) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { review: true },
    });

    if (!booking) throw new NotFoundException('Бронь не найдена');
    if (booking.guestId !== actor.id) {
      throw new ForbiddenException('Только гость может оставить отзыв');
    }
    if (booking.status !== 'COMPLETED') {
      throw new BadRequestException(
        'Отзыв можно оставить только после завершения проживания',
      );
    }
    if (booking.review) {
      throw new ConflictException('Отзыв на эту бронь уже оставлен');
    }

    return this.prisma.$transaction(async (tx) => {
      const review = await tx.review.create({
        data: {
          bookingId: booking.id,
          propertyId: booking.propertyId,
          authorId: actor.id,
          targetId: booking.hostId,
          ratingOverall: dto.ratingOverall,
          ratingClean: dto.ratingClean,
          ratingAccuracy: dto.ratingAccuracy,
          ratingCheckIn: dto.ratingCheckIn,
          ratingLocation: dto.ratingLocation,
          ratingValue: dto.ratingValue,
          ratingComm: dto.ratingComm,
          comment: dto.comment,
          isPublished: true,
        },
      });

      const agg = await tx.review.aggregate({
        where: { propertyId: booking.propertyId, isPublished: true },
        _avg: { ratingOverall: true },
        _count: { _all: true },
      });

      await tx.property.update({
        where: { id: booking.propertyId },
        data: {
          avgRating: agg._avg.ratingOverall ?? 0,
          reviewsCount: agg._count._all,
        },
      });

      return review;
    });
  }

  // ============================================================
  // ОТВЕТ ХОСТА
  // ============================================================

  async reply(reviewId: string, dto: ReplyReviewDto, actor: Actor) {
    const review = await this.prisma.review.findUnique({
      where: { id: reviewId },
      include: { property: { select: { hostId: true } } },
    });

    if (!review) throw new NotFoundException('Отзыв не найден');
    if (
      review.targetId !== actor.id &&
      review.property.hostId !== actor.id &&
      actor.role !== UserRole.ADMIN
    ) {
      throw new ForbiddenException('Только хост может ответить на отзыв');
    }
    if (review.hostReply) {
      throw new ConflictException('Ответ на отзыв уже оставлен');
    }

    return this.prisma.review.update({
      where: { id: reviewId },
      data: {
        hostReply: dto.reply,
        hostReplyAt: new Date(),
      },
    });
  }

  // ============================================================
  // ПУБЛИЧНЫЙ СПИСОК
  // ============================================================

  async listByProperty(propertyId: string, query: QueryReviewsDto) {
    const limit = query.limit ?? 10;
    const offset = query.offset ?? 0;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.review.findMany({
        where: { propertyId, isPublished: true },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          author: { select: { id: true, name: true, image: true } },
        },
      }),
      this.prisma.review.count({
        where: { propertyId, isPublished: true },
      }),
    ]);

    return {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  }
}
