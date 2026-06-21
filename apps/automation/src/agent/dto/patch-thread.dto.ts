import { IsIn } from 'class-validator';
export class PatchThreadDto {
  @IsIn(['new', 'reviewed', 'archived'])
  status!: 'new' | 'reviewed' | 'archived';
}
