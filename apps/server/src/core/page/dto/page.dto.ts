import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  IsArray,
} from 'class-validator';

export class PageIdDto {
  @IsString()
  @IsNotEmpty()
  pageId: string;
}

export class SpaceIdDto {
  @IsUUID()
  spaceId: string;
}

export class PageHistoryIdDto {
  @IsUUID()
  historyId: string;
}

export class PageInfoDto extends PageIdDto {
  @IsOptional()
  @IsBoolean()
  includeSpace: boolean;

  @IsOptional()
  @IsBoolean()
  includeContent: boolean;
}

export class DeletePageDto extends PageIdDto {
  @IsOptional()
  @IsBoolean()
  permanentlyDelete?: boolean;
}

export class GetPagesTreeDto {
  @IsOptional()
  @IsUUID()
  spaceId?: string;

  @IsOptional()
  @IsArray()
  pageIds?: string[];

  @IsOptional()
  @IsUUID()
  userId?: string;
}

export type WikiPageType = {
  id: string;
  title: string;
  path: string;
  locale?: string;
  parent?: string | null;
  isFolder: boolean;
  isUpload: boolean;
  children?: WikiPageType[];
  createdAt?: string;
  updatedAt?: string;
  isPrivate?: boolean;
  isPublished?: boolean;
  depth?: number;
};
