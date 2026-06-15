// TikTok Content Posting API client (photo mode). Transport only: init a post and
// fetch its publish status. The `post` seam is overridable in tests so no live
// network is hit. The access token is sent as a Bearer header and is NEVER logged
// or included in a thrown message.
import { Injectable } from '@nestjs/common';
import axios from 'axios';

const BASE = 'https://open.tiktokapis.com';

@Injectable()
export class TikTokContentClient {
  /** HTTP seam — overridable in tests. Returns the parsed JSON body. */
  protected async post(url: string, accessToken: string, body: unknown): Promise<any> {
    const res = await axios.post(url, body, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      timeout: 15_000,
    });
    return res.data;
  }

  /** Initialize a DIRECT_POST photo carousel. Returns the publish_id. */
  async initPhotoPost(accessToken: string, body: Record<string, unknown>): Promise<{ publishId: string }> {
    const res = await this.post(`${BASE}/v2/post/publish/content/init/`, accessToken, body);
    if (res?.error && res.error.code !== 'ok') {
      throw new Error(`TikTok init failed: ${res.error.message ?? res.error.code}`);
    }
    const publishId = String(res?.data?.publish_id ?? '');
    if (!publishId) throw new Error('TikTok init returned no publish_id');
    return { publishId };
  }

  /** Fetch the publish status for a publish_id. */
  async fetchStatus(accessToken: string, publishId: string): Promise<{ status: string; failReason?: string }> {
    const res = await this.post(`${BASE}/v2/post/publish/status/fetch/`, accessToken, { publish_id: publishId });
    if (res?.error && res.error.code !== 'ok') {
      throw new Error(`TikTok status failed: ${res.error.message ?? res.error.code}`);
    }
    return { status: String(res?.data?.status ?? ''), failReason: res?.data?.fail_reason };
  }
}
