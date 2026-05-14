import React from 'react';

type ToneColor = 'primary' | string;

function cx(...parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(' ');
}

function semanticColor(color?: string): React.CSSProperties | undefined {
  if (!color) return undefined;
  if (color === 'semantic.label.alternative') return { color: 'var(--text-muted)' };
  return { color };
}

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => <>{children}</>;

type BoxProps<T extends React.ElementType = 'div'> = {
  as?: T;
  sx?: React.CSSProperties;
} & Omit<React.ComponentPropsWithoutRef<T>, 'as'>;

export function Box<T extends React.ElementType = 'div'>({
  as,
  className,
  sx,
  style,
  ...props
}: BoxProps<T>) {
  const Component = as || 'div';
  return <Component className={cx('montage-box', className)} style={{ ...sx, ...style }} {...props} />;
}

type TypographyProps<T extends React.ElementType = 'span'> = {
  as?: T;
  align?: React.CSSProperties['textAlign'];
  color?: string;
  variant?: 'title2' | 'body2' | 'caption1' | 'caption2' | 'label2' | string;
  weight?: 'regular' | 'medium' | 'semibold' | 'bold' | string;
} & Omit<React.ComponentPropsWithoutRef<T>, 'as' | 'color'>;

const typographyClassByVariant: Record<string, string> = {
  title2: 'text-2xl leading-tight',
  body2: 'text-sm leading-relaxed',
  caption1: 'text-xs leading-normal',
  caption2: 'text-[11px] leading-normal',
  label2: 'text-sm leading-normal',
};

const typographyClassByWeight: Record<string, string> = {
  regular: 'font-normal',
  medium: 'font-medium',
  semibold: 'font-semibold',
  bold: 'font-bold',
};

export function Typography<T extends React.ElementType = 'span'>({
  as,
  align,
  className,
  color,
  style,
  variant = 'body2',
  weight,
  ...props
}: TypographyProps<T>) {
  const Component = as || 'span';
  return (
    <Component
      className={cx(
        typographyClassByVariant[variant] || undefined,
        weight ? typographyClassByWeight[weight] || undefined : undefined,
        'montage-typography',
        className
      )}
      style={{ ...semanticColor(color), textAlign: align, ...style }}
      {...props}
    />
  );
}

type ButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color'> & {
  color?: ToneColor;
  fullWidth?: boolean;
  leadingContent?: React.ReactNode;
  loading?: boolean;
  variant?: 'solid' | 'background' | string;
};

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      children,
      className,
      color = 'primary',
      disabled,
      fullWidth,
      leadingContent,
      loading,
      style,
      variant = 'solid',
      ...props
    },
    ref
  ) => {
    const solid = variant === 'solid';
    return (
      <button
        ref={ref}
        className={cx(
          'inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-all focus:outline-none focus:ring-2 focus:ring-offset-2',
          'montage-button',
          fullWidth && 'w-full',
          solid && color === 'primary'
            ? 'btn-accent focus:ring-[var(--accent)]'
            : 'montage-button--secondary',
          className
        )}
        disabled={disabled || loading}
        style={style}
        {...props}
      >
        {loading ? (
          <span
            className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-hidden
          />
        ) : (
          leadingContent
        )}
        <span>{children}</span>
      </button>
    );
  }
);

Button.displayName = 'Button';

type IconButtonProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'color'> & {
  color?: ToneColor;
  variant?: 'solid' | 'background' | string;
};

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ children, className, disabled, style, variant = 'background', ...props }, ref) => (
    <button
      ref={ref}
      className={cx(
        'inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[var(--text-secondary)] transition-all hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[var(--accent)] focus:ring-offset-2',
        'montage-icon-button',
        variant === 'solid' ? 'btn-accent' : 'montage-icon-button--secondary',
        disabled && 'cursor-not-allowed opacity-50',
        className
      )}
      disabled={disabled}
      style={style}
      {...props}
    >
      {children}
    </button>
  )
);

IconButton.displayName = 'IconButton';
