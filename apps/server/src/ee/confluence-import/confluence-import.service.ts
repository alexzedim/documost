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
    private readonly backlinkRepo: BacklinkRepo,
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

      // 1. Создаем структуру страниц
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

      // 2. Обработка вложений
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

      // 3. Генерация позиций - ТОЛЬКО для корневых страниц сначала
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

      // 4. Генерация позиций для дочерних страниц - итеративно
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

            // Если родитель уже имеет позицию
            if (parentPage && parentPage.position !== null) {
              // Получаем всех siblings с тем же родителем, у которых уже есть позиция
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
                  // Первый ребенок этого родителя
                  page.position = generateJitteredKeyBetween(null, null);
                } else {
                  // Есть другие дети - сортируем по алфавиту
                  const allSiblings = [...siblingsWithPosition, page];
                  allSiblings.sort((a, b) => a.title.localeCompare(b.title));

                  const pageIndex = allSiblings.findIndex(
                    (p) => p.newId === page.newId,
                  );

                  if (pageIndex === 0) {
                    // Вставляем перед первым sibling
                    page.position = generateJitteredKeyBetween(
                      null,
                      siblingsWithPosition[0].position,
                    );
                  } else {
                    // Находим предыдущего sibling по алфавиту с позицией
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

        // Обновляем список оставшихся страниц
        remainingChildPages = Array.from(pagesByConfluenceId.values()).filter(
          (p) =>
            p.parentConfluenceId &&
            newIdsByConfluenceId.has(p.parentConfluenceId) &&
            p.position === null,
        );

        // Защита от бесконечного цикла
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

      // 5. Убедимся, что у всех страниц есть позиция
      for (const page of Array.from(pagesByConfluenceId.values())) {
        if (page.position === null) {
          page.position = generateJitteredKeyBetween(null, null);
        }
      }

      // 6. Вставляем все страницы с parentPageId = null
      const validPageIds = new Set<string>();
      await executeTx(this.db, async (trx) => {
        // Вставка всех страниц
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
            parentPageId: null, // Временно null
          };

          await trx.insertInto('pages').values(insertablePage).execute();
          validPageIds.add(insertablePage.id);
        }

        // 7. Обновляем parentPageId для всех страниц
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

  // Добавь эти вспомогательные методы в класс:
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
          // Пропускаем системные папки
          if (entry.name === '__MACOSX' || entry.name.startsWith('.')) {
            continue;
          }
          await this.buildAttachmentCandidates(
            fullPath,
            candidates,
            currentRelativePath,
          );
        } else if (entry.isFile()) {
          // Добавляем все файлы как кандидаты
          candidates.set(currentRelativePath, fullPath);

          // Также добавляем варианты с декодированными пробелами
          if (currentRelativePath.includes('%20')) {
            const decodedPath = currentRelativePath.replace(/%20/g, ' ');
            candidates.set(decodedPath, fullPath);
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
    // Пробуем несколько вариантов поиска
    const searchPatterns = [
      `${pageId}.html`, // Точное совпадение по ID
      `**/${pageId}.html`, // В поддиректориях
      `**/*${pageId}*.html`, // Любой файл содержащий ID
      `**/*${pageId}.html`, // Файл заканчивающийся на ID.html
    ];

    for (const pattern of searchPatterns) {
      try {
        const files = await this.findFilesRecursivelyByPattern(
          baseDir,
          pattern,
        );
        if (files.length > 0) {
          // Берем первый найденный файл
          const relativePath = path.relative(baseDir, files[0]);
          return relativePath.split(path.sep).join('/');
        }
      } catch (error) {
        this.logger.debug(
          `Could not find file with pattern ${pattern}: ${error}`,
        );
      }
    }

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
          // Пропускаем системные папки
          if (entry.name === '__MACOSX' || entry.name.startsWith('.')) {
            continue;
          }
          const subResults = await this.findFilesRecursivelyByPattern(
            fullPath,
            pattern,
          );
          results.push(...subResults);
        } else if (entry.isFile() && entry.name.endsWith('.html')) {
          // Проверяем соответствие паттерну
          if (this.matchesPattern(entry.name, pattern)) {
            results.push(fullPath);
          }
        }
      }
    } catch (error) {
      // Пропускаем ошибки
    }

    return results;
  }

  private matchesPattern(fileName: string, pattern: string): boolean {
    // Простая проверка соответствия паттерну
    if (pattern === `${path.basename(pattern, '.html')}.html`) {
      // Точное совпадение
      return fileName === pattern;
    }

    if (pattern.startsWith('**/')) {
      const searchPart = pattern.slice(3);
      if (searchPart === `*${path.basename(searchPart, '.html')}*.html`) {
        // **/*ID*.html
        const id = searchPart.replace('*', '').replace('.html', '');
        return fileName.includes(id) && fileName.endsWith('.html');
      }
      if (searchPart === `*${path.basename(searchPart, '.html')}.html`) {
        // **/*ID.html
        const id = searchPart.replace('*', '').replace('.html', '');
        return fileName.endsWith(`${id}.html`);
      }
    }

    return false;
  }

  private async findFilesRecursively(
    dir: string,
    pattern: string,
  ): Promise<string[]> {
    const results: string[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          const subResults = await this.findFilesRecursively(fullPath, pattern);
          results.push(...subResults);
        } else if (entry.isFile() && entry.name === pattern) {
          results.push(fullPath);
        }
      }
    } catch (error) {
      // Пропускаем ошибки
    }

    return results;
  }

  private async parseConfluenceExport(
    extractDir: string,
  ): Promise<ConfluencePage[]> {
    const pages: ConfluencePage[] = [];

    // Рекурсивный поиск HTML файлов
    await this.findHtmlFilesRecursively(extractDir, pages);

    this.logger.debug(`Found ${pages.length} HTML files`);

    // Парсим breadcrumb для определения иерархии
    await this.parseBreadcrumbHierarchy(pages, extractDir);

    // Логируем результат
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
        // Breadcrumb содержит несколько страниц
        // Последний элемент - текущая страница
        // Предпоследний - непосредственный родитель
        const breadcrumbWithoutCurrent = breadcrumbIds.slice(0, -1); // Все кроме последнего

        if (breadcrumbWithoutCurrent.length > 0) {
          const immediateParentId =
            breadcrumbWithoutCurrent[breadcrumbWithoutCurrent.length - 1];

          if (pageMap.has(immediateParentId)) {
            page.parent = immediateParentId;
            // Строим цепочку предков
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
        // Только текущая страница в breadcrumb - значит это корневая страница
        this.logger.debug(`  -> Page ${page.id} appears to be a root page`);
      }
    }

    // Статистика
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
      // Парсим breadcrumb из HTML
      // Ищем <div id="breadcrumb-section"> или <ol id="breadcrumbs">
      const breadcrumbSectionMatch = htmlContent.match(
        /<div[^>]*id=["']breadcrumb-section["'][^>]*>([\s\S]*?)<\/div>/i,
      );

      if (breadcrumbSectionMatch) {
        const breadcrumbHtml = breadcrumbSectionMatch[1];
        // Ищем все ссылки в breadcrumb
        const linkRegex = /<a[^>]*href=["']([^"']*\.html)["'][^>]*>/gi;
        let match;

        while ((match = linkRegex.exec(breadcrumbHtml)) !== null) {
          const href = match[1];
          if (href && !href.includes('index.html')) {
            const fileName = path.basename(href);
            const pageId = this.extractPageId(fileName.replace('.html', ''));

            // Проверяем, существует ли такой файл
            const pageFile = await this.findPageFile(extractDir, pageId);
            if (pageFile && !breadcrumbIds.includes(pageId)) {
              breadcrumbIds.push(pageId);
            }
          }
        }
      }

      // Также ищем напрямую <ol id="breadcrumbs">
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

      // Добавляем текущую страницу в конец breadcrumb, если ее еще нет
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
    // Упрощенный поиск без glob
    const searchPaths = [
      path.join(extractDir, `${pageId}.html`),
      // Можно добавить другие пути
    ];

    for (const filePath of searchPaths) {
      try {
        await fs.access(filePath);
        return filePath;
      } catch {
        // Продолжаем поиск
      }
    }

    // Рекурсивный поиск
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
          // Пропускаем системные папки
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

            // НЕ определяем родителя здесь - будет определено из breadcrumb
            pages.push({
              id: pageId,
              title,
              body: content,
              parent: undefined, // Оставляем undefined
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

  private async parseDirectParentLinks(
    pages: ConfluencePage[],
    extractDir: string,
  ): Promise<void> {
    const pageMap = new Map<string, ConfluencePage>();
    pages.forEach((page) => pageMap.set(page.id, page));

    for (const page of pages) {
      if (page.parent) continue; // Уже есть родитель

      // Ищем ссылки на родительскую страницу
      const parentId = await this.findParentFromLinks(
        page.body,
        page.id,
        extractDir,
      );

      if (parentId && pageMap.has(parentId)) {
        page.parent = parentId;
        page.ancestors = [parentId];

        // Попробуем построить цепочку предков
        let currentParent = pageMap.get(parentId);
        while (currentParent && currentParent.parent) {
          if (!page.ancestors.includes(currentParent.parent)) {
            page.ancestors.unshift(currentParent.parent);
            currentParent = pageMap.get(currentParent.parent);
          } else {
            break; // Избегаем циклических ссылок
          }
        }
      }
    }
  }

  private async findParentFromLinks(
    htmlContent: string,
    currentPageId: string,
    extractDir: string,
  ): Promise<string | null> {
    try {
      // Ищем все ссылки на другие страницы
      const linkRegex = /<a[^>]*href=["']([^"']*\.html)["'][^>]*>(.*?)<\/a>/gi;
      const links: Array<{ href: string; text: string }> = [];
      let match;

      while ((match = linkRegex.exec(htmlContent)) !== null) {
        links.push({
          href: match[1],
          text: match[2].replace(/<[^>]*>/g, '').trim(),
        });
      }

      // Фильтруем ссылки, которые могут быть родителями
      for (const link of links) {
        const href = link.href;
        if (
          href &&
          !href.includes('index.html') &&
          !href.includes(currentPageId)
        ) {
          const fileName = path.basename(href);
          const pageId = this.extractPageId(fileName.replace('.html', ''));

          // Проверяем, существует ли такая страница
          const pageFile = await this.findPageFile(extractDir, pageId);
          if (pageFile) {
            // Проверяем текст ссылки - если это "Parent Page" или похожий текст
            const linkText = link.text.toLowerCase();
            if (
              linkText.includes('parent') ||
              linkText.includes('up') ||
              linkText.includes('back') ||
              link.href.includes('parent') ||
              link.href.includes('up')
            ) {
              return pageId;
            }

            // Если в тексте есть название текущей страницы или похоже на навигацию
            if (linkText.length > 0 && linkText.length < 50) {
              // Не слишком длинные ссылки
              return pageId;
            }
          }
        }
      }
    } catch (error) {
      this.logger.debug(
        `Could not find parent from links for page ${currentPageId}: ${error}`,
      );
    }

    return null;
  }

  private extractPageId(fileName: string): string {
    // Примеры имен файлов:
    // AI_Copilot_SIGMA_649959151.html -> 649959151
    // 654278811.html -> 654278811

    // Ищем числа в названии файла
    const matches = fileName.match(/\d+/g);
    if (matches && matches.length > 0) {
      // Возвращаем последнее найденное число (обычно ID в конце)
      return matches[matches.length - 1];
    }

    // Если чисел нет, используем всю строку (для index.html и т.д.)
    return fileName;
  }

  private async determineParentId(
    filePath: string,
    pages: ConfluencePage[],
    baseDir: string,
  ): Promise<string | null> {
    // Получаем путь к директории файла
    const dirPath = path.dirname(filePath);

    // Если это корневая директория, нет родителя
    if (dirPath === '.') {
      return null;
    }

    // Разбиваем путь на части
    const pathParts = dirPath.split('/').filter((part) => part !== '.');

    // Если нет частей пути, значит это корень
    if (pathParts.length === 0) {
      return null;
    }

    // Ищем родительскую директорию
    let currentPath = '';
    for (let i = 0; i < pathParts.length; i++) {
      currentPath = currentPath
        ? `${currentPath}/${pathParts[i]}`
        : pathParts[i];

      // Проверяем, есть ли в этой директории HTML файл с таким же именем
      const potentialParentDir = path.join(baseDir, currentPath);
      try {
        const entries = await fs.readdir(potentialParentDir, {
          withFileTypes: true,
        });

        for (const entry of entries) {
          if (
            entry.isFile() &&
            entry.name.endsWith('.html') &&
            entry.name !== 'index.html'
          ) {
            const parentFileNameWithoutExt = entry.name.replace('.html', '');
            const parentId = this.extractPageId(parentFileNameWithoutExt);

            // Проверяем, есть ли уже такая страница в нашем списке
            const existingParent = pages.find((p) => p.id === parentId);
            if (existingParent) {
              // Это ближайший родитель
              return parentId;
            }

            // Если родитель не найден, создаем его
            try {
              const parentContent = await fs.readFile(
                path.join(potentialParentDir, entry.name),
                'utf-8',
              );
              const parentTitle =
                this.extractTitle(parentContent) || parentFileNameWithoutExt;

              // Рекурсивно находим родителя для родителя
              const parentRelativePath = currentPath;
              const grandParentId = await this.determineParentId(
                parentRelativePath,
                pages,
                baseDir,
              );

              // Добавляем родителя
              pages.unshift({
                id: parentId,
                title: parentTitle,
                body: parentContent,
                parent: grandParentId,
                ancestors: grandParentId ? [grandParentId] : [],
              });

              return parentId;
            } catch (error) {
              this.logger.debug(`Could not read parent file: ${error}`);
            }
          }
        }
      } catch (error) {
        this.logger.debug(
          `Could not read directory ${potentialParentDir}: ${error}`,
        );
      }
    }

    return null;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  private parseIndexHtml(indexContent: string): any {
    // Парсим index.html для извлечения структуры страниц
    // Это может быть полезно для определения иерархии

    const structure = {
      pages: [] as Array<{ id: string; title: string; path: string }>,
    };

    try {
      // Простой парсинг ссылок
      const linkRegex = /<a[^>]*href=["']([^"']*\.html)["'][^>]*>(.*?)<\/a>/gi;
      let match;

      while ((match = linkRegex.exec(indexContent)) !== null) {
        const href = match[1];
        const title = match[2].replace(/<[^>]*>/g, '').trim();

        if (href && !href.includes('index.html')) {
          // Извлекаем ID из имени файла
          const fileName = href.split('/').pop() || href;
          const pageId = this.extractPageId(fileName.replace('.html', ''));

          structure.pages.push({
            id: pageId,
            title: title || fileName.replace('.html', ''),
            path: href,
          });
        }
      }
    } catch (error) {
      this.logger.debug(`Could not parse index.html structure: ${error}`);
    }

    return structure;
  }

  private async matchPagesWithStructure(
    pages: ConfluencePage[],
    structure: any,
    baseDir: string,
  ): Promise<void> {
    // Попробовать сопоставить найденные страницы со структурой из index.html
    if (!structure.pages || structure.pages.length === 0) {
      return;
    }

    const structureMap = new Map<string, any>();
    structure.pages.forEach((page: any) => {
      structureMap.set(page.id, page);
    });

    // Обновить заголовки из структуры, если они есть
    for (const page of pages) {
      const structurePage = structureMap.get(page.id);
      if (structurePage && structurePage.title) {
        page.title = structurePage.title;
      }
    }
  }

  private extractTitle(html: string): string {
    // Пробуем извлечь заголовок разными способами

    // 1. Из тега <title>
    const titleMatch = html.match(/<title>(.*?)<\/title>/i);
    if (titleMatch) {
      let title = titleMatch[1].trim();

      // Удаляем всё до первого ": " (двоеточие с пробелом)
      title = this.removePrefixBeforeColon(title);

      return title;
    }

    // 2. Из заголовка h1
    const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
    if (h1Match) {
      let title = h1Match[1].replace(/<[^>]*>/g, '').trim();
      title = this.removePrefixBeforeColon(title);
      return title;
    }

    // 3. Из метатега
    const metaMatch = html.match(
      /<meta[^>]*property=["']og:title["'][^>]*content=["'](.*?)["']/i,
    );
    if (metaMatch) {
      let title = metaMatch[1].trim();
      title = this.removePrefixBeforeColon(title);
      return title;
    }

    // 4. Из атрибута data-page-title (часто используется в Confluence)
    const dataTitleMatch = html.match(/data-page-title=["'](.*?)["']/i);
    if (dataTitleMatch) {
      let title = dataTitleMatch[1].trim();
      title = this.removePrefixBeforeColon(title);
      return title;
    }

    return 'Untitled';
  }

  // Добавь этот метод:
  private removePrefixBeforeColon(title: string): string {
    // Удаляем всё что до первого ": " (двоеточие с пробелом)
    // Пример: "AI_Copilot_SIGMA : ИИ-документы" -> "ИИ-документы"

    const colonIndex = title.indexOf(': ');
    if (colonIndex !== -1) {
      // Проверяем, есть ли что-то после ": "
      const afterColon = title.substring(colonIndex + 2).trim();
      if (afterColon.length > 0) {
        return afterColon;
      }
    }

    return title;
  }
}
