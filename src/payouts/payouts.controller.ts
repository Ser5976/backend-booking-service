import { Controller } from '@nestjs/common';
import { PayoutsService } from './payouts.service.js';

@Controller('payouts')
export class PayoutsController {
  constructor(private readonly payoutsService: PayoutsService) {}
}
