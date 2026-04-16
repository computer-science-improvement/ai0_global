import { Injectable } from '@nestjs/common';

@Injectable()
export class ContentCleanerService {
  clean(html: string | null): string {
    if (!html) return '';

    return html
      .replace(/<(figure|iframe|video|audio|svg|canvas)[\s\S]*?<\/\1>/gi, '')
      .replace(/<img[\s\S]*?>/gi, '')
      .replace(/<\/(p|div|section|article|h[1-6]|li)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/read the full story.*$/gi, '')
      .replace(/continue reading.*$/gi, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&#038;|&amp;/gi, '&')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'")
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }
}
