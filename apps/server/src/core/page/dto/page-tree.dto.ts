import { IsOptional, IsString } from "class-validator";

export class PageTreeDto {
    @IsOptional()
    @IsString()
    withContent: string;
}