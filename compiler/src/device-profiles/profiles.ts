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
    bottom: 200,  // Extra space for player toolbar
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
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }

    html, body {
      width: ${profile.viewportWidth}px;
      height: ${profile.viewportHeight}px;
      overflow: hidden;
    }

    body {
      font-family: ${profile.fontFamily};
      font-size: ${profile.fontSize}px;
      line-height: ${profile.lineHeight};
      padding: ${profile.margins.top}px ${profile.margins.right}px ${profile.margins.bottom}px ${profile.margins.left}px;
    }

    .cadence-content {
      width: ${content.width}px;
      height: ${content.height}px;
      overflow-y: scroll;
      overflow-x: hidden;
    }

    [data-span-id] {
      /* Spans are inline by default for text highlighting */
    }

    p, h1, h2, h3, h4, h5, h6 {
      margin-bottom: 0.5em;
    }

    h1 { font-size: 1.5em; }
    h2 { font-size: 1.3em; }
    h3 { font-size: 1.1em; }
  `;
}
