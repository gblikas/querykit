'use client';

import { JSX } from 'react';
import Aurora from '@/components/reactbits/blocks/Backgrounds/Aurora/Aurora';

export default function AuroraBackground(): JSX.Element {
  // Force dark-mode palette regardless of theme
  const colorStops = ['#0ea5e9', '#7c3aed', '#22d3ee']; // sky-500 → violet-600 → cyan-400
  return (
    <Aurora amplitude={1.0} blend={0.6} speed={0.4} colorStops={colorStops} />
  );
}
