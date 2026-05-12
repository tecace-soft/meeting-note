import React from 'react';
import { Loading } from 'react-coolicons';

type AppSpinnerProps = {
  className?: string;
  'aria-label'?: string;
};

/** Coolicons loading mark with Montage-friendly default sizing. */
export const AppSpinner: React.FC<AppSpinnerProps> = ({
  className = 'h-5 w-5 shrink-0 animate-spin text-[var(--accent)]',
  'aria-label': ariaLabel = 'Loading',
}) => <Loading className={className} aria-label={ariaLabel} />;
