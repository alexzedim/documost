import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PageRepo } from '@wiki/db/repos/page/page.repo';
import { MultipartFile } from '@fastify/multipart';
import { sanitize } from 'sanitize-filename-ts';
import * as path from 'path';
import {
  htmlToJson,
  jsonToText,
  tiptapExtensions,
} from '../../../collaboration/collaboration.util';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@wiki/db/types/kysely.types';
import { generateSlugId, sanitizeFileName } from '../../../common/helpers';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { TiptapTransformer } from '@hocuspocus/transformer';
import * as Y from 'yjs';
import { markdownToHtml } from '@wiki/editor-ext';
import {
  FileTaskStatus,
  FileTaskType,
  getFileTaskFolderPath,
} from '../utils/file.utils';
import { v7 as uuid7 } from 'uuid';
import { StorageService } from '../../storage/storage.service';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { QueueJob, QueueName } from '../../queue/constants';
import * as mammoth from 'mammoth';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import * as https from 'https';

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);
  private readonly httpsAgent: https.Agent;

  constructor(
    private readonly pageRepo: PageRepo,
    private readonly storageService: StorageService,
    private readonly httpService: HttpService,
    @InjectKysely() private readonly db: KyselyDB,
    @InjectQueue(QueueName.FILE_TASK_QUEUE)
    private readonly fileTaskQueue: Queue,
  ) {}

  async importPage(
    filePromise: Promise<MultipartFile>,
    userId: string,
    spaceId: string,
    workspaceId: string,
  ): Promise<void> {
    const file = await filePromise;
    const fileBuffer = await file.toBuffer();
    const fileExtension = path.extname(file.filename).toLowerCase();
    const fileName = sanitize(
      path.basename(file.filename, fileExtension).slice(0, 255),
    );
    const fileContent = fileBuffer.toString();

    let prosemirrorState = null;
    let createdPage = null;

    try {
      if (fileExtension.endsWith('.md')) {
        prosemirrorState = await this.processMarkdown(fileContent);
      } else if (fileExtension.endsWith('.html')) {
        prosemirrorState = await this.processHTML(fileContent);
      } else if (['.doc', '.docx', '.rtf'].includes(fileExtension)) {
        prosemirrorState = await this.processWordDocument(
          fileBuffer,
          file.filename,
        );
      }
    } catch (err) {
      const message = 'Error processing file content';
      this.logger.error(message, err);
      throw new BadRequestException(message);
    }

    if (!prosemirrorState) {
      const message = 'Failed to create ProseMirror state';
      this.logger.error(message);
      throw new BadRequestException(message);
    }

    const { title, prosemirrorJson } =
      this.extractTitleAndRemoveHeading(prosemirrorState);

    const pageTitle = title || fileName;

    if (prosemirrorJson) {
      try {
        const pagePosition = await this.getNewPagePosition(spaceId);

        createdPage = await this.pageRepo.insertPage({
          slugId: generateSlugId(),
          title: pageTitle,
          content: prosemirrorJson,
          textContent: jsonToText(prosemirrorJson),
          ydoc: await this.createYdoc(prosemirrorJson),
          position: pagePosition,
          spaceId: spaceId,
          creatorId: userId,
          workspaceId: workspaceId,
          lastUpdatedById: userId,
        });

        this.logger.debug(
          `Successfully imported "${title}${fileExtension}. ID: ${createdPage.id} - SlugId: ${createdPage.slugId}"`,
        );
      } catch (err) {
        const message = 'Failed to create imported page';
        this.logger.error(message, err);
        throw new BadRequestException(message);
      }
    }

    return createdPage;
  }

  async processWordDocument(
    fileBuffer: Buffer,
    filename: string,
  ): Promise<any> {
    try {
      const fileExtension = path.extname(filename).toLowerCase();

      let docxBuffer: Buffer = fileBuffer;

      if (fileExtension === '.doc' || fileExtension === '.rtf') {
        const converted = await this.convertToDocx(fileBuffer, filename);
        docxBuffer = converted.buffer;
      }

      const html = await this.convertDocxToHtml(docxBuffer);

      return this.processHTML(html);
    } catch (error) {
      this.logger.error(`Error processing Word document: ${error}`);
      throw new Error(`Failed to process Word document: ${error}`);
    }
  }

  private async convertToDocx(
    fileBuffer: Buffer,
    originalname: string,
  ): Promise<{
    buffer: Buffer;
    size: number;
    mimetype: string;
    originalname: string;
  }> {
    try {
      const docxKey = this.generateSafeFilename(originalname, '.docx');
      const url = `${process.env.AI_TOOLS_API_URL}/todocx/`;

      const formData = new FormData();

      formData.append(
        'file',
        new Blob([Buffer.from(fileBuffer)]),
        originalname,
      );

      const response = await lastValueFrom(
        this.httpService.post(url, formData, {
          headers: {
            'x-api-key': process.env.AI_TOOLS_API_KEY,
          },
          httpsAgent: this.httpsAgent,
          responseType: 'arraybuffer',
        }),
      );

      if (!response.data) {
        throw new Error('No response received from conversion service');
      }

      const buffer = Buffer.from(response.data);
      const size = buffer.length;

      return {
        buffer,
        size,
        mimetype:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        originalname: docxKey,
      };
    } catch (error) {
      this.logger.error(`DOCX conversion failed: ${error}`);
      throw new Error(`Failed to convert document to DOCX: ${error}`);
    }
  }

  private async convertDocxToHtml(docxBuffer: Buffer): Promise<string> {
    try {
      const result = await mammoth.convertToHtml(
        { buffer: docxBuffer },
        {
          styleMap: [
            "p[style-name='Heading 1'] => h1:fresh",
            "p[style-name='Heading 2'] => h2:fresh",
            "p[style-name='Heading 3'] => h3:fresh",
            "p[style-name='Heading 4'] => h4:fresh",
            "p[style-name='Heading 5'] => h5:fresh",
            "p[style-name='Heading 6'] => h6:fresh",
            "p[style-name='Title'] => h1:fresh",
            "p[style-name='Subtitle'] => h2:fresh",
            "r[style-name='Strong'] => strong",
            "r[style-name='Emphasis'] => em",
          ],
          transformDocument: (element) => {
            return element;
          },
        },
      );

      if (result.messages.length > 0) {
        this.logger.warn('Mammoth conversion warnings:', result.messages);
      }

      return result.value;
    } catch (error) {
      this.logger.error(`Mammoth conversion failed: ${error}`);
      throw new Error(`Failed to convert DOCX to HTML: ${error}`);
    }
  }

  private generateSafeFilename(
    originalname: string,
    extension: string,
  ): string {
    const nameWithoutExt = path.basename(
      originalname,
      path.extname(originalname),
    );
    const safeName = sanitize(nameWithoutExt.slice(0, 255));
    return `${safeName}${extension}`;
  }

  async processMarkdown(markdownInput: string): Promise<any> {
    try {
      const html = await markdownToHtml(markdownInput);
      return this.processHTML(html);
    } catch (err) {
      throw err;
    }
  }

  async processHTML(htmlInput: string): Promise<any> {
    try {
      return htmlToJson(htmlInput);
    } catch (err) {
      throw err;
    }
  }

  async createYdoc(prosemirrorJson: any): Promise<Buffer | null> {
    if (prosemirrorJson) {
      // this.logger.debug(`Converting prosemirror json state to ydoc`);

      const ydoc = TiptapTransformer.toYdoc(
        prosemirrorJson,
        'default',
        tiptapExtensions,
      );

      Y.encodeStateAsUpdate(ydoc);

      return Buffer.from(Y.encodeStateAsUpdate(ydoc));
    }
    return null;
  }

  extractTitleAndRemoveHeading(prosemirrorState: any) {
    let title: string | null = null;

    const content = prosemirrorState.content ?? [];

    if (
      content.length > 0 &&
      content[0].type === 'heading' &&
      content[0].attrs?.level === 1
    ) {
      title = content[0].content?.[0]?.text ?? null;
      content.shift();
    }

    // ensure at least one paragraph
    if (content.length === 0) {
      content.push({
        type: 'paragraph',
        content: [],
      });
    }

    return {
      title,
      prosemirrorJson: {
        ...prosemirrorState,
        content,
      },
    };
  }

  async getNewPagePosition(spaceId: string): Promise<string> {
    const lastPage = await this.db
      .selectFrom('pages')
      .select(['id', 'position'])
      .where('spaceId', '=', spaceId)
      .orderBy('position', (ob) => ob.collate('C').desc())
      .limit(1)
      .where('parentPageId', 'is', null)
      .executeTakeFirst();

    if (lastPage) {
      return generateJitteredKeyBetween(lastPage.position, null);
    } else {
      return generateJitteredKeyBetween(null, null);
    }
  }

  async importZip(
    filePromise: Promise<MultipartFile>,
    source: string,
    userId: string,
    spaceId: string,
    workspaceId: string,
  ) {
    const file = await filePromise;
    const fileBuffer = await file.toBuffer();
    const fileExtension = path.extname(file.filename).toLowerCase();
    const fileName = sanitizeFileName(
      path.basename(file.filename, fileExtension),
    );
    const fileSize = fileBuffer.length;

    const fileNameWithExt = fileName + fileExtension;

    const fileTaskId = uuid7();
    const filePath = `${getFileTaskFolderPath(FileTaskType.Import, workspaceId)}/${fileTaskId}/${fileNameWithExt}`;

    // upload file
    await this.storageService.upload(filePath, fileBuffer);

    const fileTask = await this.db
      .insertInto('fileTasks')
      .values({
        id: fileTaskId,
        type: FileTaskType.Import,
        source: source,
        status: FileTaskStatus.Processing,
        fileName: fileNameWithExt,
        filePath: filePath,
        fileSize: fileSize,
        fileExt: 'zip',
        creatorId: userId,
        spaceId: spaceId,
        workspaceId: workspaceId,
      })
      .returningAll()
      .executeTakeFirst();

    await this.fileTaskQueue.add(QueueJob.IMPORT_TASK, {
      fileTaskId: fileTaskId,
    });

    return fileTask;
  }
}
