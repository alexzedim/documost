// /ee/ai/ai.module.ts
import { Module } from '@nestjs/common';
import { AiController } from './ai.controller';
import { AiService } from './services/ai.service';
import { AiSearchService } from './services/ai-search.service';

@Module({
  providers: [AiService, AiSearchService],
  controllers: [AiController],
  exports: [AiService, AiSearchService],
})
export class AiModule {}