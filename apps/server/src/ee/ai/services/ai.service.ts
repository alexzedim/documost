// /ee/ai/services/ai.service.ts
import { Injectable } from '@nestjs/common';
import { User, Workspace } from '@wiki/db/types/entity.types';
import OpenAI from 'openai';

@Injectable()
export class AiService {
  private openai: OpenAI;

  constructor() {
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    }
  }

  async generateContent(
    data: any,
    user: User,
    workspace: Workspace,
  ): Promise<any> {
    const prompt = this.buildPrompt(data);

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    });

    return {
      content: completion.choices[0].message.content,
      usage: {
        promptTokens: completion.usage?.prompt_tokens || 0,
        completionTokens: completion.usage?.completion_tokens || 0,
        totalTokens: completion.usage?.total_tokens || 0,
      },
    };
  }

  async generateContentStream(
    data: any,
    user: User,
    workspace: Workspace,
    onChunk: (chunk: any) => void,
  ): Promise<void> {
    const prompt = this.buildPrompt(data);

    const stream = await this.openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        onChunk({ content });
      }
    }
  }

  private buildPrompt(data: any): string {
    const { action, content, prompt } = data;

    const actionPrompts = {
      improve_writing: `Improve the following text while maintaining its meaning:\n\n${content}`,
      fix_spelling_grammar: `Fix spelling and grammar in the following text:\n\n${content}`,
      make_shorter: `Make the following text more concise:\n\n${content}`,
      make_longer: `Expand the following text with more details:\n\n${content}`,
      simplify: `Simplify the following text:\n\n${content}`,
      change_tone: `Change the tone of the following text:\n\n${content}`,
      summarize: `Summarize the following text:\n\n${content}`,
      continue_writing: `Continue writing from:\n\n${content}`,
      translate: `Translate the following text:\n\n${content}`,
      custom: prompt || content,
    };

    return actionPrompts[action] || content;
  }
}
