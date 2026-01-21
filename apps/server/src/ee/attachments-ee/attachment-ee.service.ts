// /ee/attachments-ee/attachment-ee.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@wiki/db/types/kysely.types';

@Injectable()
export class AttachmentEeService {
  private readonly logger = new Logger(AttachmentEeService.name);

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async indexAttachment(attachmentId: string): Promise<void> {
    try {
      const attachment = await this.db
        .selectFrom('attachments')
        .selectAll()
        .where('id', '=', attachmentId)
        .executeTakeFirst();

      if (!attachment) {
        this.logger.warn(`Attachment ${attachmentId} not found for indexing`);
        return;
      }

      // Extract text content from attachment based on type
      const textContent = await this.extractTextContent(attachment);

      // Store in vector database or search index
      await this.storeInSearchIndex(attachmentId, textContent);

      this.logger.debug(`Successfully indexed attachment ${attachmentId}`);
    } catch (error) {
      this.logger.error(`Failed to index attachment ${attachmentId}:`, error);
      throw error;
    }
  }

  async indexAttachments(workspaceId: string): Promise<void> {
    try {
      const attachments = await this.db
        .selectFrom('attachments')
        .selectAll()
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .execute();

      this.logger.log(
        `Indexing ${attachments.length} attachments for workspace ${workspaceId}`,
      );

      for (const attachment of attachments) {
        try {
          await this.indexAttachment(attachment.id);
        } catch (error) {
          this.logger.error(
            `Failed to index attachment ${attachment.id}, continuing...`,
          );
        }
      }

      this.logger.log(
        `Completed indexing attachments for workspace ${workspaceId}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to index attachments for workspace ${workspaceId}:`,
        error,
      );
      throw error;
    }
  }

  private async extractTextContent(attachment: any): Promise<string> {
    // Implementation would depend on file type
    // For PDFs, use pdf-parse
    // For Office docs, use mammoth or similar
    // For images, use OCR if needed
    return '';
  }

  private async storeInSearchIndex(
    attachmentId: string,
    content: string,
  ): Promise<void> {
    // Store in your search backend (Typesense, Elasticsearch, etc.)
    this.logger.debug(`Storing attachment ${attachmentId} in search index`);
  }
}
