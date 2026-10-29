import type { Finding } from '../../sysadmin/audit.types';
import { sourceFindings, type SourceFact as ProbeSourceFact } from '../../sources/source-findings';
import type { ChannelFacts, SourceFact } from '../facts.types';
import type { DoctorCheck } from './index';

/**
 * Spec 076 FR-008, L6 (lead, 076 merge, S8): 076's pure `sourceFindings` as one of the doctor's checks. The facts loader fills what
 * it reads: each feed and page with its latest stored probe (`SourceFact.probe`, the cache only) and `required`, the proxy setting
 * (`proxyConfigured`) and the datasets whose list import was an upload (`DatasetFact.uploaded`). Its codes are catalogue entries of
 * kind `doctor`; `source_unreachable` stays a skip class and is never a finding code here.
 */

/** 072's fact as 076's checks read it (the same fields; the probe's `detail` is optional on both sides). */
const toSourceFact = (s: SourceFact): ProbeSourceFact => ({
  url: s.url, kind: s.kind, origin: s.origin, host: s.host, hostBlock: s.hostBlock,
  ...(s.id ? { id: s.id } : {}), ...(s.required !== undefined ? { required: s.required } : {}), ...(s.probe !== undefined ? { probe: s.probe } : {}),
});

export const sourcesCheck: DoctorCheck = {
  code: 'source_probe_failed',
  run(f: ChannelFacts): Finding[] {
    return sourceFindings({
      channelKey: f.channelKey,
      agent: f.agent?.handle ?? null,
      now: f.now,
      createdAt: f.card.createdAt,
      sources: f.sources.map(toSourceFact),
      proxyConfigured: f.proxyConfigured === true,
      proxyHosts: f.proxyHosts ?? [],
      uploadedImports: f.datasets.filter((d) => d.uploaded).map((d) => d.key),
    });
  },
};
