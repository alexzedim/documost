// /ee/confluence-import/confluence-import.module.ts
import { forwardRef, Module } from '@nestjs/common';
import { ConfluenceImportService } from './confluence-import.service';
import { ImportModule } from '../../integrations/import/import.module';
import { PageModule } from '../../core/page/page.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { DatabaseModule } from '@docmost/db/database.module';

@Module({
  imports: [
    forwardRef(() => ImportModule),
    PageModule,
    DatabaseModule,
    EventEmitterModule.forRoot(),
  ],
  providers: [ConfluenceImportService],
  exports: [ConfluenceImportService],
})
export class ConfluenceImportModule {}
