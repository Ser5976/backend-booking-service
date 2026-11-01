import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { AllowAnonymous, Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ReviewsService } from './reviews.service.js';
import { CreateReviewDto } from './dto/create-review.dto.js';
import { ReplyReviewDto } from './dto/reply-review.dto.js';
import { QueryReviewsDto } from './dto/query-reviews.dto.js';
import { toActor } from '../common/auth/actor.js';

@Controller()
export class ReviewsController {
  constructor(private readonly service: ReviewsService) {}

  /**
   * POST /bookings/:id/review — гость оставляет отзыв после COMPLETED.
   */
  @Post('bookings/:id/review')
  @Roles(['GUEST', 'HOST'])
  create(
    @Param('id') bookingId: string,
    @Body() dto: CreateReviewDto,
    @Session() session: UserSession,
  ) {
    return this.service.create(bookingId, dto, toActor(session.user));
  }

  /**
   * POST /reviews/:id/reply — хост отвечает на отзыв (один раз).
   */
  @Post('reviews/:id/reply')
  @Roles(['HOST', 'ADMIN'])
  reply(
    @Param('id') reviewId: string,
    @Body() dto: ReplyReviewDto,
    @Session() session: UserSession,
  ) {
    return this.service.reply(reviewId, dto, toActor(session.user));
  }

  /**
   * GET /properties/:id/reviews — публичный список отзывов.
   */
  @Get('properties/:id/reviews')
  @AllowAnonymous()
  list(@Param('id') propertyId: string, @Query() query: QueryReviewsDto) {
    return this.service.listByProperty(propertyId, query);
  }
}
