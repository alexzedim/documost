// /ee/typesense/typesense.module.ts
import { Module } from '@nestjs/common';
import { PageSearchService } from './services/page-search.service';

@Module({
  providers: [PageSearchService],
  exports: [PageSearchService],
})
export class TypesenseModule {}