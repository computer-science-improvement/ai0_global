import type { ButtonHTMLAttributes, ReactNode } from 'react';

/**
 * primary     the one main action of a view (solid green)
 * secondary   bordered ghost: the default for every other action
 * ghost       quiet text button (Cancel, Close)
 * danger      destructive confirm (solid, dark text)
 * warning     the human's action (Resume planning, Lift the pause): amber
 * tiny / tiny-danger   30px row controls inside tables and card-rows
 */
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'warning' | 'tiny' | 'tiny-danger';

const CLASS: Record<Variant, string> = {
  primary:      'btn-primary',
  secondary:    'btn-secondary',
  ghost:        'btn-ghost',
  danger:       'btn-danger',
  warning:      'btn-warning',
  tiny:         'btn-tiny',
  'tiny-danger':'btn-tiny-danger',
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  /** `sm` = 36px with a 44px hit area (panel headers, toolbars). Applies to primary / secondary / danger / warning. */
  size?: 'md' | 'sm';
  children: ReactNode;
}

export function Button({ variant = 'primary', size = 'md', children, className = '', ...rest }: Props) {
  return (
    <button className={`${CLASS[variant]}${size === 'sm' ? ' btn-sm' : ''} ${className}`.trim()} {...rest}>
      {children}
    </button>
  );
}
