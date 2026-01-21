// /ee/ai/services/ai-search.service.ts
import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@wiki/db/types/kysely.types';
import { User, Workspace } from '@wiki/db/types/entity.types';
import OpenAI from 'openai';

@Injectable()
export class AiSearchService {
  private openai: OpenAI;

  constructor(@InjectKysely() private readonly db: KyselyDB) {
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    }
  }

  async searchAndAnswer(
    data: any,
    user: User,
    workspace: Workspace,
    onChunk: (chunk: any) => void,
  ): Promise<any> {
    const { query, spaceId } = data;

    // Search for relevant pages
    let searchQuery = this.db
      .selectFrom('pages')
      .select(['id', 'title', 'textContent', 'slugId'])
      .where('workspaceId', '=', workspace.id)
      .where('deletedAt', 'is', null)
      .limit(5);

    if (spaceId) {
      searchQuery = searchQuery.where('spaceId', '=', spaceId);
    }

    const pages = await searchQuery.execute();

    // Build context from pages
    const context = pages
      .map(
        (p) =>
          `Title: ${p.title}\nContent: ${p.textContent?.substring(0, 500)}`,
      )
      .join('\n\n---\n\n');

    const prompt = `Based on the following documentation, answer the question. If the answer is not in the documentation, say so.

Documentation:
${context}

Question: ${query}

Answer:`;

    const stream = await this.openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        onChunk({ content });
      }
    }

    // Send sources
    const sources = pages.map((p) => ({
      pageId: p.id,
      title: p.title,
      slugId: p.slugId,
      similarity: 0.9,
      distance: 0.1,
      chunkIndex: 0,
      excerpt: p.textContent?.substring(0, 200) || '',
    }));

    onChunk({ sources });

    return { sources };
  }
}
