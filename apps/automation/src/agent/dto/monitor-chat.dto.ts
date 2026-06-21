import { IsBoolean } from 'class-validator';
export class MonitorChatDto { @IsBoolean() enabled!: boolean; }
