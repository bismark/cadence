import { open, Entry, ZipFile } from 'yauzl';
import { XMLParser } from 'fast-xml-parser';
import type { EPUBContainer } from '../types.js';

/**
 * Open an EPUB file and return a container interface for reading files
 */
export async function openEPUB(epubPath: string): Promise<EPUBContainer> {
  const zipFile = await openZip(epubPath);
  const entries = await readAllEntries(zipFile);
  const opfPath = await findOPFPath(entries, zipFile);

  return {
    opfPath,

    async readFile(path: string): Promise<Buffer> {
      const normalizedPath = normalizePath(path);
      const entry = entries.get(normalizedPath);
      if (!entry) {
        throw new Error(`File not found in EPUB: ${path}`);
      }
      return readEntry(zipFile, entry);
    },

    async listFiles(): Promise<string[]> {
      return Array.from(entries.keys());
    },

    async close(): Promise<void> {
      return new Promise((resolve) => {
        zipFile.close();
        resolve();
      });
    },
  };
}

/**
 * Open a ZIP file with yauzl
 */
function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    open(path, { lazyEntries: true, autoClose: false }, (err, zipFile) => {
      if (err) reject(err);
      else if (!zipFile) reject(new Error('Failed to open ZIP file'));
      else resolve(zipFile);
    });
  });
}

/**
 * Read all entries from the ZIP file into a map
 */
function readAllEntries(zipFile: ZipFile): Promise<Map<string, Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Entry>();

    zipFile.on('entry', (entry: Entry) => {
      // Skip directories
      if (!entry.fileName.endsWith('/')) {
        entries.set(normalizePath(entry.fileName), entry);
      }
      zipFile.readEntry();
    });

    zipFile.on('end', () => {
      resolve(entries);
    });

    zipFile.on('error', reject);

    zipFile.readEntry();
  });
}

/**
 * Read the contents of a ZIP entry
 */
function readEntry(zipFile: ZipFile, entry: Entry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      if (!stream) {
        reject(new Error('Failed to open read stream'));
        return;
      }

      const chunks: Buffer[] = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

/**
 * Find the OPF file path by reading META-INF/container.xml
 */
async function findOPFPath(
  entries: Map<string, Entry>,
  zipFile: ZipFile
): Promise<string> {
  const containerPath = 'META-INF/container.xml';
  const entry = entries.get(containerPath);

  if (!entry) {
    throw new Error('Invalid EPUB: missing META-INF/container.xml');
  }

  const content = await readEntry(zipFile, entry);
  const xml = content.toString('utf-8');

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });

  const parsed = parser.parse(xml);

  // Navigate to container > rootfiles > rootfile
  const rootfile = parsed?.container?.rootfiles?.rootfile;
  if (!rootfile) {
    throw new Error('Invalid container.xml: missing rootfile');
  }

  // Handle single rootfile or array
  const firstRootfile = Array.isArray(rootfile) ? rootfile[0] : rootfile;
  const fullPath = firstRootfile['@_full-path'];

  if (!fullPath) {
    throw new Error('Invalid container.xml: rootfile missing full-path');
  }

  return normalizePath(fullPath);
}

/**
 * Normalize a path (remove leading slashes, normalize separators)
 */
function normalizePath(path: string): string {
  return path.replace(/^\/+/, '').replace(/\\/g, '/');
}

/**
 * Resolve a relative path against a base path
 */
export function resolvePath(basePath: string, relativePath: string): string {
  // Get the directory of the base path
  const baseDir = basePath.substring(0, basePath.lastIndexOf('/') + 1);

  // Handle fragment identifiers
  const [pathPart, fragment] = relativePath.split('#');

  // Resolve the path
  let resolved = baseDir + pathPart;

  // Normalize ".." and "."
  const parts = resolved.split('/');
  const normalized: string[] = [];

  for (const part of parts) {
    if (part === '..') {
      normalized.pop();
    } else if (part !== '.' && part !== '') {
      normalized.push(part);
    }
  }

  const result = normalized.join('/');
  return fragment ? `${result}#${fragment}` : result;
}
