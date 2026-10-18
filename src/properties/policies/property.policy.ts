import { ForbiddenException, BadRequestException } from '@nestjs/common';
import {
  Property,
  PropertyStatus,
  UserRole,
} from '../../generated/prisma/client.js';
import { Actor } from '../../common/auth/actor.js';

const SUBMITTABLE_STATUSES: readonly PropertyStatus[] = [
  PropertyStatus.DRAFT,
  PropertyStatus.REJECTED,
];

export const PropertyPolicy = {
  canView(property: Property, actor?: Actor): boolean {
    if (property.status === PropertyStatus.PUBLISHED && !property.deletedAt)
      return true;
    if (!actor) return false;
    if (actor.role === UserRole.ADMIN) return true;
    return property.hostId === actor.id;
  },

  assertCanEdit(property: Property, actor: Actor): void {
    if (property.hostId !== actor.id && actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Нельзя редактировать чужое объявление');
    }
    if (property.deletedAt) {
      throw new BadRequestException('Объявление удалено');
    }
    // Редактировать можно в DRAFT, REJECTED, PAUSED, PUBLISHED.
    // Нельзя — в PENDING_REVIEW (чтобы не менять то, что на модерации) и ARCHIVED.
    if (property.status === PropertyStatus.PENDING_REVIEW) {
      throw new BadRequestException(
        'Объявление на модерации, дождитесь решения',
      );
    }
    if (property.status === PropertyStatus.ARCHIVED) {
      throw new BadRequestException('Объявление архивировано');
    }
  },

  assertCanSubmit(property: Property, actor: Actor): void {
    if (property.hostId !== actor.id) {
      throw new ForbiddenException(
        'Только владелец может отправить на модерацию',
      );
    }
    if (!SUBMITTABLE_STATUSES.includes(property.status)) {
      throw new BadRequestException(
        `Нельзя отправить на модерацию из статуса ${property.status}`,
      );
    }
  },

  assertCanModerate(actor: Actor): void {
    if (actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Только админ может модерировать');
    }
  },

  assertCanPause(property: Property, actor: Actor): void {
    if (property.hostId !== actor.id && actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException();
    }
    if (property.status !== PropertyStatus.PUBLISHED) {
      throw new BadRequestException('Пауза доступна только для опубликованных');
    }
  },

  assertCanArchive(property: Property, actor: Actor): void {
    if (property.hostId !== actor.id && actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException();
    }
    if (property.status === PropertyStatus.ARCHIVED) {
      throw new BadRequestException('Уже архивировано');
    }
  },
};
