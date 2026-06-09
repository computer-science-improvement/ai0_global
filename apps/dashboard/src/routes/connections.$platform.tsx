import { createFileRoute, useParams } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { Placeholder } from '../components/ui/Placeholder';
import type { IconName } from '../components/ui/Icon';

const LABEL: Record<string, { name: string; icon: IconName }> = {
  instagram: { name: 'Instagram', icon: 'instagram' },
  tiktok:    { name: 'TikTok',    icon: 'tiktok' },
  threads:   { name: 'Threads',   icon: 'threads' },
  facebook:  { name: 'Facebook',  icon: 'facebook' },
};

export const Route = createFileRoute('/connections/$platform')({ component: Connection });

function Connection() {
  const { platform } = useParams({ from: '/connections/$platform' });
  const meta = LABEL[platform] ?? { name: platform, icon: 'connections' as IconName };
  return (
    <div>
      <PageHeader title={`Connections · ${meta.name}`} subtitle="Accounts and tokens" />
      <Placeholder icon={meta.icon} title={`${meta.name} soon`} note={`${meta.name} account connections will appear once we add the integration.`} />
    </div>
  );
}
