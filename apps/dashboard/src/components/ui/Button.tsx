import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'tiny' | 'tiny-danger';

const CLASS: Record<Variant, string> = {
  primary:      'btn-primary',
  secondary:    'btn-secondary',
  ghost:        'btn-ghost',
  tiny:         'btn-tiny',
  'tiny-danger':'btn-tiny-danger',
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: ReactNode;
}

export function Button({ variant = 'primary', children, className = '', ...rest }: Props) {
  return (
    <button className={`${CLASS[variant]} ${className}`.trim()} {...rest}>
      {children}
    </button>
  );
}
