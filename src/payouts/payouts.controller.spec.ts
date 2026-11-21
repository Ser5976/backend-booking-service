import { Test, TestingModule } from '@nestjs/testing';
import { PayoutsController } from './payouts.controller.js';
import { PayoutsService } from './payouts.service.js';

describe('PayoutsController', () => {
  let controller: PayoutsController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PayoutsController],
      providers: [PayoutsService],
    }).compile();

    controller = module.get<PayoutsController>(PayoutsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
