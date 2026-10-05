/**
 * Sticker support: a folder of images the model may send, plus QQ's built-in
 * face emoji.
 *
 * A sticker spec is resolved to OneBot message segments. Local files travel as
 * `base64://`, which sidesteps every path-permission and working-directory
 * difference between OneBot implementations.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

/** Image extensions accepted from the sticker folder. */
export const STICKER_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'];

/** Characters allowed in a sticker name (the file name without extension). */
const SAFE_NAME = /^[\p{L}\p{N}_\- .()（）]+$/u;

/** Where the sticker folder lives. */
export function resolveStickerDir(configured, dataDir) {
  if (typeof configured === 'string' && configured.trim().length > 0) return path.resolve(configured.trim());
  return path.join(dataDir, 'stickers');
}

/** Every sticker in the folder, sorted by name. Never throws. */
export async function listStickers(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && STICKER_EXTENSIONS.includes(path.extname(entry.name).toLowerCase()))
      .map((entry) => ({
        name: path.basename(entry.name, path.extname(entry.name)),
        file: entry.name,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  } catch {
    return [];
  }
}

/** Guess a media type from an extension. */
function mediaTypeOf(file) {
  switch (path.extname(file).toLowerCase()) {
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    default: return 'image/jpeg';
  }
}

/**
 * Resolve one sticker spec into OneBot segments.
 *
 * Accepted forms:
 *   - `face:178`            a QQ built-in face emoji
 *   - `http(s)://…`         a remote image URL
 *   - `<sticker name>`      a file in the sticker folder (extension optional)
 *   - `<absolute path>`     any image file on disk
 *
 * @returns `{ segments }` on success or `{ error }` with a readable reason.
 */
export async function resolveSticker(spec, options) {
  const raw = String(spec ?? '').trim();
  if (raw.length === 0) return { error: '没有指定表情' };

  const face = raw.match(/^face:(\d{1,5})$/i);
  if (face !== null) return { segments: [{ type: 'face', data: { id: face[1] } }], label: raw };

  if (/^https?:\/\//i.test(raw)) return { segments: [{ type: 'image', data: { file: raw } }], label: raw };

  const dir = options.dir;
  const maxBytes = options.maxBytes;
  let file = null;

  const isAbsolutePath = path.isAbsolute(raw) || /^[A-Za-z]:[\\/]/.test(raw);
  if (isAbsolutePath) {
    file = path.resolve(raw);
  } else if (SAFE_NAME.test(raw)) {
    if (!STICKER_EXTENSIONS.includes(path.extname(raw).toLowerCase())) {
      for (const extension of STICKER_EXTENSIONS) {
        const candidate = path.join(dir, `${raw}${extension}`);
        try {
          await stat(candidate);
          file = candidate;
          break;
        } catch {
          // Try the next extension.
        }
      }
    } else {
      file = path.join(dir, raw);
    }
  } else {
    return { error: `表情名不合法：${raw}` };
  }

  if (file === null) {
    const available = await listStickers(dir);
    const names = available.map((item) => item.name).slice(0, 40).join('、');
    return { error: `表情库里没有「${raw}」。目录：${dir}${names.length > 0 ? `　可用：${names}` : '　（目录还是空的，把图片丢进去即可）'}` };
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) return { error: `不是文件：${file}` };
    if (info.size > maxBytes) return { error: `图片太大（${Math.round(info.size / 1024)}KB > ${Math.round(maxBytes / 1024)}KB）：${file}` };
    const bytes = await readFile(file);
    return {
      segments: [{ type: 'image', data: { file: `base64://${bytes.toString('base64')}` } }],
      label: `${path.basename(file)}（${Math.round(info.size / 1024)}KB）`,
    };
  } catch (error) {
    return { error: `读取表情失败：${error instanceof Error ? error.message : String(error)}` };
  }
}

/** No-op export kept for symmetry with the other modules. */
export const stickerMediaTypeOf = mediaTypeOf;
