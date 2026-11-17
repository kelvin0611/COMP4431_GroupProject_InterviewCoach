import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const healthMock = vi.hoisted(() => ({ adapter: undefined as string | undefined }));
vi.mock('../lib/api', () => ({
  healthOnce: () => Promise.resolve({ adapter: healthMock.adapter }),
}));

import { ProviderBadge } from './Common';

describe('ProviderBadge', () => {
  it('names the fine-tuned adapter once llama-server reports it loaded', async () => {
    healthMock.adapter = 'loaded';
    render(<ProviderBadge provider="llama" />);
    expect(await screen.findByText('Fine-tuned Qwen3-4B · LoRA')).toBeTruthy();
  });

  it('keeps the plain local label when the base weights are serving', async () => {
    healthMock.adapter = 'base';
    render(<ProviderBadge provider="llama" />);
    expect(await screen.findByText('Local AI coach')).toBeTruthy();
  });

  it('never relabels the scripted demo or its fallback', async () => {
    healthMock.adapter = 'loaded';
    const { unmount } = render(<ProviderBadge provider="demo" />);
    expect(await screen.findByText('Demo coach · scripted')).toBeTruthy();
    unmount();
    render(<ProviderBadge provider="demo-fallback" />);
    expect(await screen.findByText('Fallback coach · scripted')).toBeTruthy();
  });
});
