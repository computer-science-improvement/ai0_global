import type { ReactNode, CSSProperties } from 'react';

export function Card({ children, style, className = '' }: {
  children: ReactNode; style?: CSSProperties; className?: string;
}) {
  return <div className={`card ${className}`.trim()} style={style}>{children}</div>;
}

/** Card with a small heading row and an optional right-aligned action. */
export function Panel({ title, action, children, style }: {
  title: string; action?: ReactNode; children: ReactNode; style?: CSSProperties;
}) {
  return (
    <Card style={{ padding: 16, ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <h3 className="text-heading-md" style={{ margin: 0, fontSize: 13, fontWeight: 500, letterSpacing: '-0.01em' }}>{title}</h3>
        {action && <div style={{ marginLeft: 'auto' }}>{action}</div>}
      </div>
      {children}
    </Card>
  );
}
