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
import { executeTx } from '@docmost/db/utils';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventName } from '../../common/events/event.contants';
import { getProsemirrorContent } from '../../common/helpers/prosemirror/utils';
import { jsonToText } from '../../collaboration/collaboration.util';
import { ModuleRef } from '@nestjs/core';
import { ImportAttachmentService } from '../../integrations/import/services/import-attachment.service';

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
    private eventEmitter: EventEmitter2,
    private moduleRef: ModuleRef,
  ) {}

  async processConfluenceImport(opts: {
    extractDir: string;
    fileTask: FileTask;
  }): Promise<void> {
    const { extractDir, fileTask } = opts;

    try {
      const importAttachmentService = this.moduleRef.get(
        ImportAttachmentService,
        { strict: false },
      );
      const pages = await this.parseConfluenceExport(extractDir);

      const pagesByConfluenceId = new Map<string, any>();
      const newIdsByConfluenceId = new Map<string, string>();
      const parentRelations: Array<{
        childId: string;
        parentConfluenceId: string;
      }> = [];

      for (const confluencePage of pages) {
        const newId = v7();
        const slugId = generateSlugId();

        pagesByConfluenceId.set(confluencePage.id, {
          newId,
          slugId,
          title: confluencePage.title,
          originalContent: confluencePage.body,
          processedContent: confluencePage.body,
          confluenceId: confluencePage.id,
          parentConfluenceId: confluencePage.parent,
          position: null,
        });

        newIdsByConfluenceId.set(confluencePage.id, newId);

        if (confluencePage.parent) {
          parentRelations.push({
            childId: newId,
            parentConfluenceId: confluencePage.parent,
          });
        }
      }

      const attachmentCandidates = new Map<string, string>();
      await this.buildAttachmentCandidates(extractDir, attachmentCandidates);

      for (const [, page] of pagesByConfluenceId) {
        const pageRelativePath = await this.findPageRelativePath(
          extractDir,
          page.confluenceId,
        );

        page.processedContent =
          await importAttachmentService.processAttachments({
            html: page.originalContent,
            pageRelativePath: pageRelativePath || `${page.confluenceId}.html`,
            extractDir,
            pageId: page.newId,
            fileTask,
            attachmentCandidates,
            isConfluenceImport: true,
          });
      }

      const rootPages = Array.from(pagesByConfluenceId.values()).filter(
        (p) =>
          !p.parentConfluenceId ||
          !newIdsByConfluenceId.has(p.parentConfluenceId),
      );

      if (rootPages.length) {
        rootPages.sort((a, b) => a.title.localeCompare(b.title));
        const nextPosition = await this.pageService.nextPagePosition(
          fileTask.spaceId,
        );

        let prevPos: string | null = null;
        rootPages.forEach((page, idx) => {
          if (idx === 0) {
            page.position = nextPosition;
          } else {
            try {
              page.position = generateJitteredKeyBetween(prevPos, null);
            } catch (error) {
              this.logger.error(
                `Error generating position for root page ${page.confluenceId}:`,
                error,
              );
              page.position = generateJitteredKeyBetween(null, null);
            }
          }
          prevPos = page.position;
        });
      }

      let remainingChildPages = Array.from(pagesByConfluenceId.values()).filter(
        (p) =>
          p.parentConfluenceId &&
          newIdsByConfluenceId.has(p.parentConfluenceId) &&
          !p.position,
      );

      while (remainingChildPages.length > 0) {
        let processedAny = false;

        for (let i = 0; i < remainingChildPages.length; i++) {
          const page = remainingChildPages[i];
          const parentConfluenceId = page.parentConfluenceId;

          if (
            parentConfluenceId &&
            newIdsByConfluenceId.has(parentConfluenceId)
          ) {
            const parentPage = pagesByConfluenceId.get(parentConfluenceId);

            if (parentPage && parentPage.position !== null) {
              const siblingsWithPosition = Array.from(
                pagesByConfluenceId.values(),
              ).filter(
                (p) =>
                  p.parentConfluenceId === parentConfluenceId &&
                  p.newId !== page.newId &&
                  p.position !== null,
              );

              try {
                if (siblingsWithPosition.length === 0) {
                  page.position = generateJitteredKeyBetween(null, null);
                } else {
                  const allSiblings = [...siblingsWithPosition, page];
                  allSiblings.sort((a, b) => a.title.localeCompare(b.title));

                  const pageIndex = allSiblings.findIndex(
                    (p) => p.newId === page.newId,
                  );

                  if (pageIndex === 0) {
                    page.position = generateJitteredKeyBetween(
                      null,
                      siblingsWithPosition[0].position,
                    );
                  } else {
                    const prevSiblings = allSiblings
                      .slice(0, pageIndex)
                      .filter((p) => p.position !== null)
                      .sort((a, b) => a.title.localeCompare(b.title));

                    const nextSiblings = allSiblings
                      .slice(pageIndex + 1)
                      .filter((p) => p.position !== null)
                      .sort((a, b) => a.title.localeCompare(b.title));

                    const prevPos =
                      prevSiblings.length > 0
                        ? prevSiblings[prevSiblings.length - 1].position
                        : null;
                    const nextPos =
                      nextSiblings.length > 0 ? nextSiblings[0].position : null;

                    page.position = generateJitteredKeyBetween(
                      prevPos,
                      nextPos,
                    );
                  }
                }
                processedAny = true;
              } catch (error) {
                this.logger.error(
                  `Error generating position for child page ${page.confluenceId}:`,
                  error,
                );
                page.position = generateJitteredKeyBetween(null, null);
                processedAny = true;
              }
            }
          }
        }

        remainingChildPages = Array.from(pagesByConfluenceId.values()).filter(
          (p) =>
            p.parentConfluenceId &&
            newIdsByConfluenceId.has(p.parentConfluenceId) &&
            p.position === null,
        );

        if (!processedAny && remainingChildPages.length > 0) {
          this.logger.warn(
            `Could not generate positions for ${remainingChildPages.length} pages, using defaults`,
          );
          for (const page of remainingChildPages) {
            page.position = generateJitteredKeyBetween(null, null);
          }
          break;
        }
      }

      for (const page of Array.from(pagesByConfluenceId.values())) {
        if (page.position === null) {
          page.position = generateJitteredKeyBetween(null, null);
        }
      }

      const validPageIds = new Set<string>();
      await executeTx(this.db, async (trx) => {
        for (const page of Array.from(pagesByConfluenceId.values())) {
          const pmState = getProsemirrorContent(
            await this.importService.processHTML(page.processedContent),
          );

          const { title, prosemirrorJson } =
            this.importService.extractTitleAndRemoveHeading(pmState);

          const insertablePage: InsertablePage = {
            id: page.newId,
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
            parentPageId: null,
          };

          await trx.insertInto('pages').values(insertablePage).execute();
          validPageIds.add(insertablePage.id);
        }

        for (const relation of parentRelations) {
          const parentNewId = newIdsByConfluenceId.get(
            relation.parentConfluenceId,
          );
          if (parentNewId) {
            await trx
              .updateTable('pages')
              .set({ parentPageId: parentNewId })
              .where('id', '=', relation.childId)
              .execute();
          }
        }

        if (validPageIds.size > 0) {
          this.eventEmitter.emit(EventName.PAGE_CREATED, {
            pageIds: Array.from(validPageIds),
            workspaceId: fileTask.workspaceId,
          });
        }
      });

      this.logger.log(
        `Successfully imported ${pagesByConfluenceId.size} Confluence pages`,
      );
    } catch (error) {
      this.logger.error('Failed to import Confluence pages:', error);
      throw new Error(`Confluence import failed: ${error?.['message']}`);
    }
  }

  private async buildAttachmentCandidates(
    baseDir: string,
    candidates: Map<string, string>,
    relativePath: string = '',
  ): Promise<void> {
    try {
      const entries = await fs.readdir(baseDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(baseDir, entry.name);
        const currentRelativePath = relativePath
          ? `${relativePath}/${entry.name}`
          : entry.name;

        if (entry.isDirectory()) {
          if (entry.name === '__MACOSX' || entry.name.startsWith('.')) {
            continue;
          }
          await this.buildAttachmentCandidates(
            fullPath,
            candidates,
            currentRelativePath,
          );
        } else if (entry.isFile()) {
          candidates.set(currentRelativePath, fullPath);

          if (currentRelativePath.includes('%20')) {
            const decodedPath = currentRelativePath.replace(/%20/g, ' ');
            candidates.set(decodedPath, fullPath);
          }

          if (currentRelativePath.startsWith('attachments/')) {
            const withoutAttachments = currentRelativePath.substring(12);
            candidates.set(withoutAttachments, fullPath);

            const parts = withoutAttachments.split('/');
            if (parts.length > 1) {
              const fileName = parts.slice(1).join('/');
              candidates.set(fileName, fullPath);
            }
          }
        }
      }
    } catch (error) {
      this.logger.warn(`Could not scan directory ${baseDir}: ${error}`);
    }
  }

  private async findPageRelativePath(
    baseDir: string,
    pageId: string,
  ): Promise<string | null> {
    const searchPatterns = [
      `${pageId}.html`,
      `**/${pageId}.html`,
      `**/*${pageId}*.html`,
    ];

    for (const pattern of searchPatterns) {
      try {
        const files = await this.findFilesRecursivelyByPattern(
          baseDir,
          pattern,
        );
        if (files.length > 0) {
          const relativePath = path.relative(baseDir, files[0]);
          const normalizedPath = relativePath.split(path.sep).join('/');

          this.logger.debug(`Found page ${pageId} at: ${normalizedPath}`);
          return normalizedPath;
        }
      } catch (error) {
        this.logger.debug(
          `Could not find file with pattern ${pattern}: ${error}`,
        );
      }
    }

    try {
      const allHtmlFiles = await this.findFilesByExtension(baseDir, '.html');
      for (const file of allHtmlFiles) {
        const fileName = path.basename(file, '.html');
        if (fileName.includes(pageId)) {
          const relativePath = path.relative(baseDir, file);
          const normalizedPath = relativePath.split(path.sep).join('/');

          this.logger.debug(
            `Found page ${pageId} in file: ${fileName}.html at: ${normalizedPath}`,
          );
          return normalizedPath;
        }
      }
    } catch (error) {
      this.logger.debug(`Could not search HTML files: ${error}`);
    }

    this.logger.warn(`Could not find relative path for page ${pageId}`);
    return null;
  }

  private async findFilesRecursivelyByPattern(
    dir: string,
    pattern: string,
  ): Promise<string[]> {
    const results: string[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (entry.name === '__MACOSX' || entry.name.startsWith('.')) {
            continue;
          }
          const subResults = await this.findFilesRecursivelyByPattern(
            fullPath,
            pattern,
          );
          results.push(...subResults);
        } else if (entry.isFile() && entry.name.endsWith('.html')) {
          if (this.fileMatchesPattern(entry.name, pattern)) {
            results.push(fullPath);
          }
        }
      }
    } catch (error) {
      // Пропускаем ошибки
    }

    return results;
  }

  private async findFilesByExtension(
    dir: string,
    extension: string,
  ): Promise<string[]> {
    const results: string[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (entry.name === '__MACOSX' || entry.name.startsWith('.')) {
            continue;
          }
          const subResults = await this.findFilesByExtension(
            fullPath,
            extension,
          );
          results.push(...subResults);
        } else if (
          entry.isFile() &&
          entry.name.toLowerCase().endsWith(extension.toLowerCase())
        ) {
          results.push(fullPath);
        }
      }
    } catch (error) {
      // Пропускаем ошибки
    }

    return results;
  }

  private fileMatchesPattern(fileName: string, pattern: string): boolean {
    if (pattern.includes('**')) {
      const searchName = pattern.split('/').pop() || pattern;
      if (searchName.includes('*')) {
        const regexPattern = searchName
          .replace(/\*/g, '.*')
          .replace(/\./g, '\\.');
        const regex = new RegExp(`^${regexPattern}$`);
        return regex.test(fileName);
      } else {
        return fileName === searchName;
      }
    } else {
      return fileName === pattern;
    }
  }

  private async parseConfluenceExport(
    extractDir: string,
  ): Promise<ConfluencePage[]> {
    const pages: ConfluencePage[] = [];

    await this.findHtmlFilesRecursively(extractDir, pages);

    this.logger.debug(`Found ${pages.length} HTML files`);

    await this.parseBreadcrumbHierarchy(pages, extractDir);

    for (const page of pages) {
      const parentInfo = page.parent
        ? `parent: ${page.parent} (${pages.find((p) => p.id === page.parent)?.title || 'unknown'})`
        : 'root page';
      this.logger.debug(`Page: ${page.id} - "${page.title}" - ${parentInfo}`);
    }

    return pages;
  }

  private async parseBreadcrumbHierarchy(
    pages: ConfluencePage[],
    extractDir: string,
  ): Promise<void> {
    const pageMap = new Map<string, ConfluencePage>();
    pages.forEach((page) => pageMap.set(page.id, page));

    this.logger.debug(`Parsing breadcrumb hierarchy for ${pages.length} pages`);

    for (const page of pages) {
      const breadcrumbIds = await this.extractBreadcrumbFromPage(
        page.body,
        page.id,
        extractDir,
      );

      this.logger.debug(
        `Page ${page.id} ("${page.title}") breadcrumb: [${breadcrumbIds.join(', ')}]`,
      );

      if (breadcrumbIds.length > 1) {
        const breadcrumbWithoutCurrent = breadcrumbIds.slice(0, -1);

        if (breadcrumbWithoutCurrent.length > 0) {
          const immediateParentId =
            breadcrumbWithoutCurrent[breadcrumbWithoutCurrent.length - 1];

          if (pageMap.has(immediateParentId)) {
            page.parent = immediateParentId;
            page.ancestors = [...breadcrumbWithoutCurrent].reverse();

            this.logger.debug(
              `  -> Set parent for ${page.id} to ${immediateParentId}`,
            );
            this.logger.debug(`  -> Ancestors: [${page.ancestors.join(', ')}]`);
          } else {
            this.logger.warn(
              `Parent ${immediateParentId} not found in page list for page ${page.id}`,
            );
          }
        }
      } else if (breadcrumbIds.length === 1 && breadcrumbIds[0] === page.id) {
        this.logger.debug(`  -> Page ${page.id} appears to be a root page`);
      }
    }

    const pagesWithParents = pages.filter((p) => p.parent).length;
    this.logger.debug(
      `Pages with parents determined from breadcrumb: ${pagesWithParents}/${pages.length}`,
    );
  }

  private async extractBreadcrumbFromPage(
    htmlContent: string,
    currentPageId: string,
    extractDir: string,
  ): Promise<string[]> {
    const breadcrumbIds: string[] = [];

    try {
      const breadcrumbSectionMatch = htmlContent.match(
        /<div[^>]*id=["']breadcrumb-section["'][^>]*>([\s\S]*?)<\/div>/i,
      );

      if (breadcrumbSectionMatch) {
        const breadcrumbHtml = breadcrumbSectionMatch[1];
        const linkRegex = /<a[^>]*href=["']([^"']*\.html)["'][^>]*>/gi;
        let match;

        while ((match = linkRegex.exec(breadcrumbHtml)) !== null) {
          const href = match[1];
          if (href && !href.includes('index.html')) {
            const fileName = path.basename(href);
            const pageId = this.extractPageId(fileName.replace('.html', ''));

            const pageFile = await this.findPageFile(extractDir, pageId);
            if (pageFile && !breadcrumbIds.includes(pageId)) {
              breadcrumbIds.push(pageId);
            }
          }
        }
      }

      if (breadcrumbIds.length === 0) {
        const breadcrumbsOlMatch = htmlContent.match(
          /<ol[^>]*id=["']breadcrumbs["'][^>]*>([\s\S]*?)<\/ol>/i,
        );

        if (breadcrumbsOlMatch) {
          const breadcrumbHtml = breadcrumbsOlMatch[1];
          const linkRegex = /<a[^>]*href=["']([^"']*\.html)["'][^>]*>/gi;
          let match;

          while ((match = linkRegex.exec(breadcrumbHtml)) !== null) {
            const href = match[1];
            if (href && !href.includes('index.html')) {
              const fileName = path.basename(href);
              const pageId = this.extractPageId(fileName.replace('.html', ''));

              const pageFile = await this.findPageFile(extractDir, pageId);
              if (pageFile && !breadcrumbIds.includes(pageId)) {
                breadcrumbIds.push(pageId);
              }
            }
          }
        }
      }

      if (!breadcrumbIds.includes(currentPageId)) {
        breadcrumbIds.push(currentPageId);
      }

      this.logger.debug(
        `Breadcrumb for ${currentPageId}: ${breadcrumbIds.join(' -> ')}`,
      );
    } catch (error) {
      this.logger.debug(
        `Could not extract breadcrumb for page ${currentPageId}: ${error}`,
      );
    }

    return breadcrumbIds;
  }

  private async findPageFile(
    extractDir: string,
    pageId: string,
  ): Promise<string | null> {
    const searchPaths = [path.join(extractDir, `${pageId}.html`)];

    for (const filePath of searchPaths) {
      try {
        await fs.access(filePath);
        return filePath;
      } catch {
        // Продолжаем поиск
      }
    }

    return await this.findFileRecursively(extractDir, `${pageId}.html`);
  }

  private async findFileRecursively(
    dir: string,
    fileName: string,
  ): Promise<string | null> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          if (entry.name === '__MACOSX' || entry.name.startsWith('.')) {
            continue;
          }
          const found = await this.findFileRecursively(fullPath, fileName);
          if (found) return found;
        } else if (entry.isFile() && entry.name === fileName) {
          return fullPath;
        }
      }
    } catch (error) {
      // Пропускаем ошибки
    }

    return null;
  }

  private async findHtmlFilesRecursively(
    currentDir: string,
    pages: ConfluencePage[],
    relativePath: string = '',
  ): Promise<void> {
    try {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const currentRelativePath = relativePath
          ? `${relativePath}/${entry.name}`
          : entry.name;

        if (entry.isDirectory()) {
          await this.findHtmlFilesRecursively(
            fullPath,
            pages,
            currentRelativePath,
          );
        } else if (
          entry.isFile() &&
          entry.name.endsWith('.html') &&
          entry.name !== 'index.html'
        ) {
          try {
            const content = await fs.readFile(fullPath, 'utf-8');
            const fileNameWithoutExt = entry.name.replace('.html', '');
            const pageId = this.extractPageId(fileNameWithoutExt);
            const title = this.extractTitle(content) || fileNameWithoutExt;

            pages.push({
              id: pageId,
              title,
              body: content,
              parent: undefined,
              ancestors: [],
            });
          } catch (error) {
            this.logger.warn(`Could not read HTML file ${fullPath}: ${error}`);
          }
        }
      }
    } catch (error) {
      this.logger.warn(`Could not read directory ${currentDir}: ${error}`);
    }
  }

  private extractPageId(fileName: string): string {
    const matches = fileName.match(/\d+/g);
    if (matches && matches.length > 0) {
      return matches[matches.length - 1];
    }

    return fileName;
  }

  private extractTitle(html: string): string {
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    if (titleMatch) {
      let title = titleMatch[1].trim();
      title = this.removePrefixBeforeColon(title);

      return title;
    }

    const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
    if (h1Match) {
      let title = h1Match[1].replace(/<[^>]*>/g, '').trim();
      title = this.removePrefixBeforeColon(title);
      return title;
    }

    const metaMatch = html.match(
      /<meta[^>]*property=["']og:title["'][^>]*content=["'](.*?)["']/i,
    );
    if (metaMatch) {
      let title = metaMatch[1].trim();
      title = this.removePrefixBeforeColon(title);
      return title;
    }

    const dataTitleMatch = html.match(/data-page-title=["'](.*?)["']/i);
    if (dataTitleMatch) {
      let title = dataTitleMatch[1].trim();
      title = this.removePrefixBeforeColon(title);
      return title;
    }

    return 'Untitled';
  }

  private removePrefixBeforeColon(title: string): string {
    const colonIndex = title.indexOf(': ');
    if (colonIndex !== -1) {
      const afterColon = title.substring(colonIndex + 2).trim();
      if (afterColon.length > 0) {
        return afterColon;
      }
    }

    return title;
  }
}
