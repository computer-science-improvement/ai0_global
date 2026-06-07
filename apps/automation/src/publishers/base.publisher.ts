import { PostPayload } from '../common/types';

export interface PublishTarget {
  /** Channel/account/page identifier on the platform */
  id: string;
  /** OAuth access token for Meta publishers (resolved upstream from token_env).
   *  Telegram publishers ignore this. */
  token?: string;
  [key: string]: unknown;
}

export abstract class BasePublisher {
  abstract readonly platform: string;

  /**
   * Publish a post to the platform.
   * @returns Published post ID or URL
   */
  abstract publish(payload: PostPayload, target: PublishTarget): Promise<string>;
}
