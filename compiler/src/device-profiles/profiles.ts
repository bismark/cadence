import type { DeviceProfile } from '../types.js';

/**
 * Supernote Manta A5 X2 device profile
 * Screen: 1920 × 2560 px at 300 PPI
 * Physical: 10.7" diagonal
 */
export const mantaProfile: DeviceProfile = {
  name: 'supernote-manta-a5x2',
  viewportWidth: 1920,
  viewportHeight: 2560,
  margins: {
    top: 100,
    right: 80,
    bottom: 200, // Extra space for player toolbar
    left: 80,
  },
  fontSize: 48, // Large for 300 PPI
  lineHeight: 1.5,
  fontFamily: "'Noto Serif', serif",
};

/**
 * Registry of available device profiles
 */
export const profiles: Record<string, DeviceProfile> = {
  'supernote-manta-a5x2': mantaProfile,
};

/**
 * Default profile used when none is specified
 */
export const defaultProfile: DeviceProfile = mantaProfile;

/**
 * Get a profile by name, or return the default if not found
 */
export function getProfile(name?: string): DeviceProfile {
  if (!name) {
    return defaultProfile;
  }
  const profile = profiles[name];
  if (!profile) {
    throw new Error(`Unknown profile: ${name}. Available: ${Object.keys(profiles).join(', ')}`);
  }
  return profile;
}

/**
 * Get the content area dimensions (viewport minus margins)
 */
export function getContentArea(profile: DeviceProfile) {
  return {
    width: profile.viewportWidth - profile.margins.left - profile.margins.right,
    height: profile.viewportHeight - profile.margins.top - profile.margins.bottom,
    left: profile.margins.left,
    top: profile.margins.top,
  };
}

/**
 * Generate CSS for rendering with the given profile
 */
export function generateProfileCSS(profile: DeviceProfile): string {
  const content = getContentArea(profile);

  return `
    html, body {
      width: ${profile.viewportWidth}px !important;
      height: ${profile.viewportHeight}px !important;
      overflow: hidden !important;
    }

    body {
      margin: 0 !important;
      padding: ${profile.margins.top}px ${profile.margins.right}px ${profile.margins.bottom}px ${profile.margins.left}px !important;
      font-family: ${profile.fontFamily} !important;
      font-size: ${profile.fontSize}px !important;
      line-height: ${profile.lineHeight} !important;
    }

    .cadence-content {
      width: ${content.width}px !important;
      height: ${content.height}px !important;
      overflow-y: scroll !important;
      overflow-x: hidden !important;
    }

    [data-span-id] {
      /* Spans are inline by default for text highlighting */
    }
  `;
}
