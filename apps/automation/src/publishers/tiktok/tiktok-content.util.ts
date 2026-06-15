// Pure helpers for TikTok photo (carousel) posting. No I/O — unit-tested directly.

export type TikTokPrivacy =
  | 'SELF_ONLY' | 'PUBLIC_TO_EVERYONE' | 'MUTUAL_FOLLOW_FRIENDS' | 'FOLLOWER_OF_CREATOR';

export interface PhotoPostInput {
  imageUrls:    string[];
  title:        string;
  description:  string;
  privacyLevel: TikTokPrivacy;
  coverIndex?:  number;
}

const TITLE_MAX = 90;

/** Build the /v2/post/publish/content/init/ body for a DIRECT_POST photo carousel. */
export function buildPhotoPostBody(input: PhotoPostInput): Record<string, unknown> {
  if (input.imageUrls.length < 1) throw new Error('TikTok carousel needs at least one image');
  return {
    post_info: {
      title:           input.title,
      description:     input.description,
      privacy_level:   input.privacyLevel,
      disable_comment: false,
    },
    source_info: {
      source:            'PULL_FROM_URL',
      photo_cover_index: input.coverIndex ?? 0,
      photo_images:      input.imageUrls,
    },
    post_mode:  'DIRECT_POST',
    media_type: 'PHOTO',
  };
}

/** Split one caption into a TikTok title (first line, capped) + the full description. */
export function captionToTitleDescription(caption: string): { title: string; description: string } {
  const firstLine = caption.split('\n', 1)[0] ?? '';
  return { title: firstLine.slice(0, TITLE_MAX), description: caption };
}

export function isComplete(status: string): boolean { return status === 'PUBLISH_COMPLETE'; }
export function isFailed(status: string): boolean { return status === 'FAILED'; }
