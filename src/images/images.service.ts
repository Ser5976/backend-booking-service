import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ImageKitService } from '../imagekit/imagekit.service.js';
import { AttachImageDto } from './dto/attach-image.dto.js';
import { ReorderImagesDto } from './dto/reorder-images.dto.js';
import { Actor } from '../common/auth/actor.js';
import { PropertyStatus } from '../generated/prisma/client.js';

const MAX_IMAGES_PER_PROPERTY = 20;

@Injectable()
export class ImagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly imageKit: ImageKitService,
  ) {}

  // ---------- Привязка загруженного файла ----------

  async attach(dto: AttachImageDto, actor: Actor) {
    const property = await this.getPropertyForWrite(dto.propertyId, actor);

    // Проверяем, что файл реально существует в ImageKit и URL совпадает
    const file = await this.imageKit.getFileDetails(dto.imageKitId);
    if (file.url !== dto.url) {
      throw new BadRequestException('URL не соответствует imageKitId');
    }
    // Опционально: файл должен быть загружен в папку этого объявления
    if (!file.filePath?.startsWith(`/properties/${dto.propertyId}`)) {
      throw new BadRequestException('Файл не принадлежит этому объявлению');
    }

    const count = await this.prisma.propertyImage.count({
      where: { propertyId: dto.propertyId },
    });
    if (count >= MAX_IMAGES_PER_PROPERTY) {
      throw new BadRequestException(
        `Максимум ${MAX_IMAGES_PER_PROPERTY} изображений на объявление`,
      );
    }

    try {
      return await this.prisma.propertyImage.create({
        data: {
          propertyId: dto.propertyId,
          imageKitId: dto.imageKitId,
          url: dto.url,
          thumbnail: dto.thumbnail,
          alt: dto.alt,
          width: dto.width,
          height: dto.height,
          sizeBytes: dto.sizeBytes,
          order: count,
          isCover: count === 0,
        },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        throw new ConflictException('Это изображение уже привязано');
      }
      throw e;
    }
    // property объявлена, чтобы пройти проверку прав — см. ниже
  }

  // ---------- Порядок и обложка ----------

  async reorder(dto: ReorderImagesDto, actor: Actor) {
    await this.getPropertyForWrite(dto.propertyId, actor);

    // Проверяем, что все id принадлежат этому объявлению
    const ids = dto.items.map((i) => i.id);
    const images = await this.prisma.propertyImage.findMany({
      where: { id: { in: ids }, propertyId: dto.propertyId },
      select: { id: true },
    });
    if (images.length !== ids.length) {
      throw new BadRequestException(
        'Некоторые изображения не принадлежат этому объявлению',
      );
    }

    const coverId = dto.items.find((i) => i.isCover)?.id;

    await this.prisma.$transaction(
      dto.items.map((item, index) =>
        this.prisma.propertyImage.update({
          where: { id: item.id },
          data: {
            order: index,
            ...(coverId ? { isCover: item.id === coverId } : {}),
          },
        }),
      ),
    );

    return this.prisma.propertyImage.findMany({
      where: { propertyId: dto.propertyId },
      orderBy: { order: 'asc' },
    });
  }

  // ---------- Удаление ----------

  async remove(imageId: string, actor: Actor) {
    const image = await this.prisma.propertyImage.findUnique({
      where: { id: imageId },
      include: {
        property: {
          select: { id: true, hostId: true, status: true, deletedAt: true },
        },
      },
    });
    if (!image) throw new NotFoundException('Изображение не найдено');

    this.assertCanWriteProperty(image.property, actor);

    // Удаляем из БД
    await this.prisma.$transaction(async (tx) => {
      await tx.propertyImage.delete({ where: { id: imageId } });

      // Если удалили обложку — назначаем обложкой первую по порядку
      if (image.isCover) {
        const next = await tx.propertyImage.findFirst({
          where: { propertyId: image.property.id },
          orderBy: { order: 'asc' },
        });
        if (next) {
          await tx.propertyImage.update({
            where: { id: next.id },
            data: { isCover: true },
          });
        }
      }

      // Нормализуем order
      const rest = await tx.propertyImage.findMany({
        where: { propertyId: image.property.id },
        orderBy: { order: 'asc' },
        select: { id: true },
      });
      for (let i = 0; i < rest.length; i++) {
        if (rest[i]) {
          await tx.propertyImage.update({
            where: { id: rest[i]!.id },
            data: { order: i },
          });
        }
      }
    });

    // Удаляем из ImageKit (best effort, не блокирует ответ при ошибке)
    await this.imageKit.deleteFile(image.imageKitId);

    return { ok: true };
  }

  // ---------- Публичное чтение ----------

  async listByProperty(propertyId: string) {
    return this.prisma.propertyImage.findMany({
      where: { propertyId },
      orderBy: [{ isCover: 'desc' }, { order: 'asc' }],
    });
  }

  // ---------- Хелперы ----------

  private async getPropertyForWrite(propertyId: string, actor: Actor) {
    const property = await this.prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true, hostId: true, status: true, deletedAt: true },
    });
    if (!property) throw new NotFoundException('Объявление не найдено');

    this.assertCanWriteProperty(property, actor);
    return property;
  }

  private assertCanWriteProperty(
    property: {
      hostId: string;
      status: PropertyStatus;
      deletedAt: Date | null;
    },
    actor: Actor,
  ) {
    if (property.hostId !== actor.id && actor.role !== 'ADMIN') {
      throw new ForbiddenException('Нельзя изменять чужое объявление');
    }
    if (property.deletedAt) {
      throw new BadRequestException('Объявление удалено');
    }
    if (property.status === PropertyStatus.PENDING_REVIEW) {
      throw new BadRequestException(
        'Объявление на модерации, дождитесь решения',
      );
    }
  }
}
