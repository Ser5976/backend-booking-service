import { Test, TestingModule } from '@nestjs/testing';
import { PricingController } from './pricing.controller.js';
import { PricingService } from './pricing.service.js';

describe('PricingController', () => {
  let controller: PricingController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PricingController],
      providers: [PricingService],
    }).compile();

    controller = module.get<PricingController>(PricingController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
