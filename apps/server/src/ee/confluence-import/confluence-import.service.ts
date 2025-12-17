// /ee/confluence-import/confluence-import.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { FileTask, InsertablePage } from '@docmost/db/types/entity.types';
import { promises as fs } from 'fs';
import * as path from 'path';
import { v7 } from 'uuid';
import { generateSlugId } from '../../common/helpers';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { ImportService } from '../../integrations/import/services/import.service';
import { PageService } from '../../core/page/services/page.service';
import { BacklinkRepo } from '@docmost/db/repos/backlink/backlink.repo';
import { executeTx } from '@docmost/db/utils';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventName } from '../../common/events/event.contants';
import { getProsemirrorContent } from '../../common/helpers/prosemirror/utils';
import { jsonToText } from '../../collaboration/collaboration.util';

interface ConfluencePage {
  id: string;
  title: string;
  body: string;
  parent?: string;
  ancestors: string[];
}

@Injectable()
export class ConfluenceImportService {
  private readonly logger = new Logger(ConfluenceImportService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly importService: ImportService,
    private readonly pageService: PageService,
    private readonly backlinkRepo: BacklinkRepo,
    private eventEmitter: EventEmitter2,
  ) {}

  async processConfluenceImport(opts: {
    extractDir: string;
    fileTask: FileTask;
  }): Promise<void> {
    const { extractDir, fileTask } = opts;

    try {
      // Read Confluence export structure
      const indexPath = path.join(extractDir, 'index.html');
      const pages = await this.parseConfluenceExport(extractDir);

      const pagesMap = new Map<string, any>();
      
      for (const page of pages) {
        pagesMap.set(page.id, {
          id: v7(),
          slugId: generateSlugId(),
          title: page.title,
          content: page.body,
          parentPageId: null,
          confluenceId: page.id,
        });
      }

      // Establish parent-child relationships
      for (const page of pages) {
        const currentPage = pagesMap.get(page.id);
        if (page.parent && pagesMap.has(page.parent)) {
          currentPage.parentPageId = pagesMap.get(page.parent).id;
        }
      }

      // Generate positions
      const siblingsMap = new Map<string | null, any[]>();
      pagesMap.forEach((page) => {
        const group = siblingsMap.get(page.parentPageId) ?? [];
        group.push(page);
        siblingsMap.set(page.parentPageId, group);
      });

      const rootSibs = siblingsMap.get(null);
      if (rootSibs?.length) {
        rootSibs.sort((a, b) => a.title.localeCompare(b.title));
        const nextPosition = await this.pageService.nextPagePosition(fileTask.spaceId);
        
        let prevPos: string | null = null;
        rootSibs.forEach((page, idx) => {
          if (idx === 0) {
            page.position = nextPosition;
          } else {
            page.position = generateJitteredKeyBetween(prevPos, null);
          }
          prevPos = page.position;
        });
      }

      siblingsMap.forEach((sibs, parentId) => {
        if (parentId === null) return;
        sibs.sort((a, b) => a.title.localeCompare(b.title));
        
        let prevPos: string | null = null;
        for (const page of sibs) {
          page.position = generateJitteredKeyBetween(prevPos, null);
          prevPos = page.position;
        }
      });

      // Insert pages into database
      const validPageIds = new Set<string>();
      await executeTx(this.db, async (trx) => {
        for (const [, page] of pagesMap) {
          const pmState = getProsemirrorContent(
            await this.importService.processHTML(page.content)
          );

          const { title, prosemirrorJson } = 
            this.importService.extractTitleAndRemoveHeading(pmState);

          const insertablePage: InsertablePage = {
            id: page.id,
            slugId: page.slugId,
            title: title || page.title,
            icon: null,
            content: prosemirrorJson,
            textContent: jsonToText(prosemirrorJson),
            ydoc: await this.importService.createYdoc(prosemirrorJson),
            position: page.position,
            spaceId: fileTask.spaceId,
            workspaceId: fileTask.workspaceId,
            creatorId: fileTask.creatorId,
            lastUpdatedById: fileTask.creatorId,
            parentPageId: page.parentPageId,
          };

          await trx.insertInto('pages').values(insertablePage).execute();
          validPageIds.add(insertablePage.id);
        }

        if (validPageIds.size > 0) {
          this.eventEmitter.emit(EventName.PAGE_CREATED, {
            pageIds: Array.from(validPageIds),
            workspaceId: fileTask.workspaceId,
          });
        }
      });

      this.logger.log(`Successfully imported ${pagesMap.size} Confluence pages`);
    } catch (error) {
      this.logger.error('Failed to import Confluence pages:', error);
      throw new Error(`Confluence import failed: ${error?.['message']}`);
    }
  }

  private async parseConfluenceExport(extractDir: string): Promise<ConfluencePage[]> {
    const pages: ConfluencePage[] = [];
    const files = await fs.readdir(extractDir);
    
    for (const file of files) {
      if (file.endsWith('.html') && file !== 'index.html') {
        const filePath = path.join(extractDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        
        pages.push({
          id: path.basename(file, '.html'),
          title: this.extractTitle(content),
          body: content,
          ancestors: [],
        });
      }
    }
    
    return pages;
  }

  private extractTitle(html: string): string {
    const match = html.match(/<title>(.*?)<\/title>/i);
    return match ? match[1] : 'Untitled';
  }
}