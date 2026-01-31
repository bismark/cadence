import { XMLParser } from 'fast-xml-parser';
import type { EPUBContainer, OPFPackage, ManifestItem, SpineItem } from '../types.js';
import { resolvePath } from './container.js';

/**
 * Parse the OPF package document from an EPUB container
 */
export async function parseOPF(container: EPUBContainer): Promise<OPFPackage> {
  const content = await container.readFile(container.opfPath);
  const xml = content.toString('utf-8');

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['item', 'itemref', 'dc:title', 'dc:creator'].includes(name),
  });

  const parsed = parser.parse(xml);
  const pkg = parsed.package;

  if (!pkg) {
    throw new Error('Invalid OPF: missing package element');
  }

  // Extract title from metadata
  const metadata = pkg.metadata;
  const titleArray = metadata?.['dc:title'];
  const title = Array.isArray(titleArray) ? titleArray[0] : titleArray || 'Untitled';
  // Handle case where title is an object with text content
  const titleText = typeof title === 'object' ? title['#text'] || 'Untitled' : title;

  // Parse manifest
  const manifest = parseManifest(pkg.manifest, container.opfPath);

  // Parse spine
  const spine = parseSpine(pkg.spine);

  // Build media overlay mapping
  const mediaOverlays = buildMediaOverlayMap(manifest, spine);

  return {
    title: titleText,
    manifest,
    spine,
    mediaOverlays,
  };
}

/**
 * Parse the manifest section of the OPF
 */
function parseManifest(
  manifestNode: { item?: unknown[] },
  opfPath: string
): Map<string, ManifestItem> {
  const manifest = new Map<string, ManifestItem>();

  const items = manifestNode?.item || [];

  for (const item of items) {
    const itemObj = item as Record<string, string>;
    const id = itemObj['@_id'];
    const href = itemObj['@_href'];
    const mediaType = itemObj['@_media-type'];
    const mediaOverlay = itemObj['@_media-overlay'];

    if (id && href && mediaType) {
      // Resolve href relative to OPF location
      const resolvedHref = resolvePath(opfPath, href);

      manifest.set(id, {
        id,
        href: resolvedHref,
        mediaType,
        mediaOverlay,
      });
    }
  }

  return manifest;
}

/**
 * Parse the spine section of the OPF
 */
function parseSpine(spineNode: { itemref?: unknown[] }): SpineItem[] {
  const spine: SpineItem[] = [];

  const items = spineNode?.itemref || [];

  for (const item of items) {
    const itemObj = item as Record<string, string>;
    const idref = itemObj['@_idref'];
    const linear = itemObj['@_linear'] !== 'no';

    if (idref) {
      spine.push({ idref, linear });
    }
  }

  return spine;
}

/**
 * Build a mapping from spine item IDs to their media overlay SMIL file paths
 */
function buildMediaOverlayMap(
  manifest: Map<string, ManifestItem>,
  spine: SpineItem[]
): Map<string, string> {
  const overlays = new Map<string, string>();

  for (const spineItem of spine) {
    const manifestItem = manifest.get(spineItem.idref);
    if (manifestItem?.mediaOverlay) {
      // Find the SMIL file in the manifest
      const smilItem = manifest.get(manifestItem.mediaOverlay);
      if (smilItem) {
        overlays.set(spineItem.idref, smilItem.href);
      }
    }
  }

  return overlays;
}

/**
 * Get ordered list of XHTML files from spine
 */
export function getSpineXHTMLFiles(
  opf: OPFPackage
): Array<{ id: string; href: string; smilHref?: string }> {
  const result: Array<{ id: string; href: string; smilHref?: string }> = [];

  for (const spineItem of opf.spine) {
    if (!spineItem.linear) continue;

    const manifestItem = opf.manifest.get(spineItem.idref);
    if (!manifestItem) continue;

    // Check if this is an XHTML file
    if (
      manifestItem.mediaType === 'application/xhtml+xml' ||
      manifestItem.mediaType === 'text/html'
    ) {
      result.push({
        id: spineItem.idref,
        href: manifestItem.href,
        smilHref: opf.mediaOverlays.get(spineItem.idref),
      });
    }
  }

  return result;
}

/**
 * Get all audio files from the manifest
 */
export function getAudioFiles(opf: OPFPackage): string[] {
  const audioFiles: string[] = [];

  for (const item of opf.manifest.values()) {
    if (item.mediaType.startsWith('audio/')) {
      audioFiles.push(item.href);
    }
  }

  return audioFiles;
}
