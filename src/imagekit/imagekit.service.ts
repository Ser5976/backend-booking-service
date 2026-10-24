import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import ImageKit from 'imagekit';

@Injectable()
export class ImageKitService {
  private readonly logger = new Logger(ImageKitService.name);
  private readonly imagekit: ImageKit;

  constructor() {
    this.imagekit = new ImageKit({
      publicKey: process.env.IMAGEKIT_PUBLIC_KEY!,
      privateKey: process.env.IMAGEKIT_PRIVATE_KEY!,
      urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT!,
    });
  }

  /**
   * Параметры для прямой загрузки файла с клиента.
   * Возвращает { token, expire, signature }.
   * privateKey никогда не покидает сервер.
   */
  getAuthenticationParameters(): {
    token: string;
    expire: number;
    signature: string;
  } {
    return this.imagekit.getAuthenticationParameters();
  }

  /**
   * Получить метаданные файла по fileId.
   * Используется для верификации, что клиент не подсунул чужой URL/fileId
   * при привязке изображения к объявлению.
   */
  async getFileDetails(fileId: string): Promise<any> {
    try {
      return await this.imagekit.getFileDetails(fileId);
    } catch (e) {
      this.logger.error(
        `Failed to get file details for ${fileId}: ${
          e instanceof Error ? e.message : e
        }`,
      );
      throw new InternalServerErrorException(
        'Не удалось получить информацию о файле',
      );
    }
  }

  /**
   * Удалить файл из ImageKit.
   * Идемпотентно: если файл уже удалён — просто логируем, не падаем.
   */
  async deleteFile(fileId: string): Promise<void> {
    try {
      await this.imagekit.deleteFile(fileId);
      this.logger.log(`Deleted ImageKit file ${fileId}`);
    } catch (e) {
      this.logger.warn(
        `ImageKit delete failed for ${fileId}: ${
          e instanceof Error ? e.message : e
        }`,
      );
    }
  }
}
