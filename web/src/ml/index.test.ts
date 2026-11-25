import { describe, expect, it } from 'vitest';
import { DEVICE_TIERS } from '@/contracts/capabilities';
import { mlModule } from './index';

describe('mlModule', () => {
  it('provides the contract surface', () => {
    const settings = mlModule.defaultSettings(DEVICE_TIERS['webgpu-default']);
    expect(settings.tier).toBe('webgpu-default');
    expect(mlModule.sessionOptions('person-detector', 'webgpu').executionProviders).toEqual(['webgpu']);
    expect(mlModule.createOnlineTracker(settings.tracker).update(0, [])).toEqual([]);
    expect(typeof mlModule.createFramePipeline).toBe('function');
    expect(typeof mlModule.finalize).toBe('function');
  });
});
