// @vitest-environment node
/**
 * ui/fs-path.ts 纯函数单测：win32（盘符 / UNC）与 POSIX 两侧的判定、根、切分、拼接、父目录。
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface FsPathMod {
  isWindowsPath(p: string): boolean;
  sepOf(p: string): string;
  rootOfPath(p: string): string;
  splitPath(p: string): string[];
  joinPath(base: string, seg: string): string;
  parentOfPath(p: string): string;
}
const at = (rel: string): string => pathToFileURL(join(process.cwd(), 'apps', 'web', 'src', rel)).href;
const load = async (): Promise<FsPathMod> => (await import(/* @vite-ignore */ at('ui/fs-path.ts'))) as FsPathMod;

describe('fs-path · 平台路径纯函数', () => {
  it('win32 盘符：判定 / 根 / 切分 / 拼接 / 父目录', async () => {
    const m = await load();
    expect(m.isWindowsPath('C:\\Users\\me\\proj')).toBe(true);
    expect(m.sepOf('C:\\Users\\me\\proj')).toBe('\\');
    expect(m.rootOfPath('C:\\Users\\me\\proj')).toBe('C:\\');
    expect(m.splitPath('C:\\Users\\me\\proj')).toEqual(['Users', 'me', 'proj']);
    expect(m.rootOfPath('C:\\')).toBe('C:\\');
    expect(m.splitPath('C:\\')).toEqual([]);
    expect(m.joinPath('C:\\Users', 'me')).toBe('C:\\Users\\me');
    expect(m.joinPath('C:\\', 'Users')).toBe('C:\\Users');
    expect(m.parentOfPath('C:\\Users\\me\\proj')).toBe('C:\\Users\\me');
    expect(m.parentOfPath('C:\\')).toBe('C:\\');
  });

  it('UNC：\\server\\share\\dir', async () => {
    const m = await load();
    expect(m.isWindowsPath('\\\\server\\share\\dir')).toBe(true);
    expect(m.rootOfPath('\\\\server\\share\\dir')).toBe('\\\\server\\share\\');
    expect(m.splitPath('\\\\server\\share\\dir')).toEqual(['dir']);
    expect(m.joinPath('\\\\server\\share', 'dir')).toBe('\\\\server\\share\\dir');
  });

  it('POSIX：/a/b 与 /', async () => {
    const m = await load();
    expect(m.isWindowsPath('/a/b')).toBe(false);
    expect(m.sepOf('/a/b')).toBe('/');
    expect(m.rootOfPath('/a/b')).toBe('/');
    expect(m.splitPath('/a/b')).toEqual(['a', 'b']);
    expect(m.rootOfPath('/')).toBe('/');
    expect(m.splitPath('/')).toEqual([]);
    expect(m.joinPath('/a', 'b')).toBe('/a/b');
    expect(m.joinPath('/', 'a')).toBe('/a');
    expect(m.parentOfPath('/a/b')).toBe('/a');
    expect(m.parentOfPath('/')).toBe('/');
  });

  it('不混用分隔符', async () => {
    const m = await load();
    expect(m.joinPath('C:\\Users\\me', 'proj')).not.toContain('/');
    expect(m.joinPath('/a', 'b')).not.toContain('\\');
  });
});
