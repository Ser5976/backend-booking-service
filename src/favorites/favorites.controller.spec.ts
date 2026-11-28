import { Test, TestingModule } from '@nestjs/testing';
import { FavoritesController } from './favorites.controller.js';
import { FavoritesService } from './favorites.service.js';

describe('FavoritesController', () => {
  let controller: FavoritesController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FavoritesController],
      providers: [FavoritesService],
    }).compile();

    controller = module.get<FavoritesController>(FavoritesController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
