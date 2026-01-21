// /ee/ai/controllers/ai.controller.ts
import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Res,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@wiki/db/types/entity.types';
import { AiService } from '../services/ai.service';
import { AiSearchService } from '../services/ai-search.service';
import { FastifyReply } from 'fastify';

@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly aiSearchService: AiSearchService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('generate')
  async generate(
    @Body() data: any,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.aiService.generateContent(data, user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('generate/stream')
  async generateStream(
    @Body() data: any,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Res() res: FastifyReply,
  ) {
    res.raw.setHeader('Content-Type', 'text/event-stream');
    res.raw.setHeader('Cache-Control', 'no-cache');
    res.raw.setHeader('Connection', 'keep-alive');

    await this.aiService.generateContentStream(
      data,
      user,
      workspace,
      (chunk) => {
        res.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
      },
    );

    res.raw.write('data: [DONE]\n\n');
    res.raw.end();
  }

  @HttpCode(HttpStatus.OK)
  @Post('ask')
  async ask(
    @Body() data: any,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Res() res: FastifyReply,
  ) {
    res.raw.setHeader('Content-Type', 'text/event-stream');
    res.raw.setHeader('Cache-Control', 'no-cache');
    res.raw.setHeader('Connection', 'keep-alive');

    const result = await this.aiSearchService.searchAndAnswer(
      data,
      user,
      workspace,
      (chunk) => {
        res.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
      },
    );

    res.raw.write('data: [DONE]\n\n');
    res.raw.end();
  }

  @HttpCode(HttpStatus.OK)
  @Post('config')
  async getConfig(@AuthWorkspace() workspace: Workspace) {
    return {
      configured:
        !!process.env.OPENAI_API_KEY || !!process.env.ANTHROPIC_API_KEY,
      availableActions: [
        'improve_writing',
        'fix_spelling_grammar',
        'make_shorter',
        'make_longer',
        'simplify',
        'change_tone',
        'summarize',
        'continue_writing',
        'translate',
        'custom',
      ],
    };
  }
}
