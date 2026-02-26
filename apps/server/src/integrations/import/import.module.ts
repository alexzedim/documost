import { forwardRef, Module } from '@nestjs/common';
import { ImportService } from './services/import.service';
import { ImportController } from './import.controller';
import { StorageModule } from '../storage/storage.module';
import { FileImportTaskService } from './services/file-import-task.service';
import { FileTaskProcessor } from './processors/file-task.processor';
import { ImportAttachmentService } from './services/import-attachment.service';
import { FileTaskController } from './file-task.controller';
import { PageModule } from '../../core/page/page.module';
import { ConfluenceImportModule } from '../../ee/confluence-import/confluence-import.module';
import { AttachmentModule } from '../../core/attachment/attachment.module';
import { HttpModule } from '@nestjs/axios';
import { Agent } from 'node:https';
@Module({
  providers: [
    ImportService,
    FileImportTaskService,
    FileTaskProcessor,
    ImportAttachmentService,
  ],
  exports: [ImportService, ImportAttachmentService],
  controllers: [ImportController, FileTaskController],
  imports: [
    StorageModule,
    PageModule,
    AttachmentModule,
    forwardRef(() => ConfluenceImportModule),
    HttpModule.register({
      httpsAgent: new Agent({ rejectUnauthorized: false }),
    }),
  ],
})
export class ImportModule {}
