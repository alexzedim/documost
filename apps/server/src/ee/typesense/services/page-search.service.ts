// /ee/typesense/services/page-search.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@wiki/db/types/kysely.types';
import Typesense from 'typesense';

@Injectable()
export class PageSearchService {
  private readonly logger = new Logger(PageSearchService.name);
  // @ts-ignore
  private client: Typesense.Client;

  constructor(@InjectKysely() private readonly db: KyselyDB) {
    this.client = new Typesense.Client({
      nodes: [
        {
          host: process.env.TYPESENSE_HOST || 'localhost',
          port: parseInt(process.env.TYPESENSE_PORT || '8108'),
          protocol: process.env.TYPESENSE_PROTOCOL || 'http',
        },
      ],
      apiKey: process.env.TYPESENSE_API_KEY || '',
      connectionTimeoutSeconds: 2,
    });
  }

  async searchPage(
    searchParams: any,
    opts: { userId?: string; workspaceId: string },
  ): Promise<any> {
    const { query, spaceId, shareId } = searchParams;
    const { userId, workspaceId } = opts;

    try {
      const searchParameters = {
        q: query,
        query_by: 'title,textContent',
        filter_by: `workspaceId:=${workspaceId}`,
        per_page: 20,
      };

      if (spaceId) {
        searchParameters.filter_by += ` && spaceId:=${spaceId}`;
      }

      if (shareId) {
        searchParameters.filter_by += ` && shareId:=${shareId}`;
      }

      const results = await this.client
        .collections('pages')
        .documents()
        .search(searchParameters);

      return {
        data: results.hits?.map((hit) => hit.document) || [],
        total: results.found || 0,
      };
    } catch (error) {
      this.logger.error('Typesense search error:', error);
      throw error;
    }
  }

  async indexPage(pageId: string): Promise<void> {
    const page = await this.db
      .selectFrom('pages')
      .selectAll()
      .where('id', '=', pageId)
      .executeTakeFirst();

    if (!page) return;

    await this.client.collections('pages').documents().upsert({
      id: page.id,
      title: page.title,
      textContent: page.textContent,
      workspaceId: page.workspaceId,
      spaceId: page.spaceId,
      createdAt: page.createdAt.getTime(),
    });
  }
}
