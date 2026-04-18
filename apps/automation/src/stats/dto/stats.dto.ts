import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ChannelSummaryDto {
  @ApiProperty({ example: '@ai0_global' })
  channelId!: string;

  @ApiPropertyOptional({ type: Number, nullable: true })
  subscribers!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: 'Change vs 24h ago' })
  subscribersDelta24h!: number | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  title!: string | null;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  lastSnapshotAt!: Date | null;
}

export class ChannelSnapshotDto {
  @ApiProperty({ type: String, format: 'date-time' })
  capturedAt!: Date;

  @ApiPropertyOptional({ type: Number, nullable: true })
  subscribers!: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  onlineCount!: number | null;
}

export class PostWithLatestDto {
  @ApiProperty()                             id!: number;
  @ApiProperty({ example: '@ai0_global' })   channelId!: string;
  @ApiProperty()                             messageId!: number;
  @ApiPropertyOptional({ nullable: true })   title!: string | null;
  @ApiPropertyOptional({ nullable: true })   sourceUrl!: string | null;
  @ApiPropertyOptional({ nullable: true })   strategyType!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) postedAt!: Date;
  @ApiPropertyOptional({ type: Number, nullable: true }) latestViews!: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) latestReactions!: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) latestForwards!: number | null;
}

export class PostSnapshotDto {
  @ApiProperty({ type: String, format: 'date-time' }) capturedAt!: Date;
  @ApiPropertyOptional({ type: Number, nullable: true }) views!: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) forwards!: number | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) replies!: number | null;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'number' },
    nullable: true,
    example: { '👍': 12, '❤️': 4 },
  })
  reactions!: Record<string, number> | null;
  @ApiPropertyOptional({ type: Number, nullable: true }) reactionsTotal!: number | null;
}

export class PostDetailDto {
  @ApiProperty({ type: PostWithLatestDto, nullable: true }) post!: PostWithLatestDto | null;
  @ApiProperty({ type: [PostSnapshotDto] })                 snapshots!: PostSnapshotDto[];
}

export class ChannelDetailDto {
  @ApiProperty({ example: '@ai0_global' }) channelId!: string;
  @ApiProperty({ type: [ChannelSnapshotDto] }) snapshots!: ChannelSnapshotDto[];
}

export class SummaryDto {
  @ApiProperty() postsToday!: number;
  @ApiProperty() postsWeek!: number;
  @ApiProperty() postsMonth!: number;
  @ApiProperty({ type: [PostWithLatestDto] }) topPosts!: PostWithLatestDto[];
  @ApiProperty({ type: [ChannelSummaryDto] }) channelGrowth!: ChannelSummaryDto[];
}

export class RefreshResultDto {
  @ApiProperty() channels!: number;
  @ApiProperty() posts!: number;
  @ApiProperty() skipped!: boolean;
}
